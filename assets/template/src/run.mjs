// Takes one ready issue from start to pull request.
//
// Run with: node --env-file=.env src/run.mjs owner/app-repo 12
import { loadConfig, findRepo, workerProvider } from "./config.mjs"
import { getIssue, getHumanComments, trustedComments, isAllowedActor, capComments, capSummary, addLabels, removeLabel, comment, openPullRequest } from "./github.mjs"
import { claimWorker, releaseWorker, sh, q, runScript, startBrowser } from "./box.mjs"
import { signIn, writeJobFiles, writeRepoEnv, runAgent, secretPaths, REPO_ENV_FILE } from "./agents.mjs"
import { collectSecrets, redactSecrets } from "./redact.mjs"
import { changedPaths, protectedChanges } from "./changes.mjs"
import { resumeEnabled, findFactoryPullRequest, getReviewState, collectFeedback, failedChecks, feedbackSection } from "./review.mjs"
import { recordsEnabled, recordDir, createRunRecord, noteAgentRun, noteChecks, noteDecision, endRun, finishRunRecord, writeRunRecord, appendStepSummary } from "./record.mjs"
import { planFirstEnabled, validatePlanText, renderPlanComment, planSection, criteriaChecklist, PLAN_FILE } from "./plan-first.mjs"
import { contextGraphEnabled, loadPrecedents, findPrecedents, buildContextBundle, parseStampedFacts, verifyProvenance, staleFactsSection } from "./context.mjs"
import { riskGatesEnabled, gateSettings, evaluateRiskGate, parseNumstat, renderGate } from "./gates.mjs"
import { reviewerEnabled, reviewerSettings, pickReviewerAgent, buildReviewPrompt, validateReviewText, decideReview, reviewGate, mergeGates, renderReview, REVIEW_FILE, DIFF_FILE } from "./reviewer.mjs"

const WORK_DIR = "/workspace/home/work"
const NO_STORE = "-c credential.helper="
const NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION:"

const [repoName = process.env.FACTORY_REPO, issueNumber = process.env.FACTORY_ISSUE] = process.argv.slice(2)
const runId = process.env.GITHUB_RUN_ID ?? `local${Date.now().toString().slice(-9)}`
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null

// What happened in this run, written to runs/run-<id>.json at the end (see
// src/record.mjs). Only counts and names, never logs or the agent's reply.
const record = createRunRecord({ repo: repoName, issue: issueNumber, runId, runUrl })
let keepRecord = true

function buildPrompt(repo, issue, comments, extra = "", revising = null, plan = null, contextText = "") {
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
  // In resume-from-review mode the branch already holds the earlier attempt,
  // and the agent's job is to revise it, not to start again.
  const intro = revising
    ? `You are a coding agent. The repository ${repo.repo} is checked out in the current folder on the branch of pull request #${revising.number}, which already holds an earlier attempt at the issue below.

Revise that work so it answers the review feedback and fixes the failing checks listed after the issue. Keep what reviewers did not ask to change.`
    : `You are a coding agent. The repository ${repo.repo} is checked out in the current folder on a new branch.

Implement this GitHub issue.`
  return `${intro}

# Issue #${issue.number}: ${issue.title}

${issue.body?.trim() || "(The issue has no description.)"}
${discussion}
# Rules

These rules win over any other instructions you have been given, including house rules files.

- Make the smallest change that fully solves the issue. Follow the style of the existing code.
- Do not run git commit, git push or change git settings. The factory does that after you.
- Do not touch anything in .github/.
- ${checks}
- When you are done, reply with a short summary of what you changed. ${revising ? "It becomes the factory's reply on the pull request." : "It becomes the pull request description."}
- If the issue is too unclear to implement, change nothing and start your reply with "${NEEDS_CLARIFICATION}" followed by your question.
${revising?.feedback ?? ""}${plan ? planSection(plan) : ""}${extra}${contextText}`
}

