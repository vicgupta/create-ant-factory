// The E2B worker provider, tested without an E2B account: config selection
// and validation, the check-setup verification, and the exact HTTP requests
// (control plane and the in-sandbox Connect calls), all through an injected
// fake `fetch`. Nothing here touches the network. Run with: npm test
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, workerProvider, workerNoun, e2bConfig, requireBoxProvider } from "../src/config.mjs"
import {
  buildE2BCreateBody, connectFrame, createE2BWorker, e2bClient, e2bHandle, e2bSandboxesForWorker, e2bStartRequest,
  isBusyState, listE2BWorkers, parseConnectFrames, processResult, removeE2BWorker, verifyE2B, versionAtLeast,
} from "../src/e2b.mjs"
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

const e2bCfg = (e2b = { template: "caf-worker" }) => ({ ...baseConfig(), worker: { provider: "e2b", e2b } })
const ENV = { E2B_API_KEY: "e2b_test_key_1234567890" }
const API = "https://api.e2b.app"
const ENVD = "https://49983-sbx1.e2b.app"
const created = { sandboxID: "sbx1", templateID: "caf-worker", clientID: "c", envdVersion: "0.5.4", envdAccessToken: "envd-token-abc", domain: null }

// Connect stream bodies, as envd would send them.
const b64 = (text) => Buffer.from(text).toString("base64")
function stream(...messages) {
  const frames = messages.map((m) => connectFrame(m))
  const end = connectFrame({})
  end[0] = 0x02
  return Buffer.concat([...frames, end])
}
const ran = (stdout, exitCode) => stream({ event: { start: { pid: 7 } } }, { event: { data: { stdout: b64(stdout) } } }, { event: { end: exitCode ? { exitCode, exited: true, status: `exit status ${exitCode}` } : { exited: true, status: "exit status 0" } } })

