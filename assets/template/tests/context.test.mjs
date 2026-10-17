// Context Graph: decisions[] trace validation, precedents index + exact
// label/path retrieval (failed precedents included), the three-layer
// bundle, provenance staleness, and the config switch. Pure logic.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createRunRecord, noteDecision, validateDecision, writeRunRecord } from "../src/record.mjs"
import {
  contextGraphEnabled, buildPrecedentsIndex, findPrecedents, buildContextBundle,
  parseStampedFacts, formatStampedFact, verifyProvenance, staleFactsSection, MAX_PRECEDENTS,
} from "../src/context.mjs"
import { parsePlan, validatePlan } from "../src/plan-first.mjs"
import { loadConfig } from "../src/config.mjs"

const SCRIPT = fileURLToPath(new URL("../scripts/precedents.mjs", import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), "factory-context-"))

function record(runId, outcome, extra = {}) {
  const r = createRunRecord({ repo: "me/app", issue: extra.issue ?? 1, runId, now: new Date(extra.start ?? "2026-10-01T10:00:00Z") })
  Object.assign(r, { outcome, labels: extra.labels ?? [], files: extra.files ?? [], decisions: extra.decisions ?? [] })
  return r
}
const decision = (over = {}) => ({ stage: "implementation", choice: "used a helper", evidence: ["src/a.mjs"], policy_or_label: "bug", outcome: "succeeded", ...over })

test("a decision trace requires stage, choice, evidence, policy/label and a known outcome", () => {
  assert.deepEqual(validateDecision(decision()), [])
  assert.deepEqual(validateDecision(decision({ alternatives_rejected: ["copy-paste"], human_actor: "vic" })), [])
  for (const bad of [
    decision({ stage: "" }), decision({ choice: " " }), decision({ evidence: [] }),
    decision({ evidence: [""] }), decision({ evidence: "src/a.mjs" }),
    decision({ policy_or_label: "" }), decision({ outcome: "merged" }),
    decision({ alternatives_rejected: "nope" }), decision({ human_actor: "" }),
  ]) assert.ok(validateDecision(bad).length, JSON.stringify(bad))
  const r = createRunRecord({ runId: "1" })
  noteDecision(r, decision({ alternatives_rejected: ["copy-paste"] }))
  assert.equal(r.decisions[0].choice, "used a helper")
  assert.throws(() => noteDecision(r, decision({ outcome: "merged" })), /Invalid run-record decision/)
})

test("the precedents index is keyed by labels (incl. decision policies) and touched paths", () => {
  const index = buildPrecedentsIndex([
    record("1", "pr-opened", { labels: ["bug"], files: ["src/a.mjs"], decisions: [decision()] }),
    record("2", "needs-attention", { labels: ["feature"], files: ["src/b.mjs"] }),
  ])
  assert.equal(index.version, 1)
  assert.deepEqual(index.byLabel.bug, ["1"])
  assert.deepEqual(index.byPath["src/a.mjs"], ["1"])
  assert.deepEqual(index.byPath["src/b.mjs"], ["2"])
})

test("retrieval is exact label/path, top 3, and failed/rejected precedents are included and win ties", () => {
  const records = [
    record("old-ok", "pr-opened", { labels: ["bug"], files: ["src/a.mjs"], start: "2026-09-01T10:00:00Z" }),
    record("failed", "needs-attention", { labels: ["bug"], files: ["src/a.mjs"], start: "2026-09-01T10:00:00Z", decisions: [decision({ choice: "patched blindly", outcome: "failed", alternatives_rejected: ["read the stack trace"] })] }),
    record("label-only", "error", { labels: ["bug"], files: ["src/other.mjs"], start: "2026-10-01T10:00:00Z" }),
    record("unrelated", "pr-opened", { labels: ["docs"], files: ["README.md"] }),
    record("fourth", "pr-opened", { labels: ["bug"], files: ["src/a.mjs"], start: "2026-08-01T10:00:00Z" }),
  ]
  const found = findPrecedents(records, { labels: ["BUG"], files: ["src/a.mjs"] })
  assert.equal(found.length, MAX_PRECEDENTS)
  assert.equal(found[0].runId, "failed") // same score/date as old-ok, failure wins the tie
  assert.ok(!found.some((p) => p.runId === "label-only")) // label-only ranks below the three path+label matches
  assert.equal(findPrecedents(records, { labels: ["bug"] }).some((p) => p.runId === "label-only"), true) // an errored run still counts
  assert.ok(!found.some((p) => p.runId === "unrelated"))
  assert.equal(found[0].matchedFiles[0], "src/a.mjs")
  // No shared label or path means no precedent, however recent.
  assert.deepEqual(findPrecedents(records, { labels: ["nope"], files: ["nope.mjs"] }), [])
  assert.deepEqual(findPrecedents(records, {}), [])
  // The built index retrieves the same way as raw records.
  assert.equal(findPrecedents(buildPrecedentsIndex(records), { files: ["src/b.mjs"] }).length, 0)
})

