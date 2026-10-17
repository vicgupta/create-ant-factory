// Run records: one small JSON file per factory run, saying what happened
// (which worker, provider and agent, how long, how many check attempts,
// how many files changed, and how it ended). The workflow uploads the file
// as an artifact, and scripts/report.mjs turns a folder of them into a
// pass-rate / time-to-PR / rework report.
//
// A record never holds log output, prompts, error messages or the agent's
// reply: those can carry secrets or private code. Only counts, names, the
// issue title (redacted by the caller) and a short reason code.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"

export const RECORD_VERSION = 1
export const DEFAULT_RECORD_DIR = "runs"

// How a run can end. "skipped" runs (the issue was no longer ready) are kept
// in the files but left out of the pass rate.
export const OUTCOMES = ["pr-opened", "pr-revised", "needs-attention", "no-worker", "skipped", "error"]
const SUCCESS = new Set(["pr-opened", "pr-revised"])

// Left out means true: a record is a local file plus an artifact, nothing
// is posted anywhere.
export const recordsEnabled = (config) => config?.factory?.runRecords !== false

// A decision a run made, traced so a later run can learn from it (see
// src/context.mjs). Deliberately small and free-text-light: a stage, the
// choice, what was rejected, where the evidence is (files, checks or an
// issue/PR link as a plain string), the policy or label behind the choice,
// who asked for it when a person did, and how it turned out. No prompt or
// log text goes here either.
export const DECISION_OUTCOMES = ["pending", "succeeded", "failed", "rejected", "reverted"]
export const MAX_DECISIONS = 50

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim())

export function validateDecision(decision) {
  const errors = []
  if (!decision || typeof decision !== "object") return ["a decision must be an object"]
  if (typeof decision.stage !== "string" || !decision.stage.trim()) errors.push("a decision needs a stage (a non-empty string)")
  if (typeof decision.choice !== "string" || !decision.choice.trim()) errors.push("a decision needs a choice (a non-empty string)")
  if (decision.alternatives_rejected !== undefined && !isStrings(decision.alternatives_rejected)) errors.push("a decision's alternatives_rejected must be a list of non-empty strings")
  if (!isStrings(decision.evidence) || decision.evidence.length === 0) errors.push("a decision needs evidence: a list of non-empty strings (files, checks or issue/PR links)")
  if (typeof decision.policy_or_label !== "string" || !decision.policy_or_label.trim()) errors.push("a decision needs a policy_or_label (a non-empty string)")
  if (decision.human_actor !== undefined && decision.human_actor !== null && (typeof decision.human_actor !== "string" || !decision.human_actor.trim())) errors.push("a decision's human_actor must be a non-empty string when present")
  if (!DECISION_OUTCOMES.includes(decision.outcome)) errors.push(`a decision's outcome must be one of: ${DECISION_OUTCOMES.join(", ")}`)
  return errors
}

export function noteDecision(record, decision) {
  const errors = validateDecision(decision)
  if (errors.length) throw new Error(`Invalid run-record decision: ${errors.join("; ")}`)
  record.decisions ??= []
  if (record.decisions.length >= MAX_DECISIONS) return record
  record.decisions.push({
    stage: decision.stage.trim(),
    choice: decision.choice.trim(),
    ...(decision.alternatives_rejected?.length ? { alternatives_rejected: [...decision.alternatives_rejected] } : {}),
    evidence: [...decision.evidence],
    policy_or_label: decision.policy_or_label.trim(),
    ...(decision.human_actor ? { human_actor: decision.human_actor.trim() } : {}),
    outcome: decision.outcome,
  })
  return record
}

export function recordDir(env = process.env) {
  return env.FACTORY_RUN_RECORD_DIR?.trim() || DEFAULT_RECORD_DIR
}

