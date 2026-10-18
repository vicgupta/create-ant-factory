// E2B worker provider: one E2B sandbox per job, created through E2B's public
// REST API and killed when the job ends.
//
// Like src/docker.mjs and src/daytona.mjs, the handle returned here exposes
// only the primitives the rest of the factory uses on a Box —
// exec.command() and files.write() — so src/box.mjs's sh()/runScript() and
// src/agents.mjs drive a sandbox without knowing it is one.
//
// The HTTP layer is deliberately thin and isolated in e2bClient() below, and
// every request goes through an injectable `fetch`, so the tests pin the
// request shapes without an E2B account. No SDK dependency. The endpoints
// follow the official JS SDK (the `e2b` package, 2.55) and its OpenAPI types:
//
//   control plane, header X-API-KEY: $E2B_API_KEY
//   POST   {apiUrl}/v2/sandboxes                        create (NewSandboxV2 body) -> { sandboxID, envdVersion, envdAccessToken, domain }
//   POST   {apiUrl}/sandboxes/{id}/timeout              { timeout } seconds from now (the sliding TTL below)
//   GET    {apiUrl}/v2/sandboxes?metadata=&state=&limit=&nextToken=   ListedSandbox[], next page in the X-Next-Token header
//   DELETE {apiUrl}/sandboxes/{id}                      kill (404 = already gone)
//   GET    {apiUrl}/templates                           the team's templates (check-setup only)
//
//   in the sandbox (envd on port 49983), header X-Access-Token: <envdAccessToken from create>
//   POST   https://49983-{id}.{domain}/process.Process/Start   Connect server-stream, JSON codec
//   POST   https://49983-{id}.{domain}/files?path=             multipart field "file"
//
// The API key is read from the environment only, never from
// factory.config.json, and is never sent into the sandbox. The envd access
// token is per-sandbox and dies with it.
//
// Safety shape, by construction:
//   - no secrets in the create body; secrets are written inside the running
//     sandbox at job time by agents.mjs, exactly as for a Box or container
//   - autoPause: false and a short sliding timeout (worker.e2b.timeoutMinutes,
//     default 30): every command the job sends pushes the deadline out, so a
//     live job never expires, and a sandbox a killed runner left behind is
//     killed by E2B within timeoutMinutes. No billed orphan outlives that.
//   - the sandbox is killed when the job ends, success or failure, and when
//     its workspace cannot be prepared
import { e2bConfig } from "./config.mjs"

export const E2B_LABEL = "create-ant-factory"
export const ENVD_PORT = 49983
const HOME = "/workspace/home"
const EXEC_TIMEOUT_SECONDS = 600
const PAGE_LIMIT = 100
const MAX_PAGES = 20
// Refresh the sandbox's timeout at most this often. runScript() polls every
// 10s, so a running job refreshes about once a minute.
const REFRESH_EVERY_MS = 60_000

// Only a running sandbox marks its worker busy. A paused one (someone paused
// it by hand; the factory never does) is a leftover that
// scripts/release-worker.mjs kills.
const IDLE_STATES = new Set(["paused", "pausing", "killed", "killing"])
export const isBusyState = (state) => !IDLE_STATES.has(String(state ?? "").toLowerCase())

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sanitize = (value) => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "worker"