test("the bundle names its three layers and logs which layer each item came from", () => {
  const precedents = findPrecedents([record("9", "needs-attention", { labels: ["bug"], files: ["src/a.mjs"], decisions: [decision({ outcome: "failed" })] })], { labels: ["bug"] })
  const bundle = buildContextBundle({
    issue: { number: 7, title: "Fix it" }, comments: [{ author: "vic", body: "hi" }],
    repo: "me/app", repoFacts: { baseBranch: "main", checks: ["npm test"], houseRules: ["AGENTS.md"], fileMap: ["src/a.mjs"] }, precedents,
  })
  assert.match(bundle.text, /## Short-term/)
  assert.match(bundle.text, /## Long-term/)
  assert.match(bundle.text, /## Reasoning/)
  assert.match(bundle.text, /FAILED\/REJECTED/)
  assert.match(bundle.text, /Decision \(implementation\): used a helper/)
  assert.deepEqual([...new Set(bundle.layers.map((l) => l.layer))], ["short-term", "long-term", "reasoning"])
  assert.equal(bundle.layers.find((l) => l.layer === "reasoning").source, "run 9 (needs-attention)")
})

test("provenance stamps parse, verify fresh, and flag moved bases and missing sources as stale", () => {
  const line = formatStampedFact("the helper lives in src/a.mjs", { source: "src/a.mjs", baseCommit: "abc1234", runId: "42", observedAt: "2026-10-17" })
  const facts = parseStampedFacts(line)
  assert.deepEqual(facts, [{ text: "the helper lives in src/a.mjs", source: "src/a.mjs", baseCommit: "abc1234", runId: "42", observedAt: "2026-10-17" }])
  // A short stamped SHA matches the full current SHA.
  assert.equal(verifyProvenance(facts, { currentBaseCommit: "abc1234deadbeef", existingSources: ["src/a.mjs"] }).stale.length, 0)
  const stale = verifyProvenance(facts, { currentBaseCommit: "fff0000", existingSources: ["src/b.mjs"] })
  assert.equal(stale.stale.length, 1)
  assert.match(stale.stale[0].reasons.join(" "), /no longer exists/)
  assert.match(stale.stale[0].reasons.join(" "), /base moved/)
  assert.match(staleFactsSection(stale), /Stale facts flagged before coding/)
  assert.equal(staleFactsSection({ stale: [] }), "")
})

test("plan.md facts must carry a complete stamp when present, and stay optional when absent", () => {
  const withFacts = parsePlan(`# Plan\n\n## Files to touch\n- src/a.mjs\n\n## Acceptance criteria\n- [ ] Works — check: npm test\n\n## Facts\n- the helper is here — source: src/a.mjs; base: abc1234; run: 42\n`)
  assert.equal(withFacts.facts[0].source, "src/a.mjs")
  assert.deepEqual(validatePlan(withFacts, { checks: ["npm test"] }), [])
  const bad = parsePlan(`# Plan\n\n## Files to touch\n- src/a.mjs\n\n## Acceptance criteria\n- [ ] Works — check: npm test\n\n## Facts\n- an unstamped claim\n`)
  assert.match(validatePlan(bad, { checks: ["npm test"] }).join(" "), /no source stamp/)
  const none = parsePlan(`# Plan\n\n## Files to touch\n- src/a.mjs\n\n## Acceptance criteria\n- [ ] Works — check: npm test\n`)
  assert.deepEqual(validatePlan(none, { checks: ["npm test"] }), [])
})

function configWith(patch) {
  const config = {
    factory: { repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy", branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" }, allowedActors: ["me"], ...patch },
    labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
    agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
    repos: [{ repo: "me/app", baseBranch: "main" }],
    workers: [{ id: "claude-01", agent: "claude" }],
  }
  const file = join(tmp(), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return () => loadConfig(file)
}

test("contextGraph is opt-in, must be a boolean, and precedentsFile must be a name", () => {
  assert.equal(contextGraphEnabled(configWith({})()), false)
  assert.equal(contextGraphEnabled(configWith({ contextGraph: true })()), true)
  assert.throws(configWith({ contextGraph: "yes" }), /factory\.contextGraph must be true or false/)
  assert.throws(configWith({ precedentsFile: "" }), /factory\.precedentsFile must be a non-empty/)
  assert.equal(configWith({ contextGraph: true, precedentsFile: "precedents.json" })().factory.contextGraph, true)
})

test("scripts/precedents.mjs builds a committed index from a folder of records", () => {
  const dir = tmp()
  const r = record("7", "needs-attention", { labels: ["bug"], files: ["src/a.mjs"] })
  writeRunRecord(r, dir)
  const out = join(tmp(), "precedents.json")
  execFileSync("node", [SCRIPT, dir, "--out", out], { encoding: "utf8" })
  const index = JSON.parse(readFileSync(out, "utf8"))
  assert.deepEqual(index.byPath["src/a.mjs"], ["7"])
  assert.equal(findPrecedents(index, { labels: ["bug"] })[0].outcome, "needs-attention")
})
