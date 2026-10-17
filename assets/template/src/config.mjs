// Loads factory.config.json and fails loudly if it is malformed. Every key is
// described in the skill's references/config.md.
import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const CONFIG_FILE = new URL("../factory.config.json", import.meta.url)
const MAX_LABEL_LENGTH = 20 // Upstash Box label limit
// Owner and repo names on GitHub allow only letters, digits, ".", "-" and
// "_". Anything else would break the places these names are used unquoted:
// the `run:` block of the workflow install-trigger.mjs generates, and
// `git remote set-url` in run.mjs. A quote, semicolon or `$(...)` that
// passes the loose "owner/name" shape would become shell code, so the
// strict character class is a security check, not pedantry.
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

// Agent env keys and secret "env" names are written as `export NAME='value'`
// lines into files the job sources in bash. A name that is not a shell
// identifier ("MY-VAR", "API KEY", "1TOKEN") makes that `source` fail inside
// the Box, so the job dies far from the config. Reject it here instead.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const isEnvName = (name) => typeof name === "string" && ENV_NAME.test(name)

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
    } else if (name.includes("'")) {
      // install-trigger.mjs writes labels.ready into a single-quoted GitHub
      // Actions expression (github.event.label.name == '...'). A quote ends
      // that string early, GitHub rejects the whole workflow file, and the
      // trigger stops working with no visible error. One rule for all four
      // names, so a later template change cannot reintroduce it elsewhere.
      errors.push(`labels.${key} must not contain a single quote: it would generate an invalid trigger workflow`)
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

  if (!REPO_NAME.test(config.factory.repo ?? "") || config.factory.repo.startsWith("OWNER/")) {
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
  // install-trigger.mjs puts these names inside fromJSON('...') in the
  // trigger workflow, so a quote would generate an invalid file the same way
  // as in a label name. A typo'd name (a space, an @-prefix) is quieter and
  // worse: it loads fine, and then the actor guard never matches anyone, so
  // every manual "Run workflow" run is refused without saying why. Looser
  // than GitHub's full signup rules on purpose: letters, digits, hyphens.
  if (Array.isArray(config.factory.allowedActors)) {
    for (const actor of config.factory.allowedActors) {
      if (typeof actor !== "string" || !/^[A-Za-z0-9-]+$/.test(actor)) {
        errors.push(`factory.allowedActors has ${JSON.stringify(actor)}, which is not a GitHub username (letters, digits and hyphens)`)
      }
    }
  }

  // Left out means true. Browser access is fixed when a Box is created, so the
  // default is the choice that never forces anyone to delete Boxes later.
  if (config.factory.browser !== undefined && typeof config.factory.browser !== "boolean") {
    errors.push('factory.browser must be true or false. It gives every Box browser access, and the default is true')
  }

  // Left out means false. With it on, re-adding the ready label to an issue
  // whose factory pull request is still open revises that pull request in
  // place (src/review.mjs) instead of rebuilding the branch from the base.
  if (config.factory.resumeFromReview !== undefined && typeof config.factory.resumeFromReview !== "boolean") {
    errors.push("factory.resumeFromReview must be true or false. With true, re-labelling an issue with an open factory pull request revises that pull request from its review feedback")
  }

  // Left out means false. With it on, a planning agent run writes plan.md,
  // the factory validates and posts it to the issue, and only then does the
  // implementation run start from it (src/plan-first.mjs).
  if (config.factory.planFirst !== undefined && typeof config.factory.planFirst !== "boolean") {
    errors.push("factory.planFirst must be true or false. With true, a validated plan is posted to the issue before implementation and the pull request ticks off its acceptance criteria")
  }

  // Left out means true. Each run writes runs/run-<id>.json (src/record.mjs),
  // which the workflow uploads and scripts/report.mjs aggregates.
  if (config.factory.runRecords !== undefined && typeof config.factory.runRecords !== "boolean") {
    errors.push("factory.runRecords must be true or false. With true (the default), every run writes a small run record that scripts/report.mjs turns into a report")
  }

  // Left out means false. With it on, a run first builds a context bundle
  // from past run records (src/context.mjs): exact label/path precedents,
  // named short-term/long-term/reasoning layers, a decisions[] trace on the
  // record, and provenance stamps on plan facts.
  if (config.factory.contextGraph !== undefined && typeof config.factory.contextGraph !== "boolean") {
    errors.push("factory.contextGraph must be true or false. With true, past run records become a precedent-aware context bundle in the agent prompt and each run traces its decisions")
  }
  if (config.factory.precedentsFile !== undefined && (typeof config.factory.precedentsFile !== "string" || !config.factory.precedentsFile.trim())) {
    errors.push('factory.precedentsFile must be a non-empty file name such as "precedents.json" (built by scripts/precedents.mjs from downloaded run records)')
  }

  // Every pull request goes to branchPrefix + the issue number. Without the
  // prefix the branch would be "undefined12", a failure that shows up far
  // from this file, so require it here. It also has to survive
  // `git checkout -b` in run.mjs, so it must form a legal branch name once
  // the issue number is appended. Without this check a prefix like
  // "factory 2/" fails mid-run, after a worker was already claimed. The
  // prefix on its own may end with "/" ("factory/" is a fine prefix): the
  // check runs on a sample branch name, not the bare prefix.
  if (typeof config.factory.branchPrefix !== "string" || !config.factory.branchPrefix) {
    errors.push('factory.branchPrefix must be a non-empty string, for example "factory/issue-"')
  } else if (!isValidBranchPrefix(config.factory.branchPrefix)) {
    errors.push(
      `factory.branchPrefix "${config.factory.branchPrefix}" is not usable in a git branch name. Keep letters, digits, "-", "_" and "/", and do not use spaces or any of ~ ^ : ? * [ \\, ".." or "@{"`,
    )
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

  // The Box budget in check-setup.mjs subtracts from this. A non-numeric
  // value turns the spare-Boxes sum into NaN, which reads as green: "NaN
  // spare" is not less than zero and not equal to zero, so it takes the ok
  // path. A plan limit is a whole number of Boxes, so require that here.
  if (config.factory.boxLimit !== undefined && (!Number.isInteger(config.factory.boxLimit) || config.factory.boxLimit <= 0)) {
    errors.push(`factory.boxLimit must be a positive number of Boxes on the Upstash plan, not ${JSON.stringify(config.factory.boxLimit)}`)
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
    for (const key of Object.keys(agent.env ?? {})) {
      if (!isEnvName(key)) errors.push(`agent "${name}": env name "${key}" must be a shell variable name (letters, digits and "_", not starting with a digit)`)
    }
    for (const entry of agent.auth ?? []) {
      if (!entry.secret || (!entry.env && !entry.file)) errors.push(`agent "${name}": each auth entry needs a secret and an env or a file`)
      else if (entry.env && !isEnvName(entry.env)) errors.push(`agent "${name}": auth env "${entry.env}" must be a shell variable name (letters, digits and "_", not starting with a digit)`)
    }
  }

  const repoNames = new Set()
  for (const repo of config.repos) {
    if (!REPO_NAME.test(repo.repo ?? "") || /^OWNER\//.test(repo.repo ?? "")) errors.push(`repo "${repo.repo}" must be a real owner/name`)
    if (repoNames.has(repo.repo)) errors.push(`repo "${repo.repo}" is listed twice`)
    repoNames.add(repo.repo)
    if (!repo.baseBranch) errors.push(`repo "${repo.repo}" needs a baseBranch`)
    repo.setup ??= []
    repo.checks ??= []
    repo.exclude ??= []
    // A plain string such as "setup": "npm ci" is an easy slip. It would only
    // fail inside a claimed worker, after the clone: run.mjs walks the string
    // one character at a time and then crashes on commands.flatMap, and
    // plan.mjs crashes on .join. So each of these must be a list of strings.
    for (const key of ["setup", "checks", "exclude"]) {
      const list = repo[key]
      if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item.trim())) {
        errors.push(`repo "${repo.repo}": ${key} must be a list of non-empty strings, for example ${key === "exclude" ? '[".venv/"]' : '["npm ci"]'}, not ${JSON.stringify(list)}`)
      }
    }
    for (const entry of repo.secrets ?? []) {
      if (!entry.secret || !entry.env) errors.push(`repo "${repo.repo}": each secrets entry needs a secret (its name in .env and GitHub) and an env (the variable the repo expects)`)
      else if (!isEnvName(entry.env)) errors.push(`repo "${repo.repo}": secrets env "${entry.env}" must be a shell variable name (letters, digits and "_", not starting with a digit)`)
    }
  }

  if (config.worker !== undefined) {
    if (!config.worker || typeof config.worker !== "object" || Array.isArray(config.worker)) {
      errors.push('"worker" must be an object like { "provider": "docker", "docker": { ... } } or { "provider": "box" }')
    } else {
      const provider = config.worker.provider ?? "box"
      if (!["box", "docker"].includes(provider)) errors.push(`worker.provider "${provider}" must be "docker" (the default) or "box"`)
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

// Git branch names follow git check-ref-format. The issue number is appended
// to the prefix, so the check runs on a sample branch name instead of the
// bare prefix: "factory/" alone is not a name, but "factory/12" is fine.
export function isValidBranchPrefix(prefix) {
  const name = `${prefix}0`
  if (name === "@") return false
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false
  if (name.includes("..") || name.includes("@{")) return false
  // No control characters, spaces, or ~ ^ : ? * [ \
  if (/[\x00-\x20\x7f~^:?*[\]\\]/.test(name)) return false
  for (const component of name.split("/")) {
    if (component === "" || component.startsWith(".") || component.endsWith(".lock")) return false
  }
  return true
}

// Which worker provider runs jobs. The template ships "docker". The "box"
// fallback stays so factories created before the Docker default (with no
// "worker" section at all) keep behaving exactly as before.
export function workerProvider(config) {
  return config.worker?.provider ?? "box"
}

// What a worker's unit of execution is called in user-facing text: "Box" for
// the Upstash provider, "Container" for the Docker provider (one container is
// created per job and removed when the job ends). Capitalised, for the start
// of a column. Kept in one place so status.mjs and plan.mjs cannot disagree.
export function workerNoun(config) {
  return workerProvider(config) === "docker" ? "Container" : "Box"
}

// Box-only scripts (provision-workers, delete-workers, smoke-test,
// build-snapshot, apply-box-settings, box-exec) create, delete, inspect,
// run commands in or take snapshots of Upstash Boxes. Under the Docker
// provider there are no Boxes: one container is created per job and removed
// when the job ends. Running one of those scripts in a Docker factory would
// create real Upstash Boxes (billed on the plan) that the factory never
// uses, or address a container name as a Box, so the scripts call
// this first and refuse with the Docker equivalent instead of doing the wrong
// thing quietly. Old factories with no "worker" section keep the "box"
// fallback in workerProvider, so they are unaffected.
export function requireBoxProvider(config, scriptName) {
  if (workerProvider(config) === "box") return
  throw new Error(
    `worker.provider is "docker", so ${scriptName} has nothing to do: it manages Upstash Boxes, and this factory has none. ` +
      `A Docker factory creates one container per job and removes it when the job ends; verify the Docker target with "node scripts/verify-docker.mjs" instead.`,
  )
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
