// Small GitHub REST helper. Uses FACTORY_GITHUB_TOKEN, the fine-grained token
// that can reach the app repos.
const API = "https://api.github.com"

// Every comment the factory writes carries this hidden marker, so its own
// comments can be told apart from a person's, even when both use one account.
export const FACTORY_MARK = "<!-- software-factory -->"

// A factory run makes a dozen or more GitHub calls in a row (issue, labels,
// comments, pull request). One transient failure in the middle — a 429 rate
// limit, a 502 from a bad gateway — used to throw and kill the whole run,
// after a worker had already been claimed. So the call below is retried.
const MAX_GITHUB_ATTEMPTS = 4
const RETRYABLE_METHODS = new Set(["GET", "DELETE"])

// Whether a failed call may be tried again. A 429 means GitHub refused to run
// the request at all (rate limit), so retrying it cannot double-apply
// anything. A 5xx may have run server-side, so only the idempotent methods
// are retried: retrying a POST comment that actually landed would post it
// twice. 4xx errors are the caller's fault and are never retried.
export function shouldRetryGitHubCall(method, status, attempt) {
  if (attempt >= MAX_GITHUB_ATTEMPTS) return false
  if (status === 429) return true
  return status >= 500 && status <= 599 && RETRYABLE_METHODS.has(method)
}

// How long to wait before the next attempt, in milliseconds. GitHub's
// retry-after header (seconds) wins when it is there; otherwise the wait
// doubles with the attempt (about 1s, 2s, 4s) plus a little jitter, so two
// runs hitting the same limit do not retry in lockstep.
export function retryDelayMs(response, attempt) {
  const header = response.headers.get("retry-after")
  const fromHeader = Number(header)
  if (header !== null && Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader * 1000
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function github(path, { method = "GET", body } = {}) {
  const token = process.env.FACTORY_GITHUB_TOKEN
  if (!token) throw new Error("FACTORY_GITHUB_TOKEN is not set")

  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (response.ok) {
      return response.status === 204 ? null : response.json()
    }
    if (!shouldRetryGitHubCall(method, response.status, attempt)) {
      throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${await response.text()}`)
    }
    const waitMs = retryDelayMs(response, attempt)
    console.warn(
      `GitHub ${method} ${path} got ${response.status}; retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1} of ${MAX_GITHUB_ATTEMPTS}).`,
    )
    await sleep(waitMs)
  }
}

export const getIssue = (repo, number) => github(`/repos/${repo}/issues/${number}`)

export const addLabels = (repo, number, labels) =>
  github(`/repos/${repo}/issues/${number}/labels`, { method: "POST", body: { labels } })

export async function removeLabel(repo, number, label) {
  try {
    await github(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" })
  } catch (error) {
    if (!String(error.message).includes(" 404 ")) throw error // the label was not on the issue
  }
}

export const comment = (repo, number, body) =>
  github(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body: `${body}

${FACTORY_MARK}` } })

// Opens a pull request, or updates the open one for the same branch.
// draft: true opens it as a draft (a risk gate matched, see src/gates.mjs).
// GitHub's REST API cannot turn an existing ready pull request into a draft,
// so an update keeps the pull request's current draft state.
export async function openPullRequest(repo, { head, base, title, body, draft = false }) {
  const owner = repo.split("/")[0]
  const existing = await github(`/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`)
  if (existing.length > 0) {
    return github(`/repos/${repo}/pulls/${existing[0].number}`, { method: "PATCH", body: { title, body } })
  }
  return github(`/repos/${repo}/pulls`, { method: "POST", body: { head, base, title, body, ...(draft ? { draft: true } : {}) } })
}

// Comments written by people, oldest first. A user who answers the agent's
// question in a comment is heard this way. GitHub returns at most 100 comments
// per page, oldest first, so every page is read: on a long or often-retried
// issue the newest answer would otherwise be the one that gets dropped.
export async function getHumanComments(repo, number) {
  const comments = []
  for (let page = 1; ; page++) {
    const batch = await github(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)
    comments.push(...batch)
    if (batch.length < 100) break
  }
  return comments.filter((c) => !c.body?.includes(FACTORY_MARK)).map((c) => ({ author: c.user?.login, body: c.body ?? "" }))
}

// Keeps only the comments a trusted person wrote: someone on
// factory.allowedActors, or the issue's author, whose body the prompt already
// holds. On a public repo anyone can comment after the ready label is added,
// and the agent runs with its sign-in secrets, so a stranger's comment must
// never reach the prompt. GitHub logins are case-insensitive.
export function trustedComments(comments, { allowedActors = [], issueAuthor } = {}) {
  const trusted = new Set([...allowedActors, issueAuthor].filter(Boolean).map((login) => login.toLowerCase()))
  return comments.filter((c) => c.author && trusted.has(c.author.toLowerCase()))
}

// The same rule as trustedComments: GitHub logins are case-insensitive. Used
// by the workflow_dispatch guard in run.mjs, where a differently-cased
// username in factory.allowedActors used to refuse the manual run.
export function isAllowedActor(allowedActors, actor) {
  const who = String(actor ?? "").toLowerCase()
  return (allowedActors ?? []).some((login) => String(login).toLowerCase() === who)
}

// The longest comment section the agent's prompt may hold. A long discussion
// thread could otherwise swallow the agent's context window, so the factory
// keeps the newest comments up to this many characters. The issue body is
// never cut: it is the task itself.
export const MAX_COMMENT_CHARS = 8000

// Keeps the newest comments up to maxChars, oldest first, and reports how
// many older ones were dropped. The newest comment is always kept, even when
// it alone is longer than the budget.
export function capComments(comments, maxChars = MAX_COMMENT_CHARS) {
  const kept = []
  let chars = 0
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]
    const size = (comment.author?.length ?? 0) + (comment.body?.length ?? 0) + 8
    if (kept.length && chars + size > maxChars) break
    kept.unshift(comment)
    chars += size
  }
  return { kept, dropped: comments.length - kept.length }
}

// The longest agent summary that may become a pull request description.
// GitHub caps PR bodies at 65,536 characters, and the summary is whatever
// the agent wrote into summary.md: unbounded. Without a cap, a runaway
// agent would make the PR creation fail with a 422 after the commit and the
// push already happened. The cap leaves room for the "Closes #N" line and
// the footer the factory wraps the summary in.
export const MAX_PR_BODY_CHARS = 60000

// Keeps the head of the summary — the part the prompt asked for, what the
// agent changed — and says so, so nothing is trimmed silently.
export function capSummary(summary, maxChars = MAX_PR_BODY_CHARS) {
  if (summary.length <= maxChars) return summary
  return `${summary.slice(0, maxChars).trimEnd()}\n\n(Trimmed to ${maxChars} characters. The agent wrote ${summary.length}.)`
}