// "0.4.1" >= "0.4.0"? Missing or odd versions count as new.
export function versionAtLeast(version, minimum) {
  const parse = (v) => String(v ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0)
  const [a, b] = [parse(version), parse(minimum)]
  if (!version) return true
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

export class E2BApiError extends Error {
  constructor(method, path, status, detail) {
    super(`E2B API ${method} ${path} failed with HTTP ${status}${detail ? `: ${String(detail).trim().slice(0, 300)}` : ""}`)
    this.status = status
  }
}

// One sandbox per job. E2B sandboxes have no free-form name, so the
// factory's name for it travels in metadata (and shows in the E2B dashboard).
export function sandboxNameFor(config, worker, runId) {
  return sanitize(`${config.factory.boxNamePrefix ?? "factory-"}${worker.id}-${runId}`)
}

export function sandboxMetadata(config, worker, runId) {
  return { [E2B_LABEL]: "true", worker: worker.id, "run-id": sanitize(runId), name: sandboxNameFor(config, worker, runId) }
}

// Pure: the exact create body. Tested in tests/e2b.test.mjs and printed by
// src/plan.mjs as the dry run. Nothing secret goes in here.
export function buildE2BCreateBody(config, worker, runId, env = process.env) {
  const e2b = e2bConfig(config, env)
  return {
    templateID: e2b.template,
    timeout: e2b.timeoutMinutes * 60,
    autoPause: false,
    metadata: sandboxMetadata(config, worker, runId),
  }
}

// Pure: the Connect StartRequest for one command. bash gets the command as
// one argument, so nothing needs shell quoting on the way in; HOME is pinned
// so ~ means /workspace/home as it does in a Box.
export function e2bStartRequest(command, envdVersion) {
  const request = { process: { cmd: "/bin/bash", args: ["-l", "-c", `export HOME=${HOME}; ${command}`] } }
  if (versionAtLeast(envdVersion, "0.3.0")) request.stdin = false
  return request
}

// Connect protocol framing (https://connectrpc.com/docs/protocol): every
// message in a streaming body is 1 flag byte, a 4-byte big-endian length and
// the JSON. Flag 0x02 marks the end-of-stream message, which carries an
// error when the call failed.
export function connectFrame(message) {
  const json = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(5 + json.length)
  frame[0] = 0
  new DataView(frame.buffer).setUint32(1, json.length, false)
  frame.set(json, 5)
  return frame
}

export function parseConnectFrames(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const decoder = new TextDecoder()
  const messages = []
  let end = null
  for (let offset = 0; offset + 5 <= data.length; ) {
    const flags = data[offset]
    const length = view.getUint32(offset + 1, false)
    const json = decoder.decode(data.subarray(offset + 5, offset + 5 + length))
    offset += 5 + length
    const value = json ? JSON.parse(json) : {}
    if (flags & 0x02) end = value
    else messages.push(value)
  }
  return { messages, end }
}

const fromBase64 = (value) => (value ? Buffer.from(value, "base64").toString("utf8") : "")

// Pure: { result, exitCode } from the Start stream's messages. stdout and
// stderr are kept in arrival order, like a terminal (sh() merges 2>&1
// anyway). proto3 JSON leaves a zero exitCode out, so a missing one on the
// end event means 0.
export function processResult({ messages, end }) {
  if (end?.error) throw new Error(`E2B process call failed: ${end.error.code ?? "error"}${end.error.message ? `: ${end.error.message}` : ""}`)
  let result = ""
  let exitCode = null
  for (const message of messages) {
    const event = message?.event ?? {}
    if (event.data) result += fromBase64(event.data.stdout) + fromBase64(event.data.stderr)
    if (event.end) {
      exitCode = Number(event.end.exitCode ?? 0)
      if (event.end.error && !result.endsWith(event.end.error)) result += event.end.error
    }
  }
  if (exitCode === null) throw new Error("E2B process stream ended without an end event (the sandbox may have been killed or timed out)")
  return { result, exitCode }
}

// The thin HTTP layer. `fetch` is injectable; nothing else here talks to
// the network.
export function e2bClient({ apiKey, apiUrl, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error("E2B_API_KEY is not set. Create an API key in the E2B dashboard and put it in .env (and in the factory repo's secrets for Actions)")
  const base = String(apiUrl ?? "https://api.e2b.app").replace(/\/+$/, "")
  const enc = encodeURIComponent

  async function raw(method, url, { headers: extra = {}, json, body, allow = [], timeoutMs = 60_000 } = {}) {
    const headers = { Accept: "application/json", ...extra }
    const init = { method, headers }
    if (json !== undefined) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(json)
    } else if (body !== undefined) {
      init.body = body // FormData sets its own multipart Content-Type
    }
    if (typeof AbortSignal?.timeout === "function") init.signal = AbortSignal.timeout(timeoutMs)
    const response = await fetchImpl(url, init)
    if (!response.ok && !allow.includes(response.status)) {
      const detail = await response.text().catch(() => "")
      throw new E2BApiError(method, url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, ""), response.status, detail)
    }
    return response
  }
  async function call(method, url, options = {}) {
    const response = await raw(method, url, { ...options, headers: { "X-API-KEY": apiKey, ...(options.headers ?? {}) } })
    if (!response.ok) return null
    const text = await response.text().catch(() => "")
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  const envdHeaders = (sandbox) => ({
    ...(sandbox.envdAccessToken ? { "X-Access-Token": sandbox.envdAccessToken } : {}),
    // envd before 0.4.0 has no default user; the SDK sends "user" then.
    ...(versionAtLeast(sandbox.envdVersion, "0.4.0") ? {} : { Authorization: `Basic ${Buffer.from("user:").toString("base64")}` }),
  })

  return {
    apiUrl: base,
    createSandbox: (body) => call("POST", `${base}/v2/sandboxes`, { json: body, timeoutMs: 120_000 }),
    setTimeout: (id, seconds) => call("POST", `${base}/sandboxes/${enc(id)}/timeout`, { json: { timeout: seconds } }),
    // Killing is idempotent here: a sandbox that is already gone is fine.
    killSandbox: (id) => call("DELETE", `${base}/sandboxes/${enc(id)}`, { allow: [404] }),
    listTemplates: () => call("GET", `${base}/templates`),
    // Every running or paused sandbox whose metadata carries all of
    // `metadata`, across pages (the next page token comes in a header).
    async listSandboxes(metadata) {
      const items = []
      let nextToken = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ metadata: new URLSearchParams(Object.entries(metadata).map(([k, v]) => [enc(k), enc(v)])).toString(), limit: String(PAGE_LIMIT) })
        query.append("state", "running")
        query.append("state", "paused")
        if (nextToken) query.set("nextToken", nextToken)
        const response = await raw("GET", `${base}/v2/sandboxes?${query}`, { headers: { "X-API-KEY": apiKey } })
        const text = await response.text().catch(() => "")
        items.push(...(text ? JSON.parse(text) : []))
        nextToken = response.headers?.get?.("x-next-token") || null
        if (!nextToken) break
      }
      return items
    },
    async execute(sandbox, command, timeoutSeconds = EXEC_TIMEOUT_SECONDS) {
      const response = await raw("POST", `${sandbox.envdUrl}/process.Process/Start`, {
        headers: {
          ...envdHeaders(sandbox),
          "Content-Type": "application/connect+json",
          "Connect-Protocol-Version": "1",
          "Connect-Timeout-Ms": String(timeoutSeconds * 1000),
          "Keepalive-Ping-Interval": "50",
        },
        body: connectFrame(e2bStartRequest(command, sandbox.envdVersion)),
        timeoutMs: (timeoutSeconds + 30) * 1000,
      })
      return processResult(parseConnectFrames(new Uint8Array(await response.arrayBuffer())))
    },
    upload(sandbox, path, content) {
      const form = new FormData()
      form.append("file", new Blob([content]), path)
      const query = new URLSearchParams({ path })
      if (!versionAtLeast(sandbox.envdVersion, "0.4.0")) query.set("username", "user")
      return raw("POST", `${sandbox.envdUrl}/files?${query}`, { headers: envdHeaders(sandbox), body: form, timeoutMs: 120_000 })
    },
  }
}

