// Dry run. Reads the incoming issue, checks it against the config, and prints
// which worker would take it. It changes nothing on GitHub or Upstash.
//
// Run with: node --env-file=.env src/plan.mjs owner/app-repo 12
import { loadConfig, findRepo } from "./config.mjs"
import { getIssue } from "./github.mjs"
import { getWorkerStates, pickWorker } from "./workers.mjs"
import { workerProvider } from "./config.mjs"
import { createDockerWorker } from "./docker.mjs"

const [repoName = process.env.FACTORY_REPO, issueNumber = process.env.FACTORY_ISSUE] = process.argv.slice(2)
if (!repoName || !issueNumber) {
  console.error("Usage: node src/plan.mjs <owner/repo> <issue number>")
  process.exit(1)
}

// Returning instead of calling process.exit avoids a Node crash on Windows
// when fetch connections are still closing.
async function main() {
  const config = loadConfig()
  console.log(
    `Config OK: ${config.repos.length} repos, ${config.workers.filter((w) => w.enabled).length} enabled workers.`,
  )

  const repo = findRepo(config, repoName)
  if (!repo) {
    console.error(`${repoName} is not in factory.config.json. Ignoring it.`)
    process.exitCode = 1
    return
  }

  const issue = await getIssue(repo.repo, issueNumber)
  const issueLabels = issue.labels.map((l) => l.name)
  console.log(`\nIssue ${repo.repo}#${issue.number}: ${issue.title}`)
  console.log(`State: ${issue.state}. Labels: ${issueLabels.join(", ") || "none"}`)

  if (issue.state !== "open" || !issueLabels.includes(config.labels.ready)) {
    console.log(`\nThe issue is not open with the "${config.labels.ready}" label, so the factory would skip it.`)
    return
  }

  const states = await getWorkerStates(config)
  console.log("\nWorkers:")
  for (const w of states)
    console.log(`  ${w.id.padEnd(16)} ${w.agent.padEnd(15)} ${w.state.padEnd(9)} Box: ${w.boxStatus}`)

  const worker = pickWorker(states, issueLabels, 0, config.agents)
  if (!worker) {
    console.log("\nNo free worker right now. The factory would wait for one.")
    return
  }

  if (workerProvider(config) === "docker") {
    // Dry-run in the literal sense: print the exact docker run, start nothing.
    const { runCommand } = await createDockerWorker(config, worker, "plan", { dryRun: true })
    console.log(`\nPlan: worker ${worker.id} (${worker.agent}) would take this issue in a new Docker container.`)
    console.log(`Would run: ${runCommand}`)
  } else {
    console.log(`\nPlan: worker ${worker.id} (${worker.agent}) would take this issue in Box ${worker.boxName}.`)
  }
  console.log(`Branch: ${config.factory.branchPrefix}${issue.number}, base: ${repo.baseBranch}`)
  console.log(`Setup: ${repo.setup.join(" && ") || "none"}. Checks: ${repo.checks.join(" && ") || "none"}`)
  console.log("\nDry run only. Nothing was changed.")
}

await main()
