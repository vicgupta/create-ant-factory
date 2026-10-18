// Frees a worker that is stuck as busy. That happens when a factory run is
// cancelled or crashes before it can release its Box. Check the Actions tab
// first: if a run is still using the worker, leave it alone.
//
// With the Docker worker provider there is no Box: a stuck busy worker is a
// leftover container from a killed run, and removing it is the whole cleanup
// (the workspace and every sign-in file go with it). Stopped containers are
// removed too: one that exited without being removed (host reboot, OOM kill)
// no longer marks the worker busy but still holds the job's sign-in files.
//
// With the Daytona provider it is the same idea: every factory sandbox
// labelled worker=<id>, running or stopped, is deleted. With E2B, every
// factory sandbox whose metadata names the worker, running or paused, is
// killed.
//
// Run with: node --env-file=.env scripts/release-worker.mjs <worker id>
import { Box } from "@upstash/box"
import { loadConfig, workerProvider, dockerHostFor } from "../src/config.mjs"
import { getWorkerStates } from "../src/workers.mjs"
import { sh, q } from "../src/box.mjs"
import { secretPaths } from "../src/agents.mjs"
import { listDockerWorkers, containersForWorker, removeDockerWorker, dockerHandle } from "../src/docker.mjs"
import { listDaytonaWorkers, sandboxesForWorker, deleteDaytonaSandboxes } from "../src/daytona.mjs"
import { listE2BWorkers, e2bSandboxesForWorker, killE2BSandboxes } from "../src/e2b.mjs"

const config = loadConfig()
const workerId = process.argv[2]

if (workerProvider(config) === "docker") {
  const worker = (await getWorkerStates(config)).find((w) => w.id === workerId)
  if (!worker) throw new Error("Usage: release-worker.mjs <worker id>")
  const stuck = containersForWorker(await listDockerWorkers(config, { all: true }), worker.id)
  if (stuck.length === 0) {
    console.log(`No factory containers, running or stopped, exist for worker ${worker.id}. Nothing to release.`)
    process.exit(0)
  }
  const host = dockerHostFor(config)
  for (const container of stuck) {
    await removeDockerWorker(dockerHandle(container.name, host))
    console.log(`Removed leftover container ${container.name} (${container.status})`)
  }
  console.log(`Worker ${worker.id} is free.`)
  process.exit(0)
}

if (workerProvider(config) === "daytona") {
  const worker = config.workers.find((w) => w.id === workerId)
  if (!worker) throw new Error("Usage: release-worker.mjs <worker id>")
  const stuck = sandboxesForWorker(await listDaytonaWorkers(config), worker.id)
  if (stuck.length === 0) {
    console.log(`No factory sandboxes, running or stopped, exist for worker ${worker.id}. Nothing to release.`)
    process.exit(0)
  }
  await deleteDaytonaSandboxes(config, stuck)
  for (const sandbox of stuck) console.log(`Deleted leftover Daytona sandbox ${sandbox.name} (${sandbox.state})`)
  console.log(`Worker ${worker.id} is free.`)
  process.exit(0)
}

if (workerProvider(config) === "e2b") {
  const worker = config.workers.find((w) => w.id === workerId)
  if (!worker) throw new Error("Usage: release-worker.mjs <worker id>")
  const stuck = e2bSandboxesForWorker(await listE2BWorkers(config), worker.id)
  if (stuck.length === 0) {
    console.log(`No factory sandboxes, running or paused, exist for worker ${worker.id}. Nothing to release.`)
    process.exit(0)
  }
  await killE2BSandboxes(config, stuck)
  for (const sandbox of stuck) console.log(`Killed leftover E2B sandbox ${sandbox.name} (${sandbox.state})`)
  console.log(`Worker ${worker.id} is free.`)
  process.exit(0)
}

const worker = (await getWorkerStates(config)).find((w) => w.id === workerId)
if (!worker?.boxId) throw new Error("Usage: release-worker.mjs <worker id> (the worker must have a Box)")

const box = await Box.get(worker.boxId)

// Clean up first and free the worker last, so no new run can claim the Box
// while its sign-in folder is being deleted. A cancelled run never reached its
// own cleanup.
if (worker.boxStatus === "paused") await box.resume()
await sh(box, `rm -rf ${secretPaths(config).map(q).join(" ")} ~/.git-credentials`, { allowFailure: true })
console.log("Removed any sign-in files left by the interrupted run.")
await box.pause().catch(() => {})

for (const label of await box.labels.list()) {
  if (label === config.factory.busyLabel || label.startsWith("run-")) {
    await box.labels.remove(label)
    console.log(`Removed label ${label}`)
  }
}
console.log(`Worker ${worker.id} is free and its Box is paused.`)
