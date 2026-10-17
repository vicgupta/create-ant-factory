// Daytona worker provider: one Daytona sandbox per job, created through
// Daytona's public REST API and deleted when the job ends.
//
// Like src/docker.mjs, the handle returned here exposes only the primitives
// the rest of the factory uses on a Box — exec.command() and files.write() —
// so src/box.mjs's sh()/runScript() and src/agents.mjs drive a sandbox
// without knowing it is one. Box-only things (labels as claims, pause,
// Upstash browser, snapshots built by scripts/build-snapshot.mjs) stay in the
// Box path.
//
// The HTTP layer is deliberately thin and isolated in daytonaClient() below,
// and every request goes through an injectable `fetch`, so the tests pin the
// request shapes without a Daytona account. The endpoints follow Daytona's
// published API clients (@daytonaio/api-client and
// @daytonaio/toolbox-api-client 0.225, the ones the official SDK uses):
//
//   POST   {apiUrl}/sandbox                             create (CreateSandbox body)
//   GET    {apiUrl}/sandbox/{idOrName}                  state, errorReason, toolboxProxyUrl
//   GET    {apiUrl}/sandbox/{id}/toolbox-proxy-url      { url }, when the sandbox omits it
//   GET    {apiUrl}/sandbox?labels=<json>&limit=&cursor=  { items, nextCursor }
//   DELETE {apiUrl}/sandbox/{idOrName}                  teardown
//   GET    {apiUrl}/snapshots/{idOrName}                snapshot state (check-setup only)
//   POST   {toolboxProxyUrl}/{id}/process/execute       { command, timeout } -> { exitCode, result }
//   POST   {toolboxProxyUrl}/{id}/files/upload-v2?path= multipart field "file"
//
// Every request carries Authorization: Bearer $DAYTONA_API_KEY. The key is
// read from the environment only, never from factory.config.json, and it is
// never sent into the sandbox.
//
// Safety shape, by construction in buildDaytonaCreateBody():
//   - no secrets in the create body; secrets are written inside the running
//     sandbox at job time by agents.mjs, exactly as for a Box or container
//   - public: false (no public preview links)
//   - autoDeleteInterval 0 with an autoStopInterval: a sandbox a killed runner
//     left behind stops once idle and then deletes itself
//   - the sandbox is deleted when the job ends, success or failure
import { daytonaConfig } from "./config.mjs"

export const DAYTONA_LABEL = "create-ant-factory"
const HOME = "/workspace/home"
const EXEC_TIMEOUT_SECONDS = 600
const PAGE_LIMIT = 100
const MAX_PAGES = 20

// A sandbox in one of these states no longer marks its worker busy. A
// stopped one that has not deleted itself yet is still removed by
// scripts/release-worker.mjs, like a stopped Docker container.
const IDLE_STATES = new Set(["stopped", "stopping", "archived", "archiving", "destroyed", "destroying", "error", "build_failed"])
export const isBusyState = (state) => !IDLE_STATES.has(String(state ?? "").toLowerCase())

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
const sanitize = (value) => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "worker"

export class DaytonaApiError extends Error {
  constructor(method, path, status, detail) {
    super(`Daytona API ${method} ${path} failed with HTTP ${status}${detail ? `: ${String(detail).trim().slice(0, 300)}` : ""}`)
    this.status = status
  }
}

// One sandbox per job, named after the worker and the run so a stuck one is
// easy to find in the Daytona dashboard (and by scripts/release-worker.mjs,
// which finds them by label).
export function sandboxNameFor(config, worker, runId) {
  return sanitize(`${config.factory.boxNamePrefix ?? "factory-"}${worker.id}-${runId}`)
}

// Pure: the exact CreateSandbox body. Tested in tests/daytona.test.mjs and
// printed by src/plan.mjs as the dry run. Nothing secret goes in here: the
// body is visible to anyone who can read the sandbox in the dashboard.
export function buildDaytonaCreateBody(config, worker, runId, env = process.env) {
  const daytona = daytonaConfig(config, env)
  const body = {
    name: sandboxNameFor(config, worker, runId),
    labels: { [DAYTONA_LABEL]: "true", worker: worker.id, "run-id": sanitize(runId) },
    env: { HOME },
    public: false,
    autoStopInterval: daytona.autoStopMinutes,
    autoDeleteInterval: 0,
  }
  if (daytona.snapshot) body.snapshot = daytona.snapshot
  if (daytona.target) body.target = daytona.target
  return body
}