// A started sandbox, shaped like the subset of a Box the factory uses.
// Every command first pushes the sandbox's timeout out again (at most once a
// minute), so a live job never expires mid-run and a dead one expires soon.
export function e2bHandle(client, sandbox, { timeoutMinutes = 30, now = Date.now } = {}) {
  const id = sandbox.sandboxID
  let refreshedAt = now()
  async function keepAlive() {
    if (now() - refreshedAt < REFRESH_EVERY_MS) return
    refreshedAt = now()
    try {
      await client.setTimeout(id, timeoutMinutes * 60)
    } catch (error) {
      console.warn(`Could not extend E2B sandbox ${id}'s timeout: ${error.message}. The job goes on; it fails if the sandbox expires.`)
    }
  }
  return {
    kind: "e2b",
    id,
    name: sandbox.name ?? id,
    exec: {
      async command(command) {
        await keepAlive()
        const { result, exitCode } = await client.execute(sandbox, command)
        return { result, status: exitCode === 0 ? "completed" : "failed" }
      },
    },
    files: {
      async write({ path, content }) {
        await keepAlive()
        await client.upload(sandbox, path, content)
      },
    },
    // No Upstash browser in an E2B sandbox. startBrowser() in box.mjs checks
    // `kind` first, so this is only a guard for other callers.
    browser: {
      async listTabs() { throw new Error("browser is not enabled for this box") },
      tab: { async create() { throw new Error("browser is not enabled for this box") } },
    },
    remove: () => client.killSandbox(id),
  }
}

