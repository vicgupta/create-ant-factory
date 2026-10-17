// Loads factory.config.json and fails loudly if it is malformed. Every key is
// described in the skill's references/config.md.
import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const CONFIG_FILE = new URL("../factory.config.json", import.meta.url)
const MAX_LABEL_LENGTH = 20 // Upstash Box label limit

export function loadConfig(file = CONFIG_FILE) {
  const config = JSON.parse(readFileSync(file, "utf8"))
  // Paths in the config (jobFiles, setup scripts) are relative to the config file.
  Object.defineProperty(config, "baseUrl", { value: new URL("./", file instanceof URL ? file : pathToFileURL(String(file))) })
  const errors = []

  for (const key of ["factory", "labels", "agents", "repos", "workers"]) {
    if (!config[key]) errors.push(`missing "${key}" section`)
  }
  if (errors.length) throw new Error(`factory.config.json: ${errors.join("; ")}`)

  // The four label names the factory moves an issue through. A missing one
  // fails confusingly later: `issueLabels.includes(undefined)` is always
  // false, so every run silently skips, and posting `[undefined]` to the
  // labels endpoint is a 422. Two keys sharing a name breaks the transitions
  // the same way, so each name must be unique too.
  for (const key of ["ready", "running", "review", "needsAttention"]) {
    const name = config.labels[key]
    if (typeof name !== "string" || !name.trim()) {
      errors.push(`labels.${key} must be the name of the GitHub issue label (a non-empty string)`)
    }
  }
  const labelNames = new Set()
  for (const key of ["ready", "running", "review", "needsAttention"]) {
    const name = config.labels[key]
    if (typeof name === "string" && name.trim()) {
      if (labelNames.has(name.toLowerCase())) errors.push(`labels.${key} "${name}" is used for another label too; each label needs its own name`)
      labelNames.add(name.toLowerCase())
    }
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(config.factory.repo ?? "") || config.factory.repo.startsWith("OWNER/")) {
    errors.push(`factory.repo "${config.factory.repo}" must be the real owner/name of the factory repo`)
  }
  for (const label of [config.factory.boxLabel, config.factory.busyLabel]) {
    if (!/^[A-Za-z0-9._:-]{1,20}$/.test(label ?? "")) {
      errors.push(`Box label "${label}" must be 1-${MAX_LABEL_LENGTH} letters, digits, ".", "_", "-" or ":"`)
    }
  }

  // Preview hosts such as Vercel block deployments for commits whose author is
  // not on their team, so this must be the address of a real team member.
  if (!config.factory.gitAuthor?.name || !config.factory.gitAuthor?.email) {
    errors.push("factory.gitAuthor needs a name and an email")
  } else if (/^OWNER@/.test(config.factory.gitAuthor.email)) {
    errors.push("factory.gitAuthor.email is still the placeholder. Use the noreply address of a real person on the team")
  }

  if (!Array.isArray(config.factory.allowedActors) || config.factory.allowedActors.length === 0 || config.factory.allowedActors.includes("OWNER")) {
    errors.push("factory.allowedActors needs the real GitHub usernames that may start the factory")
  }

  // Left out means true. Browser access is fixed when a Box is created, so the
  // default is the choice that never forces anyone to delete Boxes later.
  if (config.factory.browser !== undefined && typeof config.factory.browser !== "boolean") {
    errors.push('factory.browser must be true or false. It gives every Box browser access, and the default is true')
  }

  // Every pull request goes to branchPrefix + the issue number. Without the
  // prefix the branch would be "undefined12", a failure that shows up far
  // from this file, so require it here.
  if (typeof config.factory.branchPrefix !== "string" || !config.factory.branchPrefix) {
    errors.push('factory.branchPrefix must be a non-empty string, for example "factory/issue-"')
  }

  // Every worker Box (and Docker container) is named boxNamePrefix + worker id,
  // and check-setup flags any Box whose name starts with the prefix as a clash.
  // Left out, workers become "undefinedclaude-01"; left empty, every Box on the
  // account looks like a clash. Letters, digits, ".", "_" and "-" are safe for
  // both Upstash Box and Docker container names.
  if (typeof config.factory.boxNamePrefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.factory.boxNamePrefix)) {
    errors.push(`factory.boxNamePrefix must be a non-empty name such as "factory-" (letters, digits, ".", "_" or "-", starting with a letter or digit), not ${JSON.stringify(config.factory.boxNamePrefix)}`)
  }

  // A zero, negative or non-numeric timeout also fails far from the cause:
  // an instantly-dead worker deadline, or a runScript that throws at once.
  for (const key of ["waitForWorkerMinutes", "agentTimeoutMinutes", "commandTimeoutMinutes", "imageBuildTimeoutMinutes"]) {
    const value = config.factory[key]
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      errors.push(`factory.${key} must be a positive number of minutes, not ${JSON.stringify(value)}`)
    }
  }

  for (const [name, agent] of Object.entries(config.agents)) {
    // Box labels are at most 20 characters, and each Box gets "agent-<name>".
    if (!/^[a-z0-9-]{1,14}$/.test(name)) errors.push(`agent name "${name}" must be 1-14 lowercase letters, digits or dashes`)

    // "ask" is how the template ships. It loads, so the setup stages can run,
    // but nothing that creates a Box or a snapshot accepts it (see box.mjs).
    // [] means the user chose the CLI's own defaults.
    if (agent.boxSettings !== "ask" && !Array.isArray(agent.boxSettings)) {
      errors.push(`agent "${name}" needs "boxSettings": "ask" until the user has been asked, [] for the CLI's default model and effort, or a list of settings`)
    }
    for (const setting of Array.isArray(agent.boxSettings) ? agent.boxSettings : []) {
      const structured = setting.format === "json" || setting.format === "toml"
      const ok = setting.path?.startsWith("/") && ((structured && setting.values && typeof setting.values === "object") || (setting.format === "text" && typeof setting.content === "string"))
      if (!ok) errors.push(`agent "${name}": each boxSettings entry needs an absolute path, a format (json, toml or text) and values (or content for text)`)
      if (setting.format === "toml" && Object.values(setting.values ?? {}).some((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
        errors.push(`agent "${name}": toml boxSettings can only set simple top-level values. Use format "text" for anything nested`)
      }
    }

    if (agent.priority !== undefined && typeof agent.priority !== "number") errors.push(`agent "${name}": priority must be a number. Higher takes unlabelled issues first`)
    if (!agent.command?.includes("{prompt}")) errors.push(`agent "${name}" needs a command that contains {prompt}`)
    else if (!agent.command.includes("{summary}") && !agent.promptExtra?.includes("{summary}")) console.warn(`Warning: the command of agent "${name}" has no {summary}, so its pull requests will have no description.`)
    if (agent.command?.includes("{summary}") && agent.promptExtra?.includes("{summary}")) {
      console.warn(`Warning: agent "${name}" fills {summary} both from its command and through promptExtra. Use one, or the two writes overwrite each other.`)
    }
    for (const file of agent.jobFiles ?? []) {
      if (!file.from || !file.to?.startsWith("/")) errors.push(`agent "${name}": each jobFiles entry needs "from" (a path in this repo) and "to" (an absolute path in the Box)`)
      else if (!existsSync(new URL(file.from, config.baseUrl))) errors.push(`agent "${name}": jobFiles source "${file.from}" does not exist in this repo`)
    }
    for (const entry of agent.auth ?? []) {
      if (!entry.secret || (!entry.env && !entry.file)) errors.push(`agent "${name}": each auth entry needs a secret and an env or a file`)
    }
  }

  const repoNames = new Set()
  for (const repo of config.repos) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo.repo ?? "") || /^OWNER\//.test(repo.repo ?? "")) errors.push(`repo "${repo.repo}" must be a real owner/name`)
    if (repoNames.has(repo.repo)) errors.push(`repo "${repo.repo}" is listed twice`)
    repoNames.add(repo.repo)
    if (!repo.baseBranch) errors.push(`repo "${repo.repo}" needs a baseBranch`)
    repo.setup ??= []
    repo.checks ??= []
    repo.exclude ??= []
    for (const entry of repo.secrets ?? []) {
      if (!entry.secret || !entry.env) errors.push(`repo "${repo.repo}": each secrets entry needs a secret (its name in .env and GitHub) and an env (the variable the repo expects)`)
    }
  }

  if (config.worker !== undefined) {
    if (!config.worker || typeof config.worker !== "object" || Array.isArray(config.worker)) {
      errors.push('"worker" must be an object like { "provider": "box" } or { "provider": "docker", "docker": { ... } }')
    } else {
      const provider = config.worker.provider ?? "box"
      if (!["box", "docker"].includes(provider)) errors.push(`worker.provider "${provider}" must be "box" (the default) or "docker"`)
      if (provider === "docker" || config.worker.docker !== undefined) {
        const docker = dockerConfig(config)
        if (!docker.image) errors.push("worker.docker.image must name the worker image to run")
        if (!/^[0-9]+(\.[0-9]+)?$/.test(docker.cpus) || Number(docker.cpus) <= 0) errors.push(`worker.docker.cpus "${docker.cpus}" must be a positive number`)
        if (!/^[0-9]+(\.[0-9]+)?[bkmg]?$/i.test(docker.memory)) errors.push(`worker.docker.memory "${docker.memory}" must look like "4g", "512m" or a byte count`)
        if (docker.host !== null && (typeof docker.host !== "string" || !docker.host || /\s/.test(docker.host))) errors.push('worker.docker.host must be one Docker endpoint with no spaces (for example "tcp://10.0.1.20:2376"), or left out to use DOCKER_HOST / docker context')
      }
    }
  }

  const workerIds = new Set()
  for (const worker of config.workers) {
    if (!/^[a-z0-9-]+$/.test(worker.id ?? "")) errors.push(`worker id "${worker.id}" must be lowercase letters, digits and dashes`)
    if (workerIds.has(worker.id)) errors.push(`worker "${worker.id}" is listed twice`)
    workerIds.add(worker.id)
    if (!config.agents[worker.agent]) errors.push(`worker "${worker.id}" uses unknown agent "${worker.agent}"`)
    worker.enabled ??= true
  }

  if (errors.length) throw new Error(`factory.config.json:\n  - ${errors.join("\n  - ")}`)
  return config
}

