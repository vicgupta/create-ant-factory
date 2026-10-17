// Independent reviewer pass (src/reviewer.mjs): parsing and validating
// review.md, the severity-based block decision, agent choice, config
// validation, and merging with a risk gate. Pure; no worker or network.
// Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "../src/config.mjs"
import { parseReview, validateReviewText, decideReview, reviewGate, mergeGates, pickReviewerAgent, reviewerEnabled, reviewerSettings, reviewerErrors, buildReviewPrompt, renderReview, REVIEWER_DEFAULTS } from "../src/reviewer.mjs"
import { renderGate } from "../src/gates.mjs"
import { createRunRecord, stepSummary, summarizeRecords, formatReport } from "../src/record.mjs"

const baseConfig = (factoryPatch = {}, extra = {}) => ({
  factory: {
    repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
    branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
    allowedActors: ["me"], ...factoryPatch,
  },
  labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
  agents: {
    claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' },
    codex: { boxSettings: [], command: 'codex exec "$(cat {prompt})" --output-last-message {summary}' },
  },
  repos: [{ repo: "me/app", baseBranch: "main", checks: ["npm test"] }],
  workers: [{ id: "claude-01", agent: "claude", enabled: true }, { id: "codex-01", agent: "codex", enabled: true }],
  ...extra,
})
const load = (config) => {
  const file = join(mkdtempSync(join(tmpdir(), "factory-reviewer-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return loadConfig(pathToFileURL(file))
}

const GOOD = `# Review

## Findings
- [critical] src/auth.mjs — the token is logged on every request
- [minor] general — the summary does not mention the new flag
- [major] \`src/db.mjs\` -- the migration is not reversible
`

test("parses findings with severity, location and summary; tolerates dash variants and backticks", () => {
  const r = parseReview(GOOD)
  assert.ok(r.sawTitle && r.sawFindings)
  assert.deepEqual(r.findings, [
    { severity: "critical", location: "src/auth.mjs", summary: "the token is logged on every request" },
    { severity: "minor", location: "general", summary: "the summary does not mention the new flag" },
    { severity: "major", location: "src/db.mjs", summary: "the migration is not reversible" },
  ])
  assert.deepEqual(r.unparsed, [])
})

test("'- none' is a valid empty review", () => {
  const { review, errors } = validateReviewText("# Review\n\n## Findings\n- none\n")
  assert.deepEqual(errors, [])
  assert.equal(review.findings.length, 0)
})

test("invalid reviews are rejected in plain words", () => {
  assert.match(validateReviewText("").errors[0], /no review file/)
  assert.match(validateReviewText("## Findings\n- none\n").errors.join("\n"), /# Review/)
  assert.match(validateReviewText("# Review\n\nLooks good to me!\n").errors.join("\n"), /no "## Findings"/)
  assert.match(validateReviewText("# Review\n\n## Findings\n").errors.join("\n"), /empty/)
  assert.match(validateReviewText("# Review\n\n## Findings\n- this is bad\n").errors.join("\n"), /not in the shape/)
  assert.match(validateReviewText("# Review\n\n## Findings\n- [blocker] a.js — x\n").errors.join("\n"), /not in the shape/, "unknown severity")
  assert.match(validateReviewText("# Review\n\n## Findings\n- none\n- [minor] a.js — x\n").errors.join("\n"), /says "- none" but/)
  assert.match(validateReviewText("# Review\n\n## Findings\n- [minor] ../etc/passwd — x\n").errors.join("\n"), /not a repo-relative path/)
  assert.match(validateReviewText(`# Review\n\n## Findings\n${"- [minor] a.js — x\n".repeat(31)}`).errors.join("\n"), /limit is 30/)
  assert.match(validateReviewText("x".repeat(20001)).errors[0], /limit is 20000/)
})

test("the decision comes only from severities: blockOn and above block", () => {
  const { review } = validateReviewText(GOOD)
  const atCritical = decideReview(review.findings, { blockOn: "critical" })
  assert.equal(atCritical.decision, "block")
  assert.equal(atCritical.blocking.length, 1)
  assert.deepEqual(atCritical.counts, { minor: 1, major: 1, critical: 1 })
  assert.equal(decideReview(review.findings, { blockOn: "major" }).blocking.length, 2)
  assert.equal(decideReview(review.findings, { blockOn: "minor" }).blocking.length, 3)
  assert.equal(decideReview([{ severity: "minor", location: "general", summary: "x" }], { blockOn: "critical" }).decision, "pass")
  assert.equal(decideReview([], REVIEWER_DEFAULTS).decision, "pass")
  // Same inputs, same decision.
  assert.deepEqual(decideReview(review.findings, { blockOn: "critical" }), atCritical)
})

test("auto picks another agent type of an enabled worker, else the same type in a fresh session", () => {
  const config = baseConfig({ reviewer: {} })
  assert.deepEqual(pickReviewerAgent(config, "claude"), { agent: "codex", differentType: true })
  assert.deepEqual(pickReviewerAgent(config, "codex"), { agent: "claude", differentType: true })
  const one = baseConfig({ reviewer: {} }, { workers: [{ id: "claude-01", agent: "claude", enabled: true }, { id: "codex-01", agent: "codex", enabled: false }] })
  assert.deepEqual(pickReviewerAgent(one, "claude"), { agent: "claude", differentType: false })
  assert.deepEqual(pickReviewerAgent(baseConfig({ reviewer: { agent: "codex" } }), "codex", reviewerSettings(baseConfig({ reviewer: { agent: "codex" } }))), { agent: "codex", differentType: false })
})

test("off unless factory.reviewer is an object; enabled:false turns it off; defaults fill in", () => {
  assert.equal(reviewerEnabled(baseConfig()), false)
  assert.equal(reviewerEnabled(baseConfig({ reviewer: {} })), true)
  assert.equal(reviewerEnabled(baseConfig({ reviewer: { enabled: false } })), false)
  assert.deepEqual(reviewerSettings(baseConfig({ reviewer: { blockOn: "major" } })), { ...REVIEWER_DEFAULTS, blockOn: "major" })
})

test("the loader rejects a bad factory.reviewer", () => {
  assert.deepEqual(reviewerErrors(baseConfig()), [])
  assert.deepEqual(reviewerErrors(baseConfig({ reviewer: { agent: "auto", blockOn: "major", timeoutMinutes: 10, onError: "draft", enabled: true } })), [])
  assert.match(reviewerErrors(baseConfig({ reviewer: "yes" }))[0], /must be an object/)
  const errors = reviewerErrors(baseConfig({ reviewer: { agent: "gemini", blockOn: "blocker", timeoutMinutes: 0, onError: "ready", enabled: "y" } })).join("\n")
  for (const re of [/enabled must be true or false/, /agent must be "auto" or one of/, /blockOn must be one of/, /timeoutMinutes must be a positive/, /onError must be one of/]) assert.match(errors, re)
  assert.throws(() => load(baseConfig({ reviewer: { blockOn: "blocker" } })), /factory\.reviewer\.blockOn/)
  assert.doesNotThrow(() => load(baseConfig({ reviewer: { agent: "codex" } })))
})

test("a blocking review parks the issue; an error parks by default or drafts with onError", () => {
  const block = { decision: "block", agent: "codex", blockOn: "critical", blocking: [{ severity: "critical", location: "src/a.js", summary: "x" }] }
  const g = reviewGate(block, REVIEWER_DEFAULTS)
  assert.equal(g.decision, "needs-attention")
  assert.equal(g.reasons[0].rule, "independent-review")
  assert.match(g.reasons[0].why, /critical in `src\/a.js`/)
  assert.deepEqual(reviewGate({ decision: "pass" }), { decision: "ready", reasons: [] })
  assert.equal(reviewGate({ decision: "error", errors: ["timed out"] }, REVIEWER_DEFAULTS).decision, "needs-attention")
  assert.equal(reviewGate({ decision: "error", errors: ["timed out"] }, { ...REVIEWER_DEFAULTS, onError: "draft" }).decision, "draft")
  assert.match(reviewGate({ decision: "error", errors: ["timed out"] }, REVIEWER_DEFAULTS).reasons[0].why, /timed out/)
})

test("merging with a risk gate keeps the strictest decision and every reason", () => {
  const risk = { decision: "draft", reasons: [{ rule: "diff-size", action: "draft", why: "big" }] }
  const rev = { decision: "needs-attention", reasons: [{ rule: "independent-review", action: "needs-attention", why: "critical" }] }
  assert.deepEqual(mergeGates(risk, rev), { decision: "needs-attention", reasons: [...risk.reasons, ...rev.reasons] })
  assert.equal(mergeGates(rev, { decision: "draft", reasons: [] }).decision, "needs-attention")
  assert.deepEqual(mergeGates(null, rev), rev)
  assert.deepEqual(mergeGates(risk, null), risk)
  assert.match(renderGate(mergeGates(null, rev)), /independent-review/)
})

test("the review prompt carries the issue, plan, decision trace, precedents and diff path, never the author's reply", () => {
  const prompt = buildReviewPrompt({
    repo: { repo: "me/app" },
    issue: { number: 7, title: "Add a --dry-run flag", body: "Print what would happen." },
    plan: { files: ["src/cli.mjs"], criteria: [{ text: "flag prints the plan", check: "npm test" }] },
    decisions: [{ stage: "risk-gate", choice: "ready", outcome: "succeeded" }],
    precedents: [{ layer: "reasoning", source: "run 41 (needs-attention)", ref: "#3" }],
    diffPath: "/job/review.diff", reviewPath: "/job/review.md", diffStat: " src/cli.mjs | 4 ++++", blockOn: "major",
  })
  for (const s of ["Issue #7: Add a --dry-run flag", "src/cli.mjs", "flag prints the plan — check: npm test", "risk-gate: ready → succeeded", "run 41 (needs-attention) #3", "/job/review.diff", "/job/review.md", "Change no file", "at major or above"]) assert.ok(prompt.includes(s), s)
  assert.ok(!/summary of what you changed/i.test(prompt))
  const revision = buildReviewPrompt({ repo: { repo: "me/app" }, issue: { number: 7, title: "t" }, diffPath: "d", reviewPath: "r", revising: { number: 12 } })
  assert.match(revision, /revision of pull request #12/)
})

test("rendering says who reviewed, what blocked, and that nobody can waive it", () => {
  const findings = [{ severity: "critical", location: "src/a.js", summary: "leaks the token" }]
  const blocked = renderReview({ decision: "block", agent: "codex", differentType: true, blockOn: "critical", findings, blocking: findings })
  assert.match(blocked, /\*\*Blocked\*\* by the codex reviewer/)
  assert.match(blocked, /\[critical\] `src\/a.js` — leaks the token/)
  assert.match(blocked, /neither agent can waive it/)
  assert.match(renderReview({ decision: "pass", agent: "claude", differentType: false, blockOn: "critical", findings: [], blocking: [] }), /same agent type as the author, fresh session\) reviewer with no findings/)
  assert.match(renderReview({ decision: "error", agent: "codex", differentType: true, errors: ["the reviewer wrote no review file"] }), /did not complete[\s\S]*no review file/)
  assert.equal(renderReview(null), "")
})

test("run records carry the review as counts only, and the report totals it", () => {
  const record = createRunRecord({ repo: "me/app", issue: 7, runId: "1" })
  assert.equal(record.review, null)
  record.review = { agent: "codex", differentType: true, decision: "block", counts: { minor: 0, major: 1, critical: 1 }, minutes: 2 }
  assert.match(stepSummary(record), /Independent review \| block \(codex; 1 critical, 1 major, 0 minor\)/)
  const s = summarizeRecords([
    { ...record, outcome: "needs-attention", reason: "review-blocked", startedAt: "2026-10-17T10:00:00Z" },
    { ...record, runId: "2", review: { ...record.review, decision: "pass" }, outcome: "pr-opened", startedAt: "2026-10-17T11:00:00Z" },
    { ...record, runId: "3", review: null, outcome: "pr-opened", startedAt: "2026-10-17T12:00:00Z" },
  ])
  assert.deepEqual(s.reviews, { reviewed: 2, passed: 1, blocked: 1, errors: 0 })
  assert.match(formatReport(s), /Independent review: 2 change\(s\) reviewed, 1 passed, 1 blocked, 0 did not complete/)
  assert.match(formatReport(s), /review-blocked \(1\)/)
})

test("scripts/review-check.mjs: exit 0 pass, 1 block, 2 invalid", async () => {
  const { spawnSync } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const script = fileURLToPath(new URL("../scripts/review-check.mjs", import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), "factory-review-check-"))
  const write = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p }
  const env = { ...process.env, FACTORY_CONFIG: join(dir, "missing.json") }
  const run = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: "utf8", env })
  const good = write("good.md", GOOD)
  assert.equal(run(good).status, 1)
  assert.equal(run(write("minor.md", "# Review\n\n## Findings\n- [minor] general — nit\n")).status, 0)
  assert.equal(run(write("bad.md", "LGTM")).status, 2)
  const json = JSON.parse(run(good, "--block-on", "major", "--json").stdout)
  assert.equal(json.blocking.length, 2)
  assert.equal(run(good, "--block-on", "blocker").status, 2)
  assert.equal(run().status, 2)
})
