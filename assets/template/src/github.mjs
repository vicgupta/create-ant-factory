// Small GitHub REST helper. Uses FACTORY_GITHUB_TOKEN, the fine-grained token
// that can reach the app repos.
const API = "https://api.github.com"

// Every comment the factory writes carries this hidden marker, so its own
// comments can be told apart from a person's, even when both use one account.
const FACTORY_MARK = "<!-- software-factory -->"

export async function github(path, { method = "GET", body } = {}) {
  const token = process.env.FACTORY_GITHUB_TOKEN
  if (!token) throw new Error("FACTORY_GITHUB_TOKEN is not set")

  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${await response.text()}`)
  }
  return response.status === 204 ? null : response.json()
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
export async function openPullRequest(repo, { head, base, title, body }) {
  const owner = repo.split("/")[0]
  const existing = await github(`/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`)
  if (existing.length > 0) {
    return github(`/repos/${repo}/pulls/${existing[0].number}`, { method: "PATCH", body: { title, body } })
  }
  return github(`/repos/${repo}/pulls`, { method: "POST", body: { head, base, title, body } })
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