// A fake fetch: routes "METHOD origin+path" (query stripped) to handlers and
// records every call with its parsed body.
function fakeFetch(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const u = new URL(url)
    const key = `${init.method ?? "GET"} ${u.origin}${u.pathname}`
    let body = init.body
    if (typeof body === "string") body = JSON.parse(body)
    else if (body instanceof Uint8Array) body = parseConnectFrames(body).messages[0]
    calls.push({ key, url, query: u.searchParams, headers: init.headers ?? {}, body })
    const route = Object.entries(routes).find(([pattern]) => pattern === key)
    const reply = route ? await route[1]({ url: u, body, calls }) : { status: 404, json: { message: "not found" } }
    const status = reply.status ?? 200
    const bytes = reply.bytes ?? Buffer.from(reply.json === undefined ? (reply.text ?? "") : JSON.stringify(reply.json))
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      text: async () => bytes.toString(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  return { fetch, calls }
}

// --- config selection ---------------------------------------------------------

test("e2b is selected by worker.provider and gets the sandbox noun", () => {
  const config = load(e2bCfg())
  assert.equal(workerProvider(config), "e2b")
  assert.equal(workerNoun(config), "Sandbox")
})

test("e2b settings: defaults, apiUrl follows the domain, config over environment, empty env is unset", () => {
  assert.deepEqual(e2bConfig(load(e2bCfg({})), {}), { template: "base", domain: "e2b.app", apiUrl: API, timeoutMinutes: 30 })
  assert.equal(e2bConfig(load(e2bCfg({})), { E2B_DOMAIN: "e2b.internal.example" }).apiUrl, "https://api.e2b.internal.example")
  assert.equal(e2bConfig(load(e2bCfg({})), { E2B_API_URL: "https://e2b-api.example/" }).apiUrl, "https://e2b-api.example")
  assert.equal(e2bConfig(load(e2bCfg({ domain: "mine.example" })), { E2B_DOMAIN: "other.example" }).domain, "mine.example")
  assert.deepEqual(e2bConfig(load(e2bCfg({})), { E2B_DOMAIN: "", E2B_API_URL: "" }), e2bConfig(load(e2bCfg({})), {}))
})

test("bad e2b settings are refused, and a key in the config is refused outright", () => {
  assert.throws(() => load(e2bCfg({ template: "two words" })), /worker\.e2b\.template/)
  assert.throws(() => load(e2bCfg({ domain: "https://e2b.app" })), /worker\.e2b\.domain/)
  assert.throws(() => load(e2bCfg({ apiUrl: "ftp://x" })), /worker\.e2b\.apiUrl/)
  assert.throws(() => load(e2bCfg({ timeoutMinutes: 0 })), /worker\.e2b\.timeoutMinutes/)
  assert.throws(() => load(e2bCfg({ timeoutMinutes: 2000 })), /worker\.e2b\.timeoutMinutes/)
  assert.throws(() => load(e2bCfg({ apiKey: "e2b_x" })), /E2B_API_KEY/)
  assert.throws(() => load({ ...baseConfig(), worker: { provider: "e2b", e2b: "caf" } }), /worker\.e2b must be an object/)
  assert.doesNotThrow(() => load(e2bCfg({ template: "team/caf-worker:v2", timeoutMinutes: 60 })))
})

test("box-only scripts refuse under e2b and point at check-setup", () => {
  const config = load(e2bCfg())
  for (const script of ["provision-workers.mjs", "delete-workers.mjs", "smoke-test.mjs", "build-snapshot.mjs", "apply-box-settings.mjs", "box-exec.mjs"]) {
    assert.throws(() => requireBoxProvider(config, script), (error) => {
      assert.match(error.message, /worker\.provider is "e2b"/)
      assert.match(error.message, new RegExp(script.replace(".", "\\.")))
      assert.match(error.message, /check-setup\.mjs/)
      return true
    })
  }
})

test("only the e2b provider puts E2B_API_KEY in the secret plan", () => {
  const saved = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = "e2b_plan"
  try {
    const rows = (config) => secretPlan(config).map(([repo, name]) => `${repo} ${name}`)
    assert.ok(rows(load(e2bCfg())).includes("me/factory E2B_API_KEY"))
    assert.ok(!rows(load(e2bCfg())).some((r) => /UPSTASH_BOX_API_KEY|DAYTONA_API_KEY/.test(r)))
    assert.ok(!rows(load({ ...baseConfig(), worker: { provider: "docker" } })).some((r) => r.endsWith("E2B_API_KEY")))
    assert.ok(!rows(load({ ...baseConfig(), worker: { provider: "daytona" } })).some((r) => r.endsWith("E2B_API_KEY")))
    assert.ok(!rows(load(baseConfig())).some((r) => r.endsWith("E2B_API_KEY")))
  } finally {
    if (saved === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = saved
  }
})

test("run records and the report carry provider e2b", () => {
  const record = createRunRecord({ repo: "me/app", issue: 1, runId: "1" })
  record.provider = workerProvider(load(e2bCfg()))
  endRun(record, "pr-opened")
  assert.equal(record.provider, "e2b")
  assert.ok(JSON.stringify(summarizeRecords([record]).byProvider).includes("e2b"))
})

// --- check-setup verification -------------------------------------------------

test("check-setup fails on a missing E2B_API_KEY and calls nothing", async () => {
  const { fetch, calls } = fakeFetch({})
  const result = await verifyE2B(load(e2bCfg()), { env: {}, fetch })
  assert.equal(result.ok, false)
  assert.equal(result.checks[0].id, "key")
  assert.match(result.checks[0].message, /E2B_API_KEY has no value/)
  assert.equal(calls.length, 0)
})

test("check-setup passes with a working key and a ready template, and never prints the key", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/v2/sandboxes`]: () => ({ json: [{ sandboxID: "sbx9", state: "running", metadata: { "create-ant-factory": "true", worker: "claude-01", name: "factory-claude-01-7" } }] }),
    [`GET ${API}/templates`]: () => ({ json: [{ templateID: "tpl123", aliases: ["caf-worker"], names: ["me/caf-worker"], buildStatus: "ready", envdVersion: "0.5.4" }] }),
  })
  const result = await verifyE2B(load(e2bCfg()), { env: ENV, fetch })
  assert.equal(result.ok, true, JSON.stringify(result.checks))
  assert.deepEqual(result.checks.map((c) => c.id), ["key", "api", "template"])
  assert.match(result.checks[1].message, /1 running: factory-claude-01-7/)
  assert.equal(calls[0].query.get("metadata"), "create-ant-factory=true")
  assert.deepEqual(calls[0].query.getAll("state"), ["running", "paused"])
  assert.equal(calls[0].headers["X-API-KEY"], ENV.E2B_API_KEY)
  assert.ok(!JSON.stringify(result).includes(ENV.E2B_API_KEY))
})

test("check-setup flags a rejected key, a missing or unbuilt template, and notes the default base", async () => {
  const rejected = await verifyE2B(load(e2bCfg()), { env: ENV, fetch: fakeFetch({ [`GET ${API}/v2/sandboxes`]: () => ({ status: 401, json: { message: "Invalid API key" } }) }).fetch })
  assert.equal(rejected.ok, false)
  assert.match(rejected.checks.at(-1).message, /refused the key/)

  const list = { [`GET ${API}/v2/sandboxes`]: () => ({ json: [] }) }
  const missing = await verifyE2B(load(e2bCfg()), { env: ENV, fetch: fakeFetch({ ...list, [`GET ${API}/templates`]: () => ({ json: [] }) }).fetch })
  assert.equal(missing.ok, false)
  assert.match(missing.checks.at(-1).message, /not found.*e2b template build --dockerfile worker\/Dockerfile/)

  const building = await verifyE2B(load(e2bCfg()), { env: ENV, fetch: fakeFetch({ ...list, [`GET ${API}/templates`]: () => ({ json: [{ templateID: "caf-worker", aliases: [], buildStatus: "building" }] }) }).fetch })
  assert.equal(building.ok, false)
  assert.match(building.checks.at(-1).message, /"building", not "ready"/)

  const base = await verifyE2B(load(e2bCfg({})), { env: ENV, fetch: fakeFetch({ ...list, [`GET ${API}/templates`]: () => ({ json: [] }) }).fetch })
  assert.equal(base.ok, true)
  assert.equal(base.checks.at(-1).status, "note")
  assert.match(base.checks.at(-1).message, /no agent CLIs/)
})

// --- request shapes -----------------------------------------------------------

test("create body: template, metadata, sliding timeout, never auto-paused, no secrets", () => {
  const body = buildE2BCreateBody(load(e2bCfg({ template: "caf-worker", timeoutMinutes: 45 })), { id: "claude-01" }, "run 42", { ...ENV, CLAUDE_CODE_OAUTH_TOKEN: "secret-token-value" })
  assert.deepEqual(body, {
    templateID: "caf-worker",
    timeout: 2700,
    autoPause: false,
    metadata: { "create-ant-factory": "true", worker: "claude-01", "run-id": "run-42", name: "factory-claude-01-run-42" },
  })
  assert.ok(!JSON.stringify(body).match(/e2b_|secret-token|TOKEN|KEY|envVars/), "no secrets or env in the create body")
})

test("dry run returns the exact request and needs neither a key nor the network", async () => {
  const { fetch, calls } = fakeFetch({})
  const handle = await createE2BWorker(load(e2bCfg()), { id: "claude-01", agent: "claude" }, "7", { dryRun: true, env: {}, fetch })
  assert.equal(handle.kind, "e2b")
  assert.equal(handle.dryRun, true)
  assert.equal(handle.request.method, "POST")
  assert.equal(handle.request.url, `${API}/v2/sandboxes`)
  assert.equal(handle.request.body.metadata.worker, "claude-01")
  assert.equal(calls.length, 0)
})

test("create: kills a same-run leftover, creates, prepares the workspace through envd", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/v2/sandboxes`]: () => ({ json: [{ sandboxID: "old1", state: "running", metadata: {} }] }),
    [`DELETE ${API}/sandboxes/old1`]: () => ({ status: 204 }),
    [`POST ${API}/v2/sandboxes`]: () => ({ status: 201, json: created }),
    [`POST ${ENVD}/process.Process/Start`]: () => ({ bytes: ran("", 0) }),
  })
  const handle = await createE2BWorker(load(e2bCfg()), { id: "claude-01", agent: "claude" }, "42", { env: ENV, fetch, sleep: async () => {} })
  assert.equal(handle.kind, "e2b")
  assert.equal(handle.id, "sbx1")
  assert.equal(handle.name, "factory-claude-01-42")
  assert.deepEqual(calls.map((c) => c.key), [`GET ${API}/v2/sandboxes`, `DELETE ${API}/sandboxes/old1`, `POST ${API}/v2/sandboxes`, `POST ${ENVD}/process.Process/Start`])
  assert.equal(new URLSearchParams(calls[0].query.get("metadata")).get("run-id"), "42")
  const create = calls[2]
  assert.equal(create.headers["X-API-KEY"], ENV.E2B_API_KEY)
  assert.equal(create.body.templateID, "caf-worker")
  const start = calls[3]
  assert.equal(start.headers["X-Access-Token"], "envd-token-abc")
  assert.equal(start.headers["X-API-KEY"], undefined, "the API key never goes to the sandbox")
  assert.equal(start.headers["Content-Type"], "application/connect+json")
  assert.equal(start.headers["Connect-Protocol-Version"], "1")
  assert.equal(start.headers.Authorization, undefined, "envd >= 0.4.0 picks its default user")
  assert.equal(start.body.process.cmd, "/bin/bash")
  assert.match(start.body.process.args[2], /^export HOME=\/workspace\/home; mkdir -p \/workspace\/home\/work/)
  assert.equal(start.body.stdin, false)
})