export function createRunRecord({ repo, issue, runId, runUrl = null, now = new Date() }) {
  return {
    version: RECORD_VERSION,
    runId: String(runId),
    runUrl,
    repo: repo ?? null,
    issue: issue === undefined || issue === null ? null : Number(issue),
    title: null,
    mode: "new",
    worker: null,
    agent: null,
    provider: null,
    startedAt: now.toISOString(),
    endedAt: null,
    minutes: null,
    agentRuns: 0,
    agentMinutes: 0,
    checkAttempts: 0,
    checksPassed: null,
    filesChanged: null,
    outcome: null,
    reason: null,
    pullRequest: null,
    labels: [],
    files: [],
    decisions: [],
    contextBundle: [],
    gate: null,
    review: null,
  }
}

// One agent run's minutes (runScript reports them as a string like "3.4").
export function noteAgentRun(record, minutes) {
  record.agentRuns += 1
  const value = Number(minutes)
  if (Number.isFinite(value)) record.agentMinutes = Math.round((record.agentMinutes + value) * 10) / 10
}

export function noteChecks(record, passed) {
  record.checkAttempts += 1
  record.checksPassed = Boolean(passed)
}

// Sets the outcome once. The first ending wins, so the generic "error" the
// top level records after a thrown error cannot overwrite the more precise
// outcome (for example "no-worker") that was set just before the throw.
export function endRun(record, outcome, reason = null) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`Unknown run outcome "${outcome}"`)
  if (record.outcome) return record
  record.outcome = outcome
  record.reason = reason
  return record
}

export function finishRunRecord(record, now = new Date()) {
  if (!record.outcome) endRun(record, "error", "unfinished")
  record.endedAt = now.toISOString()
  record.minutes = Math.round(((now - new Date(record.startedAt)) / 60000) * 10) / 10
  return record
}

const safeName = (runId) => String(runId).replace(/[^A-Za-z0-9._-]/g, "_")

export function writeRunRecord(record, dir = recordDir()) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `run-${safeName(record.runId)}.json`)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  return file
}

