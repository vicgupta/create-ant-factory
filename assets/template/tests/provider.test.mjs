// Provider selection and Docker invocation, tested without a Docker daemon
// (and without the Upstash SDK): everything here is pure argument/config
// logic. Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, workerProvider, dockerConfig } from "../src/config.mjs"
import { buildDockerRunArgs, containerNameFor, createDockerWorker, formatDockerRunCommand, parseDockerPs } from "../src/docker.mjs"

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
  assert.deepEqual(dockerConfig(config), { image: "create-ant-factory-worker:latest", cpus: "4", memory: "4g" })
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