test("the sandbox's own domain wins for envd, and old envd gets the user header", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/v2/sandboxes`]: () => ({ json: [] }),
    [`POST ${API}/v2/sandboxes`]: () => ({ json: { ...created, envdVersion: "0.2.0", domain: "eu.e2b.example" } }),
    [`POST https://49983-sbx1.eu.e2b.example/process.Process/Start`]: () => ({ bytes: ran("", 0) }),
  })
  await createE2BWorker(load(e2bCfg()), { id: "claude-01" }, "42", { env: ENV, fetch, sleep: async () => {} })
  const start = calls.at(-1)
  assert.equal(start.headers.Authorization, `Basic ${Buffer.from("user:").toString("base64")}`)
  assert.equal(start.body.stdin, undefined, "envd < 0.3.0 cannot take stdin")
})

test("exec and file write: the envd requests sh() and agents.mjs rely on", async () => {
  const { fetch, calls } = fakeFetch({
    [`POST ${ENVD}/process.Process/Start`]: ({ body }) => ({ bytes: body.process.args[2].endsWith("false") ? ran("", 1) : ran("hello\n__EXIT__0", 0) }),
    [`POST ${ENVD}/files`]: () => ({ json: [{ name: "env", path: "/workspace/home/.factory/env", type: "file" }] }),
  })
  const sandbox = { ...created, envdUrl: ENVD }
  const handle = e2bHandle(e2bClient({ apiKey: ENV.E2B_API_KEY, apiUrl: API, fetch }), sandbox)
  const run = await handle.exec.command("echo 'it''s' && ls ~")
  assert.deepEqual(run, { result: "hello\n__EXIT__0", status: "completed" })
  assert.deepEqual(calls[0].body.process.args, ["-l", "-c", "export HOME=/workspace/home; echo 'it''s' && ls ~"], "no extra quoting: the command is one argv entry")
  assert.equal((await handle.exec.command("false")).status, "failed")

  await handle.files.write({ path: "/workspace/home/.factory/env", content: "export A='b'\n" })
  const upload = calls.at(-1)
  assert.equal(upload.query.get("path"), "/workspace/home/.factory/env")
  assert.equal(upload.query.get("username"), null)
  assert.equal(upload.headers["X-Access-Token"], "envd-token-abc")
  assert.ok(upload.body instanceof FormData)
  assert.equal(await upload.body.get("file").text(), "export A='b'\n")
  assert.equal(upload.headers["Content-Type"], undefined, "FormData sets its own multipart boundary")
})

