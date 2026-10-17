// Provider selection and Docker invocation, tested without a Docker daemon
// (and without the Upstash SDK): everything here is pure argument/config
// logic. Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, workerProvider, dockerConfig } from "../src/config.mjs"
import { buildDockerRunArgs, buildDockerSmokeArgs, containerNameFor, containersForWorker, createDockerWorker, dockerPsArgs, formatDockerRunCommand, parseDockerInfo, parseDockerPs, parseDockerSystemDf, parseDockerVersion, parseMemoryBytes, summarizeDockerChecks, verifyDocker } from "../src/docker.mjs"

const baseConfig = () => ({
  factory: {
    repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
    branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
    allowedActors: ["me"],
  },
  labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
  agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
  repos: [{ repo: "me/app", baseBranch: "main" }],
  workers: [{ id: "claude-01", agent: "claude" }],
})

function load(config) {
  const file = join(mkdtempSync(join(tmpdir(), "factory-config-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return loadConfig(file)
}

test("box is the default provider when no worker section exists", () => {
  const config = load(baseConfig())
  assert.equal(workerProvider(config), "box")
  assert.equal(dockerConfig(config).image, "create-ant-factory-worker:latest")
})

test("docker provider and its limits come from worker.docker, with defaults", () => {
  const config = load({ ...baseConfig(), worker: { provider: "docker", docker: { cpus: 4 } } })
  assert.equal(workerProvider(config), "docker")
  assert.deepEqual(dockerConfig(config), { image: "create-ant-factory-worker:latest", cpus: "4", memory: "4g", host: null })
})

test("docker host can be pinned in config and bad hosts are refused", () => {
  const config = load({ ...baseConfig(), worker: { provider: "docker", docker: { host: "tcp://10.0.1.20:2376" } } })
  assert.equal(dockerConfig(config).host, "tcp://10.0.1.20:2376")
  assert.throws(() => load({ ...baseConfig(), worker: { provider: "docker", docker: { host: "two words" } } }), /worker\.docker\.host/)
})

test("unknown providers and bad docker limits are refused", () => {
  assert.throws(() => load({ ...baseConfig(), worker: { provider: "daytona" } }), /worker\.provider/)
  assert.throws(() => load({ ...baseConfig(), worker: { provider: "docker", docker: { memory: "lots" } } }), /worker\.docker\.memory/)
  assert.throws(() => load({ ...baseConfig(), worker: { provider: "docker", docker: { cpus: "0" } } }), /worker\.docker\.cpus/)
})

test("docker run args: limits and labels set, no ports, no docker.sock, no secrets", () => {
  const config = { ...baseConfig(), worker: { provider: "docker", docker: { image: "img:1", cpus: "2", memory: "4g" } } }
  const args = buildDockerRunArgs(config, { id: "claude-01", agent: "claude" }, "run 42")
  assert.equal(containerNameFor(config, { id: "claude-01" }, "run 42"), "factory-claude-01-run-42")
  assert.deepEqual(args.slice(0, 2), ["run", "-d"])
  assert.ok(args.includes("--cpus") && args.includes("--memory") && args.includes("worker=claude-01"))
  assert.ok(!args.includes("-p") && !args.includes("--publish"), "no published ports")
  assert.ok(!args.join(" ").includes("docker.sock"), "never mount the Docker socket")
  assert.ok(!args.join(" ").match(/TOKEN|SECRET|PASSWORD/), "no secrets in the run args")
})

test("dry run prints the exact command and starts nothing", async () => {
  const config = { ...baseConfig(), worker: { provider: "docker", docker: { image: "img:1" } } }
  const handle = await createDockerWorker(config, { id: "claude-01", agent: "claude" }, "7", { dryRun: true })
  assert.equal(handle.kind, "docker")
  assert.equal(handle.dryRun, true)
  assert.match(handle.runCommand, /^docker 'run' '-d'/)
  assert.equal(formatDockerRunCommand(buildDockerRunArgs(config, { id: "claude-01" }, "7")), handle.runCommand)
})

test("parseDockerPs marks only the labelled worker busy", () => {
  const rows = parseDockerPs("factory-claude-01-7\tUp 1m\tcreate-ant-factory=true,worker=claude-01,run-id=7\nother\tUp 1m\tapp=web")
  assert.equal(rows.find((r) => r.labels.worker === "claude-01")?.name, "factory-claude-01-7")
  assert.equal(rows.filter((r) => r.labels.worker === "codex-01").length, 0)
})

test("containersForWorker finds only the stuck containers of one worker", () => {
  const rows = parseDockerPs("factory-claude-01-7\tUp 1m\tcreate-ant-factory=true,worker=claude-01,run-id=7\nfactory-codex-01-9\tUp 2m\tcreate-ant-factory=true,worker=codex-01,run-id=9\nother\tUp 1m\tapp=web")
  assert.deepEqual(containersForWorker(rows, "claude-01").map((c) => c.name), ["factory-claude-01-7"])
  assert.deepEqual(containersForWorker(rows, "unknown"), [])
})

// --- verification (verifyDocker) -------------------------------------------
// All runs below inject a fake `docker` runner with fixture output, so they
// pass on machines with no Docker installed and never touch a daemon.

const dockerCfg = (extra = {}) => ({ ...baseConfig(), worker: { provider: "docker", docker: { image: "img:1", cpus: "2", memory: "4g", ...extra } } })

function fakeRun(responses) {
  // responses: first-arg -> {code, stdout, stderr}; arrays are consumed in order
  const queues = new Map(Object.entries(responses).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]))
  return async (args) => {
    const queue = queues.get(args[0]) ?? [{ code: 0, stdout: "", stderr: "" }]
    return queue.length > 1 ? queue.shift() : queue[0]
  }
}

const healthy = {
  "--version": { code: 0, stdout: "Docker version 27.3.1, build ce12230", stderr: "" },
  version: { code: 0, stdout: JSON.stringify({ Client: { Version: "27.3.1" }, Server: { Version: "27.3.1", ApiVersion: "1.47" } }), stderr: "" },
  info: { code: 0, stdout: JSON.stringify({ ServerVersion: "27.3.1", ContainersRunning: 1, Images: 5, NCPU: 4, MemTotal: 8 * 1024 ** 3, OperatingSystem: "Debian", Architecture: "arm64" }), stderr: "" },
  system: { code: 0, stdout: "Images\t2GB\t500MB\nContainers\t10MB\t0B", stderr: "" },
  image: { code: 0, stdout: "[]", stderr: "" },
  run: { code: 0, stdout: "", stderr: "" },
  ps: { code: 0, stdout: "factory-claude-01-7\tUp 1m\tcreate-ant-factory=true,worker=claude-01,run-id=7", stderr: "" },
}

test("parse helpers read version, info and system df fixtures", () => {
  assert.deepEqual(parseDockerVersion(healthy.version.stdout), { client: "27.3.1", server: "27.3.1", api: "1.47" })
  assert.equal(parseDockerVersion("Docker version 27.3.1, build x").client, "27.3.1")
  const info = parseDockerInfo(healthy.info.stdout)
  assert.equal(info.cpus, 4)
  assert.equal(info.memTotalBytes, 8 * 1024 ** 3)
  assert.deepEqual(parseDockerSystemDf(healthy.system.stdout)[0], { type: "Images", size: "2GB", reclaimable: "500MB" })
  assert.equal(parseMemoryBytes("4g"), 4 * 1024 ** 3)
  assert.equal(parseMemoryBytes("512m"), 512 * 1024 ** 2)
  assert.equal(parseMemoryBytes("lots"), null)
})

test("smoke args run the worker image with limits, no ports, no docker.sock", () => {
  const args = buildDockerSmokeArgs(dockerCfg())
  assert.deepEqual(args.slice(0, 2), ["run", "--rm"])
  assert.ok(args.includes("img:1") && args.at(-1) === "true")
  assert.ok(!args.includes("-p") && !args.join(" ").includes("docker.sock"))
})

test("verifyDocker passes end to end on healthy fixture output", async () => {
  const result = await verifyDocker(dockerCfg(), { run: fakeRun(healthy), env: {} })
  assert.equal(result.ok, true, JSON.stringify(result.checks))
  assert.deepEqual(result.checks.map((c) => c.id), ["cli", "daemon", "resources", "disk", "image", "smoke", "containers"])
  assert.equal(result.containers[0].labels.worker, "claude-01")
  assert.equal(summarizeDockerChecks(result.checks).problems, 0)
})

test("verifyDocker stops at a missing CLI and reports it as a failure, not a pass", async () => {
  const result = await verifyDocker(dockerCfg(), { run: async () => { throw new Error("spawn docker ENOENT") }, env: {} })
  assert.equal(result.ok, false)
  assert.equal(result.checks.length, 1)
  assert.match(result.checks[0].message, /docker CLI is not installed/)
})

test("verifyDocker flags an unreachable daemon, a missing image and a failing smoke", async () => {
  const noDaemon = await verifyDocker(dockerCfg(), { run: fakeRun({ ...healthy, version: { code: 1, stdout: "", stderr: "Cannot connect" } }), env: { DOCKER_HOST: "tcp://10.0.1.20:2376" } })
  assert.equal(noDaemon.ok, false)
  assert.equal(noDaemon.target, "tcp://10.0.1.20:2376")
  assert.match(noDaemon.checks.at(-1).message, /not reachable/)

  const noImage = await verifyDocker(dockerCfg(), { run: fakeRun({ ...healthy, image: { code: 1, stdout: "", stderr: "No such image" } }), env: {} })
  assert.equal(noImage.ok, false)
  assert.match(noImage.checks.at(-1).message, /docker build -f worker\/Dockerfile/)

  const badSmoke = await verifyDocker(dockerCfg(), { run: fakeRun({ ...healthy, run: { code: 126, stdout: "", stderr: "exec: true: not found" } }), env: {} })
  assert.equal(badSmoke.ok, false)
  assert.match(badSmoke.checks.at(-1).message, /smoke container/)
})

test("verifyDocker flags a host with less RAM than one container asks for", async () => {
  const small = { ...healthy, info: { code: 0, stdout: JSON.stringify({ NCPU: 1, MemTotal: 1 * 1024 ** 3, ContainersRunning: 0 }), stderr: "" } }
  const result = await verifyDocker(dockerCfg(), { run: fakeRun(small), env: {} })
  assert.equal(result.ok, false)
  assert.match(result.checks.find((c) => c.id === "resources").message, /less than worker\.docker\.memory/)
})

test("summarizeDockerChecks: notes never fail, fails always do", () => {
  assert.equal(summarizeDockerChecks([{ status: "ok" }, { status: "note" }]).ok, true)
  assert.equal(summarizeDockerChecks([{ status: "ok" }, { status: "fail" }]).problems, 1)
})

test("dockerPsArgs lists running containers by default and stopped ones with all", () => {
  const running = dockerPsArgs()
  assert.equal(running[0], "ps")
  assert.ok(!running.includes("-a"), "busy detection must only see running containers")
  assert.deepEqual(running.slice(running.indexOf("--filter"), running.indexOf("--filter") + 2), ["--filter", "label=create-ant-factory=true"])
  const all = dockerPsArgs({ all: true })
  assert.ok(all.includes("-a"), "release-worker must also see stopped containers")
  assert.deepEqual(all.filter((a) => a !== "-a"), running)
})

test("containersForWorker keeps a stopped leftover so release-worker removes it", () => {
  const rows = parseDockerPs("factory-claude-01-7\tExited (137) 2 hours ago\tcreate-ant-factory=true,worker=claude-01,run-id=7\nfactory-claude-01-9\tUp 1m\tcreate-ant-factory=true,worker=claude-01,run-id=9")
  assert.deepEqual(containersForWorker(rows, "claude-01").map((c) => c.name), ["factory-claude-01-7", "factory-claude-01-9"])
})
