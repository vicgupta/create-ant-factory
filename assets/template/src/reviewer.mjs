// Independent reviewer pass. After the implementation agent's change has
// passed the checks and is staged, and before the pull request is opened (or
// a revision is pushed), a second agent session reviews the staged diff
// against the issue, the validated plan, and the decision trace and
// precedents the run used. It changes no file: it writes review.md in the
// job folder, and the factory turns that file into a decision.
//
// The reviewer is "independent" in two ways:
//   - it is a fresh agent session that never saw the implementation prompt
//     or the implementation agent's reply, only the diff and the inputs;
//   - by default ("agent": "auto") it is a different agent type from the
//     worker that wrote the change, when the factory has one.
//
// The decision is computed by the factory from the findings' severities,
// not from anything the reviewer says about itself: a finding at or above
// factory.reviewer.blockOn blocks, so the pull request opens as a draft and
// the issue is parked at factory:needs-attention for a person. A reviewer
// that errors, times out, writes no review or edits the repo also parks the
// issue by default (onError), so a broken reviewer never waves a change
// through.
//
// review.md has this line-based shape, so validation is a pure function:
//
//   # Review
//
//   ## Findings
//   - [critical] src/auth.mjs — the token is logged on every request
//   - [minor] general — the summary does not mention the new flag
//
// "- none" under Findings means no findings. Severities are critical, major
// and minor; the location is a repo-relative path or "general".
//
// Off unless factory.reviewer is an object (and "enabled" is not false).
import { stricter } from "./gates.mjs"

export const REVIEW_FILE = "review.md"
export const DIFF_FILE = "review.diff"
export const SEVERITIES = ["minor", "major", "critical"]
export const ON_ERROR_ACTIONS = ["needs-attention", "draft"]
export const REVIEWER_DEFAULTS = { agent: "auto", blockOn: "critical", timeoutMinutes: 15, onError: "needs-attention" }
export const MAX_REVIEW_CHARS = 20000
export const MAX_FINDINGS = 30
export const MAX_DIFF_CHARS = 60000
const rank = (severity) => SEVERITIES.indexOf(severity)

export const reviewerEnabled = (config) => {
  const r = config?.factory?.reviewer
  return Boolean(r) && typeof r === "object" && !Array.isArray(r) && r.enabled !== false
}

export function reviewerSettings(config) {
  const r = config?.factory?.reviewer
  return { ...REVIEWER_DEFAULTS, ...(r && typeof r === "object" && !Array.isArray(r) ? r : {}) }
}

// Config errors for factory.reviewer, in the loader's message style.
export function reviewerErrors(config) {
  const r = config?.factory?.reviewer
  if (r === undefined) return []
  if (!r || typeof r !== "object" || Array.isArray(r)) return ['factory.reviewer must be an object like { "agent": "auto", "blockOn": "critical" }']
  const errors = []
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") errors.push("factory.reviewer.enabled must be true or false")
  if (r.agent !== undefined && r.agent !== "auto" && !(typeof r.agent === "string" && config?.agents?.[r.agent])) {
    errors.push(`factory.reviewer.agent must be "auto" or one of the agent types in "agents" (${Object.keys(config?.agents ?? {}).join(", ") || "none"})`)
  }
  if (r.blockOn !== undefined && !SEVERITIES.includes(r.blockOn)) errors.push(`factory.reviewer.blockOn must be one of: ${SEVERITIES.join(", ")}`)
  if (r.timeoutMinutes !== undefined && !(Number.isInteger(r.timeoutMinutes) && r.timeoutMinutes > 0)) errors.push("factory.reviewer.timeoutMinutes must be a positive whole number")
  if (r.onError !== undefined && !ON_ERROR_ACTIONS.includes(r.onError)) errors.push(`factory.reviewer.onError must be one of: ${ON_ERROR_ACTIONS.join(", ")}`)
  return errors
}

// Which agent type reviews. An explicit agent always wins. "auto" picks the
// first agent type of an enabled worker that differs from the one that wrote
// the change; with only one agent type in use, the same type reviews in a
// fresh session, and the result says so.
export function pickReviewerAgent(config, workerAgent, settings = reviewerSettings(config)) {
  if (settings.agent && settings.agent !== "auto") return { agent: settings.agent, differentType: settings.agent !== workerAgent }
  const used = [...new Set((config?.workers ?? []).filter((w) => w.enabled !== false).map((w) => w.agent))]
  const other = used.find((a) => a !== workerAgent && config?.agents?.[a])
  return other ? { agent: other, differentType: true } : { agent: workerAgent, differentType: false }
}