test("Connect framing round-trips, stderr is kept, and a stream error or missing end throws", () => {
  assert.deepEqual(parseConnectFrames(connectFrame({ a: 1 })), { messages: [{ a: 1 }], end: null })
  const mixed = stream({ event: { data: { stdout: b64("out ") } } }, { event: { data: { stderr: b64("err") } } }, { event: { end: { exitCode: 2 } } })
  assert.deepEqual(processResult(parseConnectFrames(mixed)), { result: "out err", exitCode: 2 })
  const failed = connectFrame({ error: { code: "unavailable", message: "sandbox not found" } })
  failed[0] = 0x02
  assert.throws(() => processResult(parseConnectFrames(failed)), /unavailable: sandbox not found/)
  assert.throws(() => processResult(parseConnectFrames(stream({ event: { start: { pid: 1 } } }))), /without an end event/)
  assert.deepEqual(e2bStartRequest("ls", "0.5.0"), { process: { cmd: "/bin/bash", args: ["-l", "-c", "export HOME=/workspace/home; ls"] }, stdin: false })
  assert.equal(versionAtLeast("0.10.0", "0.4.0"), true)
  assert.equal(versionAtLeast("0.3.9", "0.4.0"), false)
})

test("a live job keeps its sandbox alive: commands extend the timeout at most once a minute", async () => {
  let clock = 0
  const { fetch, calls } = fakeFetch({
    [`POST ${ENVD}/process.Process/Start`]: () => ({ bytes: ran("", 0) }),
    [`POST ${API}/sandboxes/sbx1/timeout`]: () => ({ status: 204 }),
  })
  const handle = e2bHandle(e2bClient({ apiKey: ENV.E2B_API_KEY, apiUrl: API, fetch }), { ...created, envdUrl: ENVD }, { timeoutMinutes: 20, now: () => clock })
  await handle.exec.command("true")
  clock = 30_000
  await handle.exec.command("true")
  clock = 61_000
  await handle.exec.command("true")
  const refreshes = calls.filter((c) => c.key === `POST ${API}/sandboxes/sbx1/timeout`)
  assert.equal(refreshes.length, 1)
  assert.deepEqual(refreshes[0].body, { timeout: 1200 })
  assert.equal(refreshes[0].headers["X-API-KEY"], ENV.E2B_API_KEY)
})

