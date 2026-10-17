// Config validation: the branch and Box name prefixes and the factory timeouts. Pure logic,
// no network. Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.mjs"

const baseConfig = () => ({
  factory: {
    repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
    branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
    allowedActors: ["me"],
  },
  labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
  agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
  repos: [{ repo: "me/app", baseBranch: "main" }],
  workers: [{ id: "claude-01", agent: "claude" }],
})

function load(factoryPatch = {}) {
  const config = baseConfig()
  if (factoryPatch === null) delete config.factory
  else Object.assign(config.factory, factoryPatch)
  const file = join(mkdtempSync(join(tmpdir(), "factory-config-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return loadConfig(file)
}

test("a config with a branch prefix and valid timeouts loads", () => {
  const config = load({ waitForWorkerMinutes: 20, agentTimeoutMinutes: 25, commandTimeoutMinutes: 15, imageBuildTimeoutMinutes: 30 })
  assert.equal(config.factory.branchPrefix, "factory/issue-")
})

test("timeouts may be left out entirely", () => {
  assert.doesNotThrow(() => load())
})

test("a missing branchPrefix is rejected", () => {
  const config = baseConfig()
  delete config.factory.branchPrefix
  const file = join(mkdtempSync(join(tmpdir(), "factory-config-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  assert.throws(() => loadConfig(file), /factory\.branchPrefix must be a non-empty string/)
})

test("an empty branchPrefix is rejected", () => {
  assert.throws(() => load({ branchPrefix: "" }), /factory\.branchPrefix must be a non-empty string/)
})

for (const key of ["waitForWorkerMinutes", "agentTimeoutMinutes", "commandTimeoutMinutes", "imageBuildTimeoutMinutes"]) {
  test(`${key} rejects zero, negative and non-numeric values`, () => {
    for (const value of [0, -5, "30", NaN, null]) {
      assert.throws(() => load({ [key]: value }), new RegExp(`factory\\.${key} must be a positive number of minutes`), `accepted ${JSON.stringify(value)}`)
    }
  })

  test(`${key} accepts a positive number`, () => {
    assert.doesNotThrow(() => load({ [key]: 1.5 }))
  })
}

test("a missing boxNamePrefix is rejected", () => {
  assert.throws(() => load({ boxNamePrefix: undefined }), /factory\.boxNamePrefix must be a non-empty name/)
})

test("an empty boxNamePrefix is rejected", () => {
  assert.throws(() => load({ boxNamePrefix: "" }), /factory\.boxNamePrefix/)
})

test("a boxNamePrefix with spaces or slashes is rejected", () => {
  assert.throws(() => load({ boxNamePrefix: "my factory-" }), /factory\.boxNamePrefix/)
  assert.throws(() => load({ boxNamePrefix: "team/factory-" }), /factory\.boxNamePrefix/)
})

test("ordinary boxNamePrefix values load", () => {
  for (const boxNamePrefix of ["factory-", "acme_factory.", "f1-"]) {
    assert.equal(load({ boxNamePrefix }).factory.boxNamePrefix, boxNamePrefix)
  }
})
