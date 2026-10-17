// Config validation: variable names that end up in `export NAME=...` lines the
// job sources in bash. Pure logic, no network. Run with: npm test
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, isEnvName } from "../src/config.mjs"
import { q } from "../src/box.mjs"

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

function load(patch) {
  const config = baseConfig()
  patch(config)
  const file = join(mkdtempSync(join(tmpdir(), "factory-config-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return loadConfig(file)
}

const GOOD = ["CLAUDE_CODE_OAUTH_TOKEN", "DATABASE_URL", "_X", "a1"]
const BAD = ["MY-VAR", "API KEY", "1TOKEN", "X;rm", "", "A=B"]

test("isEnvName accepts shell identifiers and rejects everything else", () => {
  for (const name of GOOD) assert.equal(isEnvName(name), true, name)
  for (const name of [...BAD, undefined, 42]) assert.equal(isEnvName(name), false, String(name))
})

test("every accepted name really works in a sourced export line", () => {
  for (const name of GOOD) {
    const out = execFileSync("bash", ["-c", `export ${name}=${q("v'1")}; printf %s "$${name}"`], { encoding: "utf8" })
    assert.equal(out, "v'1", name)
  }
})

test("a config with valid env names loads", () => {
  assert.doesNotThrow(() => load((c) => {
    c.agents.claude.env = { CODEX_HOME: "/workspace/home/.codex" }
    c.agents.claude.auth = [{ secret: "CLAUDE_CODE_OAUTH_TOKEN", env: "CLAUDE_CODE_OAUTH_TOKEN" }, { secret: "AUTH_JSON", file: "/workspace/home/.x/auth.json" }]
    c.repos[0].secrets = [{ secret: "TEST_DATABASE_URL", env: "DATABASE_URL" }]
  }))
})

for (const bad of BAD.filter(Boolean)) {
  test(`agent env key ${JSON.stringify(bad)} is rejected`, () => {
    assert.throws(() => load((c) => { c.agents.claude.env = { [bad]: "x" } }), /env name .* must be a shell variable name/)
  })

  test(`agent auth env ${JSON.stringify(bad)} is rejected`, () => {
    assert.throws(() => load((c) => { c.agents.claude.auth = [{ secret: "S", env: bad }] }), /auth env .* must be a shell variable name/)
  })

  test(`repo secrets env ${JSON.stringify(bad)} is rejected`, () => {
    assert.throws(() => load((c) => { c.repos[0].secrets = [{ secret: "S", env: bad }] }), /secrets env .* must be a shell variable name/)
  })
}