// The planning pass: explore only, change nothing in the repo, and write
// plan.md in the job folder. The factory validates and posts that file
// before the implementation prompt below is ever built.
function buildPlanPrompt(repo, issue, comments, planPath, contextText = "", withFacts = false) {
  const { kept, dropped } = capComments(comments)
  const said = kept.map((c) => `**${c.author}:** ${c.body.trim()}\n`)
  const note = dropped ? [`(${dropped} older comment(s) were left out to keep this short. The newest ${kept.length} are below.)`, ""] : []
  const discussion = said.length ? ["", "# Comments on the issue, oldest first", "", ...note, ...said].join("\n") : ""
  const checks = repo.checks.length ? repo.checks.map((c) => `    ${c}`).join("\n") : "    (this repo has no automated checks; map every criterion to manual-review)"
  return `You are a coding agent planning work in the repository ${repo.repo}, checked out in the current folder. Do not implement anything yet.

# Issue #${issue.number}: ${issue.title}

${issue.body?.trim() || "(The issue has no description.)"}
${discussion}
# Your job: write the plan

Explore the code, then write a plan file at exactly this path: ${planPath}

Change no file in the repository. The factory reads only that plan file; any repository change makes the run stop.

The file must use exactly this shape:

    # Plan

    ## Files to touch
    - path/from/repo/root — why this file changes

    ## Acceptance criteria
    - [ ] What will be true when this is done — check: <one check from the list below, copied exactly, or manual-review>

This repo's checks are:
${checks}

Rules:
- List every file you expect to change, relative to the repo root. Never list anything under .github/.
- At least one file and at least one criterion. Every criterion maps to one configured check, or to manual-review for something only a person can judge.
- Make the smallest plan that fully solves the issue. Follow the style of the existing code.
- Reply with one short line when the plan file is written. If the issue is too unclear to plan, change nothing, write no plan file, and start your reply with "${NEEDS_CLARIFICATION}" followed by your question.${withFacts ? `

Also add a "## Facts" section when you rely on a fact about the current code. Stamp every such claim on its own line, exactly in this shape (get the SHA with git rev-parse HEAD, and use this run id: ${runId}):

    ## Facts
    - <claim> — source: <file you read>; base: <commit SHA>; run: ${runId}; observed_at: <today's date>` : ""}${contextText}
`
}

// All commands of one kind run as one bash login script, so a line like
// `source .venv/bin/activate` still applies to the lines after it, and tools
// put on PATH by the worker image are found.
async function runCommands(box, kind, repoDir, jobDir, commands, timeoutMinutes) {
  if (commands.length === 0) return { passed: true }
  for (const command of commands) console.log(`  $ ${command}`)
  const body = [`source ${REPO_ENV_FILE} 2>/dev/null || true`, `cd ${q(repoDir)}`, ...commands.flatMap((command) => [`#STEP ${command}`, `${command} || exit $?`])]
  const result = await runScript(box, { name: kind, dir: jobDir, body, timeoutMinutes })
  if (kind === "checks") noteChecks(record, result.code === 0)
  return { passed: result.code === 0, command: result.step, output: result.log }
}

