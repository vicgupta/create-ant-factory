// Frees a worker that is stuck as busy. That happens when a factory run is
// cancelled or crashes before it can release its Box. Check the Actions tab
// first: if a run is still using the worker, leave it alone.
//
// With the Docker worker provider there is no Box: a stuck busy worker is a
// leftover container from a killed run, and removing it is the whole cleanup
// (the workspace and every sign-in file go with it).
//
// Run with: node --env-file=.env scripts/release-worker.mjs <worker id>
import { Box } from "@upstash/box"
import { loadConfig, workerProvider, dockerHostFor } from "../src/config.mjs"
import { getWorkerStates } from "../src/workers.mjs"
import { sh, q } from "../src/box.mjs"
import { secretPaths } from "../src/agents.mjs"
import { listDockerWorkers, containersForWorker, removeDockerWorker, dockerHandle } from "../src/docker.mjs"

const config = loadConfig()
const workerId = process.argv[2]

if (workerProvider(config) === "docker") {
  const worker = (await getWorkerStates(config)).find((w) => w.id === workerId)
  if (!worker) throw new Error("Usage: release-worker.mjs <worker id>")
  const stuck = containersForWorker(await listDockerWorkers(config), worker.id)
  if (stuck.length === 0) {
    console.log(`No factory containers are running for worker ${worker.id}. Nothing to release.`)
    process.exit(0)
  }
  const host = dockerHostFor(config)
  for (const container of stuck) {
    await removeDockerWorker(dockerHandle(container.name, host))
    console.log(`Removed stuck container ${container.name} (${container.status})`)
  }
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
