import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  createRunRecord, noteAgentRun, noteChecks, endRun, finishRunRecord, writeRunRecord, readRecords,
  summarizeRecords, formatReport, stepSummary, appendStepSummary, recordsEnabled, recordDir,
} from "../src/record.mjs"
import { loadConfig } from "../src/config.mjs"

const tmp = () => mkdtempSync(join(tmpdir(), "factory-record-"))
const REPORT = fileURLToPath(new URL("../scripts/report.mjs", import.meta.url))

function made(runId, outcome, extra = {}) {
  const start = new Date(extra.start ?? "2026-10-01T10:00:00Z")
  const record = createRunRecord({ repo: "me/app", issue: 7, runId, now: start })
  Object.assign(record, { worker: "claude-01", agent: "claude", provider: "docker", ...extra.fields })
  for (const minutes of extra.agentRuns ?? ["3.0"]) noteAgentRun(record, minutes)
  for (const passed of extra.checks ?? [true]) noteChecks(record, passed)
  endRun(record, outcome, extra.reason ?? null)
  return finishRunRecord(record, new Date(start.getTime() + (extra.minutes ?? 10) * 60000))
}

test("a record counts agent runs, minutes and check attempts", () => {
  const r = made("1", "pr-opened", { agentRuns: ["3.4", "1.2"], checks: [false, true], minutes: 12 })
  assert.equal(r.agentRuns, 2)
  assert.equal(r.agentMinutes, 4.6)
  assert.equal(r.checkAttempts, 2)
  assert.equal(r.checksPassed, true)
  assert.equal(r.minutes, 12)
  assert.equal(r.outcome, "pr-opened")
})

test("the first ending wins, and an unfinished run is an error", () => {
  const r = createRunRecord({ repo: "me/app", issue: 1, runId: "x" })
  endRun(r, "no-worker")
  endRun(r, "error", "exception")
  assert.equal(r.outcome, "no-worker")
  assert.equal(r.reason, null)
  const open = finishRunRecord(createRunRecord({ repo: "me/app", issue: 1, runId: "y" }))
  assert.equal(open.outcome, "error")
  assert.equal(open.reason, "unfinished")
  assert.throws(() => endRun(createRunRecord({ runId: "z" }), "merged"), /Unknown run outcome/)
})

test("records are written per run id and read back from nested artifact folders", () => {
  const dir = tmp()
  const file = writeRunRecord(made("123", "pr-opened"), join(dir, "run-record-123-1"))
  assert.match(file, /run-123\.json$/)
  writeRunRecord(made("124", "needs-attention", { reason: "checks-failed" }), join(dir, "run-record-124-1"))
  // The same record downloaded twice counts once; foreign JSON and junk are ignored.
  writeRunRecord(made("123", "pr-opened"), join(dir, "copy"))
  writeFileSync(join(dir, "package.json"), '{"name":"x"}')
  writeFileSync(join(dir, "broken.json"), "{nope")
  assert.deepEqual(readRecords(dir).map((r) => r.runId), ["123", "124"])
  // Odd characters in a run id cannot escape the folder.
  assert.match(writeRunRecord(made("../evil", "skipped"), dir), /run-\.\._evil\.json$/)
})

test("a record never stores logs or replies, only counts and names", () => {
  const r = made("9", "needs-attention", { reason: "agent-error" })
  assert.deepEqual(Object.keys(r).sort(), [
    "agent", "agentMinutes", "agentRuns", "checkAttempts", "checksPassed", "contextBundle", "decisions", "endedAt", "files", "filesChanged", "gate", "issue", "labels", "minutes",
    "mode", "outcome", "provider", "pullRequest", "reason", "repo", "review", "runId", "runUrl", "startedAt", "title", "version", "worker",
  ])
})