const isSafeLocation = (loc) =>
  loc === "general" ||
  (typeof loc === "string" && loc.length > 0 && !loc.startsWith("/") && !loc.includes("\\") && !loc.split("/").includes("..") && !/\s/.test(loc))

const FINDING = /^-\s*\[(critical|major|minor)\]\s+(\S+)\s+(?:—|–|--|-)\s+(.+)$/i

export function parseReview(text = "") {
  const lines = String(text ?? "").replaceAll("\r\n", "\n").split("\n")
  let section = null
  let sawTitle = false
  let sawFindings = false
  let none = false
  const findings = []
  const unparsed = []
  for (const raw of lines) {
    const line = raw.trim()
    if (/^#\s+review\b/i.test(line)) { sawTitle = true; continue }
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      section = heading[1].trim().toLowerCase()
      if (section === "findings") sawFindings = true
      continue
    }
    if (section !== "findings" || !line.startsWith("-")) continue
    if (/^-\s*none\.?$/i.test(line)) { none = true; continue }
    const m = FINDING.exec(line)
    if (!m) { unparsed.push(line); continue }
    findings.push({ severity: m[1].toLowerCase(), location: m[2].replace(/^`|`$/g, "").replace(/^\.\//, ""), summary: m[3].trim() })
  }
  return { sawTitle, sawFindings, none, findings, unparsed }
}

// Everything wrong with review.md, in plain words. Empty means the factory
// may decide from it.
export function validateReviewText(text) {
  const raw = String(text ?? "")
  if (!raw.trim()) return { review: parseReview(""), errors: ["the reviewer wrote no review file"] }
  if (raw.length > MAX_REVIEW_CHARS) return { review: parseReview(raw), errors: [`the review is ${raw.length} characters; the limit is ${MAX_REVIEW_CHARS}`] }
  const review = parseReview(raw)
  const errors = []
  if (!review.sawTitle) errors.push('the review does not start with "# Review"')
  if (!review.sawFindings) errors.push('the review has no "## Findings" section')
  else if (!review.findings.length && !review.none && !review.unparsed.length) errors.push('the Findings section is empty (write "- none" when there is nothing to report)')
  if (review.none && review.findings.length) errors.push('the Findings section says "- none" but also lists findings')
  for (const line of review.unparsed.slice(0, 5)) errors.push(`this finding is not in the shape "- [critical|major|minor] <path or general> — <what is wrong>": ${line.slice(0, 200)}`)
  if (review.findings.length > MAX_FINDINGS) errors.push(`the review lists ${review.findings.length} findings; the limit is ${MAX_FINDINGS}`)
  for (const f of review.findings) if (!isSafeLocation(f.location)) errors.push(`finding location "${f.location}" is not a repo-relative path or "general"`)
  return { review, errors }
}

// The decision. Pure: findings at or above blockOn block, nothing else does.
export function decideReview(findings = [], settings = REVIEWER_DEFAULTS) {
  const blockOn = SEVERITIES.includes(settings?.blockOn) ? settings.blockOn : REVIEWER_DEFAULTS.blockOn
  const blocking = findings.filter((f) => rank(f.severity) >= rank(blockOn))
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]))
  return { decision: blocking.length ? "block" : "pass", blocking, counts, blockOn }
}