// Which worker provider runs jobs. Upstash Box is the default so existing
// factories (no "worker" section at all) keep behaving exactly as before.
export function workerProvider(config) {
  return config.worker?.provider ?? "box"
}

export const DOCKER_DEFAULTS = { image: "create-ant-factory-worker:latest", cpus: "2", memory: "4g" }

// Docker settings with defaults filled in. `host` is optional: when set it
// wins (passed to the docker CLI as -H); otherwise the CLI's own
// DOCKER_HOST / docker context decides where it talks.
export function dockerConfig(config) {
  const docker = config.worker?.docker ?? {}
  return {
    image: docker.image ?? DOCKER_DEFAULTS.image,
    cpus: String(docker.cpus ?? DOCKER_DEFAULTS.cpus),
    memory: String(docker.memory ?? DOCKER_DEFAULTS.memory),
    host: docker.host ?? null,
  }
}

// The Docker endpoint a command will actually hit, for display and -H.
export function dockerHostFor(config, env = process.env) {
  return dockerConfig(config).host ?? env.DOCKER_HOST ?? null
}

export function findRepo(config, repoName) {
  return config.repos.find((r) => r.repo.toLowerCase() === String(repoName).toLowerCase())
}

export function boxNameFor(config, worker) {
  return `${config.factory.boxNamePrefix}${worker.id}`
}

// Agent types that at least one enabled worker runs.
export function usedAgents(config) {
  return [...new Set(config.workers.filter((w) => w.enabled).map((w) => w.agent))]
}
