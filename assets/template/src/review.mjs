// Resume-from-review mode. When an issue that already has an open factory pull
// request gets the ready label again, the factory does not start over from the
// base branch. It checks out the existing factory branch, hands the agent the
// review feedback and any failing checks on that pull request, lets the agent
// revise, pushes normally (never --force) and replies on the pull request.
//
// The network calls are small wrappers. The rules (whose feedback counts, which
// checks failed, how much of it reaches the prompt) are pure functions so they
// can be tested without GitHub.
import { github, FACTORY_MARK } from "./github.mjs"

// Whether a re-labelled issue with an open factory pull request is revised in
// place. Left out means false, so an existing factory keeps its old behaviour
// (a fresh branch from the base, force-pushed) until the owner opts in.
export const resumeEnabled = (config) => config.factory.resumeFromReview === true

// The open pull request whose head is this issue's factory branch, or null.
// The head filter is owner:branch, so a fork's branch of the same name is not
// picked up.
export async function findFactoryPullRequest(repo, branch) {
  const owner = repo.split("/")[0]
  const open = await github(`/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`)
  return open[0] ?? null
}

// Everything reviewers said on a pull request, read best-effort. Reviews and
// inline comments are on the pulls API, the conversation is on the issues API.
// Check runs need the token's "Checks" read access, which fine-grained tokens
// may lack; a failed read there is reported, not fatal, because the review
// comments alone are enough to revise.
export async function getReviewState(repo, pr) {
  const pages = async (path) => {
    const all = []
    for (let page = 1; ; page++) {
      const batch = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
      all.push(...batch)
      if (batch.length < 100) break
    }
    return all
  }
  const [reviews, reviewComments, conversation] = await Promise.all([
    pages(`/repos/${repo}/pulls/${pr.number}/reviews`),
    pages(`/repos/${repo}/pulls/${pr.number}/comments`),
    pages(`/repos/${repo}/issues/${pr.number}/comments`),
  ])
  let checkRuns = []
  let checksError = null
  try {
    checkRuns = (await github(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`)).check_runs ?? []
  } catch (error) {
    checksError = error.message
  }
  return { reviews, reviewComments, conversation, checkRuns, checksError }
}

const isTrusted = (login, trusted) => Boolean(login) && trusted.has(login.toLowerCase())
const byFactory = (body) => String(body ?? "").includes(FACTORY_MARK)

// The same trust rule as issue comments: only factory.allowedActors and the
// issue's author are heard. On a public repo anyone can review or comment on a
// pull request, and the agent runs with its sign-in secrets, so a stranger's
// "review" must never reach the prompt. The factory's own comments are dropped
// too. Inline comments keep their file and line, because "change this" means
// nothing without them. Oldest first.
//
// Feedback from before the factory's last "Revised after review" reply was
// already handled by that revision, so only newer items count. The first
// revision of a pull request has no such reply and sees everything.
export function lastRevisionAt(conversation = []) {
  return conversation.filter((c) => byFactory(c.body)).map((c) => c.created_at ?? "").sort().at(-1) ?? ""
}

export function collectFeedback({ reviews = [], reviewComments = [], conversation = [] }, { allowedActors = [], issueAuthor } = {}) {
  const trusted = new Set([...allowedActors, issueAuthor].filter(Boolean).map((login) => login.toLowerCase()))
  const since = lastRevisionAt(conversation)
  const items = []
  for (const r of reviews) {
    if (!isTrusted(r.user?.login, trusted) || byFactory(r.body)) continue
    const body = String(r.body ?? "").trim()
    // An approval with no text, or a review that only carries inline comments,
    // adds nothing beyond those comments.
    if (!body && r.state !== "CHANGES_REQUESTED") continue
    const verdict = r.state === "CHANGES_REQUESTED" ? " (requested changes)" : ""
    items.push({ at: r.submitted_at ?? "", text: `**${r.user.login}** in a review${verdict}: ${body || "(no text)"}` })
  }
  for (const c of reviewComments) {
    if (!isTrusted(c.user?.login, trusted) || byFactory(c.body)) continue
    const line = c.line ?? c.original_line
    const where = c.path ? `\`${c.path}${line ? `:${line}` : ""}\`` : "the diff"
    items.push({ at: c.created_at ?? "", text: `**${c.user.login}** on ${where}: ${String(c.body ?? "").trim()}` })
  }
  for (const c of conversation) {
    if (!isTrusted(c.user?.login, trusted) || byFactory(c.body)) continue
    items.push({ at: c.created_at ?? "", text: `**${c.user.login}** on the pull request: ${String(c.body ?? "").trim()}` })
  }
  return items.filter((item) => !since || item.at > since).sort((a, b) => a.at.localeCompare(b.at)).map((item) => item.text)
}

// Check runs on the pull request's head commit that did not pass. Neutral and
// skipped runs are not failures; a run still in progress is not one yet.
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"])
export function failedChecks(checkRuns = []) {
  return checkRuns
    .filter((run) => run.status === "completed" && FAILED.has(run.conclusion))
    .map((run) => ({ name: run.name, conclusion: run.conclusion, summary: String(run.output?.summary ?? run.output?.title ?? "").trim() }))
}

export const MAX_FEEDBACK_CHARS = 8000

// The prompt section the agent revises from. Keeps the newest feedback within
// the budget and says how much was left out, the same way the issue comments
// are capped. Returns "" when there is nothing to act on.
export function feedbackSection(prNumber, feedback, failed, maxChars = MAX_FEEDBACK_CHARS) {
  if (!feedback.length && !failed.length) return ""
  const kept = []
  let chars = 0
  for (let i = feedback.length - 1; i >= 0; i--) {
    if (kept.length && chars + feedback[i].length > maxChars) break
    kept.unshift(feedback[i])
    chars += feedback[i].length
  }
  const dropped = feedback.length - kept.length
  const lines = ["", `# Review feedback on pull request #${prNumber}`, ""]
  if (dropped) lines.push(`(${dropped} older item(s) were left out to keep this short.)`, "")
  lines.push(...(kept.length ? kept.map((text) => `- ${text}`) : ["(No review comments. Fix the failing checks below.)"]))
  if (failed.length) {
    lines.push("", "# Checks that failed on the pull request", "")
    for (const run of failed) lines.push(`- \`${run.name}\` (${run.conclusion})${run.summary ? `: ${run.summary.slice(0, 500)}` : ""}`)
  }
  return `${lines.join("\n")}\n`
}
