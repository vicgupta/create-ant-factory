// Scheduled scan (src/scan.mjs): fingerprint/dedupe, ready label never applied,
// dry-run CLI. No network, no Docker. Run with: npm test
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../src/config.mjs"
import {
  SCAN_DEFAULTS,
  HUMAN_GATE_NOTICE,
  assertSafeCandidateLabels,
  buildCandidateBody,
  candidateIssueLabels,
  findMarkersInText,
  fingerprint,
  forbiddenScanLabels,
  isDuplicateIssue,
  pathAllowed,
  planScan,
  scanRepos,
  scanSettings,
  scheduledScanEnabled,
  scheduledScanErrors,
} from "../src/scan.mjs"

const SCRIPT = fileURLToPath(new URL("../scripts/scheduled-scan.mjs", import.meta.url))

const baseConfig = (factoryPatch = {}) => ({
  factory: {
    repo: "me/factory",
    boxNamePrefix: "factory-",
    boxLabel: "factory",
    busyLabel: "busy",
    branchPrefix: "factory/issue-",
    gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
    allowedActors: ["me"],
    ...factoryPatch,
  },
  labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
  agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
  repos: [{ repo: "me/app", baseBranch: "main", checks: ["npm test"] }],
  workers: [{ id: "claude-01", agent: "claude" }],
})

const writeConfig = (config) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-scan-"))
  const file = join(dir, "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return file
}

test("fingerprint normalizes case, punctuation and whitespace", () => {
  assert.equal(fingerprint("TODO: Fix Auth Flow"), fingerprint("todo fix auth flow"))
  assert.equal(fingerprint("  Hello, World!  "), "hello world")
  assert.equal(fingerprint(""), "")
})

test("open and recently-closed issues count as duplicates; old closed ones do not", () => {
  const now = Date.parse("2026-10-17T12:00:00Z")
  const existing = [
    { number: 1, title: "TODO: Fix Auth Flow", state: "open" },
    { number: 2, title: "FIXME: flaky test", state: "closed", closedAt: "2026-10-01T00:00:00Z" },
    { number: 3, title: "HACK: old thing", state: "closed", closedAt: "2025-01-01T00:00:00Z" },
  ]
  assert.equal(isDuplicateIssue(existing, { title: "todo: fix auth flow" }, { now }).duplicate, true)
  assert.equal(isDuplicateIssue(existing, { title: "FIXME: flaky test" }, { skipClosedDays: 30, now }).reason, "recently-closed")
  assert.equal(isDuplicateIssue(existing, { title: "HACK: old thing" }, { skipClosedDays: 30, now }).duplicate, false)
  assert.equal(isDuplicateIssue(existing, { title: "HACK: old thing" }, { skipClosedDays: 0, now }).duplicate, true)
  assert.equal(isDuplicateIssue(existing, { title: "brand new" }, { now }).duplicate, false)
})

test("planScan skips duplicates and caps at maxPerRun", () => {
  const existing = [{ number: 9, title: "TODO: already open", state: "open" }]
  const candidates = [
    { title: "TODO: already open", body: "a" },
    { title: "TODO: first new", body: "b" },
    { title: "TODO: first new", body: "same title again" },
    { title: "TODO: second new", body: "c" },
    { title: "TODO: third new", body: "d" },
    { title: "  ", body: "empty" },
  ]
  const plan = planScan(candidates, existing, { maxPerRun: 2, now: Date.now() })
  assert.deepEqual(plan.create.map((c) => c.title), ["TODO: first new", "TODO: second new"])
  assert.equal(plan.skip.find((s) => s.reason === "open").candidate.title, "TODO: already open")
  assert.equal(plan.skip.find((s) => s.reason === "duplicate-in-batch").candidate.title, "TODO: first new")
  assert.equal(plan.skip.find((s) => s.reason === "max-per-run").candidate.title, "TODO: third new")
  assert.equal(plan.skip.find((s) => s.reason === "empty-title").reason, "empty-title")
})