// The review as a gate in the shape src/gates.mjs uses, so it merges with a
// risk gate (strictest wins) and reuses the draft / needs-attention path.
//   outcome  { decision: "pass" | "block" | "error", blocking, agent, errors }
export function reviewGate(outcome, settings = REVIEWER_DEFAULTS) {
  if (!outcome) return null
  if (outcome.decision === "pass") return { decision: "ready", reasons: [] }
  if (outcome.decision === "block") {
    const n = outcome.blocking.length
    return { decision: "needs-attention", reasons: [{ rule: "independent-review", action: "needs-attention", why: `the ${outcome.agent} reviewer reported ${n} finding(s) at or above ${outcome.blockOn ?? settings.blockOn}: ${outcome.blocking.slice(0, 3).map((f) => `${f.severity} in \`${f.location}\``).join(", ")}` }] }
  }
  const action = ON_ERROR_ACTIONS.includes(settings.onError) ? settings.onError : REVIEWER_DEFAULTS.onError
  return { decision: action, reasons: [{ rule: "independent-review", action, why: `the review did not complete (${(outcome.errors ?? ["unknown error"]).slice(0, 2).join("; ")}), so it cannot vouch for the change` }] }
}

// Strictest of two gates; either may be null.
export function mergeGates(a, b) {
  if (!a) return b ?? null
  if (!b) return a
  return { decision: stricter(a.decision, b.decision), reasons: [...a.reasons, ...b.reasons] }
}

// The reviewer's prompt. It sees the issue, the plan, the decision trace
// and the precedents used, and the staged diff in a file. It never sees the
// implementation agent's reply, so the author cannot argue its own case.
export function buildReviewPrompt({ repo, issue, plan = null, decisions = [], precedents = [], diffPath, reviewPath, diffStat = "", revising = null, blockOn = "critical" }) {
  const planLines = plan?.files?.length
    ? ["", "# The validated plan the change was built from", "", "Files to touch:", ...plan.files.map((f) => `- ${f}`), "", "Acceptance criteria:", ...plan.criteria.map((c) => `- ${c.text} — check: ${c.check}`)]
    : []
  const trace = decisions.length
    ? ["", "# Decisions this run traced (stage: choice → outcome)", "", ...decisions.slice(0, 20).map((d) => `- ${d.stage}: ${d.choice} → ${d.outcome}`)]
    : []
  const prior = precedents.length
    ? ["", "# Past runs the factory showed the author (precedents)", "", "Check that the change does not repeat a mistake from a failed, rejected or reverted run.", ...precedents.slice(0, 3).map((p) => `- ${p.source}${p.ref ? ` ${p.ref}` : ""}`)]
    : []
  return `You are an independent code reviewer for the repository ${repo.repo}, checked out in the current folder. Another agent wrote the staged change; you did not. Review it. Do not fix it.

# Issue #${issue.number}: ${issue.title}

${issue.body?.trim() || "(The issue has no description.)"}
${planLines.join("\n")}${trace.join("\n")}${prior.join("\n")}

# The change

${revising ? `This is a revision of pull request #${revising.number}: the diff holds only the new commits' changes on top of the reviewed branch.` : "The diff is the whole change against the base branch."} It is staged in the repository (see git diff --cached) and also saved at:
    ${diffPath}
${diffStat ? `\nFiles and line counts:\n${diffStat.trim().split("\n").slice(0, 40).map((l) => `    ${l}`).join("\n")}\n` : ""}
The repo's checks already passed, so do not report style nits a linter would catch. Look for: the change not doing what the issue asks, criteria in the plan that are not met, bugs, security problems (secrets, injection, auth), data loss, and changes outside what the issue needs.

# Your output

Write a review file at exactly this path: ${reviewPath}

Change no file in the repository and do not run git commit, git push, git reset, git checkout or git stash. Any repository change makes the review count as failed.

The file must use exactly this shape:

    # Review

    ## Findings
    - [critical] path/from/repo/root — what is wrong and why it matters
    - [minor] general — something that is not tied to one file

Severities: critical (must not merge: wrong behaviour, security, data loss, the issue is not solved), major (should be fixed before merge), minor (worth a note). Write "- none" under Findings when you have nothing to report. Findings at ${blockOn} or above stop the pull request for a person, so do not inflate or soften severities.

Reply with one short line when the review file is written.
`
}

// Markdown for the pull request body and issue comment.
export function renderReview(outcome) {
  if (!outcome) return ""
  const who = `${outcome.agent}${outcome.differentType ? "" : " (same agent type as the author, fresh session)"}`
  if (outcome.decision === "error") {
    return ["## Independent review", "", `The ${who} reviewer did not complete, so this change was not independently reviewed:`, "", ...(outcome.errors ?? []).slice(0, 5).map((e) => `- ${e}`)].join("\n")
  }
  const head = outcome.decision === "block"
    ? `**Blocked** by the ${who} reviewer: ${outcome.blocking.length} finding(s) at or above \`${outcome.blockOn}\`. A person decides whether this goes further.`
    : outcome.findings.length
      ? `Passed by the ${who} reviewer: no finding at or above \`${outcome.blockOn}\`.`
      : `Passed by the ${who} reviewer with no findings.`
  const list = outcome.findings.slice(0, MAX_FINDINGS).map((f) => `- [${f.severity}] \`${f.location}\` — ${f.summary}`)
  return ["## Independent review", "", head, ...(list.length ? ["", ...list] : []), "", "The block decision is computed by the factory from the findings' severities; neither agent can waive it."].join("\n")
}
