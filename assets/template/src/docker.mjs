// Docker worker provider: one container per job on a Docker host the user
// controls (local, or a VM/VPC host via DOCKER_HOST / docker context).
//
// The handle returned here deliberately exposes the same two primitives the
// rest of the factory uses on a Box — exec.command() and files.write() —
// so src/box.mjs's sh()/runScript() and src/agents.mjs drive a container
// without knowing it is one. Anything Box-only (labels, pause, browser,
// snapshots) stays in the Box path.
//
// Safety shape, by construction in buildDockerRunArgs():
//   - no published ports (-p) and no /var/run/docker.sock mount, ever
//   - no secrets in the image or in these args; secrets are written inside
//     the running container at job time by agents.mjs, exactly as for a Box
//   - resource limits come from worker.docker in factory.config.json
//   - the container is removed (docker rm -f) when the job ends
import { spawn, spawnSync } from "node:child_process"
import { dockerConfig, dockerHostFor } from "./config.mjs"

export const DOCKER_LABEL = "create-ant-factory=true"

const sanitize = (value) => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "worker"

// One container per job, named after the worker and the run so a stuck one
// is easy to find (and easy to remove by hand: see references/providers.md).
export function containerNameFor(config, worker, runId) {
  return sanitize(`${config.factory.boxNamePrefix ?? "factory-"}${worker.id}-${runId}`)
}

// Pure: the exact `docker run` argument list. Tested in tests/provider.test.mjs
// and printed by src/plan.mjs as the dry run, so it can be verified on a
// machine with no Docker at all. `env` is for non-secret variables only:
// values given here are visible in `docker inspect`.
export function buildDockerRunArgs(config, worker, runId, { env = {} } = {}) {
  const docker = dockerConfig(config)
  const name = containerNameFor(config, worker, runId)
  const args = [
    "run", "-d",
    "--name", name,
    "--label", DOCKER_LABEL,
    "--label", `worker=${worker.id}`,
    "--label", `run-id=${sanitize(runId)}`,
    "--cpus", docker.cpus,
    "--memory", docker.memory,
    "--security-opt", "no-new-privileges",
    "--workdir", "/workspace/home/work",
    "-e", "HOME=/workspace/home",
  ]
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`)
  args.push(docker.image, "sleep", "infinity")
  return args
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

// The same command as one printable line, for dry runs and logs.
export function formatDockerRunCommand(args) {
  return `docker ${args.map(shellQuote).join(" ")}`
}

// Parses `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Labels}}'` output.
// Pure, so worker-busy detection is testable without a daemon.
export function parseDockerPs(output) {
  return String(output ?? "").split("\n").filter(Boolean).map((line) => {
    const [name = "", status = "", labelsText = ""] = line.split("\t")
    const labels = Object.fromEntries(labelsText.split(",").filter(Boolean).map((pair) => {
      const at = pair.indexOf("=")
      return at < 0 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)]
    }))
    return { name, status, labels }
  })
}