test("candidate labels never include ready or other factory status labels", () => {
  const config = baseConfig({ scheduledScan: { enabled: true, candidateLabel: "factory:candidate" } })
  assert.deepEqual(forbiddenScanLabels(config).sort(), ["factory:needs-attention", "factory:review", "factory:running", "ready"].sort())
  assert.deepEqual(candidateIssueLabels(config, ["ready", "factory:running", "priority", "READY"]), ["factory:candidate", "priority"])
  assert.throws(() => candidateIssueLabels(baseConfig({ scheduledScan: { candidateLabel: "ready" } })), /collides with a factory status label/)
  assert.throws(() => assertSafeCandidateLabels(config, ["factory:candidate", "ready"]), /never apply ready/)
  assert.deepEqual(assertSafeCandidateLabels(config, ["factory:candidate", "docs"]), ["factory:candidate", "docs"])
})

test("candidate issue body always states the human gate and never implies auto-start", () => {
  const body = buildCandidateBody({ body: "Do the thing.", repo: "me/app", path: "src/a.ts", line: 12, marker: "TODO", source: "marker-scan" })
  assert.match(body, /Do the thing/)
  assert.match(body, /Human gate/)
  assert.match(body, /never applies the ready label/)
  assert.match(body, /src\/a\.ts:12/)
  assert.match(body, /software-factory-scan/)
  assert.ok(HUMAN_GATE_NOTICE.includes("ready"))
  assert.ok(!/apply the ready label yourself to start/i.test(body) || /person applies the \*\*ready\*\* label/.test(body))
})

test("marker scan finds TODO/FIXME lines and ignores noise", () => {
  const text = [
    "// TODO: wire up retries",
    "const x = 1 // not a marker",
    "/* FIXME: flaky on CI */",
    "// TODO:",
    "// software-factory-scan",
    "# XXX: document the flag",
  ].join("\n")
  const hits = findMarkersInText(text, { path: "src/x.ts", markers: ["TODO", "FIXME", "XXX"] })
  assert.equal(hits.length, 3)
  assert.equal(hits[0].marker, "TODO")
  assert.match(hits[0].title, /wire up retries/)
  assert.equal(hits[0].line, 1)
  assert.equal(hits[1].marker, "FIXME")
  assert.equal(hits[2].marker, "XXX")
})

test("path allowlist uses the same matcher as risk gates", () => {
  assert.ok(pathAllowed("src/a.ts", ["src/"]))
  assert.ok(!pathAllowed("docs/a.md", ["src/"]))
  assert.ok(pathAllowed("anywhere.ts", []))
})

test("scheduledScan config: off by default, validated, template loads", () => {
  assert.equal(scheduledScanEnabled(baseConfig()), false)
  assert.equal(scheduledScanEnabled(baseConfig({ scheduledScan: { enabled: false } })), false)
  assert.equal(scheduledScanEnabled(baseConfig({ scheduledScan: { enabled: true } })), true)
  assert.equal(scheduledScanEnabled(baseConfig({ scheduledScan: {} })), true)
  assert.deepEqual(scheduledScanErrors(baseConfig()), [])
  assert.match(scheduledScanErrors(baseConfig({ scheduledScan: "nope" }))[0], /must be an object/)
  assert.match(scheduledScanErrors(baseConfig({ scheduledScan: { candidateLabel: "ready" } }))[0], /must not be the same as labels\.ready/)
  assert.match(scheduledScanErrors(baseConfig({ scheduledScan: { maxPerRun: 0 } }))[0], /maxPerRun/)
  assert.match(scheduledScanErrors(baseConfig({ scheduledScan: { repos: ["other/x"] } }))[0], /not in "repos"/)
  assert.deepEqual(scanRepos(baseConfig({ scheduledScan: { enabled: true } })), ["me/app"])
  assert.deepEqual(scanRepos(baseConfig({ scheduledScan: { repos: ["me/app"] } })), ["me/app"])

  const file = writeConfig(baseConfig({ scheduledScan: { enabled: true, candidateLabel: "factory:candidate", maxPerRun: 5 } }))
  const loaded = loadConfig(file)
  assert.equal(loaded.factory.scheduledScan.enabled, true)
  assert.equal(scanSettings(loaded).maxPerRun, 5)
  assert.equal(scanSettings(loaded).candidateLabel, "factory:candidate")

  assert.throws(
    () => loadConfig(writeConfig(baseConfig({ scheduledScan: { candidateLabel: "ready" } }))),
    /candidateLabel/,
  )
})

