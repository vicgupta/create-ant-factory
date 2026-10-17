// A repo's setup, checks and exclude must each be a list of non-empty
// strings. A plain string ("setup": "npm ci") used to load fine and then
// crash inside a claimed worker. Run with: npm test (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.mjs"

const baseConfig = (repo = {}) => ({
  factory: {
    repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
    branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
    allowedActors: ["me"],
  },
  labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
  agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
  repos: [{ repo: "me/app", baseBranch: "main", ...repo }],
  workers: [{ id: "claude-01", agent: "claude" }],
})

function load(config) {
  const file = join(mkdtempSync(join(tmpdir(), "factory-config-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return loadConfig(file)
}

test("lists of commands and patterns load", () => {
  const config = load(baseConfig({ setup: ["npm ci"], checks: ["npm test", "npm run build"], exclude: [".venv/"] }))
  assert.deepEqual(config.repos[0].setup, ["npm ci"])
  assert.deepEqual(config.repos[0].checks, ["npm test", "npm run build"])
  assert.deepEqual(config.repos[0].exclude, [".venv/"])
})

test("left-out lists default to empty", () => {
  const config = load(baseConfig())
  assert.deepEqual(config.repos[0].setup, [])
  assert.deepEqual(config.repos[0].checks, [])
  assert.deepEqual(config.repos[0].exclude, [])
})

for (const key of ["setup", "checks", "exclude"]) {
  test(`a plain string for ${key} is rejected`, () => {
    assert.throws(() => load(baseConfig({ [key]: "npm ci" })), new RegExp(`repo "me/app": ${key} must be a list of non-empty strings`))
  })

  test(`an empty or non-string entry in ${key} is rejected`, () => {
    assert.throws(() => load(baseConfig({ [key]: ["npm ci", ""] })), new RegExp(`${key} must be a list`))
    assert.throws(() => load(baseConfig({ [key]: ["npm ci", 42] })), new RegExp(`${key} must be a list`))
  })
}

test("the template's own repo entry passes this check", async () => {
  const { readFileSync } = await import("node:fs")
  const template = JSON.parse(readFileSync(new URL("../factory.config.json", import.meta.url), "utf8"))
  const repo = template.repos[0]
  for (const key of ["setup", "checks", "exclude"]) {
    assert.ok(Array.isArray(repo[key]) && repo[key].every((item) => typeof item === "string" && item.trim()), key)
  }
})
