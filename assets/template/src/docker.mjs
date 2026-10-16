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
import { dockerConfig } from "./config.mjs"

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

function runDocker(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

// For scripts/check-setup.mjs: is the CLI there, and is the worker image?
export function dockerSetupStatus(config) {
  const cli = spawnSync("docker", ["--version"], { encoding: "utf8" }).status === 0
  const imageName = dockerConfig(config).image
  const image = cli && spawnSync("docker", ["image", "inspect", imageName], { encoding: "utf8" }).status === 0
  return { cli, image, imageName, dockerHost: process.env.DOCKER_HOST ?? null }
}

// A running container, shaped like the subset of a Box the factory uses.
export function dockerHandle(name) {
  return {
    kind: "docker",
    id: name,
    name,
    exec: {
      async command(command) {
        const { code, stdout, stderr } = await runDocker(["exec", name, "sh", "-c", command])
        return { result: `${stdout}${stderr}`, status: code === 0 ? "completed" : "failed" }
      },
    },
    files: {
      async write({ path, content }) {
        const dir = path.slice(0, path.lastIndexOf("/")) || "/"
        const { code, stderr } = await runDocker(["exec", "-i", name, "sh", "-c", `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`], { input: content })
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

  await runDocker(["rm", "-f", name]) // a leftover from a killed run of the same id
  const { code, stdout, stderr } = await runDocker(args)
  if (code !== 0) {
    throw new Error(`docker run failed for worker ${worker.id} (image ${dockerConfig(config).image}): ${stderr.trim() || stdout.trim()}. Build the image with: docker build -f worker/Dockerfile -t ${dockerConfig(config).image} .`)
  }
  const handle = dockerHandle(name)
  const ready = await runDocker(["exec", name, "sh", "-c", "mkdir -p /workspace/home/work /workspace/home/.factory"])
  if (ready.code !== 0) throw new Error(`Worker container ${name} started but is not usable: ${ready.stderr.trim()}`)
  return handle
}

// Removal is the cleanup: workspace, sign-in files and the container all go.
export async function removeDockerWorker(handle) {
  const name = handle?.name ?? handle?.id
  if (!name) return
  const { code, stderr } = await runDocker(["rm", "-f", name])
  if (code !== 0) console.warn(`Could not remove worker container ${name}: ${stderr.trim()}. Remove it with: docker rm -f ${name}`)
}

// Running factory containers, for workers.mjs. Throws when Docker is
// unreachable so a run fails loudly instead of double-claiming a worker.
export async function listDockerWorkers() {
  const { code, stdout, stderr } = await runDocker(["ps", "--filter", `label=${DOCKER_LABEL}`, "--format", "{{.Names}}\t{{.Status}}\t{{.Labels}}"])
  if (code !== 0) throw new Error(`docker ps failed (is the Docker host reachable${process.env.DOCKER_HOST ? ` at DOCKER_HOST=${process.env.DOCKER_HOST}` : ""}?): ${stderr.trim()}`)
  return parseDockerPs(stdout)
}