const READY_COMMAND = `mkdir -p ${HOME}/work ${HOME}/.factory 2>/dev/null || { sudo -n mkdir -p ${HOME}/work ${HOME}/.factory && sudo -n chown -R "$(id -u):$(id -g)" ${HOME}; }`

// Starts the job's sandbox and returns its handle. With dryRun it starts
// nothing and needs no key: it returns the handle-to-be plus the exact
// create request, which is how plan.mjs (and the tests) verify it without
// an E2B account. Any failure after the sandbox exists kills it before the
// error is thrown, so a failed start never leaves a billed sandbox.
export async function createE2BWorker(config, worker, runId, { dryRun = false, env = process.env, fetch, sleep = sleepFor, now } = {}) {
  const e2b = e2bConfig(config, env)
  const body = buildE2BCreateBody(config, worker, runId, env)
  const name = body.metadata.name
  if (dryRun) return { kind: "e2b", id: name, name, dryRun: true, request: { method: "POST", url: `${e2b.apiUrl}/v2/sandboxes`, body } }

  const client = e2bClient({ apiKey: env.E2B_API_KEY, apiUrl: e2b.apiUrl, fetch })
  // A leftover from a killed attempt of the same run. Best effort: a failure
  // here must not stop a job that would otherwise work.
  try {
    const leftovers = await client.listSandboxes({ [E2B_LABEL]: "true", worker: worker.id, "run-id": body.metadata["run-id"] })
    for (const leftover of leftovers) await client.killSandbox(leftover.sandboxID).catch(() => {})
  } catch {}
  const created = await client.createSandbox(body)
  if (!created?.sandboxID) throw new Error(`E2B did not return a sandbox for worker ${worker.id}`)
  const sandbox = { ...created, name, envdUrl: `https://${ENVD_PORT}-${created.sandboxID}.${created.domain || e2b.domain}` }
  try {
    const handle = e2bHandle(client, sandbox, { timeoutMinutes: e2b.timeoutMinutes, now })
    // envd can take a moment to answer right after create; retry briefly.
    let ready
    for (let attempt = 1; ; attempt++) {
      try {
        ready = await handle.exec.command(READY_COMMAND)
        break
      } catch (error) {
        if (attempt >= 5 || (error.status && ![502, 503, 504].includes(error.status))) throw error
        await sleep(1000 * attempt)
      }
    }
    if (ready.status !== "completed") throw new Error(`E2B sandbox ${name} started but ${HOME} is not writable: ${ready.result.trim().slice(-300)}`)
    return handle
  } catch (error) {
    await client.killSandbox(created.sandboxID).catch(() => {})
    throw error
  }
}

// Killing is the cleanup: workspace, sign-in files and the sandbox all go.
export async function removeE2BWorker(handle) {
  if (!handle?.remove) return
  try {
    await handle.remove()
  } catch (error) {
    console.warn(`Could not kill E2B sandbox ${handle.name ?? handle.id}: ${error.message}. Kill it in the E2B dashboard, or run scripts/release-worker.mjs for its worker. It also expires on its own within worker.e2b.timeoutMinutes.`)
  }
}

// Factory sandboxes as plain rows { id, name, state, busy, labels }. Throws
// when the API is unreachable so a run fails loudly instead of
// double-claiming a worker.
export async function listE2BWorkers(config, { env = process.env, fetch } = {}) {
  const client = e2bClient({ apiKey: env.E2B_API_KEY, apiUrl: e2bConfig(config, env).apiUrl, fetch })
  const sandboxes = await client.listSandboxes({ [E2B_LABEL]: "true" })
  return sandboxes.map((s) => ({ id: s.sandboxID, name: s.metadata?.name ?? s.sandboxID, state: s.state ?? "unknown", busy: isBusyState(s.state), labels: s.metadata ?? {} }))
}