test("the report gives pass rate, median time to PR and rework, per agent and provider", () => {
  const records = [
    made("1", "pr-opened", { minutes: 10, start: "2026-10-01T10:00:00Z" }),
    made("2", "pr-opened", { minutes: 20, checks: [false, true], start: "2026-10-02T10:00:00Z" }),
    made("3", "pr-revised", { minutes: 5, start: "2026-10-03T10:00:00Z", fields: { mode: "revise" } }),
    made("4", "needs-attention", { reason: "checks-failed", checks: [false, false], start: "2026-10-04T10:00:00Z", fields: { agent: "codex", worker: "codex-01", provider: "box" } }),
    made("5", "skipped", { start: "2026-10-05T10:00:00Z", agentRuns: [], checks: [] }),
  ]
  const s = summarizeRecords(records)
  assert.equal(s.total, 5)
  assert.equal(s.runs, 4)
  assert.equal(s.passed, 3)
  assert.equal(s.passRate, 75)
  assert.equal(s.medianMinutesToPr, 15)
  assert.equal(s.revisions, 1)
  assert.equal(s.checkRetries, 2)
  assert.deepEqual(s.reasons, { "checks-failed": 1 })
  assert.equal(s.byAgent.claude.passRate, 100)
  assert.equal(s.byAgent.codex.passRate, 0)
  assert.equal(s.byProvider.box.runs, 1)
  const text = formatReport(s)
  assert.match(text, /Pass rate: 75% \(3 of 4 runs/)
  assert.match(text, /Median time to a new pull request: 15 min/)
  assert.match(text, /\| codex \| 1 \| 0 \| 0% \|/)
  assert.match(text, /checks-failed \(1\)/)
  assert.equal(formatReport(summarizeRecords([])), "No run records found.\n")
})

test("the step summary is a markdown table and is only written inside Actions", () => {
  const r = made("1", "needs-attention", { reason: "no-changes", fields: { title: "Fix | pipes" } })
  const text = stepSummary(r)
  assert.match(text, /\| Outcome \| needs-attention \(no-changes\) \|/)
  assert.match(text, /Fix \\\| pipes/)
  assert.equal(appendStepSummary(r, {}), false)
  const file = join(tmp(), "summary.md")
  assert.equal(appendStepSummary(r, { GITHUB_STEP_SUMMARY: file }), true)
  assert.match(readFileSync(file, "utf8"), /### Factory run record/)
})

test("runRecords is on unless set to false, and must be a boolean", () => {
  const base = {
    factory: {
      repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
      branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" }, allowedActors: ["me"],
    },
    labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
    agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
    repos: [{ repo: "me/app", baseBranch: "main" }],
    workers: [{ id: "claude-01", agent: "claude" }],
  }
  const load = (runRecords) => {
    const file = join(tmp(), "factory.config.json")
    writeFileSync(file, JSON.stringify({ ...base, factory: { ...base.factory, ...(runRecords === undefined ? {} : { runRecords }) } }))
    return loadConfig(file)
  }
  assert.equal(recordsEnabled(load(undefined)), true)
  assert.equal(recordsEnabled(load(true)), true)
  assert.equal(recordsEnabled(load(false)), false)
  assert.throws(() => load("no"), /factory\.runRecords must be true or false/)
  assert.equal(recordDir({}), "runs")
  assert.equal(recordDir({ FACTORY_RUN_RECORD_DIR: "out/records" }), "out/records")
})

test("scripts/report.mjs reads a folder and prints markdown or JSON", () => {
  const dir = tmp()
  writeRunRecord(made("1", "pr-opened"), join(dir, "run-record-1-1"))
  writeRunRecord(made("2", "needs-attention", { reason: "agent-error" }), join(dir, "run-record-2-1"))
  assert.match(execFileSync("node", [REPORT, dir], { encoding: "utf8" }), /Pass rate: 50% \(1 of 2 runs/)
  const json = JSON.parse(execFileSync("node", [REPORT, dir, "--json"], { encoding: "utf8" }))
  assert.equal(json.passRate, 50)
  const out = join(tmp(), "report.md")
  execFileSync("node", [REPORT, "--out", out, dir], { encoding: "utf8" })
  assert.match(readFileSync(out, "utf8"), /# Factory report/)
  assert.throws(() => execFileSync("node", [REPORT, join(dir, "missing")], { stdio: "pipe" }), /gh run download/)
})

test("the workflow uploads the run record even when the run fails", () => {
  const workflow = readFileSync(new URL("../.github/workflows/factory.yml", import.meta.url), "utf8")
  assert.match(workflow, /uses: actions\/upload-artifact@v4/)
  assert.match(workflow, /if: always\(\) && vars\.FACTORY_DRY_RUN != 'true'/)
  assert.match(workflow, /name: run-record-\$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /path: runs\//)
})
