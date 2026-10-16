// Checks the local setup without changing anything and without printing a
// secret: tools, the config, which secrets have a value, whether the GitHub
// token reaches every repo, and whether the Box key works.
//
// Run with: node --env-file=.env scripts/check-setup.mjs
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { Box } from "@upstash/box"
import { loadConfig, usedAgents } from "../src/config.mjs"
import { readSecret } from "../src/agents.mjs"
import { describeBoxSettings } from "../src/box.mjs"

let problems = 0
const ok = (text) => console.log(`  ok    ${text}`)
const bad = (text) => (problems++, console.log(`  FIX   ${text}`))
const note = (text) => console.log(`  note  ${text}`)

console.log("Tools")
const [major, minor] = process.versions.node.split(".").map(Number)
major > 20 || (major === 20 && minor >= 6) ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old. --env-file needs 20.6 or newer`)
for (const tool of ["git", "gh"]) {
  spawnSync(tool, ["--version"]).status === 0 ? ok(`${tool} is installed`) : bad(`${tool} is not installed`)
}
const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" })
const ghText = `${gh.stdout}${gh.stderr}`
gh.status === 0 ? ok(`gh is signed in${/workflow/.test(ghText) ? "" : ". Its token may lack the workflow scope, which pushing workflow files needs"}`) : bad("gh is not signed in. Run: gh auth login")

existsSync(new URL("../package-lock.json", import.meta.url)) ? ok("package-lock.json exists") : bad("package-lock.json is missing. Run npm install and commit it: the Factory workflow runs npm ci, which fails without it")

console.log("\nConfig")
let config
try {
  config = loadConfig()
  ok(`${config.repos.length} repos, ${config.workers.filter((w) => w.enabled).length} enabled workers, agent types in use: ${usedAgents(config).join(", ")}`)
  for (const name of usedAgents(config)) note(`${name}: ${describeBoxSettings(config, name)}`)
} catch (error) {
  bad(error.message)
}

if (config) {
  console.log("\nSecrets (values are never shown)")
  const entries = [{ secret: "UPSTASH_BOX_API_KEY" }, { secret: "FACTORY_GITHUB_TOKEN" }, ...usedAgents(config).flatMap((name) => config.agents[name].auth ?? []), ...config.repos.flatMap((r) => r.secrets ?? [])]
  for (const entry of entries) {
    const value = readSecret(entry)
    value ? ok(`${entry.secret} is set (${value.length} characters)`) : bad(`${entry.secret} has no value in .env${entry.localFile ? ` or in ${entry.localFile}` : ""}`)
  }

  console.log("\nGitHub token")
  const token = process.env.FACTORY_GITHUB_TOKEN
  for (const repo of [config.factory.repo, ...config.repos.map((r) => r.repo)]) {
    if (!token) break
    const response = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } })
    if (response.ok) ok(`${repo} is reachable`)
    else bad(`${repo}: HTTP ${response.status}. The token cannot see this repo. A fine-grained token covers ONE owner, so the factory repo and the app repos need the same owner, and an organisation may have to approve the token first`)
  }
  note("Reachable is not proof of write access. The first dispatch and the first push are the real test.")

  console.log("\nUpstash Box")
  try {
    const boxes = await Box.list()
    ok(`the Box key works. ${boxes.length} Boxes on the account`)

    // Whatever is on the account and is not one of our workers, or our smoke
    // Box, belongs to something else, even if it shares our label or prefix.
    const prefix = config.factory.boxNamePrefix
    const workerNames = new Set(config.workers.map((w) => `${prefix}${w.id}`))
    const isOurs = (b) => workerNames.has(b.name) || ((b.name ?? "").startsWith(`${prefix}smoke-`) && (b.labels ?? []).includes(config.factory.boxLabel))
    const foreign = boxes.filter((b) => !isOurs(b))
    const clash = foreign.filter((b) => (b.labels ?? []).includes(config.factory.boxLabel) || (b.name ?? "").startsWith(prefix))
    if (clash.length) bad(`${clash.length} Boxes that are not this factory's workers share its label "${config.factory.boxLabel}" or its name prefix "${prefix}": ${clash.map((b) => b.name).join(", ")}. Choose another label and prefix, or scripts that select by label could touch them`)

    // The Box budget. Paused Boxes count toward the plan's limit.
    const wanted = config.workers.filter((w) => w.enabled).length
    const existing = boxes.filter((b) => workerNames.has(b.name)).length
    const limit = config.factory.boxLimit
    if (limit) {
      const spare = limit - foreign.length - wanted
      const line = `Box budget: limit ${limit} - ${foreign.length} Boxes of other projects - ${wanted} workers = ${spare} spare`
      if (spare < 0) bad(`${line}. The workers do not fit`)
      else if (spare === 0) note(`${line}. No slot is left for a smoke test once every worker has a Box (${existing} exist now)`)
      else ok(`${line} (${existing} worker Boxes exist now). Run smoke tests one at a time, and remember that --keep holds a slot`)
    } else {
      note(`This factory wants ${wanted} worker Boxes and ${foreign.length} other Boxes are on the account. Set factory.boxLimit to the plan's Box limit and this check does the sum. Paused Boxes count`)
    }
  } catch (error) {
    bad(`the Box key does not work: ${error.message}`)
  }

  console.log("\nTimeouts")
  const f = config.factory
  const worst = (f.waitForWorkerMinutes ?? 30) + 3 * (f.commandTimeoutMinutes ?? 20) + 2 * (f.agentTimeoutMinutes ?? 25)
  let workflowLimit = null
  try {
    workflowLimit = Number(/timeout-minutes:\s*(\d+)/.exec(readFileSync(new URL("../.github/workflows/factory.yml", import.meta.url), "utf8"))?.[1])
  } catch {}
  const sum = `worst case for one run: wait ${f.waitForWorkerMinutes ?? 30} + setup and two rounds of checks 3 x ${f.commandTimeoutMinutes ?? 20} + two agent runs 2 x ${f.agentTimeoutMinutes ?? 25} = ${worst} min`
  if (!workflowLimit) note(`${sum}. Could not read timeout-minutes from the workflow`)
  else if (worst + 10 > workflowLimit) bad(`${sum}, but the workflow stops at ${workflowLimit}. A run killed by that limit skips its cleanup and leaves the worker busy. Raise timeout-minutes or lower the config timeouts`)
  else ok(`${sum}, inside the workflow's ${workflowLimit}`)
}

console.log(problems ? `\n${problems} thing(s) to fix.` : "\nAll good.")
process.exitCode = problems ? 1 : 0
