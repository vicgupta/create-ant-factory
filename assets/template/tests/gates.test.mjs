// Risk-based human gates (src/gates.mjs): pure decisions from paths, diff
// size, checks, tier, issue labels/text and failed precedents. No network.
// Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../src/config.mjs"
import { evaluateRiskGate, pathMatches, keywordMatches, parseNumstat, riskGateErrors, riskGatesEnabled, gateSettings, renderGate } from "../src/gates.mjs"

const SCRIPT = fileURLToPath(new URL("../scripts/risk-gate.mjs", import.meta.url))

const baseConfig = (factoryPatch = {}, repoPatch = {}) => ({
  factory: {
    repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
    branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
    allowedActors: ["me"], ...factoryPatch,
  },
  labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
  agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
  repos: [{ repo: "me/app", baseBranch: "main", checks: ["npm test"], ...repoPatch }],
  workers: [{ id: "claude-01", agent: "claude" }],
})
const writeConfig = (config) => {
  const file = join(mkdtempSync(join(tmpdir(), "factory-gates-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return file
}

const RULES = {
  maxFilesForReady: 5,
  maxLinesForReady: 200,
  rules: [
    { name: "migrations", paths: ["**/migrations/**", "*.sql"], action: "needs-attention" },
    { name: "auth", keywords: ["auth", "payment"], action: "draft" },
    { name: "critical", tiers: ["critical"], action: "draft" },
    { name: "hotfix", labels: ["hotfix"], action: "needs-attention" },
  ],
}

test("path patterns: prefix, single-segment *, cross-segment **, exact", () => {
  assert.ok(pathMatches("infra/", "infra/main.tf"))
  assert.ok(!pathMatches("infra/", "src/infra.ts"))
  assert.ok(pathMatches("*.sql", "init.sql"))
  assert.ok(!pathMatches("*.sql", "db/init.sql"))
  assert.ok(pathMatches("**/*.sql", "db/init.sql"))
  assert.ok(pathMatches("**/*.sql", "init.sql"))
  assert.ok(pathMatches("**/migrations/**", "migrations/001.js"))
  assert.ok(pathMatches("**/migrations/**", "packages/db/migrations/001.js"))
  assert.ok(pathMatches("README.md", "./README.md"))
  assert.ok(!pathMatches("README.md", "docs/README.md"))
  assert.ok(!pathMatches("a.b", "aXb"), "dots are literal")
})

test("keywords are whole-word and case-insensitive", () => {
  assert.ok(keywordMatches("auth", "Fix the Auth flow"))
  assert.ok(keywordMatches("auth", "src/auth.ts"))
  assert.ok(!keywordMatches("auth", "credit the author"))
  assert.ok(!keywordMatches("", "anything"))
})

test("numstat parsing counts lines and treats binary files as zero", () => {
  const n = parseNumstat("10\t2\tsrc/a.ts\n-\t-\tlogo.png\n\n3\t0\tREADME.md\n")
  assert.deepEqual(n.files.map((f) => f.path), ["src/a.ts", "logo.png", "README.md"])
  assert.equal(n.added, 13)
  assert.equal(n.removed, 2)
  assert.equal(n.lines, 15)
})

test("a small change with checks and no matching rule is ready", () => {
  const gate = evaluateRiskGate(RULES, { files: ["src/button.tsx"], lines: 12, hasChecks: true, issue: { title: "Make the button blue" } })
  assert.equal(gate.decision, "ready")
  assert.deepEqual(gate.reasons, [])
})

test("each matcher fires, and the strictest action wins", () => {
  assert.equal(evaluateRiskGate(RULES, { files: ["src/login.ts"], issue: { title: "Add payment retry" } }).decision, "draft")
  assert.equal(evaluateRiskGate(RULES, { files: ["src/auth/session.ts"] }).decision, "draft")
  assert.equal(evaluateRiskGate(RULES, { files: ["src/x.ts"], tier: "Critical" }).decision, "draft")
  assert.equal(evaluateRiskGate(RULES, { files: ["src/x.ts"], issue: { labels: ["HotFix"] } }).decision, "needs-attention")
  const both = evaluateRiskGate(RULES, { files: ["db/migrations/002.js", "src/auth.ts"] })
  assert.equal(both.decision, "needs-attention")
  assert.deepEqual(both.reasons.map((r) => r.rule), ["migrations", "auth"])
})

test("diff size limits and missing checks turn a change into a draft", () => {
  assert.equal(evaluateRiskGate(RULES, { files: ["a", "b", "c", "d", "e", "f"], lines: 10 }).decision, "draft")
  assert.equal(evaluateRiskGate(RULES, { files: ["a"], lines: 201 }).decision, "draft")
  assert.equal(evaluateRiskGate(RULES, { files: ["a"], lines: 200 }).decision, "ready")
  assert.equal(evaluateRiskGate(RULES, { files: ["a"], hasChecks: false }).decision, "draft")
  assert.equal(evaluateRiskGate({ ...RULES, noChecks: "ready" }, { files: ["a"], hasChecks: false }).decision, "ready")
})

test("a failed precedent on the same files gates the change; a success does not", () => {
  const failed = [{ runId: "41", outcome: "needs-attention", reason: "checks-failed" }]
  const passed = [{ runId: "40", outcome: "pr-opened" }]
  const gate = evaluateRiskGate(RULES, { files: ["src/a.ts"], precedents: failed })
  assert.equal(gate.decision, "draft")
  assert.match(gate.reasons[0].why, /run 41 \(needs-attention, checks-failed\)/)
  assert.equal(evaluateRiskGate(RULES, { files: ["src/a.ts"], precedents: passed }).decision, "ready")
  assert.equal(evaluateRiskGate({ ...RULES, failedPrecedent: "needs-attention" }, { files: ["src/a.ts"], precedents: failed }).decision, "needs-attention")
})

test("the gate is deterministic: same inputs, same decision and reasons", () => {
  const input = { files: ["db/migrations/1.js", "src/auth.ts", "x", "y", "z", "w"], lines: 999, hasChecks: false, tier: "critical", issue: { title: "auth", labels: ["hotfix"] } }
  assert.deepEqual(evaluateRiskGate(RULES, input), evaluateRiskGate(RULES, input))
})

test("the rendered gate names every rule and says the agent cannot waive it", () => {
  const text = renderGate(evaluateRiskGate(RULES, { files: ["init.sql"] }))
  assert.match(text, /## Risk gate/)
  assert.match(text, /`migrations` → needs-attention/)
  assert.match(text, /cannot waive/)
  assert.equal(renderGate(null), "")
})

test("riskGates is off unless it is an object, and enabled:false turns it off", () => {
  assert.equal(riskGatesEnabled({ factory: {} }), false)
  assert.equal(riskGatesEnabled({ factory: { riskGates: {} } }), true)
  assert.equal(riskGatesEnabled({ factory: { riskGates: { enabled: false } } }), false)
  assert.deepEqual(gateSettings({ factory: { riskGates: { maxLinesForReady: 9 } } }).rules, [])
})

test("the loader rejects malformed gate settings and accepts good ones", () => {
  assert.doesNotThrow(() => loadConfig(writeConfig(baseConfig({ riskGates: RULES }, { tier: "critical" }))))
  const bad = (riskGates) => riskGateErrors({ factory: { riskGates } })
  assert.equal(bad(undefined).length, 0)
  assert.match(bad([]).join(), /must be an object/)
  assert.match(bad({ maxLinesForReady: 0 }).join(), /positive whole number/)
  assert.match(bad({ noChecks: "maybe" }).join(), /noChecks must be one of/)
  assert.match(bad({ rules: [{ name: "x", paths: ["a/"], action: "ready" }] }).join(), /"draft" or "needs-attention"/)
  assert.match(bad({ rules: [{ name: "x", action: "draft" }] }).join(), /at least one of paths/)
  assert.match(bad({ rules: [{ name: "x", paths: [], action: "draft" }] }).join(), /non-empty list/)
  assert.match(bad({ rules: [{ name: "x", paths: ["a"], action: "draft" }, { name: "x", paths: ["b"], action: "draft" }] }).join(), /used twice/)
  assert.throws(() => loadConfig(writeConfig(baseConfig({ riskGates: { rules: [{ name: "x", action: "draft" }] } }))), /riskGates\.rules\[0\]/)
  assert.throws(() => loadConfig(writeConfig(baseConfig({}, { tier: "" }))), /tier must be a non-empty string/)
})

test("the template's riskGates block passes validation", async () => {
  const { readFileSync } = await import("node:fs")
  const template = JSON.parse(readFileSync(new URL("../factory.config.json", import.meta.url), "utf8"))
  assert.deepEqual(riskGateErrors(template), [])
  assert.ok(riskGatesEnabled(template))
})

test("scripts/risk-gate.mjs dry-runs a change with no worker or network", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-script-"))
  const file = writeConfig(baseConfig({ riskGates: RULES }))
  const numstat = join(dir, "numstat")
  writeFileSync(numstat, "4\t1\tdb/migrations/003.js\n2\t0\tsrc/a.ts\n")
  const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: dir, env: { ...process.env, FACTORY_CONFIG: file } })
  const out = JSON.parse(run("me/app", "--numstat", numstat, "--json"))
  assert.equal(out.decision, "needs-attention")
  assert.equal(out.lines, 7)
  assert.equal(out.files, 2)
  assert.match(run("me/app", "--files", "src/ok.ts", "--lines", "3"), /→ ready/)
  const missing = spawnSync(process.execPath, [SCRIPT, "me/app"], { encoding: "utf8", cwd: dir, env: { ...process.env, FACTORY_CONFIG: file } })
  assert.equal(missing.status, 2)
  const unknown = spawnSync(process.execPath, [SCRIPT, "me/other", "--files", "a"], { encoding: "utf8", cwd: dir, env: { ...process.env, FACTORY_CONFIG: file } })
  assert.equal(unknown.status, 2)
})
