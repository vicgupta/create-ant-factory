// Retries on transient GitHub API failures. No network: fetch is stubbed.
// Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { github, shouldRetryGitHubCall, retryDelayMs } from "../src/github.mjs"

const response = (status, headers = {}) => new Response(null, { status, headers })

test("a 429 is retried for any method: GitHub refused to run the request", () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.equal(shouldRetryGitHubCall(method, 429, 1), true, method)
  }
})

test("a 5xx is retried only for the idempotent methods", () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(shouldRetryGitHubCall("GET", status, 1), true, `GET ${status}`)
    assert.equal(shouldRetryGitHubCall("DELETE", status, 1), true, `DELETE ${status}`)
    assert.equal(shouldRetryGitHubCall("POST", status, 1), false, `POST ${status}`)
    assert.equal(shouldRetryGitHubCall("PATCH", status, 1), false, `PATCH ${status}`)
  }
})

test("4xx errors are never retried: they are the caller's fault", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(shouldRetryGitHubCall("GET", status, 1), false, `GET ${status}`)
    assert.equal(shouldRetryGitHubCall("POST", 422, 1), false, "POST 422")
  }
})

test("no retry once the attempts are used up", () => {
  assert.equal(shouldRetryGitHubCall("GET", 502, 3), true)
  assert.equal(shouldRetryGitHubCall("GET", 502, 4), false)
  assert.equal(shouldRetryGitHubCall("POST", 429, 4), false)
})

test("the retry-after header decides the wait", () => {
  assert.equal(retryDelayMs(response(429, { "retry-after": "2" }), 1), 2000)
  assert.equal(retryDelayMs(response(429, { "retry-after": "0" }), 3), 0)
})

test("without the header the wait backs off with the attempt", () => {
  const first = retryDelayMs(response(502), 1)
  const second = retryDelayMs(response(502), 2)
  const third = retryDelayMs(response(502), 3)
  assert.ok(first >= 1000 && first < 1500, `attempt 1: ${first}`)
  assert.ok(second >= 2000 && second < 2500, `attempt 2: ${second}`)
  assert.ok(third >= 4000 && third < 4500, `attempt 3: ${third}`)
})

test("a non-numeric retry-after falls back to the backoff", () => {
  const wait = retryDelayMs(response(429, { "retry-after": "soon" }), 1)
  assert.ok(wait >= 1000 && wait < 1500, `got ${wait}`)
})

function stubFetch(t, handler) {
  const realFetch = globalThis.fetch
  const realToken = process.env.FACTORY_GITHUB_TOKEN
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options?.method ?? "GET" })
    return handler(calls.length)
  }
  process.env.FACTORY_GITHUB_TOKEN = "test-token"
  t.after(() => {
    globalThis.fetch = realFetch
    if (realToken === undefined) delete process.env.FACTORY_GITHUB_TOKEN
    else process.env.FACTORY_GITHUB_TOKEN = realToken
  })
  return calls
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

test("a GET that 502s once is retried and returns the body", async (t) => {
  const calls = stubFetch(t, (n) => (n === 1 ? response(502) : json({ login: "octo" })))
  const issue = await github("/repos/owner/app/issues/1")
  assert.deepEqual(issue, { login: "octo" })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, "GET")
})

test("a POST that is rate-limited is retried: the 429 ran nothing server-side", async (t) => {
  const calls = stubFetch(t, (n) => (n === 1 ? response(429, { "retry-after": "0" }) : json({ id: 9 })))
  const created = await github("/repos/owner/app/issues/1/comments", { method: "POST", body: { body: "hi" } })
  assert.deepEqual(created, { id: 9 })
  assert.equal(calls.length, 2)
})

test("a POST that 503s is not retried: it may already have run server-side", async (t) => {
  const calls = stubFetch(t, () => response(503))
  await assert.rejects(
    github("/repos/owner/app/issues/1/comments", { method: "POST", body: { body: "hi" } }),
    /GitHub POST .* failed: 503/,
  )
  assert.equal(calls.length, 1)
})

test("after the last attempt the error names the method, path and status", async (t) => {
  const calls = stubFetch(t, () => response(502))
  await assert.rejects(github("/repos/owner/app/issues/1"), /GitHub GET \/repos\/owner\/app\/issues\/1 failed: 502/)
  assert.equal(calls.length, 4)
})