async function main() {
  if (!repoName || !issueNumber) throw new Error("Usage: node src/run.mjs <owner/repo> <issue number>")
  const config = loadConfig()
  keepRecord = recordsEnabled(config)
  record.provider = workerProvider(config)
  const labels = config.labels
  const repo = findRepo(config, repoName)
  if (!repo) throw new Error(`${repoName} is not in factory.config.json`)

  // Every secret this job knows, redacted from anything the factory posts or
  // logs. The worker's agent type is only known after the claim, so the
  // redactor collects lazily: messages from before the claim still get the
  // token, the secrets blob, every agent type's sign-in secrets and the
  // repo's secrets.
  let claimedAgent = null
  // The independent reviewer may be another agent type, signed in with its
  // own secrets; those are redacted too once it is picked.
  let reviewerAgent = null
  const redact = (text) => redactSecrets(text, [
    ...collectSecrets(config, { agentName: claimedAgent, repo }),
    ...(reviewerAgent && reviewerAgent !== claimedAgent ? collectSecrets(config, { agentName: reviewerAgent, repo }) : []),
  ])
  const details = (title, text) => `<details><summary>${title}</summary>\n\n\`\`\`\n${redact(text).slice(-3000)}\n\`\`\`\n\n</details>`

  // The label path is guarded in the app repo's trigger. This guards the
  // "Run workflow" button, which anyone with write access to this repo can press.
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && !isAllowedActor(config.factory.allowedActors, process.env.GITHUB_ACTOR)) {
    throw new Error(`${process.env.GITHUB_ACTOR} is not in factory.allowedActors, so this manual run is refused.`)
  }

  const issue = await getIssue(repo.repo, issueNumber)
  const issueLabels = issue.labels.map((l) => l.name)
  record.title = redact(issue.title)
  record.labels = issueLabels
  console.log(`Issue ${repo.repo}#${issue.number}: ${issue.title}`)
  if (issue.state !== "open" || !issueLabels.includes(labels.ready)) {
    console.log(`Not open with the "${labels.ready}" label. Skipping.`)
    endRun(record, "skipped", "not-ready")
    return
  }

  // Reports a problem on the issue and hands it back to a human.
  // reason is a short code for the run record, for example "checks-failed".
  const needsAttention = async (message, reason = "other") => {
    endRun(record, "needs-attention", reason)
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
    await needsAttention(`The label \`agent:${forced}\` asks for an agent type that has no enabled worker. Remove or change that label, then add \`${labels.ready}\` again.`, "unknown-agent-label")
    return
  }

  const claim = await claimWorker(config, issueLabels, runId)
  if (!claim) {
    await comment(repo.repo, issue.number, `The factory had no free worker in time. Remove and re-add the \`${labels.ready}\` label to try again.`)
    endRun(record, "no-worker")
    throw new Error("No free worker in time")
  }
  const { worker, box } = claim
  claimedAgent = worker.agent
  record.worker = worker.id
  record.agent = worker.agent
  console.log(`Worker ${worker.id} (${worker.agent}) claimed. ${box.kind === "docker" ? "Container" : box.kind === "daytona" ? "Daytona sandbox" : "Box"}: ${box.id}`)

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

    // Resume-from-review: an open factory pull request for this issue means a
    // person sent it back. Revise that branch instead of rebuilding it.
    let revising = null
    if (resumeEnabled(config)) {
      const pr = await findFactoryPullRequest(repo.repo, branch)
      if (pr) {
        const state = await getReviewState(repo.repo, pr)
        if (state.checksError) console.log(`Could not read the pull request's checks, so only review comments are used: ${redact(state.checksError).slice(0, 300)}`)
        const feedback = collectFeedback(state, { allowedActors: config.factory.allowedActors, issueAuthor: issue.user?.login })
        const failed = failedChecks(state.checkRuns)
        record.mode = "revise"
        revising = { number: pr.number, url: pr.html_url, feedback: redact(feedbackSection(pr.number, feedback, failed)) }
        console.log(`Resuming pull request #${pr.number}: ${feedback.length} review item(s), ${failed.length} failing check(s).`)
        await removeLabel(repo.repo, issue.number, labels.review)
        if (!revising.feedback) {
          await needsAttention(`Pull request #${pr.number} is open for this issue, but it has no review feedback from \`factory.allowedActors\` or the issue author and no failing checks, so the agent has nothing to revise. Leave a review on the pull request, then add the \`${labels.ready}\` label again.`, "nothing-to-revise")
          return
        }
      }
    }

    console.log("\nPreparing the workspace...")
    // The Box image tells git to save credentials on disk. NO_STORE switches that
    // off for our commands, and any saved file is removed, so the agent cannot
    // find the GitHub token.
    await sh(box, `rm -rf ${q(repoDir)} ${jobDir} ~/.git-credentials && mkdir -p ${jobDir}`)
    // A revision clones the pull request's branch itself, so the agent starts
    // from the reviewed commits and the push below is a normal fast-forward.
    await sh(box, `git ${NO_STORE} clone --quiet --depth 50 --branch ${q(revising ? branch : repo.baseBranch)} ${q(authedUrl)} ${q(repoDir)}`)
    // The token is removed from the clone here and only used again for the push.
    await sh(
      box,
      `cd ${q(repoDir)} && git remote set-url origin ${q(`https://github.com/${repo.repo}.git`)} && ${revising ? "" : `git checkout --quiet -b ${q(branch)} && `}git config user.name ${q(config.factory.gitAuthor.name)} && git config user.email ${q(config.factory.gitAuthor.email)}`,
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
    // Context Graph: precedents from past run records, in three named
    // layers, injected below. Off unless factory.contextGraph is true.
    // Retrieval here is by issue label; after a plan exists it is refined
    // by the plan's files (exact path match) for the implementation prompt.
    let contextText = ""
    let refineContext = null
    if (contextGraphEnabled(config)) {
      try {
        const allPrecedents = loadPrecedents({ indexFile: process.env.FACTORY_PRECEDENTS_FILE || config.factory.precedentsFile || "precedents.json", recordsDir: recordDir() })
        const queryLabels = issueLabels.filter((l) => !Object.values(labels).includes(l))
        const head = (await sh(box, `cd ${q(repoDir)} && git rev-parse HEAD`, { allowFailure: true })).output.trim().split("\n").at(-1)?.trim() ?? ""
        const fileMap = (await sh(box, `cd ${q(repoDir)} && git ls-files | head -50`, { allowFailure: true })).output.split("\n").filter(Boolean)
        const houseRules = []
        for (const name of ["AGENTS.md", "CLAUDE.md", "SKILL.md"]) {
          if ((await sh(box, `cd ${q(repoDir)} && test -f ${q(name)}`, { allowFailure: true })).code === 0) houseRules.push(name)
        }
        const repoFacts = { baseBranch: repo.baseBranch, checks: repo.checks, houseRules, fileMap, skillRefs: houseRules.includes("SKILL.md") ? ["SKILL.md in the app repo root"] : [] }
        refineContext = (files = []) => {
          const precedents = findPrecedents(allPrecedents, { labels: queryLabels, files })
          const bundle = buildContextBundle({ issue, comments, reviewFeedback: revising?.feedback ?? "", repo: repo.repo, repoFacts, precedents })
          record.contextBundle = bundle.layers
          return bundle.text
        }
        contextText = refineContext()
        noteDecision(record, { stage: "context", choice: record.contextBundle.filter((e) => e.layer === "reasoning").length ? `injected precedents from ${record.contextBundle.filter((e) => e.layer === "reasoning").map((e) => e.source).join(", ")}` : "no precedent matched this issue's labels", alternatives_rejected: ["embedding/vector or graph-database retrieval (not used by design)"], evidence: fileMap.slice(0, 5).length ? fileMap.slice(0, 5) : [repo.repo], policy_or_label: queryLabels[0] ?? "context-graph", outcome: "pending" })
        // Resume-from-review: re-verify any provenance-stamped facts that
        // travelled with the review feedback, and flag stale ones up front.
        if (revising) {
          const facts = parseStampedFacts(revising.feedback)
          if (facts.length) {
            const check = verifyProvenance(facts, { currentBaseCommit: head || null, existingSources: fileMap })
            if (check.stale.length) {
              contextText += staleFactsSection(check)
              noteDecision(record, { stage: "provenance", choice: `flagged ${check.stale.length} stale stamped fact(s) before coding`, evidence: check.stale.map((f) => f.source ?? f.text), policy_or_label: "context-graph", outcome: "pending" })
            }
          }
        }
        console.log(`Context bundle: ${record.contextBundle.length} item(s) across short-term/long-term/reasoning layers.`)
      } catch (error) {
        // Context is an aid, never a reason to kill a run that would work.
        console.log(`Context bundle skipped: ${redact(error.message).slice(0, 300)}`)
        contextText = ""
      }
    }

    const setup = await runCommands(box, "setup", repoDir, jobDir, repo.setup, stepMinutes)
    if (!setup.passed) {
      await needsAttention(`The repo's setup command \`${setup.command}\` failed in the worker Box, so the agent was not started. This is a factory or worker image problem, not a problem with the issue.\n\n${details("Setup output", setup.output)}`, "setup-failed")
      return
    }

    console.log(`\nSigning in ${worker.agent} and starting the agent...`)
    await signIn(box, config, worker.agent)
    await writeJobFiles(box, config, worker.agent)
    // Chromium has to be running before the agent's login shell starts, because
    // that is when the worker image decides whether a browser tool attaches to it.
    if (await startBrowser(box, config)) console.log("The Box's browser is running.")
    const timeoutMinutes = config.factory.agentTimeoutMinutes ?? 25

    // Plan-first (new pull requests only; a revision already has its plan in
    // the review feedback). The planning agent writes plan.md in the job
    // folder, the factory validates it and posts it to the issue, and only a
    // valid plan reaches the implementation prompt. An invalid one hands the
    // issue back instead of letting the agent improvise a scope.
    let plan = null
    if (planFirstEnabled(config) && !revising) {
      console.log("\nPlanning first: asking the agent for a validated plan before implementation...")
      const planPath = `${jobDir}/${PLAN_FILE}`
      // Setup may leave untracked build output; only changes the planning
      // pass itself adds count against it.
      const statusBefore = new Set((await sh(box, `cd ${q(repoDir)} && git status --porcelain`)).output.split("\n").filter(Boolean))
      const planned = await runAgent(box, config, worker.agent, { workDir: repoDir, jobDir, prompt: buildPlanPrompt(repo, issue, comments, planPath, contextText, contextGraphEnabled(config)), timeoutMinutes })
      noteAgentRun(record, planned.minutes)
      console.log(`Planning finished in ${planned.minutes} min with exit code ${planned.code}.`)
      if (planned.code !== 0) {
        await needsAttention(`The ${worker.agent} agent stopped with an error during the planning pass, so no plan was posted and nothing was implemented.\n\n${details("Agent log", planned.log)}`, "agent-error")
        return
      }
      const planQuestion = new RegExp(`^[ \\t]*${NEEDS_CLARIFICATION}(.*)`, "ms").exec(planned.summary)
      if (planQuestion) {
        await needsAttention(`The agent needs more detail before it can plan:\n\n> ${planQuestion[1].trim()}\n\nAnswer in a comment or edit the issue, then add the \`${labels.ready}\` label again.`, "needs-clarification")
        return
      }
      const planText = (await sh(box, `cat ${q(planPath)} 2>/dev/null`, { allowFailure: true })).output
      const { plan: parsed, errors } = validatePlanText(planText, repo)
      const touched = (await sh(box, `cd ${q(repoDir)} && git status --porcelain`)).output.split("\n").filter((line) => line && !statusBefore.has(line)).join("\n")
      if (touched) errors.push(`the planning pass changed files in the repository, which it must not do:\n${touched}`)
      if (errors.length) {
        await needsAttention(`The plan-first pass did not produce a valid plan, so nothing was implemented. Fix the issue text if it was unclear, then add the \`${labels.ready}\` label again.\n\n${errors.map((e) => `- ${e}`).join("\n")}\n\n${details("Plan received", planText || "(no plan file was written)")}`, "plan-invalid")
        return
      }
      plan = parsed
      if (refineContext) {
        contextText = refineContext(plan.files)
        try {
          if (plan.facts?.length) {
            const head = (await sh(box, `cd ${q(repoDir)} && git rev-parse HEAD`, { allowFailure: true })).output.trim().split("\n").at(-1)?.trim() ?? ""
            const filesNow = (await sh(box, `cd ${q(repoDir)} && git ls-files`, { allowFailure: true })).output.split("\n").filter(Boolean)
            const check = verifyProvenance(plan.facts, { currentBaseCommit: head || null, existingSources: filesNow })
            if (check.stale.length) contextText += staleFactsSection(check)
            noteDecision(record, { stage: "provenance", choice: check.stale.length ? `flagged ${check.stale.length} stale plan fact(s)` : `verified ${check.fresh.length} stamped plan fact(s)`, evidence: plan.facts.map((f) => f.source ?? f.text), policy_or_label: "context-graph", outcome: check.stale.length ? "failed" : "succeeded" })
          }
          noteDecision(record, { stage: "planning", choice: `validated plan: ${plan.files.join(", ")}`, evidence: plan.files, policy_or_label: "plan-first", outcome: "succeeded" })
        } catch { /* a tracing failure must not stop a valid plan */ }
      }
      await comment(repo.repo, issue.number, redact(renderPlanComment(plan, { runUrl })))
      console.log(`Plan validated and posted to the issue: ${plan.files.length} file(s), ${plan.criteria.length} acceptance criteria.`)
    }

    let result = await runAgent(box, config, worker.agent, { workDir: repoDir, jobDir, prompt: buildPrompt(repo, issue, comments, "", revising, plan, contextText), timeoutMinutes })
    noteAgentRun(record, result.minutes)
    console.log(`Agent finished in ${result.minutes} min with exit code ${result.code}.`)

    if (result.code !== 0) {
      await needsAttention(`The ${worker.agent} agent stopped with an error.\n\n${details("Agent log", result.log)}`, "agent-error")
      return
    }
    // Some agents print a line or two before the marker, so look for it at the
    // start of any line, not only at the start of the reply.
    const question = new RegExp(`^[ \\t]*${NEEDS_CLARIFICATION}(.*)`, "ms").exec(result.summary)
    if (question) {
      await needsAttention(`The agent needs more detail before it can start:\n\n> ${question[1].trim()}\n\nAnswer in a comment or edit the issue, then add the \`${labels.ready}\` label again.`, "needs-clarification")
      return
    }

    console.log("\nRunning checks...")
    let checks = await runCommands(box, "checks", repoDir, jobDir, repo.checks, stepMinutes)
    if (!checks.passed) {
      console.log(`Check failed: ${checks.command}. Giving the agent one chance to fix it.`)
      const extra = `\n# A check failed after your first attempt\n\nThe command \`${checks.command}\` failed with this output. Fix it.\n\n${redact(checks.output).slice(-3000)}\n`
      result = await runAgent(box, config, worker.agent, { workDir: repoDir, jobDir, prompt: buildPrompt(repo, issue, comments, extra, revising, plan, contextText), timeoutMinutes })
      noteAgentRun(record, result.minutes)
      checks = result.code === 0 ? await runCommands(box, "checks", repoDir, jobDir, repo.checks, stepMinutes) : checks
    }
    if (!checks.passed) {
      await needsAttention(`The change did not pass \`${checks.command}\`, so no pull request was opened.\n\n${details("Check output", checks.output)}`, "checks-failed")
      return
    }

    const status = (await sh(box, `cd ${q(repoDir)} && git add -A && git status --porcelain`)).output.trim()
    if (!status) {
      await needsAttention(`The agent finished without changing any files.\n\n${details("Agent reply", result.summary || result.log)}`, "no-changes")
      return
    }
    console.log(`\nChanged files:\n${status}`)
    // --no-renames lists a moved file under both its old and new path, so a
    // workflow moved out of .github/ is caught too.
    const staged = changedPaths((await sh(box, `cd ${q(repoDir)} && git diff --cached --name-only --no-renames`)).output)
    record.filesChanged = staged.length
    record.files = staged
    try { noteDecision(record, { stage: "implementation", choice: `changed ${staged.length} file(s): ${staged.slice(0, 10).join(", ")}`, evidence: staged.slice(0, 10).length ? staged.slice(0, 10) : [repo.repo], policy_or_label: record.labels.find((l) => !Object.values(labels).includes(l)) ?? "context-graph", outcome: checks.passed ? "succeeded" : "pending" }) } catch { /* tracing only */ }
    const blocked = protectedChanges(staged)
    if (blocked.length) {
      await needsAttention(`The agent changed files in \`.github/\`, which the factory never pushes, so no pull request was opened:\n\n${blocked.map((path) => `- \`${path}\``).join("\n")}\n\nIf the issue really needs a workflow change, make that change by hand.`, "protected-paths")
      return
    }

    // Risk gate: decided by the factory from what it measured (paths, diff
    // size, checks, tier, issue labels/text, failed precedents on the same
    // files). The agent's reply is not an input, so it cannot waive a gate.
    let gate = null
    if (riskGatesEnabled(config)) {
      const numstat = parseNumstat((await sh(box, `cd ${q(repoDir)} && git diff --cached --numstat --no-renames`, { allowFailure: true })).output)
      let precedents = []
      try {
        precedents = findPrecedents(loadPrecedents({ indexFile: process.env.FACTORY_PRECEDENTS_FILE || config.factory.precedentsFile || "precedents.json", recordsDir: recordDir() }), { files: staged })
      } catch { /* no precedents yet is not a reason to stop */ }
      gate = evaluateRiskGate(gateSettings(config), { files: staged, lines: numstat.lines, hasChecks: repo.checks.length > 0, tier: repo.tier ?? null, issue: { title: issue.title, body: issue.body, labels: issueLabels }, precedents })
      record.gate = { decision: gate.decision, rules: gate.reasons.map((r) => r.rule), lines: numstat.lines }
      console.log(`Risk gate: ${gate.decision}${gate.reasons.length ? ` (${gate.reasons.map((r) => r.rule).join(", ")})` : ""}.`)
      try { noteDecision(record, { stage: "risk-gate", choice: gate.decision, evidence: staged.slice(0, 10).length ? staged.slice(0, 10) : [repo.repo], policy_or_label: gate.reasons[0]?.rule ?? "risk-gates", outcome: gate.decision === "ready" ? "succeeded" : "pending" }) } catch { /* tracing only */ }
    }

    // Independent reviewer: a second, fresh agent session (another agent
    // type when the factory has one) reviews the staged diff against the
    // issue, the plan, the decision trace and the precedents used. The
    // factory blocks on findings at or above factory.reviewer.blockOn; a
    // reviewer that fails parks the issue too (onError), so a broken review
    // never waves a change through. Its reply is not an input either.
    // Returns { decision: "pass" | "block" | "error", findings, blocking,
    // counts, blockOn, agent, differentType, minutes, errors }.
    const runReviewer = async ({ settings, pick }) => {
      const base = { agent: pick.agent, differentType: pick.differentType, blockOn: settings.blockOn, findings: [], blocking: [], counts: null, minutes: null }
      // The change as it will be committed: HEAD, the staged diff and any
      // edit to a tracked file. New untracked files (a coverage folder from
      // running the tests) do not count; they are cleaned up afterwards.
      // Everything was staged with git add -A above, so nothing untracked
      // and unignored existed before the review.
      const fingerprint = async () => (await sh(box, `cd ${q(repoDir)} && git rev-parse HEAD && git diff --cached --no-renames | git hash-object --stdin && git diff --no-renames | git hash-object --stdin`, { allowFailure: true })).output
      // Snapshot the staged change, so whatever the reviewer does, the
      // author's change is exactly what gets committed (or nothing is).
      const headBefore = (await sh(box, `cd ${q(repoDir)} && git rev-parse HEAD`)).output.trim().split("\n").at(-1).trim()
      const treeBefore = (await sh(box, `cd ${q(repoDir)} && git write-tree`)).output.trim().split("\n").at(-1).trim()
      const before = await fingerprint()
      const diffPath = `${jobDir}/${DIFF_FILE}`
      const reviewPath = `${jobDir}/${REVIEW_FILE}`
      try {
        await sh(box, `cd ${q(repoDir)} && git diff --cached --no-renames > ${q(diffPath)} && rm -f ${q(reviewPath)}`)
        const diffStat = (await sh(box, `cd ${q(repoDir)} && git diff --cached --stat --no-renames`, { allowFailure: true })).output
        if (pick.agent !== worker.agent) {
          await signIn(box, config, pick.agent)
          await writeJobFiles(box, config, pick.agent)
        }
        const precedents = (record.contextBundle ?? []).filter((e) => e.layer === "reasoning")
        const prompt = buildReviewPrompt({ repo, issue, plan, decisions: record.decisions ?? [], precedents, diffPath, reviewPath, diffStat, revising, blockOn: settings.blockOn })
        console.log(`\nIndependent review by ${pick.agent}${pick.differentType ? "" : " (same agent type, fresh session)"}...`)
        const ran = await runAgent(box, config, pick.agent, { workDir: repoDir, jobDir, prompt, timeoutMinutes: settings.timeoutMinutes })
        base.minutes = ran.minutes
        const errors = []
        if (ran.code !== 0) errors.push(`the reviewer stopped with exit code ${ran.code}`)
        if ((await fingerprint()) !== before) errors.push("the reviewer changed the repository, which it must not do; the author's staged change was restored")
        const text = (await sh(box, `cat ${q(reviewPath)} 2>/dev/null`, { allowFailure: true })).output
        if (!errors.length) {
          const { review: parsed, errors: invalid } = validateReviewText(text)
          errors.push(...invalid)
          if (!errors.length) {
            const decided = decideReview(parsed.findings, settings)
            return { ...base, ...decided, findings: parsed.findings }
          }
        }
        return { ...base, decision: "error", errors: errors.map((e) => redact(e)) }
      } catch (error) {
        return { ...base, decision: "error", errors: [redact(error.message).slice(0, 300)] }
      } finally {
        // Put the author's change back exactly if anything moved, then make
        // sure it really is back; a mismatch stops the run before any push.
        await sh(box, `cd ${q(repoDir)} && git clean -fdq`, { allowFailure: true })
        if ((await fingerprint()) !== before) {
          await sh(box, `cd ${q(repoDir)} && git reset --quiet --soft ${q(headBefore)} && git read-tree ${q(treeBefore)} && git checkout-index -a -f && git clean -fdq`, { allowFailure: true })
          if ((await fingerprint()) !== before) throw new Error("The independent reviewer changed the repository and the staged change could not be restored, so nothing was pushed.")
        }
      }
    }

    let review = null
    if (reviewerEnabled(config)) {
      const settings = reviewerSettings(config)
      const pick = pickReviewerAgent(config, worker.agent, settings)
      reviewerAgent = pick.agent
      review = await runReviewer({ settings, pick })
      const rg = reviewGate(review, settings)
      if (rg && rg.decision !== "ready") gate = mergeGates(gate, rg)
      record.review = { agent: pick.agent, differentType: pick.differentType, decision: review.decision, counts: review.counts ?? null, minutes: review.minutes ?? null }
      console.log(`Independent review (${pick.agent}): ${review.decision}${review.findings?.length ? `, ${review.findings.length} finding(s)` : ""}.`)
      try { noteDecision(record, { stage: "review", choice: review.decision === "error" ? "review did not complete" : `${review.decision}: ${review.findings.length} finding(s), blocking at ${review.blockOn}`, evidence: review.blocking?.length ? review.blocking.slice(0, 10).map((f) => f.location) : staged.slice(0, 10).length ? staged.slice(0, 10) : [repo.repo], policy_or_label: "independent-review", outcome: review.decision === "pass" ? "succeeded" : review.decision === "block" ? "rejected" : "failed" }) } catch { /* tracing only */ }
    }
    const gateSection = gate ? `\n\n${renderGate(gate)}` : ""
    const reviewSection = review ? `\n\n${redact(renderReview(review))}` : ""
    const parkReason = gate?.reasons.some((r) => r.rule === "independent-review" && r.action === "needs-attention") ? (review?.decision === "error" ? "review-error" : "review-blocked") : "risk-gate"

    const title = issue.title
    const checkLine = repo.checks.length ? `Checks passed: ${repo.checks.map((c) => `\`${c}\``).join(", ")}.` : "This repo has no automated checks."
    // The summary is whatever the agent wrote into summary.md: unbounded.
    // Without the cap, a runaway reply would fail the PR creation (GitHub
    // caps bodies at 65,536 characters) after the commit and push were made.
    const description = capSummary(redact(result.summary)) || "(The agent gave no summary.)"

    const planChecklist = plan ? criteriaChecklist(plan, { checksPassed: true }) : ""
    const planBody = planChecklist ? `\n\n## Acceptance criteria\n\n${planChecklist}\n\nCriteria mapped to a configured check are ticked because those checks passed on this run. \`manual-review\` criteria stay unticked for the reviewer.` : ""

    if (revising) {
      // A normal push, never --force: the reviewed commits stay in the pull
      // request's history. If someone pushed to the branch meanwhile, git
      // refuses and the issue goes to needs-attention instead of losing work.
      await sh(box, `cd ${q(repoDir)} && git commit --quiet -m ${q(`Address review feedback on #${revising.number}\n\nRefs #${issue.number}`)}`)
      const pushed = await sh(box, `cd ${q(repoDir)} && git ${NO_STORE} push --quiet ${q(authedUrl)} ${q(`${branch}:${branch}`)}`, { allowFailure: true })
      if (pushed.code !== 0) {
        await needsAttention(`The revision for pull request #${revising.number} could not be pushed, most likely because the branch changed while the agent worked. Nothing was force-pushed. Add the \`${labels.ready}\` label again to revise from the new branch tip.\n\n${details("Push output", pushed.output ?? "")}`, "push-rejected")
        return
      }
      console.log(`\nRevised pull request: ${revising.url}`)
      record.pullRequest = revising.url
      await comment(repo.repo, revising.number, `Revised after review by factory worker \`${worker.id}\` (${worker.agent}). ${checkLine}${runUrl ? ` [Factory run](${runUrl}).` : ""}\n\n${description}${gateSection}${reviewSection}`)
      if (gate?.decision === "needs-attention") {
        await needsAttention(`The revision was pushed to ${revising.url}, but a gate needs a person to decide before it goes further.\n\n${renderGate(gate)}${reviewSection}`, parkReason)
        return
      }
      await removeLabel(repo.repo, issue.number, labels.running)
      await addLabels(repo.repo, issue.number, [labels.review])
      await comment(repo.repo, issue.number, `Pull request revised and ready for another review: ${revising.url}`)
      endRun(record, "pr-revised")
      return
    }

    await sh(box, `cd ${q(repoDir)} && git commit --quiet -m ${q(`${title}\n\nCloses #${issue.number}`)}`)
    await sh(box, `cd ${q(repoDir)} && git ${NO_STORE} push --quiet --force ${q(authedUrl)} ${q(`${branch}:${branch}`)}`)
    const pr = await openPullRequest(repo.repo, {
      head: branch,
      base: repo.baseBranch,
      title,
      draft: Boolean(gate && gate.decision !== "ready"),
      body: `Closes #${issue.number}\n\n${description}${planBody}${gateSection}${reviewSection}\n\n---\nBuilt by factory worker \`${worker.id}\` (${worker.agent}) in ${box.kind === "docker" ? "a Docker container" : box.kind === "daytona" ? "a Daytona sandbox" : "an Upstash Box"}. ${checkLine}${runUrl ? ` [Factory run](${runUrl}).` : ""}`,
    })
    console.log(`\nPull request: ${pr.html_url}${pr.draft ? " (draft)" : ""}`)
    record.pullRequest = pr.html_url

    if (gate?.decision === "needs-attention") {
      await needsAttention(`A draft pull request was opened, but a gate needs a person to decide before it goes further: ${pr.html_url}\n\n${renderGate(gate)}${reviewSection}`, parkReason)
      return
    }
    await removeLabel(repo.repo, issue.number, labels.running)
    await addLabels(repo.repo, issue.number, [labels.review])
    await comment(repo.repo, issue.number, gate?.decision === "draft" ? `Draft pull request opened for review: ${pr.html_url}\n\n${renderGate(gate)}${reviewSection}` : `Pull request ready for review: ${pr.html_url}${reviewSection}`)
    endRun(record, "pr-opened")
  } catch (error) {
    endRun(record, "error", "exception")
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
  endRun(record, "error", "exception")
} finally {
  // A broken record must never change the run's own result.
  if (keepRecord) {
    try {
      finishRunRecord(record)
      const file = writeRunRecord(record, recordDir())
      appendStepSummary(record)
      console.log(`Run record: ${file} (${record.outcome}${record.reason ? `, ${record.reason}` : ""})`)
    } catch (error) {
      console.error(`Could not write the run record: ${error.message}`)
    }
  }
}
