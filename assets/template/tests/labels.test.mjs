// The issue label names loadConfig() requires: each of the four must be a
// non-empty string, and they must all differ. Run with: npm test (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.mjs"

const baseConfig = () => ({
  factory: {
    repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
    gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
    allowedActors: ["me"],
  },
  labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
  agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
  repos: [{ repo: "me/app", baseBranch: "main" }],
  workers: [{ id: "claude-01", agent: "claude" }],
})

function load(config) {
  const file = join(mkdtempSync(join(tmpdir(), "factory-config-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return loadConfig(file)
}

test("the template's label names load", () => {
  const config = load(baseConfig())
  assert.equal(config.labels.ready, "ready")
})

test("a missing label name is rejected", () => {
  const config = baseConfig()
  delete config.labels.review
  assert.throws(() => load(config), /labels\.review must be the name of the GitHub issue label/)
})

test("an empty label name is rejected", () => {
  const config = baseConfig()
  config.labels.ready = "  "
  assert.throws(() => load(config), /labels\.ready must be the name of the GitHub issue label/)
})

test("two labels sharing a name are rejected", () => {
  const config = baseConfig()
  config.labels.review = "ready"
  assert.throws(() => load(config), /labels\.review "ready" is used for another label too/)
})

test("labels are compared case-insensitively for duplicates", () => {
  const config = baseConfig()
  config.labels.review = "READY"
  assert.throws(() => load(config), /used for another label too/)
})