// Every toolbox command runs through sh -c with HOME pinned, so a command
// behaves the same whether the daemon runs it through a shell or splits it
// into arguments, and ~ means /workspace/home as it does in a Box.
export function daytonaExecCommand(command) {
  return `sh -c ${shellQuote(`export HOME=${HOME}; ${command}`)}`
}

// The thin HTTP layer. `fetch` is injectable; nothing else here talks to
// the network.
export function daytonaClient({ apiKey, apiUrl, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error("DAYTONA_API_KEY is not set. Create an API key in the Daytona dashboard and put it in .env (and in the factory repo's secrets for Actions)")
  const base = String(apiUrl ?? "https://app.daytona.io/api").replace(/\/+$/, "")
  const enc = encodeURIComponent

  async function call(method, url, { json, body, allow = [], timeoutMs = 60_000 } = {}) {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
    const init = { method, headers }
    if (json !== undefined) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(json)
    } else if (body !== undefined) {
      init.body = body // FormData sets its own multipart Content-Type
    }
    if (typeof AbortSignal?.timeout === "function") init.signal = AbortSignal.timeout(timeoutMs)
    const response = await fetchImpl(url, init)
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "")
    if (!response.ok && !allow.includes(response.status)) {
      const detail = await response.text().catch(() => "")
      throw new DaytonaApiError(method, path, response.status, detail)
    }
    if (!response.ok) return null
    const text = await response.text().catch(() => "")
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  const toolbox = (proxyUrl, id) => `${String(proxyUrl).replace(/\/+$/, "")}/${enc(id)}`

  return {
    apiUrl: base,
    createSandbox: (body) => call("POST", `${base}/sandbox`, { json: body, timeoutMs: 120_000 }),
    getSandbox: (idOrName) => call("GET", `${base}/sandbox/${enc(idOrName)}`),
    getToolboxProxyUrl: async (id) => (await call("GET", `${base}/sandbox/${enc(id)}/toolbox-proxy-url`))?.url ?? null,
    getSnapshot: (idOrName) => call("GET", `${base}/snapshots/${enc(idOrName)}`, { allow: [404] }),
    // Deleting is idempotent here: a sandbox that is already gone is fine.
    deleteSandbox: (idOrName) => call("DELETE", `${base}/sandbox/${enc(idOrName)}`, { allow: [404] }),
    // Every sandbox carrying all of `labels`, across pages. Older API
    // versions answered with a plain array; both shapes are read.
    async listSandboxes(labels) {
      const items = []
      let cursor = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ labels: JSON.stringify(labels), limit: String(PAGE_LIMIT) })
        if (cursor) query.set("cursor", cursor)
        const result = await call("GET", `${base}/sandbox?${query}`)
        if (Array.isArray(result)) return [...items, ...result]
        items.push(...(result?.items ?? []))
        cursor = result?.nextCursor ?? null
        if (!cursor) break
      }
      return items
    },
    execute: (proxyUrl, id, command, timeoutSeconds = EXEC_TIMEOUT_SECONDS) =>
      call("POST", `${toolbox(proxyUrl, id)}/process/execute`, { json: { command, timeout: timeoutSeconds }, timeoutMs: (timeoutSeconds + 30) * 1000 }),
    upload(proxyUrl, id, path, content) {
      const form = new FormData()
      form.append("file", new Blob([content]), path.slice(path.lastIndexOf("/") + 1) || "file")
      return call("POST", `${toolbox(proxyUrl, id)}/files/upload-v2?${new URLSearchParams({ path })}`, { body: form, timeoutMs: 120_000 })
    },
  }
}

// A started sandbox, shaped like the subset of a Box the factory uses.
export function daytonaHandle(client, sandbox) {
  const id = sandbox.id
  const proxyUrl = sandbox.toolboxProxyUrl
  return {
    kind: "daytona",
    id,
    name: sandbox.name ?? id,
    exec: {
      async command(command) {
        const response = await client.execute(proxyUrl, id, daytonaExecCommand(command))
        const code = Number(response?.exitCode ?? response?.code ?? 0)
        return { result: response?.result ?? "", status: code === 0 ? "completed" : "failed" }
      },
    },
    files: {
      async write({ path, content }) {
        await client.upload(proxyUrl, id, path, content)
      },
    },
    // No Upstash browser in a Daytona sandbox. startBrowser() in box.mjs
    // checks `kind` first, so this is only a guard for other callers.
    browser: {
      async listTabs() { throw new Error("browser is not enabled for this box") },
      tab: { async create() { throw new Error("browser is not enabled for this box") } },
    },
    remove: () => client.deleteSandbox(id),
  }
}

