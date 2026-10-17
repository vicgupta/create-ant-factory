// Which secrets set-secrets.mjs puts on which repo. Pure logic: values come
// from process.env, nothing is sent to GitHub. Run with: npm test
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { secretPlan } from "../src/secrets.mjs"

const KEYS = ["UPSTASH_BOX_API_KEY", "FACTORY_GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "APP_DB_URL", "FACTORY_SECRETS_JSON"]
const saved = {}

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.UPSTASH_BOX_API_KEY = "box-key"
  process.env.FACTORY_GITHUB_TOKEN = "gh-token"
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-token"
  process.env.APP_DB_URL = "postgres://test"
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const config = (worker) => ({
  ...(worker ? { worker } : {}),
  factory: { repo: "me/factory" },
  agents: {
    claude: { auth: [{ secret: "CLAUDE_CODE_OAUTH_TOKEN", env: "CLAUDE_CODE_OAUTH_TOKEN" }] },
    codex: { auth: [{ secret: "OPENAI_API_KEY", env: "OPENAI_API_KEY" }] },
  },
  repos: [{ repo: "me/app", secrets: [{ secret: "APP_DB_URL", env: "DATABASE_URL" }] }],
  workers: [
    { id: "claude-01", agent: "claude", enabled: true },
    { id: "codex-01", agent: "codex", enabled: false },
  ],
})

const names = (plan) => plan.map(([repo, name]) => `${repo} ${name}`)

test("the Box provider puts the Box key on the factory repo", () => {
  assert.deepEqual(names(secretPlan(config())), [
    "me/factory UPSTASH_BOX_API_KEY",
    "me/factory FACTORY_GITHUB_TOKEN",
    "me/factory CLAUDE_CODE_OAUTH_TOKEN",
    "me/app FACTORY_GITHUB_TOKEN",
    "me/factory APP_DB_URL",
  ])
})

test("the Docker provider neither needs nor sets the Box key", () => {
  delete process.env.UPSTASH_BOX_API_KEY
  const plan = secretPlan(config({ provider: "docker" }))
  assert.ok(!names(plan).some((row) => row.endsWith("UPSTASH_BOX_API_KEY")))
  // Every row has a value, so set-secrets.mjs does not stop with "Fill in .env first".
  assert.deepEqual(plan.filter(([, , value]) => !value), [])
})

test("an agent type with no enabled worker is left out", () => {
  assert.ok(!names(secretPlan(config())).some((row) => row.endsWith("OPENAI_API_KEY")))
})

test("a missing value shows up as an empty row, so the script can name it", () => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  const missing = secretPlan(config()).filter(([, , value]) => !value).map(([, name]) => name)
  assert.deepEqual(missing, ["CLAUDE_CODE_OAUTH_TOKEN"])
})
