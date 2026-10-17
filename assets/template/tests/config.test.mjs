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

// A prefix that git would refuse fails here, not mid-run in run.mjs after a
// worker was already claimed.
for (const prefix of ["factory 2/", "fac..tory/", "x@{y/", "~branch/", "^wip", "a:b", "q?x", "a*b", "[x", "back\\slash", ".hidden/", "reflog.lock/", "/leading"]) {
  test(`branchPrefix "${prefix}" is rejected as an illegal git branch name`, () => {
    assert.throws(() => load({ branchPrefix: prefix }), /factory\.branchPrefix .* is not usable in a git branch name/, `accepted ${JSON.stringify(prefix)}`)
  })
}

for (const prefix of ["factory/issue-", "factory/", "a/b-c_d/", "issue-"]) {
  test(`branchPrefix "${prefix}" is accepted as a legal git branch name`, () => {
    assert.doesNotThrow(() => load({ branchPrefix: prefix }), `rejected ${JSON.stringify(prefix)}`)
  })
}

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

test("boxLimit may be left out", () => {
  assert.doesNotThrow(() => load())
})

test("boxLimit rejects zero, negative, fractional and non-numeric values", () => {
  for (const value of [0, -5, 10.5, "10", NaN, null]) {
    assert.throws(() => load({ boxLimit: value }), /factory\.boxLimit must be a positive number of Boxes/, `accepted ${JSON.stringify(value)}`)
  }
})

test("boxLimit accepts a positive whole number", () => {
  assert.equal(load({ boxLimit: 10 }).factory.boxLimit, 10)
})

test("allowedActors entries must look like GitHub usernames", () => {
  load({ allowedActors: ["vicgupta", "octo-org"] }) // letters, digits and hyphens are fine
  for (const bad of ["vic gupta", "@vicgupta", "vic'gupta", "vic_gupta", "", 42]) {
    assert.throws(() => load({ allowedActors: ["vicgupta", bad] }), /factory\.allowedActors has .* which is not a GitHub username/, JSON.stringify(bad))
  }
})

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
