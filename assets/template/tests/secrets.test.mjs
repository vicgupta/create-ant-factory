// Where readSecret looks for a secret, and in which order. Pure logic, no network.
// Run with: npm test   (node --test tests/)
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSecret } from "../src/secrets.mjs"

const NAME = "FACTORY_TEST_SECRET"
const saved = {}

beforeEach(() => {
  for (const key of [NAME, "FACTORY_SECRETS_JSON", "HOME"]) saved[key] = process.env[key]
  delete process.env[NAME]
  delete process.env.FACTORY_SECRETS_JSON
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function tempFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "factory-secret-"))
  const file = join(dir, "auth.json")
  writeFileSync(file, content)
  return file
}

test("an environment variable (from .env) wins over everything else", () => {
  process.env[NAME] = "from-env"
  process.env.FACTORY_SECRETS_JSON = JSON.stringify({ [NAME]: "from-actions" })
  assert.equal(readSecret({ secret: NAME, localFile: tempFile("from-file") }), "from-env")
})

test("in Actions the value comes from the secrets JSON blob", () => {
  process.env.FACTORY_SECRETS_JSON = JSON.stringify({ [NAME]: "from-actions", OTHER: "x" })
  assert.equal(readSecret({ secret: NAME }), "from-actions")
})

test("a broken secrets blob is ignored and the local file is used", () => {
  process.env.FACTORY_SECRETS_JSON = "{not json"
  assert.equal(readSecret({ secret: NAME, localFile: tempFile("from-file") }), "from-file")
})

test("a leading ~ in localFile means the home directory", () => {
  const home = mkdtempSync(join(tmpdir(), "factory-home-"))
  mkdirSync(join(home, ".codex"))
  writeFileSync(join(home, ".codex", "auth.json"), '{"token":"t"}')
  process.env.HOME = home
  assert.equal(readSecret({ secret: NAME, localFile: "~/.codex/auth.json" }), '{"token":"t"}')
})

test("nothing found gives undefined, so callers can name the missing secret", () => {
  assert.equal(readSecret({ secret: NAME }), undefined)
  assert.equal(readSecret({ secret: NAME, localFile: "/no/such/file" }), undefined)
  process.env.FACTORY_SECRETS_JSON = JSON.stringify({ [NAME]: "" })
  assert.equal(readSecret({ secret: NAME }), undefined)
})