test("scripts/scheduled-scan.mjs dry-run never creates issues and never applies ready", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-scan-cli-"))
  const src = join(dir, "src")
  mkdirSync(src)
  writeFileSync(join(src, "todo.ts"), "// TODO: add caching layer\nexport const x = 1\n")
  const config = baseConfig({
    scheduledScan: {
      enabled: true,
      candidateLabel: "factory:candidate",
      paths: ["src/"],
      markers: ["TODO"],
      maxPerRun: 5,
      skipClosedDays: 30,
    },
  })
  const configFile = join(dir, "factory.config.json")
  writeFileSync(configFile, JSON.stringify(config))

  const existing = {
    "me/app": [{ number: 3, title: "TODO: add caching layer", state: "open" }],
  }
  const env = {
    ...process.env,
    FACTORY_CONFIG: configFile,
    FACTORY_SCAN_ISSUES_JSON: JSON.stringify(existing),
  }

  // Duplicate of the open issue → skip, dry-run.
  const dup = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--json"], { encoding: "utf8", env })
  assert.equal(dup.status, 0, dup.stderr)
  const dupOut = JSON.parse(dup.stdout)
  assert.equal(dupOut.dryRun, true)
  assert.equal(dupOut.created.length, 0)
  assert.ok(dupOut.skipped.some((s) => s.reason === "open"))

  // New marker → would-create with candidate label only.
  writeFileSync(join(src, "other.ts"), "// TODO: brand new work item here\n")
  const fresh = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--json"], { encoding: "utf8", env })
  assert.equal(fresh.status, 0, fresh.stderr)
  const freshOut = JSON.parse(fresh.stdout)
  assert.equal(freshOut.dryRun, true)
  assert.ok(freshOut.created.length >= 1)
  for (const c of freshOut.created) {
    assert.ok(c.labels.includes("factory:candidate"))
    assert.ok(!c.labels.map((l) => l.toLowerCase()).includes("ready"))
    assert.equal(c.action, "would-create")
  }

  // --yes with FACTORY_SCAN_DRY_CREATE still never sends ready.
  const createEnv = { ...env, FACTORY_SCAN_DRY_CREATE: "1", FACTORY_SCAN_ISSUES_JSON: JSON.stringify({ "me/app": [] }) }
  const created = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--yes", "--json"], { encoding: "utf8", env: createEnv })
  assert.equal(created.status, 0, created.stderr)
  const createdOut = JSON.parse(created.stdout)
  assert.equal(createdOut.dryRun, false)
  assert.ok(createdOut.created.length >= 1)
  for (const c of createdOut.created) {
    assert.deepEqual(c.labels.filter((l) => l.toLowerCase() === "ready"), [])
    assert.ok(c.labels.includes("factory:candidate"))
  }

  // Disabled without --force exits cleanly and creates nothing.
  writeFileSync(configFile, JSON.stringify(baseConfig({ scheduledScan: { enabled: false } })))
  const off = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--json"], { encoding: "utf8", env })
  assert.equal(off.status, 0, off.stderr)
  assert.match(off.stdout, /disabled|"ok": false/)
})

test("candidates JSON path: dry-run plans creates without walking the tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-scan-json-"))
  const configFile = join(dir, "factory.config.json")
  writeFileSync(
    configFile,
    JSON.stringify(
      baseConfig({
        scheduledScan: { enabled: true, candidateLabel: "factory:candidate", paths: ["src/"], maxPerRun: 10 },
      }),
    ),
  )
  const candidates = join(dir, "candidates.json")
  writeFileSync(
    candidates,
    JSON.stringify([
      { repo: "me/app", title: "Tighten rate limits", body: "From the backlog.", labels: ["ready", "backlog"] },
      { repo: "me/app", title: "Tighten rate limits", body: "duplicate title" },
    ]),
  )
  const env = {
    ...process.env,
    FACTORY_CONFIG: configFile,
    FACTORY_SCAN_ISSUES_JSON: JSON.stringify({ "me/app": [] }),
  }
  const result = spawnSync(process.execPath, [SCRIPT, "--candidates", candidates, "--json"], { encoding: "utf8", env })
  assert.equal(result.status, 0, result.stderr)
  const out = JSON.parse(result.stdout)
  assert.equal(out.created.length, 1)
  assert.deepEqual(out.created[0].labels, ["factory:candidate", "backlog"])
  assert.ok(!out.created[0].labels.includes("ready"), "ready must be stripped from candidates JSON labels")
  assert.ok(out.skipped.some((s) => s.reason === "duplicate-in-batch"))
  assert.equal(out.created[0].title, "Tighten rate limits")
})