// --- teardown -----------------------------------------------------------------

test("a sandbox whose workspace cannot be prepared is killed before the error is thrown", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/v2/sandboxes`]: () => ({ json: [] }),
    [`POST ${API}/v2/sandboxes`]: () => ({ json: created }),
    [`POST ${ENVD}/process.Process/Start`]: () => ({ bytes: ran("Permission denied", 1) }),
    [`DELETE ${API}/sandboxes/sbx1`]: () => ({ status: 204 }),
  })
  await assert.rejects(createE2BWorker(load(e2bCfg()), { id: "claude-01" }, "42", { env: ENV, fetch, sleep: async () => {} }), /not writable: Permission denied/)
  assert.equal(calls.at(-1).key, `DELETE ${API}/sandboxes/sbx1`)
})

test("envd that never answers: retried briefly, then the sandbox is killed", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/v2/sandboxes`]: () => ({ json: [] }),
    [`POST ${API}/v2/sandboxes`]: () => ({ json: created }),
    [`POST ${ENVD}/process.Process/Start`]: () => ({ status: 502, text: "port not open" }),
    [`DELETE ${API}/sandboxes/sbx1`]: () => ({ status: 204 }),
  })
  await assert.rejects(createE2BWorker(load(e2bCfg()), { id: "claude-01" }, "42", { env: ENV, fetch, sleep: async () => {} }), /HTTP 502/)
  assert.equal(calls.filter((c) => c.key.endsWith("/process.Process/Start")).length, 5)
  assert.equal(calls.at(-1).key, `DELETE ${API}/sandboxes/sbx1`)
})

test("release kills the sandbox, and a failed kill only warns", async () => {
  const { fetch, calls } = fakeFetch({ [`DELETE ${API}/sandboxes/sbx1`]: () => ({ status: 204 }) })
  await removeE2BWorker(e2bHandle(e2bClient({ apiKey: ENV.E2B_API_KEY, apiUrl: API, fetch }), { ...created, envdUrl: ENVD }))
  assert.equal(calls.at(-1).key, `DELETE ${API}/sandboxes/sbx1`)

  const broken = e2bHandle(e2bClient({ apiKey: ENV.E2B_API_KEY, apiUrl: API, fetch: fakeFetch({ [`DELETE ${API}/sandboxes/sbx1`]: () => ({ status: 500, text: "boom" }) }).fetch }), { ...created, envdUrl: ENVD })
  const warn = console.warn
  let warned = ""
  console.warn = (text) => (warned = text)
  try {
    await removeE2BWorker(broken)
  } finally {
    console.warn = warn
  }
  assert.match(warned, /Could not kill E2B sandbox.*expires on its own/)
})

// --- busy detection -----------------------------------------------------------

test("listing follows X-Next-Token pages and only running sandboxes mark a worker busy", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/v2/sandboxes`]: ({ url }) => url.searchParams.get("nextToken")
      ? { json: [{ sandboxID: "sbx3", state: "paused", metadata: { worker: "codex-01", name: "factory-codex-01-9" } }] }
      : { json: [{ sandboxID: "sbx2", state: "running", metadata: { worker: "claude-01", name: "factory-claude-01-7" } }], headers: { "X-Next-Token": "t2" } },
  })
  const config = load({ ...e2bCfg(), workers: [{ id: "claude-01", agent: "claude" }, { id: "codex-01", agent: "claude" }, { id: "off-01", agent: "claude", enabled: false }] })
  const rows = await listE2BWorkers(config, { env: ENV, fetch })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].query.get("nextToken"), "t2")
  const states = daytonaWorkerStates(config, rows)
  assert.deepEqual(states.map((w) => [w.id, w.state, w.boxName]), [["claude-01", "busy", "factory-claude-01-7"], ["codex-01", "free", "factory-codex-01"], ["off-01", "disabled", "factory-off-01"]])
  assert.deepEqual(e2bSandboxesForWorker(rows, "codex-01").map((r) => r.id), ["sbx3"], "release-worker also sees paused leftovers")
  assert.equal(isBusyState("running"), true)
  assert.equal(isBusyState("paused"), false)
})

test("the client refuses to start without a key", () => {
  assert.throws(() => e2bClient({ apiUrl: API, fetch: async () => ({}) }), /E2B_API_KEY is not set/)
})
