// Signs an agent in and runs it inside a Box. Agents are described in
// factory.config.json, so a new agent type needs no code change:
//
//   "auth":    secrets to place in the Box. Each entry has a "secret" name and
//              either "env" (export it as this variable) or "file" (write it to
//              this path).
//   "env":     extra environment variables for the agent.
//   "jobFiles": files from this repo that are copied into the Box at the start
//              of every job, such as a house CLAUDE.md or AGENTS.md. They are
//              read fresh each time, so editing them needs no image rebuild.
//   "command": the shell command. {prompt} is a file with the task, {summary}
//              is the file the agent's final reply must end up in.
import { existsSync, readFileSync } from "node:fs"
import { q, sh, runScript } from "./box.mjs"
import { readSecret } from "./secrets.mjs"

export { readSecret } // kept here so existing imports keep working

const HOME = "/workspace/home"
const ENV_FILE = `${HOME}/.factory/env`
export const REPO_ENV_FILE = `${HOME}/.factory/repo-env`

// Every path the factory writes secrets to, so they can be removed again.
export function secretPaths(config) {
  const files = Object.values(config.agents).flatMap((a) => (a.auth ?? []).filter((x) => x.file).map((x) => x.file))
  return [`${HOME}/.factory`, ...files]
}

export async function signIn(box, config, agentName) {
  const agent = config.agents[agentName]
  const lines = Object.entries(agent.env ?? {}).map(([key, value]) => `export ${key}=${q(value)}`)

  await sh(box, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`)
  for (const entry of agent.auth ?? []) {
    const value = readSecret(entry)
    if (!value) throw new Error(`Secret ${entry.secret} is not set, and agent "${agentName}" needs it`)
    if (entry.env) lines.push(`export ${entry.env}=${q(value)}`)
    if (entry.file) {
      const dir = entry.file.slice(0, entry.file.lastIndexOf("/"))
      await sh(box, `mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`)
      await box.files.write({ path: entry.file, content: value })
      await sh(box, `chmod 600 ${q(entry.file)}`)
    }
  }
  await box.files.write({ path: ENV_FILE, content: lines.join("\n") + "\n" })
  await sh(box, `chmod 600 ${ENV_FILE}`)
}

// Secrets a repo's own setup, tests and checks need, such as a test database
// URL. They go in their own file, which setup, checks and the agent all read.
// The agent's sign-in stays in a separate file that only the agent reads, so
// dependency install scripts never see it.
export async function writeRepoEnv(box, repo) {
  const lines = []
  for (const entry of repo.secrets ?? []) {
    const value = readSecret(entry)
    if (!value) throw new Error(`Secret ${entry.secret} is not set, and repo ${repo.repo} needs it`)
    lines.push(`export ${entry.env}=${q(value)}`)
  }
  await sh(box, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`)
  await box.files.write({ path: REPO_ENV_FILE, content: lines.map((line) => `${line}\n`).join("") })
  await sh(box, `chmod 600 ${REPO_ENV_FILE}`)
}

// Copies the agent type's jobFiles from the factory repo into the Box.
export async function writeJobFiles(box, config, agentName) {
  for (const file of config.agents[agentName].jobFiles ?? []) {
    const content = readFileSync(new URL(file.from, config.baseUrl), "utf8").replaceAll("\r\n", "\n")
    const dir = file.to.slice(0, file.to.lastIndexOf("/"))
    await sh(box, `mkdir -p ${q(dir)}`)
    await box.files.write({ path: file.to, content })
  }
}

// Runs the agent with runScript, so it is in the background, in bash, and
// polled. The task goes in through a file, and the agent's final reply has to
// end up in the summary file, which becomes the pull request description.
export async function runAgent(box, config, agentName, { workDir, jobDir, prompt, timeoutMinutes }) {
  const promptFile = `${jobDir}/prompt.md`
  const summaryFile = `${jobDir}/summary.md`
  const command = config.agents[agentName].command.replaceAll("{prompt}", promptFile).replaceAll("{summary}", summaryFile)

  await sh(box, `mkdir -p ${q(jobDir)} ${q(workDir)} && rm -f ${summaryFile}`)
  // promptExtra is for agents that cannot put their reply into {summary} through
  // the command line. It can tell them to write the file themselves.
  const extra = (config.agents[agentName].promptExtra ?? "").replaceAll("{summary}", summaryFile)
  await box.files.write({ path: promptFile, content: [prompt, extra].filter(Boolean).join("\n") })
  const result = await runScript(box, {
    name: "agent",
    dir: jobDir,
    timeoutMinutes,
    onTick: (minutes) => console.log(`  agent still working (${minutes} min)`),
    body: [`source ${ENV_FILE}`, `source ${REPO_ENV_FILE} 2>/dev/null || true`, "export PATH=$HOME/.local/bin:$PATH", `cd ${q(workDir)}`, command],
  })

  // Empty when the agent's command did not get its reply into {summary}. The
  // smoke test warns about that, because the pull request text comes from here.
  const summary = (await sh(box, `cat ${summaryFile} 2>/dev/null`, { allowFailure: true })).output.trim()
  return { ...result, summary }
}
