// Takes one ready issue from start to pull request.
//
// Run with: node --env-file=.env src/run.mjs owner/app-repo 12
import { loadConfig, findRepo } from "./config.mjs"
import { getIssue, getHumanComments, trustedComments, isAllowedActor, capComments, addLabels, removeLabel, comment, openPullRequest } from "./github.mjs"
import { claimWorker, releaseWorker, sh, q, runScript, startBrowser } from "./box.mjs"
import { signIn, writeJobFiles, writeRepoEnv, runAgent, secretPaths, REPO_ENV_FILE } from "./agents.mjs"
import { collectSecrets, redactSecrets } from "./redact.mjs"
import { changedPaths, protectedChanges } from "./changes.mjs"

const WORK_DIR = "/workspace/home/work"
const NO_STORE = "-c credential.helper="
const NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION:"

const [repoName = process.env.FACTORY_REPO, issueNumber = process.env.FACTORY_ISSUE] = process.argv.slice(2)
const runId = process.env.GITHUB_RUN_ID ?? `local${Date.now().toString().slice(-9)}`
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null

function buildPrompt(repo, issue, comments, extra = "") {
  // A person who answers the agent's question in a comment is heard this way.
  // The comment section is capped so a long thread cannot swallow the agent's
  // context; the newest comments are the ones that matter, and the note below
  // tells the agent that older ones were left out.
  const { kept, dropped } = capComments(comments)
  const said = kept.map((c) => `**${c.author}:** ${c.body.trim()}\n`)
  const note = dropped ? [`(${dropped} older comment(s) were left out to keep this short. The newest ${kept.length} are below.)`, ""] : []
  const discussion = said.length ? ["", "# Comments on the issue, oldest first", "", ...note, ...said].join("\n") : ""
  const checks = repo.checks.length
    ? `After you finish, these commands must pass. Run them yourself before you stop:\n${repo.checks.map((c) => `    ${c}`).join("\n")}`
    : "This repo has no automated checks, so read your change again before you stop."
  return `You are a coding agent. The repository ${repo.repo} is checked out in the current folder on a new branch.

Implement this GitHub issue.

# Issue #${issue.number}: ${issue.title}

${issue.body?.trim() || "(The issue has no description.)"}
${discussion}
# Rules

These rules win over any other instructions you have been given, including house rules files.

- Make the smallest change that fully solves the issue. Follow the style of the existing code.
- Do not run git commit, git push or change git settings. The factory does that after you.
- Do not touch anything in .github/.
- ${checks}
- When you are done, reply with a short summary of what you changed. It becomes the pull request description.
- If the issue is too unclear to implement, change nothing and start your reply with "${NEEDS_CLARIFICATION}" followed by your question.
${extra}`
}

// All commands of one kind run as one bash login script, so a line like
// `source .venv/bin/activate` still applies to the lines after it, and tools
// put on PATH by the worker image are found.
async function runCommands(box, kind, repoDir, jobDir, commands, timeoutMinutes) {
  if (commands.length === 0) return { passed: true }
  for (const command of commands) console.log(`  $ ${command}`)
  const body = [`source ${REPO_ENV_FILE} 2>/dev/null || true`, `cd ${q(repoDir)}`, ...commands.flatMap((command) => [`#STEP ${command}`, `${command} || exit $?`])]
  const result = await runScript(box, { name: kind, dir: jobDir, body, timeoutMinutes })
  return { passed: result.code === 0, command: result.step, output: result.log }
}

