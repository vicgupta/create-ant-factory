// The Daytona worker provider, tested without a Daytona account: config
// selection and validation, the check-setup verification, and the exact
// HTTP requests, all through an injected fake `fetch`. Nothing here touches
// the network. Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, workerProvider, workerNoun, daytonaConfig, requireBoxProvider } from "../src/config.mjs"
import { buildDaytonaCreateBody, createDaytonaWorker, daytonaClient, daytonaExecCommand, daytonaHandle, isBusyState, listDaytonaWorkers, removeDaytonaWorker, sandboxesForWorker, verifyDaytona, waitUntilStarted } from "../src/daytona.mjs"
import { daytonaWorkerStates } from "../src/workers.mjs"
import { secretPlan } from "../src/secrets.mjs"
import { createRunRecord, endRun, summarizeRecords } from "../src/record.mjs"

const baseConfig = () => ({
  factory: {
    repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
    branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
    allowedActors: ["me"],
  },
  labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
  agents: { claude: { boxSettings: [], auth: [{ secret: "CLAUDE_CODE_OAUTH_TOKEN", env: "CLAUDE_CODE_OAUTH_TOKEN" }], command: 'claude -p "$(cat {prompt})" > {summary}' } },
  repos: [{ repo: "me/app", baseBranch: "main" }],
  workers: [{ id: "claude-01", agent: "claude" }],
})