// Pure: the rows that belong to one worker (busy or not).
export function e2bSandboxesForWorker(rows, workerId) {
  return rows.filter((row) => row.labels?.worker === workerId)
}

// Kills every factory sandbox of one worker. scripts/release-worker.mjs.
export async function killE2BSandboxes(config, rows, { env = process.env, fetch } = {}) {
  const client = e2bClient({ apiKey: env.E2B_API_KEY, apiUrl: e2bConfig(config, env).apiUrl, fetch })
  for (const row of rows) await client.killSandbox(row.id)
}

// Pure: does a template row match a configured name or id?
const templateMatches = (template, wanted) =>
  [template.templateID, ...(template.aliases ?? []), ...(template.names ?? [])].some((n) => n === wanted || String(n).split("/").pop() === wanted)

// Shared E2B verification for scripts/check-setup.mjs. Read-only: it
// creates nothing. Each step is { id, status: "ok"|"fail"|"note", message }.
//   key (E2B_API_KEY set) -> api (the key lists sandboxes) -> template
export async function verifyE2B(config, { env = process.env, fetch } = {}) {
  const e2b = e2bConfig(config, env)
  const checks = []
  const add = (id, status, message) => checks.push({ id, status, message })
  const done = () => ({ ok: !checks.some((c) => c.status === "fail"), problems: checks.filter((c) => c.status === "fail").length, checks, apiUrl: e2b.apiUrl })

  if (!env.E2B_API_KEY) {
    add("key", "fail", `worker.provider is "e2b" but E2B_API_KEY has no value. Create an API key in the E2B dashboard (Team > API keys) and put it in .env, then run scripts/set-secrets.mjs so Actions gets it too`)
    return done()
  }
  add("key", "ok", `E2B_API_KEY is set (${env.E2B_API_KEY.length} characters); API: ${e2b.apiUrl}, sandbox timeout ${e2b.timeoutMinutes} min (sliding)`)

  const client = e2bClient({ apiKey: env.E2B_API_KEY, apiUrl: e2b.apiUrl, fetch })
  try {
    const sandboxes = await client.listSandboxes({ [E2B_LABEL]: "true" })
    const busy = sandboxes.filter((s) => isBusyState(s.state))
    add("api", "ok", `the E2B key works. ${sandboxes.length} factory sandbox(es) exist${busy.length ? `, ${busy.length} running: ${busy.map((s) => s.metadata?.name ?? s.sandboxID).join(", ")}` : " (none running is normal between jobs)"}`)
  } catch (error) {
    add("api", "fail", `the E2B API at ${e2b.apiUrl} refused the key or is unreachable: ${error.message}. Check E2B_API_KEY and E2B_DOMAIN / E2B_API_URL / worker.e2b`)
    return done()
  }

  const buildHint = `build it from worker/Dockerfile with the E2B CLI (e2b template build --dockerfile worker/Dockerfile --name ${e2b.template === "base" ? "create-ant-factory-worker" : e2b.template}) or the E2B Template SDK, then set worker.e2b.template`
  let templates
  try {
    templates = (await client.listTemplates()) ?? []
  } catch (error) {
    add("template", "fail", `could not list E2B templates: ${error.message}`)
    return done()
  }
  const template = (Array.isArray(templates) ? templates : []).find((t) => templateMatches(t, e2b.template))
  if (!template && e2b.template === "base") {
    add("template", "note", `worker.e2b.template is "base" (the default): sandboxes start from E2B's public base image, which has no agent CLIs. To get the worker image, ${buildHint}`)
  } else if (!template) {
    add("template", "fail", `template "${e2b.template}" was not found on this E2B team. To create it, ${buildHint}`)
  } else if (template.buildStatus && String(template.buildStatus).toLowerCase() !== "ready") {
    add("template", "fail", `template "${e2b.template}" is "${template.buildStatus}", not "ready". Wait for the build to finish, or build it again`)
  } else {
    add("template", "ok", `template "${e2b.template}" is ready${template.envdVersion ? ` (envd ${template.envdVersion})` : ""}`)
  }
  return done()
}