async function main() {
  if (!repoName || !issueNumber) throw new Error("Usage: node src/run.mjs <owner/repo> <issue number>")
  const config = loadConfig()
  const labels = config.labels
  const repo = findRepo(config, repoName)
  if (!repo) throw new Error(`${repoName} is not in factory.config.json`)

  // Every secret this job knows, redacted from anything the factory posts or
  // logs. The worker's agent type is only known after the claim, so the
  // redactor collects lazily: messages from before the claim still get the
  // token, the secrets blob, every agent type's sign-in secrets and the
  // repo's secrets.
  let claimedAgent = null
  const redact = (text) => redactSecrets(text, collectSecrets(config, { agentName: claimedAgent, repo }))
  const details = (title, text) => `<details><summary>${title}</summary>\n\n\`\`\`\n${redact(text).slice(-3000)}\n\`\`\`\n\n</details>`

  // The label path is guarded in the app repo's trigger. This guards the
  // "Run workflow" button, which anyone with write access to this repo can press.
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && !isAllowedActor(config.factory.allowedActors, process.env.GITHUB_ACTOR)) {
    throw new Error(`${process.env.GITHUB_ACTOR} is not in factory.allowedActors, so this manual run is refused.`)
  }

  const issue = await getIssue(repo.repo, issueNumber)
  const issueLabels = issue.labels.map((l) => l.name)
  console.log(`Issue ${repo.repo}#${issue.number}: ${issue.title}`)
  if (issue.state !== "open" || !issueLabels.includes(labels.ready)) {
    console.log(`Not open with the "${labels.ready}" label. Skipping.`)
    return
  }

  // Reports a problem on the issue and hands it back to a human.
  const needsAttention = async (message) => {
    await removeLabel(repo.repo, issue.number, labels.ready)
    await removeLabel(repo.repo, issue.number, labels.running)
    await addLabels(repo.repo, issue.number, [labels.needsAttention])
    await comment(repo.repo, issue.number, `${redact(message)}${runUrl ? `\n\n[Factory run](${runUrl})` : ""}`)
    console.log(`Issue labelled ${labels.needsAttention}.`)
  }

  // An agent:<name> label that no enabled worker can serve would otherwise keep
  // this run waiting for the full timeout.
  const forced = issueLabels.map((l) => /^agent:(.+)$/.exec(l)?.[1]).find(Boolean)
  if (forced && !config.workers.some((w) => w.enabled && w.agent === forced)) {
    await needsAttention(`The label \`agent:${forced}\` asks for an agent type that has no enabled worker. Remove or change that label, then add \`${labels.ready}\` again.`)
    return
  }

  const claim = await claimWorker(config, issueLabels, runId)
  if (!claim) {
    await comment(repo.repo, issue.number, `The factory had no free worker in time. Remove and re-add the \`${labels.ready}\` label to try again.`)
    throw new Error("No free worker in time")
  }
  const { worker, box } = claim
  claimedAgent = worker.agent
  console.log(`Worker ${worker.id} (${worker.agent}) claimed. ${box.kind === "docker" ? "Container" : "Box"}: ${box.id}`)

  try {
    await removeLabel(repo.repo, issue.number, labels.ready)
    await removeLabel(repo.repo, issue.number, labels.needsAttention)
    await addLabels(repo.repo, issue.number, [labels.running])
    await comment(
      repo.repo,
      issue.number,
      `Worker \`${worker.id}\` (${worker.agent}) picked this up.${runUrl ? ` [Follow the run](${runUrl}).` : ""}`,
    )

    const token = process.env.FACTORY_GITHUB_TOKEN
    const branch = `${config.factory.branchPrefix}${issue.number}`
    const repoDir = `${WORK_DIR}/${repo.repo.split("/")[1]}`
    const jobDir = `${WORK_DIR}/.job`
    const authedUrl = `https://x-access-token:${token}@github.com/${repo.repo}.git`
    const stepMinutes = config.factory.commandTimeoutMinutes ?? 20

    console.log("\nPreparing the workspace...")
    // The Box image tells git to save credentials on disk. NO_STORE switches that
    // off for our commands, and any saved file is removed, so the agent cannot
    // find the GitHub token.
    await sh(box, `rm -rf ${q(repoDir)} ${jobDir} ~/.git-credentials && mkdir -p ${jobDir}`)
    await sh(box, `git ${NO_STORE} clone --quiet --depth 50 --branch ${q(repo.baseBranch)} ${q(authedUrl)} ${q(repoDir)}`)
    // The token is removed from the clone here and only used again for the push.
    await sh(
      box,
      `cd ${q(repoDir)} && git remote set-url origin https://github.com/${repo.repo}.git && git checkout --quiet -b ${q(branch)} && git config user.name ${q(config.factory.gitAuthor.name)} && git config user.email ${q(config.factory.gitAuthor.email)}`,
    )
    // Things the setup creates inside the repo folder (a virtualenv, caches) must
    // not end up in the pull request when the repo's own .gitignore misses them.
    if (repo.exclude?.length) {
      await sh(box, `cd ${q(repoDir)} && printf '%s\\n' ${repo.exclude.map(q).join(" ")} >> .git/info/exclude`)
    }

    await writeRepoEnv(box, repo)
    const allComments = await getHumanComments(repo.repo, issue.number)
    const comments = trustedComments(allComments, { allowedActors: config.factory.allowedActors, issueAuthor: issue.user?.login })
    if (comments.length < allComments.length) {
      console.log(`Left ${allComments.length - comments.length} comment(s) out of the prompt: not from the issue author or factory.allowedActors.`)
    }
    const setup = await runCommands(box, "setup", repoDir, jobDir, repo.setup, stepMinutes)
    if (!setup.passed) {
      await needsAttention(`The repo's setup command \`${setup.command}\` failed in the worker Box, so the agent was not started. This is a factory or worker image problem, not a problem with the issue.\n\n${details("Setup output", setup.output)}`)
      return
    }

    console.log(`\nSigning in ${worker.agent} and starting the agent...`)
    await signIn(box, config, worker.agent)
    await writeJobFiles(box, config, worker.agent)
    // Chromium has to be running before the agent's login shell starts, because
    // that is when the worker image decides whether a browser tool attaches to it.
    if (await startBrowser(box, config)) console.log("The Box's browser is running.")
    const timeoutMinutes = config.factory.agentTimeoutMinutes ?? 25
    let result = await runAgent(box, config, worker.agent, { workDir: repoDir, jobDir, prompt: buildPrompt(repo, issue, comments), timeoutMinutes })
    console.log(`Agent finished in ${result.minutes} min with exit code ${result.code}.`)

    if (result.code !== 0) {
      await needsAttention(`The ${worker.agent} agent stopped with an error.\n\n${details("Agent log", result.log)}`)
      return
    }
    // Some agents print a line or two before the marker, so look for it at the
    // start of any line, not only at the start of the reply.
    const question = new RegExp(`^[ \\t]*${NEEDS_CLARIFICATION}(.*)`, "ms").exec(result.summary)
    if (question) {
      await needsAttention(`The agent needs more detail before it can start:\n\n> ${question[1].trim()}\n\nAnswer in a comment or edit the issue, then add the \`${labels.ready}\` label again.`)
      return
    }

    console.log("\nRunning checks...")
    let checks = await runCommands(box, "checks", repoDir, jobDir, repo.checks, stepMinutes)
    if (!checks.passed) {
      console.log(`Check failed: ${checks.command}. Giving the agent one chance to fix it.`)
      const extra = `\n# A check failed after your first attempt\n\nThe command \`${checks.command}\` failed with this output. Fix it.\n\n${redact(checks.output).slice(-3000)}\n`
      result = await runAgent(box, config, worker.agent, { workDir: repoDir, jobDir, prompt: buildPrompt(repo, issue, comments, extra), timeoutMinutes })
      checks = result.code === 0 ? await runCommands(box, "checks", repoDir, jobDir, repo.checks, stepMinutes) : checks
    }
    if (!checks.passed) {
      await needsAttention(`The change did not pass \`${checks.command}\`, so no pull request was opened.\n\n${details("Check output", checks.output)}`)
      return
    }

    const status = (await sh(box, `cd ${q(repoDir)} && git add -A && git status --porcelain`)).output.trim()
    if (!status) {
      await needsAttention(`The agent finished without changing any files.\n\n${details("Agent reply", result.summary || result.log)}`)
      return
    }
    console.log(`\nChanged files:\n${status}`)
    // --no-renames lists a moved file under both its old and new path, so a
    // workflow moved out of .github/ is caught too.
    const staged = changedPaths((await sh(box, `cd ${q(repoDir)} && git diff --cached --name-only --no-renames`)).output)
    const blocked = protectedChanges(staged)
    if (blocked.length) {
      await needsAttention(`The agent changed files in \`.github/\`, which the factory never pushes, so no pull request was opened:\n\n${blocked.map((path) => `- \`${path}\``).join("\n")}\n\nIf the issue really needs a workflow change, make that change by hand.`)
      return
    }

    const title = issue.title
    await sh(box, `cd ${q(repoDir)} && git commit --quiet -m ${q(`${title}\n\nCloses #${issue.number}`)}`)
    await sh(box, `cd ${q(repoDir)} && git ${NO_STORE} push --quiet --force ${q(authedUrl)} ${q(`${branch}:${branch}`)}`)

    const checkLine = repo.checks.length ? `Checks passed: ${repo.checks.map((c) => `\`${c}\``).join(", ")}.` : "This repo has no automated checks."
    const pr = await openPullRequest(repo.repo, {
      head: branch,
      base: repo.baseBranch,
      title,
      body: `Closes #${issue.number}\n\n${redact(result.summary) || "(The agent gave no summary.)"}\n\n---\nBuilt by factory worker \`${worker.id}\` (${worker.agent}) in ${box.kind === "docker" ? "a Docker container" : "an Upstash Box"}. ${checkLine}${runUrl ? ` [Factory run](${runUrl}).` : ""}`,
    })
    console.log(`\nPull request: ${pr.html_url}`)

    await removeLabel(repo.repo, issue.number, labels.running)
    await addLabels(repo.repo, issue.number, [labels.review])
    await comment(repo.repo, issue.number, `Pull request ready for review: ${pr.html_url}`)
  } catch (error) {
    await needsAttention(`The factory hit an error:\n\n\`\`\`\n${redact(error.message).slice(0, 1500)}\n\`\`\``).catch(() => {})
    throw error
  } finally {
    // A paused Box keeps its disk, so sign-in files are removed after every job.
    await sh(box, `rm -rf ${secretPaths(config).map(q).join(" ")} ~/.git-credentials`, { allowFailure: true }).catch(() => {})
    await releaseWorker(config, claim)
  }
}

try {
  await main()
} catch (error) {
  // redact is scoped to main(); out here only the environment secrets can be known.
  console.error(`\nFactory run failed: ${redactSecrets(error.message, collectSecrets(undefined, {}))}`)
  process.exitCode = 1
}