function load(config) {
  const file = join(mkdtempSync(join(tmpdir(), "factory-config-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return loadConfig(file)
}

const daytonaCfg = (daytona = { snapshot: "caf-worker" }) => ({ ...baseConfig(), worker: { provider: "daytona", daytona } })
const ENV = { DAYTONA_API_KEY: "dtn_test_key_123456" }
const TOOLBOX = "https://proxy.app.daytona.io/toolbox"

// A fake fetch: routes "METHOD path" (query stripped) to handlers and
// records every call with its parsed body.
function fakeFetch(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const u = new URL(url)
    const key = `${init.method ?? "GET"} ${u.origin}${u.pathname}`
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body
    calls.push({ key, url, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body })
    const route = Object.entries(routes).find(([pattern]) => pattern === key)
    const reply = route ? await route[1]({ url: u, body, calls }) : { status: 404, json: { message: "not found" } }
    const status = reply.status ?? 200
    const text = reply.json === undefined ? (reply.text ?? "") : JSON.stringify(reply.json)
    return { ok: status >= 200 && status < 300, status, text: async () => text }
  }
  return { fetch, calls }
}

const API = "https://app.daytona.io/api"
const started = { id: "sb-1", name: "factory-claude-01-42", state: "started", toolboxProxyUrl: TOOLBOX, labels: {} }

// --- config selection --------------------------------------------------------

test("daytona is selected by worker.provider and gets its own noun", () => {
  const config = load(daytonaCfg())
  assert.equal(workerProvider(config), "daytona")
  assert.equal(workerNoun(config), "Sandbox")
})

test("daytona settings: defaults, config over environment, empty env counts as unset", () => {
  assert.deepEqual(daytonaConfig(load(daytonaCfg({})), {}), { snapshot: null, target: null, apiUrl: API, autoStopMinutes: 30, startTimeoutMinutes: 5 })
  assert.deepEqual(daytonaConfig(load(daytonaCfg({})), { DAYTONA_API_URL: "https://daytona.internal/api/", DAYTONA_TARGET: "eu" }).apiUrl, "https://daytona.internal/api")
  assert.equal(daytonaConfig(load(daytonaCfg({})), { DAYTONA_TARGET: "eu" }).target, "eu")
  assert.equal(daytonaConfig(load(daytonaCfg({ target: "us" })), { DAYTONA_TARGET: "eu" }).target, "us")
  assert.equal(daytonaConfig(load(daytonaCfg({})), { DAYTONA_API_URL: "", DAYTONA_TARGET: "" }).apiUrl, API)
})

test("bad daytona settings are refused, and a key in the config is refused outright", () => {
  assert.throws(() => load(daytonaCfg({ snapshot: "two words" })), /worker\.daytona\.snapshot/)
  assert.throws(() => load(daytonaCfg({ apiUrl: "ftp://x" })), /worker\.daytona\.apiUrl/)
  assert.throws(() => load(daytonaCfg({ autoStopMinutes: -1 })), /worker\.daytona\.autoStopMinutes/)
  assert.throws(() => load(daytonaCfg({ startTimeoutMinutes: 0 })), /worker\.daytona\.startTimeoutMinutes/)
  assert.throws(() => load(daytonaCfg({ apiKey: "dtn_x" })), /DAYTONA_API_KEY/)
  assert.throws(() => load({ ...baseConfig(), worker: { provider: "daytona", daytona: "caf" } }), /worker\.daytona must be an object/)
  assert.doesNotThrow(() => load(daytonaCfg({ autoStopMinutes: 0 })))
})

test("box-only scripts refuse under daytona and point at check-setup", () => {
  const config = load(daytonaCfg())
  for (const script of ["provision-workers.mjs", "delete-workers.mjs", "smoke-test.mjs", "build-snapshot.mjs", "apply-box-settings.mjs", "box-exec.mjs"]) {
    assert.throws(() => requireBoxProvider(config, script), (error) => {
      assert.match(error.message, /worker\.provider is "daytona"/)
      assert.match(error.message, new RegExp(script.replace(".", "\\.")))
      assert.match(error.message, /check-setup\.mjs/)
      return true
    })
  }
})

test("only the daytona provider puts DAYTONA_API_KEY in the secret plan", () => {
  const saved = process.env.DAYTONA_API_KEY
  process.env.DAYTONA_API_KEY = "dtn_plan"
  try {
    const rows = (config) => secretPlan(config).map(([repo, name]) => `${repo} ${name}`)
    assert.ok(rows(load(daytonaCfg())).includes("me/factory DAYTONA_API_KEY"))
    assert.ok(!rows(load(daytonaCfg())).includes("me/factory UPSTASH_BOX_API_KEY"))
    assert.ok(!rows(load({ ...baseConfig(), worker: { provider: "docker" } })).some((r) => r.endsWith("DAYTONA_API_KEY")))
    assert.ok(!rows(load(baseConfig())).some((r) => r.endsWith("DAYTONA_API_KEY")))
  } finally {
    if (saved === undefined) delete process.env.DAYTONA_API_KEY
    else process.env.DAYTONA_API_KEY = saved
  }
})

test("run records and the report carry provider daytona", () => {
  const record = createRunRecord({ repo: "me/app", issue: 1, runId: "1" })
  record.provider = workerProvider(load(daytonaCfg()))
  endRun(record, "pr-opened")
  const summary = summarizeRecords([record])
  assert.equal(record.provider, "daytona")
  assert.ok(JSON.stringify(summary.byProvider).includes("daytona"))
})

// --- check-setup verification ----------------------------------------------

test("check-setup fails on a missing DAYTONA_API_KEY and calls nothing", async () => {
  const { fetch, calls } = fakeFetch({})
  const result = await verifyDaytona(load(daytonaCfg()), { env: {}, fetch })
  assert.equal(result.ok, false)
  assert.equal(result.checks[0].id, "key")
  assert.match(result.checks[0].message, /DAYTONA_API_KEY has no value/)
  assert.equal(calls.length, 0)
})

test("check-setup passes with a working key and an active snapshot, and never prints the key", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/sandbox`]: () => ({ json: { items: [{ id: "sb-9", name: "factory-claude-01-7", state: "started", labels: { "create-ant-factory": "true", worker: "claude-01" } }], nextCursor: null } }),
    [`GET ${API}/snapshots/caf-worker`]: () => ({ json: { id: "s1", name: "caf-worker", state: "active" } }),
  })
  const result = await verifyDaytona(load(daytonaCfg()), { env: ENV, fetch })
  assert.equal(result.ok, true, JSON.stringify(result.checks))
  assert.deepEqual(result.checks.map((c) => c.id), ["key", "api", "snapshot"])
  assert.match(result.checks[1].message, /1 running: factory-claude-01-7/)
  assert.equal(JSON.parse(calls[0].query.labels)["create-ant-factory"], "true")
  assert.equal(calls[0].headers.Authorization, `Bearer ${ENV.DAYTONA_API_KEY}`)
  assert.ok(!JSON.stringify(result).includes(ENV.DAYTONA_API_KEY))
})

test("check-setup flags a rejected key, a missing snapshot and notes an unset one", async () => {
  const rejected = await verifyDaytona(load(daytonaCfg()), { env: ENV, fetch: fakeFetch({ [`GET ${API}/sandbox`]: () => ({ status: 401, json: { message: "Unauthorized" } }) }).fetch })
  assert.equal(rejected.ok, false)
  assert.match(rejected.checks.at(-1).message, /refused the key/)

  const missing = await verifyDaytona(load(daytonaCfg()), { env: ENV, fetch: fakeFetch({ [`GET ${API}/sandbox`]: () => ({ json: [] }) }).fetch })
  assert.equal(missing.ok, false)
  assert.match(missing.checks.at(-1).message, /daytona snapshot push/)

  const unset = await verifyDaytona(load(daytonaCfg({})), { env: ENV, fetch: fakeFetch({ [`GET ${API}/sandbox`]: () => ({ json: { items: [], nextCursor: null } }) }).fetch })
  assert.equal(unset.ok, true)
  assert.equal(unset.checks.at(-1).status, "note")
})

// --- request shapes ----------------------------------------------------------

test("create body: labels, snapshot, target, no secrets, never public, self-deleting", () => {
  const body = buildDaytonaCreateBody(load(daytonaCfg({ snapshot: "caf-worker", target: "eu" })), { id: "claude-01" }, "run 42", { ...ENV, CLAUDE_CODE_OAUTH_TOKEN: "secret-token-value" })
  assert.deepEqual(body, {
    name: "factory-claude-01-run-42",
    labels: { "create-ant-factory": "true", worker: "claude-01", "run-id": "run-42" },
    env: { HOME: "/workspace/home" },
    public: false,
    autoStopInterval: 30,
    autoDeleteInterval: 0,
    snapshot: "caf-worker",
    target: "eu",
  })
  assert.ok(!JSON.stringify(body).match(/dtn_|secret-token|TOKEN|KEY/), "no secrets in the create body")
})

test("dry run returns the exact request and needs neither a key nor the network", async () => {
  const { fetch, calls } = fakeFetch({})
  const handle = await createDaytonaWorker(load(daytonaCfg()), { id: "claude-01", agent: "claude" }, "7", { dryRun: true, env: {}, fetch })
  assert.equal(handle.kind, "daytona")
  assert.equal(handle.dryRun, true)
  assert.equal(handle.request.method, "POST")
  assert.equal(handle.request.url, `${API}/sandbox`)
  assert.equal(handle.request.body.labels.worker, "claude-01")
  assert.equal(calls.length, 0)
})

test("create: deletes a same-name leftover, creates, waits for started, prepares the workspace", async () => {
  let polls = 0
  const { fetch, calls } = fakeFetch({
    [`DELETE ${API}/sandbox/factory-claude-01-42`]: () => ({ status: 404, json: { message: "not found" } }),
    [`POST ${API}/sandbox`]: ({ body }) => ({ json: { id: "sb-1", name: body.name, state: "creating", toolboxProxyUrl: TOOLBOX } }),
    [`GET ${API}/sandbox/sb-1`]: () => ({ json: polls++ === 0 ? { ...started, state: "starting" } : started }),
    [`POST ${TOOLBOX}/sb-1/process/execute`]: () => ({ json: { exitCode: 0, result: "" } }),
  })
  const handle = await createDaytonaWorker(load(daytonaCfg()), { id: "claude-01", agent: "claude" }, "42", { env: ENV, fetch, sleep: async () => {} })
  assert.equal(handle.kind, "daytona")
  assert.equal(handle.id, "sb-1")
  assert.deepEqual(calls.map((c) => c.key), [
    `DELETE ${API}/sandbox/factory-claude-01-42`,
    `POST ${API}/sandbox`,
    `GET ${API}/sandbox/sb-1`,
    `GET ${API}/sandbox/sb-1`,
    `POST ${TOOLBOX}/sb-1/process/execute`,
  ])
  const create = calls[1]
  assert.equal(create.headers.Authorization, `Bearer ${ENV.DAYTONA_API_KEY}`)
  assert.equal(create.headers["Content-Type"], "application/json")
  assert.equal(create.body.snapshot, "caf-worker")
  const ready = calls.at(-1).body
  assert.match(ready.command, /^sh -c '/)
  assert.match(ready.command, /mkdir -p \/workspace\/home\/work/)
  assert.equal(ready.timeout, 600)
})

test("create fetches the toolbox URL when the sandbox does not include it", async () => {
  const { fetch, calls } = fakeFetch({
    [`POST ${API}/sandbox`]: () => ({ json: { id: "sb-1", name: "n", state: "started" } }),
    [`GET ${API}/sandbox/sb-1/toolbox-proxy-url`]: () => ({ json: { url: TOOLBOX } }),
    [`POST ${TOOLBOX}/sb-1/process/execute`]: () => ({ json: { exitCode: 0, result: "" } }),
  })
  await createDaytonaWorker(load(daytonaCfg()), { id: "claude-01" }, "42", { env: ENV, fetch, sleep: async () => {} })
  assert.ok(calls.some((c) => c.key === `GET ${API}/sandbox/sb-1/toolbox-proxy-url`))
})

test("exec and file write: the toolbox requests sh() and agents.mjs rely on", async () => {
  const { fetch, calls } = fakeFetch({
    [`POST ${TOOLBOX}/sb-1/process/execute`]: ({ body }) => ({ json: { exitCode: body.command.includes("false") ? 1 : 0, result: "hello\n__EXIT__0" } }),
    [`POST ${TOOLBOX}/sb-1/files/upload-v2`]: () => ({ text: "" }),
  })
  const handle = daytonaHandle(daytonaClient({ apiKey: ENV.DAYTONA_API_KEY, apiUrl: API, fetch }), started)
  const run = await handle.exec.command("echo 'it''s' && ls ~")
  assert.deepEqual(run, { result: "hello\n__EXIT__0", status: "completed" })
  assert.equal(calls[0].body.command, daytonaExecCommand("echo 'it''s' && ls ~"))
  assert.equal(calls[0].body.command, `sh -c 'export HOME=/workspace/home; echo '\\''it'\\'''\\''s'\\'' && ls ~'`)
  assert.equal((await handle.exec.command("false")).status, "failed")

  await handle.files.write({ path: "/workspace/home/.factory/env", content: "export A='b'\n" })
  const upload = calls.at(-1)
  assert.equal(upload.query.path, "/workspace/home/.factory/env")
  assert.ok(upload.body instanceof FormData)
  assert.equal(await upload.body.get("file").text(), "export A='b'\n")
  assert.equal(upload.headers["Content-Type"], undefined, "FormData sets its own multipart boundary")
})

// --- teardown ----------------------------------------------------------------

test("a sandbox that fails to start is deleted before the error is thrown", async () => {
  const { fetch, calls } = fakeFetch({
    [`POST ${API}/sandbox`]: () => ({ json: { id: "sb-1", name: "n", state: "creating" } }),
    [`GET ${API}/sandbox/sb-1`]: () => ({ json: { id: "sb-1", name: "n", state: "error", errorReason: "snapshot not found" } }),
    [`DELETE ${API}/sandbox/sb-1`]: () => ({ status: 200, json: {} }),
  })
  await assert.rejects(createDaytonaWorker(load(daytonaCfg()), { id: "claude-01" }, "42", { env: ENV, fetch, sleep: async () => {} }), /did not start: state "error" \(snapshot not found\)/)
  assert.equal(calls.at(-1).key, `DELETE ${API}/sandbox/sb-1`)
})

test("a sandbox whose workspace cannot be prepared is deleted too", async () => {
  const { fetch, calls } = fakeFetch({
    [`POST ${API}/sandbox`]: () => ({ json: started }),
    [`POST ${TOOLBOX}/sb-1/process/execute`]: () => ({ json: { exitCode: 1, result: "Permission denied" } }),
    [`DELETE ${API}/sandbox/sb-1`]: () => ({ json: {} }),
  })
  await assert.rejects(createDaytonaWorker(load(daytonaCfg()), { id: "claude-01" }, "42", { env: ENV, fetch, sleep: async () => {} }), /not writable: Permission denied/)
  assert.equal(calls.at(-1).key, `DELETE ${API}/sandbox/sb-1`)
})

test("waitUntilStarted times out with a hint instead of waiting forever", async () => {
  const client = { getSandbox: async () => ({ id: "sb-1", name: "n", state: "pulling_snapshot" }) }
  await assert.rejects(waitUntilStarted(client, { id: "sb-1", name: "n", state: "creating" }, { timeoutMs: 0, sleep: async () => {} }), /startTimeoutMinutes/)
})

test("release deletes the sandbox, and a failed delete only warns", async () => {
  const { fetch, calls } = fakeFetch({ [`DELETE ${API}/sandbox/sb-1`]: () => ({ status: 204 }) })
  const handle = daytonaHandle(daytonaClient({ apiKey: ENV.DAYTONA_API_KEY, apiUrl: API, fetch }), started)
  await removeDaytonaWorker(handle)
  assert.equal(calls.at(-1).key, `DELETE ${API}/sandbox/sb-1`)

  const broken = daytonaHandle(daytonaClient({ apiKey: ENV.DAYTONA_API_KEY, apiUrl: API, fetch: fakeFetch({ [`DELETE ${API}/sandbox/sb-1`]: () => ({ status: 500, text: "boom" }) }).fetch }), started)
  const warn = console.warn
  let warned = ""
  console.warn = (text) => (warned = text)
  try {
    await removeDaytonaWorker(broken)
  } finally {
    console.warn = warn
  }
  assert.match(warned, /Could not delete Daytona sandbox/)
})

// --- busy detection ----------------------------------------------------------

test("listing follows nextCursor pages and only running sandboxes mark a worker busy", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/sandbox`]: ({ url }) => url.searchParams.get("cursor")
      ? { json: { items: [{ id: "sb-3", name: "factory-codex-01-9", state: "stopped", labels: { worker: "codex-01" } }], nextCursor: null } }
      : { json: { items: [{ id: "sb-2", name: "factory-claude-01-7", state: "started", labels: { worker: "claude-01" } }], nextCursor: "c2" } },
  })
  const config = load({ ...daytonaCfg(), workers: [{ id: "claude-01", agent: "claude" }, { id: "codex-01", agent: "claude" }, { id: "off-01", agent: "claude", enabled: false }] })
  const rows = await listDaytonaWorkers(config, { env: ENV, fetch })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].query.cursor, "c2")
  const states = daytonaWorkerStates(config, rows)
  assert.deepEqual(states.map((w) => [w.id, w.state, w.boxStatus]), [["claude-01", "busy", "started"], ["codex-01", "free", "not created"], ["off-01", "disabled", "not created"]])
  assert.deepEqual(sandboxesForWorker(rows, "codex-01").map((r) => r.id), ["sb-3"], "release-worker also sees stopped leftovers")
  assert.equal(isBusyState("creating"), true)
  assert.equal(isBusyState("destroyed"), false)
})

test("the client refuses to start without a key", () => {
  assert.throws(() => daytonaClient({ apiUrl: API, fetch: async () => ({}) }), /DAYTONA_API_KEY is not set/)
})