// Polls until the sandbox is started. A snapshot that is still being pulled
// can take a minute or two on first use, hence the configurable timeout.
export async function waitUntilStarted(client, sandbox, { timeoutMs, sleep = sleepFor, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let current = sandbox
  for (;;) {
    const state = String(current?.state ?? "").toLowerCase()
    if (state === "started") return current
    if (["error", "build_failed", "destroyed", "destroying"].includes(state)) {
      throw new Error(`Daytona sandbox ${current.name ?? current.id} did not start: state "${state}"${current.errorReason ? ` (${current.errorReason})` : ""}`)
    }
    if (Date.now() >= deadline) throw new Error(`Daytona sandbox ${current?.name ?? current?.id} was not started within ${Math.round(timeoutMs / 60000)} minute(s) (last state "${state || "unknown"}"). Raise worker.daytona.startTimeoutMinutes if the snapshot is large`)
    await sleep(pollMs)
    current = await client.getSandbox(current.id)
  }
}

const READY_COMMAND = `mkdir -p ${HOME}/work ${HOME}/.factory 2>/dev/null || { sudo -n mkdir -p ${HOME}/work ${HOME}/.factory && sudo -n chown -R "$(id -u):$(id -g)" ${HOME}; }`

// Starts the job's sandbox and returns its handle. With dryRun it starts
// nothing and needs no key: it returns the handle-to-be plus the exact
// create request, which is how plan.mjs (and the tests) verify it without a
// Daytona account. Any failure after the sandbox exists deletes it before
// the error is thrown, so a failed start never leaves a billed sandbox.
export async function createDaytonaWorker(config, worker, runId, { dryRun = false, env = process.env, fetch, sleep } = {}) {
  const daytona = daytonaConfig(config, env)
  const body = buildDaytonaCreateBody(config, worker, runId, env)
  if (dryRun) return { kind: "daytona", id: body.name, name: body.name, dryRun: true, request: { method: "POST", url: `${daytona.apiUrl}/sandbox`, body } }

  const client = daytonaClient({ apiKey: env.DAYTONA_API_KEY, apiUrl: daytona.apiUrl, fetch })
  // A leftover from a killed attempt of the same run would hold the name.
  // Best effort: a failure here must not stop a job that would otherwise work.
  await client.deleteSandbox(body.name).catch(() => {})
  const created = await client.createSandbox(body)
  if (!created?.id) throw new Error(`Daytona did not return a sandbox for worker ${worker.id}`)
  try {
    let sandbox = await waitUntilStarted(client, created, { timeoutMs: daytona.startTimeoutMinutes * 60_000, sleep })
    if (!sandbox.toolboxProxyUrl) sandbox = { ...sandbox, toolboxProxyUrl: await client.getToolboxProxyUrl(sandbox.id) }
    if (!sandbox.toolboxProxyUrl) throw new Error(`Daytona sandbox ${sandbox.name ?? sandbox.id} has no toolbox URL`)
    const handle = daytonaHandle(client, sandbox)
    const ready = await handle.exec.command(READY_COMMAND)
    if (ready.status !== "completed") throw new Error(`Daytona sandbox ${handle.name} started but ${HOME} is not writable: ${ready.result.trim().slice(-300)}`)
    return handle
  } catch (error) {
    await client.deleteSandbox(created.id).catch(() => {})
    throw error
  }
}

// Deleting is the cleanup: workspace, sign-in files and the sandbox all go.
export async function removeDaytonaWorker(handle) {
  if (!handle?.remove) return
  try {
    await handle.remove()
  } catch (error) {
    console.warn(`Could not delete Daytona sandbox ${handle.name ?? handle.id}: ${error.message}. Delete it in the Daytona dashboard, or run scripts/release-worker.mjs for its worker.`)
  }
}

// Factory sandboxes as plain rows { id, name, state, busy, labels }.
// Throws when the API is unreachable so a run fails loudly instead of
// double-claiming a worker.
export async function listDaytonaWorkers(config, { env = process.env, fetch } = {}) {
  const client = daytonaClient({ apiKey: env.DAYTONA_API_KEY, apiUrl: daytonaConfig(config, env).apiUrl, fetch })
  const sandboxes = await client.listSandboxes({ [DAYTONA_LABEL]: "true" })
  return sandboxes.map((s) => ({ id: s.id, name: s.name ?? s.id, state: s.state ?? "unknown", busy: isBusyState(s.state), labels: s.labels ?? {} }))
}

// Pure: the rows that belong to one worker (busy or not).
export function sandboxesForWorker(rows, workerId) {
  return rows.filter((row) => row.labels?.worker === workerId)
}

// Deletes every factory sandbox of one worker. scripts/release-worker.mjs.
export async function deleteDaytonaSandboxes(config, rows, { env = process.env, fetch } = {}) {
  const client = daytonaClient({ apiKey: env.DAYTONA_API_KEY, apiUrl: daytonaConfig(config, env).apiUrl, fetch })
  for (const row of rows) await client.deleteSandbox(row.id)
}

// Shared Daytona verification for scripts/check-setup.mjs. Read-only: it
// creates nothing. Each step is { id, status: "ok"|"fail"|"note", message }.
//   key (DAYTONA_API_KEY set) -> api (the key lists sandboxes) -> snapshot
export async function verifyDaytona(config, { env = process.env, fetch } = {}) {
  const daytona = daytonaConfig(config, env)
  const checks = []
  const add = (id, status, message) => checks.push({ id, status, message })
  const done = () => ({ ok: !checks.some((c) => c.status === "fail"), problems: checks.filter((c) => c.status === "fail").length, checks, apiUrl: daytona.apiUrl })

  if (!env.DAYTONA_API_KEY) {
    add("key", "fail", `worker.provider is "daytona" but DAYTONA_API_KEY has no value. Create an API key in the Daytona dashboard (Keys) and put it in .env, then run scripts/set-secrets.mjs so Actions gets it too`)
    return done()
  }
  add("key", "ok", `DAYTONA_API_KEY is set (${env.DAYTONA_API_KEY.length} characters); API: ${daytona.apiUrl}${daytona.target ? `, target ${daytona.target}` : ""}`)

  const client = daytonaClient({ apiKey: env.DAYTONA_API_KEY, apiUrl: daytona.apiUrl, fetch })
  try {
    const sandboxes = await client.listSandboxes({ [DAYTONA_LABEL]: "true" })
    const busy = sandboxes.filter((s) => isBusyState(s.state))
    add("api", "ok", `the Daytona key works. ${sandboxes.length} factory sandbox(es) exist${busy.length ? `, ${busy.length} running: ${busy.map((s) => s.name ?? s.id).join(", ")}` : " (none running is normal between jobs)"}`)
  } catch (error) {
    add("api", "fail", `the Daytona API at ${daytona.apiUrl} refused the key or is unreachable: ${error.message}. Check DAYTONA_API_KEY and DAYTONA_API_URL / worker.daytona.apiUrl`)
    return done()
  }

  if (!daytona.snapshot) {
    add("snapshot", "note", "no worker.daytona.snapshot: sandboxes start from Daytona's default snapshot, which has no agent CLIs. Push the worker image as a snapshot (daytona snapshot push create-ant-factory-worker:latest --name create-ant-factory-worker) and set worker.daytona.snapshot")
    return done()
  }
  try {
    const snapshot = await client.getSnapshot(daytona.snapshot)
    if (!snapshot) add("snapshot", "fail", `snapshot "${daytona.snapshot}" was not found on this Daytona account. Push it: docker build -f worker/Dockerfile -t create-ant-factory-worker:latest . && daytona snapshot push create-ant-factory-worker:latest --name ${daytona.snapshot}`)
    else if (String(snapshot.state ?? "").toLowerCase() !== "active") add("snapshot", "fail", `snapshot "${daytona.snapshot}" is "${snapshot.state ?? "unknown"}", not "active". Wait for it to finish, or push it again`)
    else add("snapshot", "ok", `snapshot "${daytona.snapshot}" is active`)
  } catch (error) {
    add("snapshot", "fail", `could not read snapshot "${daytona.snapshot}": ${error.message}`)
  }
  return done()
}
