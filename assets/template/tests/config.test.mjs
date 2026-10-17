// Config validation: the branch prefix and the factory timeouts. Pure logic,
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

function loadRepos(repoPatch = {}) {
  const config = baseConfig()
  Object.assign(config.repos[0], repoPatch)
  const file = join(mkdtempSync(join(tmpdir(), "factory-config-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return loadConfig(file)
}

test("repo names with shell metacharacters are rejected", () => {
  // Each of these passes the old "owner/name with no spaces" check but would
  // be interpolated unquoted into shell by install-trigger.mjs or run.mjs.
  for (const bad of ["me/app;echo", "me/app$(id)", "me/a'pp", 'me/a"pp', "me/app`x`", "me/app|head", "me/app&", "me/app#", "me/app?"]) {
    assert.throws(() => loadRepos({ repo: bad }), /must be a real owner\/name/, `accepted ${bad}`)
    assert.throws(() => load({ repo: bad }), /must be the real owner\/name of the factory repo/, `factory accepted ${bad}`)
  }
})

test("repo names with the wrong shape are rejected", () => {
  for (const bad of ["", "me/", "/app", "app", "me/a/pp", "me/ app", "OWNER/app"]) {
    assert.throws(() => loadRepos({ repo: bad }), /must be a real owner\/name/, `accepted ${bad}`)
  }
  assert.throws(() => load({ repo: "OWNER/factory" }), /must be the real owner\/name of the factory repo/)
})

test("real GitHub owner/name values still load", () => {
  assert.doesNotThrow(() => loadRepos({ repo: "My-Org/my.app_repo2" }))
  assert.doesNotThrow(() => load({ repo: "vicgupta/create-ant-factory" }))
})
