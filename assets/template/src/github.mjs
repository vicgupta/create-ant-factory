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
// question in a comment is heard this way.
export async function getHumanComments(repo, number) {
  const comments = await github(`/repos/${repo}/issues/${number}/comments?per_page=100`)
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