function runDocker(args, { input, host = null } = {}) {
  return new Promise((resolve, reject) => {
    // -H only when an endpoint is configured; otherwise the CLI's own
    // DOCKER_HOST / docker context decides, exactly as a user's docker would.
    const child = spawn("docker", [...(host ? ["-H", host] : []), ...args], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

// Lightweight probe kept for callers that only need CLI/image presence.
// The full shared verification is verifyDocker() below; check-setup and
// scripts/verify-docker.mjs both use that, not this.
export function dockerSetupStatus(config) {
  const cli = spawnSync("docker", ["--version"], { encoding: "utf8" }).status === 0
  const imageName = dockerConfig(config).image
  const image = cli && spawnSync("docker", ["image", "inspect", imageName], { encoding: "utf8" }).status === 0
  return { cli, image, imageName, dockerHost: dockerHostFor(config) }
}

// ---------------------------------------------------------------------------
// Shared Docker verification. ONE implementation, used at creation/setup time
// (scripts/check-setup.mjs) and on demand later (scripts/verify-docker.mjs),
// always against the configured target host — never just "is a CLI present".
//
// Steps, in order, each producing { id, status: "ok"|"fail"|"note", message }:
//   cli -> daemon (docker version) -> resources (docker info / system df)
//   -> image (present, or pulled when pullIfMissing) -> smoke
//   (docker run --rm <image> true) -> running factory containers (docker ps)
// A failed step that later steps depend on stops the chain. `run` is
// injectable so the parsing/aggregation is unit-tested with fixture output
// on machines with no Docker at all.
// ---------------------------------------------------------------------------

export function parseDockerVersion(output) {
  const text = String(output ?? "").trim()
  try {
    const parsed = JSON.parse(text)
    return { client: parsed.Client?.Version ?? null, server: parsed.Server?.Version ?? null, api: parsed.Server?.ApiVersion ?? parsed.Client?.ApiVersion ?? null }
  } catch {}
  const versions = [...text.matchAll(/version\s+([0-9][^,\s]*)/gi)].map((m) => m[1])
  return { client: versions[0] ?? null, server: versions[1] ?? versions[0] ?? null, api: null }
}

export function parseDockerInfo(output) {
  try {
    const info = JSON.parse(String(output ?? ""))
    return {
      serverVersion: info.ServerVersion ?? null,
      containersRunning: info.ContainersRunning ?? null,
      images: info.Images ?? null,
      cpus: info.NCPU ?? null,
      memTotalBytes: info.MemTotal ?? null,
      operatingSystem: info.OperatingSystem ?? null,
      architecture: info.Architecture ?? null,
    }
  } catch {
    return { serverVersion: null, containersRunning: null, images: null, cpus: null, memTotalBytes: null, operatingSystem: null, architecture: null }
  }
}

export function parseDockerSystemDf(output) {
  return String(output ?? "").split("\n").filter(Boolean).map((line) => {
    const [type = "", size = "", reclaimable = ""] = line.split("\t")
    return { type, size, reclaimable }
  })
}

// "4g" / "512m" / "1024" (bytes) -> bytes, for comparing config vs host.
export function parseMemoryBytes(value) {
  const match = /^([0-9]+(?:\.[0-9]+)?)([bkmg])?$/i.exec(String(value).trim())
  if (!match) return null
  const factor = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(match[2] ?? "").toLowerCase()]
  return Math.round(Number(match[1]) * factor)
}

// Pure aggregation: ok only when no step failed. Notes never fail a run.
export function summarizeDockerChecks(checks) {
  const problems = checks.filter((c) => c.status === "fail").length
  return { ok: problems === 0, problems, checks }
}

// The trivial smoke: start the worker image, run `true`, remove it (--rm).
// Same limits/no-ports/no-socket shape as a real job container.
export function buildDockerSmokeArgs(config) {
  const docker = dockerConfig(config)
  return [
    "run", "--rm",
    "--label", DOCKER_LABEL, "--label", "verify=true",
    "--cpus", docker.cpus, "--memory", docker.memory,
    "--security-opt", "no-new-privileges",
    docker.image, "true",
  ]
}

export async function verifyDocker(config, { run, env = process.env, pullIfMissing = false } = {}) {
  const docker = dockerConfig(config)
  const host = dockerHostFor(config, env)
  const target = host ?? env.DOCKER_CONTEXT ?? "current docker context / local socket"
  const exec = run ?? ((args) => runDocker(args, { host }))
  const checks = []
  const add = (id, status, message) => checks.push({ id, status, message })
  const done = (extra = {}) => ({ ...summarizeDockerChecks(checks), host, target, image: docker.image, containers: [], ...extra })

  let versionOut
  try {
    versionOut = await exec(["--version"])
  } catch (error) {
    versionOut = { code: 1, stdout: "", stderr: error.message }
  }
  if (versionOut.code !== 0) {
    add("cli", "fail", `worker.provider is "docker" but the docker CLI is not installed (or not on PATH). Install Docker on the machine that runs the factory, or point DOCKER_HOST at your Docker host`)
    return done()
  }
  add("cli", "ok", `docker CLI ${parseDockerVersion(versionOut.stdout).client ?? ""} installed; target: ${target}`.replace("  ", " "))

  const daemon = await exec(["version", "--format", "{{json .}}"])
  if (daemon.code !== 0) {
    add("daemon", "fail", `the Docker daemon at ${target} is not reachable${host ? ` (DOCKER_HOST/config host: ${host})` : ""}. Start Docker on the VPS, check DOCKER_HOST / docker context and any TLS certs, then re-run. Detail: ${(daemon.stderr || daemon.stdout).trim().slice(-300)}`)
    return done()
  }
  const version = parseDockerVersion(daemon.stdout)
  add("daemon", "ok", `Docker daemon reachable at ${target}${version.server ? ` (server ${version.server})` : ""}`)

  const infoResult = await exec(["info", "--format", "{{json .}}"])
  if (infoResult.code !== 0) {
    add("resources", "fail", `docker info failed on ${target}: ${(infoResult.stderr || infoResult.stdout).trim().slice(-300)}`)
    return done()
  }
  const info = parseDockerInfo(infoResult.stdout)
  const wantedBytes = parseMemoryBytes(docker.memory)
  if (info.memTotalBytes && wantedBytes && info.memTotalBytes < wantedBytes) {
    add("resources", "fail", `the Docker host has ${Math.round(info.memTotalBytes / 1024 ** 3 * 10) / 10} GiB RAM, less than worker.docker.memory "${docker.memory}" for one container. Lower worker.docker.memory or use a bigger host`)
  } else {
    add("resources", "ok", `host resources: ${info.cpus ?? "?"} CPUs, ${info.memTotalBytes ? `${Math.round(info.memTotalBytes / 1024 ** 3 * 10) / 10} GiB` : "?"} RAM${info.containersRunning !== null ? `, ${info.containersRunning} containers running` : ""} (config asks cpus ${docker.cpus}, memory ${docker.memory} per job)`)
  }
  const df = await exec(["system", "df", "--format", "{{.Type}}\t{{.Size}}\t{{.Reclaimable}}"])
  if (df.code === 0) {
    const imagesRow = parseDockerSystemDf(df.stdout).find((r) => /^images/i.test(r.type))
    if (imagesRow) add("disk", "note", `docker disk: images use ${imagesRow.size} (${imagesRow.reclaimable} reclaimable). Prune with: docker image prune`)
  } else {
    add("disk", "note", "docker system df was not available; disk use was not checked")
  }

  let image = await exec(["image", "inspect", docker.image])
  if (image.code !== 0 && pullIfMissing) {
    add("image", "note", `worker image "${docker.image}" is not present locally; pulling it (--pull)`)
    const pull = await exec(["pull", docker.image])
    if (pull.code === 0) image = { code: 0 }
    else add("image-pull", "fail", `could not pull "${docker.image}": ${(pull.stderr || pull.stdout).trim().slice(-300)}`)
  }
  if (image.code !== 0) {
    add("image", "fail", `worker image "${docker.image}" is missing on ${target}. Build it there: docker build -f worker/Dockerfile -t ${docker.image} . — or pull it: docker pull ${docker.image} (on-demand script: add --pull)`)
    return done()
  }
  add("image", "ok", `worker image ${docker.image} present on ${target}`)

  const smokeArgs = buildDockerSmokeArgs(config)
  if (smokeArgs.join(" ").includes("docker.sock") || smokeArgs.includes("-p")) throw new Error("smoke args must never publish ports or mount the Docker socket")
  const smoke = await exec(smokeArgs)
  if (smoke.code !== 0) {
    add("smoke", "fail", `a smoke container from ${docker.image} did not run to completion (docker run --rm ${docker.image} true). Detail: ${(smoke.stderr || smoke.stdout).trim().slice(-300)}`)
    return done()
  }
  add("smoke", "ok", `smoke passed: docker run --rm ${docker.image} true exited 0`)

  const ps = await exec(["ps", "--filter", `label=${DOCKER_LABEL}`, "--format", "{{.Names}}\t{{.Status}}\t{{.Labels}}"])
  if (ps.code !== 0) {
    add("containers", "fail", `docker ps failed on ${target}: ${(ps.stderr || ps.stdout).trim().slice(-300)}`)
    return done()
  }
  const containers = parseDockerPs(ps.stdout)
  add("containers", "ok", containers.length ? `${containers.length} running factory container(s): ${containers.map((c) => `${c.name} (${c.status})`).join(", ")}` : "no factory containers running right now (normal between jobs)")
  return done({ containers })
}

// A running container, shaped like the subset of a Box the factory uses.
export function dockerHandle(name, host = null) {
  return {
    kind: "docker",
    id: name,
    name,
    host,
    exec: {
      async command(command) {
        const { code, stdout, stderr } = await runDocker(["exec", name, "sh", "-c", command], { host })
        return { result: `${stdout}${stderr}`, status: code === 0 ? "completed" : "failed" }
      },
    },
    files: {
      async write({ path, content }) {
        const dir = path.slice(0, path.lastIndexOf("/")) || "/"
        const { code, stderr } = await runDocker(["exec", "-i", name, "sh", "-c", `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`], { input: content, host })
        if (code !== 0) throw new Error(`Could not write ${path} in container ${name}: ${stderr.trim()}`)
      },
    },
    // No Upstash browser in a container. startBrowser() in box.mjs checks
    // `kind` first, so this is only a guard for other callers.
    browser: {
      async listTabs() { throw new Error("browser is not enabled for this box") },
      tab: { async create() { throw new Error("browser is not enabled for this box") } },
    },
  }
}

// Starts the job's container and returns its handle. With dryRun it starts
// nothing: it returns the handle-to-be plus the exact command, which is how
// plan.mjs (and the tests) verify the invocation without a Docker daemon.
export async function createDockerWorker(config, worker, runId, { dryRun = false, env = {} } = {}) {
  const args = buildDockerRunArgs(config, worker, runId, { env })
  const name = containerNameFor(config, worker, runId)
  if (dryRun) return { ...dockerHandle(name), dryRun: true, runCommand: formatDockerRunCommand(args) }

  const host = dockerHostFor(config)
  await runDocker(["rm", "-f", name], { host }) // a leftover from a killed run of the same id
  const { code, stdout, stderr } = await runDocker(args, { host })
  if (code !== 0) {
    throw new Error(`docker run failed for worker ${worker.id} (image ${dockerConfig(config).image}): ${stderr.trim() || stdout.trim()}. Build the image with: docker build -f worker/Dockerfile -t ${dockerConfig(config).image} .`)
  }
  const handle = dockerHandle(name, host)
  const ready = await runDocker(["exec", name, "sh", "-c", "mkdir -p /workspace/home/work /workspace/home/.factory"], { host })
  if (ready.code !== 0) throw new Error(`Worker container ${name} started but is not usable: ${ready.stderr.trim()}`)
  return handle
}

// Removal is the cleanup: workspace, sign-in files and the container all go.
export async function removeDockerWorker(handle) {
  const name = handle?.name ?? handle?.id
  if (!name) return
  const { code, stderr } = await runDocker(["rm", "-f", name], { host: handle?.host ?? null })
  if (code !== 0) console.warn(`Could not remove worker container ${name}: ${stderr.trim()}. Remove it with: docker rm -f ${name}`)
}

// Pure: the parsed `docker ps` rows that belong to one worker. A worker
// stuck busy under the Docker provider is exactly this list: each row is a
// container a killed run left behind (scripts/release-worker.mjs removes
// them; removing a container is the whole cleanup, the workspace and every
// sign-in file go with it).
export function containersForWorker(containers, workerId) {
  return containers.filter((c) => c.labels?.worker === workerId)
}

// Running factory containers, for workers.mjs. Throws when Docker is
// unreachable so a run fails loudly instead of double-claiming a worker.
export async function listDockerWorkers(config) {
  const { code, stdout, stderr } = await runDocker(["ps", "--filter", `label=${DOCKER_LABEL}`, "--format", "{{.Names}}\t{{.Status}}\t{{.Labels}}"], { host: config ? dockerHostFor(config) : null })
  if (code !== 0) throw new Error(`docker ps failed (is the Docker host reachable${process.env.DOCKER_HOST ? ` at DOCKER_HOST=${process.env.DOCKER_HOST}` : ""}?): ${stderr.trim()}`)
  return parseDockerPs(stdout)
}
