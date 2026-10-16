import test from "node:test"
import assert from "node:assert/strict"
import { collectSecrets, redactSecrets } from "../src/redact.mjs"

test("redactSecrets replaces every occurrence of every value", () => {
  const out = redactSecrets("token abc123xyz here and abc123xyz again, plus def456uvw", ["abc123xyz", "def456uvw"])
  assert.equal(out, "token *** here and *** again, plus ***")
})

test("redactSecrets leaves text alone when there is nothing to redact", () => {
  assert.equal(redactSecrets("nothing secret here", []), "nothing secret here")
  assert.equal(redactSecrets("nothing secret here", ["xyz"]), "nothing secret here")
})

test("redactSecrets handles empty and non-string input", () => {
  assert.equal(redactSecrets("", ["abc123xyz"]), "")
  assert.equal(redactSecrets(null, ["abc123xyz"]), "null")
})

test("collectSecrets finds the GitHub token in the environment", () => {
  const saved = process.env.FACTORY_GITHUB_TOKEN
  const savedBlob = process.env.FACTORY_SECRETS_JSON
  try {
    process.env.FACTORY_GITHUB_TOKEN = "ghp_testtoken123456"
    delete process.env.FACTORY_SECRETS_JSON
    const values = collectSecrets({ agents: {} }, {})
    assert.ok(values.includes("ghp_testtoken123456"))
  } finally {
    if (saved === undefined) delete process.env.FACTORY_GITHUB_TOKEN
    else process.env.FACTORY_GITHUB_TOKEN = saved
    if (savedBlob === undefined) delete process.env.FACTORY_SECRETS_JSON
    else process.env.FACTORY_SECRETS_JSON = savedBlob
  }
})

test("collectSecrets reads the secrets blob and skips short values", () => {
  const savedBlob = process.env.FACTORY_SECRETS_JSON
  const savedToken = process.env.FACTORY_GITHUB_TOKEN
  try {
    delete process.env.FACTORY_GITHUB_TOKEN
    process.env.FACTORY_SECRETS_JSON = JSON.stringify({ LONG_SECRET: "longsecretvalue1", SHORT: "abc" })
    const values = collectSecrets({ agents: {} }, {})
    assert.ok(values.includes("longsecretvalue1"))
    assert.ok(!values.includes("abc"), "short values must not be redacted")
  } finally {
    if (savedBlob === undefined) delete process.env.FACTORY_SECRETS_JSON
    else process.env.FACTORY_SECRETS_JSON = savedBlob
    if (savedToken === undefined) delete process.env.FACTORY_GITHUB_TOKEN
    else process.env.FACTORY_GITHUB_TOKEN = savedToken
  }
})

test("collectSecrets pulls agent sign-in and repo secrets through readSecret", () => {
  const saved = { ...process.env }
  try {
    delete process.env.FACTORY_GITHUB_TOKEN
    delete process.env.FACTORY_SECRETS_JSON
    process.env.TEST_AGENT_API_KEY = "sk-ant-testkey-12345"
    process.env.TEST_REPO_DB_URL = "postgres://user:pw123456@db/test"
    const config = { agents: { claude: { auth: [{ secret: "TEST_AGENT_API_KEY", env: "ANTHROPIC_API_KEY" }] } } }
    const repo = { secrets: [{ secret: "TEST_REPO_DB_URL", env: "DATABASE_URL" }] }
    const values = collectSecrets(config, { agentName: "claude", repo })
    assert.ok(values.includes("sk-ant-testkey-12345"))
    assert.ok(values.includes("postgres://user:pw123456@db/test"))
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    for (const [key, value] of Object.entries(saved)) process.env[key] = value
  }
})

test("collectSecrets falls back to every agent type before a worker is claimed", () => {
  const saved = { ...process.env }
  try {
    delete process.env.FACTORY_GITHUB_TOKEN
    delete process.env.FACTORY_SECRETS_JSON
    process.env.TEST_CODEX_KEY = "sk-codex-testkey-99"
    const config = { agents: { codex: { auth: [{ secret: "TEST_CODEX_KEY", env: "OPENAI_API_KEY" }] } } }
    const values = collectSecrets(config, {})
    assert.ok(values.includes("sk-codex-testkey-99"))
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    for (const [key, value] of Object.entries(saved)) process.env[key] = value
  }
})

test("collectSecrets tolerates a missing or broken config", () => {
  assert.deepEqual(collectSecrets(undefined, {}), collectSecrets(undefined, {}))
  assert.ok(Array.isArray(collectSecrets({ agents: { x: {} } }, { agentName: "x" })))
})