const cell = (value) => String(value ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ")

// A few lines of markdown for the GitHub Actions job summary page.
export function stepSummary(record) {
  const rows = [
    ["Issue", record.repo && record.issue ? `${record.repo}#${record.issue}${record.title ? ` ${record.title}` : ""}` : null],
    ["Outcome", record.reason ? `${record.outcome} (${record.reason})` : record.outcome],
    ["Mode", record.mode === "revise" ? "revise an open pull request" : "new pull request"],
    ["Worker", record.worker ? `${record.worker} (${record.agent})` : null],
    ["Provider", record.provider],
    ["Run minutes", record.minutes],
    ["Agent runs / minutes", `${record.agentRuns} / ${record.agentMinutes}`],
    ["Check attempts", record.checkAttempts],
    ["Files changed", record.filesChanged],
    ["Pull request", record.pullRequest],
    ["Independent review", record.review ? `${record.review.decision} (${record.review.agent}${record.review.counts ? `; ${["critical", "major", "minor"].map((k) => `${record.review.counts[k] ?? 0} ${k}`).join(", ")}` : ""})` : null],
    ["Risk gate", record.gate ? `${record.gate.decision}${record.gate.rules?.length ? ` (${record.gate.rules.join(", ")})` : ""}` : null],
    ["Decisions traced", record.decisions?.length ?? 0],
    ["Context layers", (record.contextBundle ?? []).map((e) => e.layer).filter((v, i, a) => a.indexOf(v) === i).join(", ") || null],
  ]
  return ["### Factory run record", "", "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), ""].join("\n")
}

export function appendStepSummary(record, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) return false
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${stepSummary(record)}\n`)
  return true
}

// Every *.json under dir, any depth: `gh run download --pattern` puts each
// artifact in its own sub-folder. Files that are not run records are skipped,
// and a record that appears twice (downloaded twice) counts once.
export function readRecords(dir) {
  const found = new Map()
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith(".json")) {
        try {
          const record = JSON.parse(readFileSync(path, "utf8"))
          if (record?.version === RECORD_VERSION && record.runId && OUTCOMES.includes(record.outcome)) found.set(record.runId, record)
        } catch {
          // Not JSON or not ours: ignore it.
        }
      }
    }
  }
  walk(dir)
  return [...found.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
}

function stats(records) {
  const counted = records.filter((r) => r.outcome !== "skipped")
  const passed = counted.filter((r) => SUCCESS.has(r.outcome))
  const opened = records.filter((r) => r.outcome === "pr-opened")
  return {
    runs: counted.length,
    passed: passed.length,
    passRate: counted.length ? Math.round((passed.length / counted.length) * 1000) / 10 : null,
    medianMinutesToPr: median(opened.map((r) => r.minutes)),
    revisions: records.filter((r) => r.outcome === "pr-revised").length,
    checkRetries: counted.filter((r) => r.checkAttempts > 1).length,
    agentMinutes: Math.round(counted.reduce((sum, r) => sum + (Number(r.agentMinutes) || 0), 0) * 10) / 10,
  }
}

function groupBy(records, key) {
  const groups = new Map()
  for (const r of records) {
    const name = r[key] ?? "(none)"
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(r)
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([name, list]) => [name, stats(list)]))
}

export function summarizeRecords(records) {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, records.filter((r) => r.outcome === o).length]))
  const reasons = {}
  for (const r of records) if (r.outcome === "needs-attention" || r.outcome === "error") reasons[r.reason ?? "(none)"] = (reasons[r.reason ?? "(none)"] ?? 0) + 1
  return {
    total: records.length,
    from: records[0]?.startedAt ?? null,
    to: records.at(-1)?.startedAt ?? null,
    ...stats(records),
    outcomes,
    reasons,
    reviews: {
      reviewed: records.filter((r) => r.review).length,
      passed: records.filter((r) => r.review?.decision === "pass").length,
      blocked: records.filter((r) => r.review?.decision === "block").length,
      errors: records.filter((r) => r.review?.decision === "error").length,
    },
    byAgent: groupBy(records.filter((r) => r.outcome !== "skipped"), "agent"),
    byProvider: groupBy(records.filter((r) => r.outcome !== "skipped"), "provider"),
  }
}

const pct = (v) => (v === null ? "—" : `${v}%`)

export function formatReport(summary) {
  if (!summary.total) return "No run records found.\n"
  const table = (title, groups) => [
    `## By ${title}`,
    "",
    `| ${title} | Runs | Passed | Pass rate | Median min to PR | Revisions | Check retries | Agent min |`,
    "|---|---|---|---|---|---|---|---|",
    ...Object.entries(groups).map(([name, s]) => `| ${cell(name)} | ${s.runs} | ${s.passed} | ${pct(s.passRate)} | ${cell(s.medianMinutesToPr)} | ${s.revisions} | ${s.checkRetries} | ${s.agentMinutes} |`),
    "",
  ]
  const reasons = Object.entries(summary.reasons).sort((a, b) => b[1] - a[1])
  return [
    "# Factory report",
    "",
    `${summary.total} run record(s) from ${summary.from?.slice(0, 10)} to ${summary.to?.slice(0, 10)}. ${summary.outcomes.skipped} skipped run(s) are left out of the rates.`,
    "",
    `- Pass rate: ${pct(summary.passRate)} (${summary.passed} of ${summary.runs} runs opened or revised a pull request)`,
    `- Median time to a new pull request: ${summary.medianMinutesToPr === null ? "—" : `${summary.medianMinutesToPr} min`}`,
    `- Rework: ${summary.revisions} revision run(s) after review, ${summary.checkRetries} run(s) needed a second check attempt`,
    `- Agent time: ${summary.agentMinutes} min in total`,
    ...(summary.reviews?.reviewed ? [`- Independent review: ${summary.reviews.reviewed} change(s) reviewed, ${summary.reviews.passed} passed, ${summary.reviews.blocked} blocked, ${summary.reviews.errors} did not complete`] : []),
    "",
    "## Outcomes",
    "",
    ...OUTCOMES.filter((o) => summary.outcomes[o]).map((o) => `- ${o}: ${summary.outcomes[o]}`),
    ...(reasons.length ? ["", "Why runs stopped: " + reasons.map(([r, n]) => `${r} (${n})`).join(", ")] : []),
    "",
    ...table("agent", summary.byAgent),
    ...table("provider", summary.byProvider),
  ].join("\n")
}
