// Runs one shell command in a worker's Box and prints the output. For debugging.
// The Box is resumed if needed and left running. Pause it from the console or
// let the next factory run do it.
//
// Run with: node --env-file=.env scripts/box-exec.mjs claude-01 "ls -la ~" [--pause]
//
// The first argument is a worker id, or the full name of another Box of this
// factory, such as a kept smoke-test Box.
import { Box } from "@upstash/box"
import { loadConfig, requireBoxProvider } from "../src/config.mjs"
import { sh } from "../src/box.mjs"
import { getWorkerStates } from "../src/workers.mjs"

const [workerId, command, flag] = process.argv.slice(2)
const config = loadConfig()
// A debug shell inside a worker's Box. Under the Docker provider there are
// no Boxes; run the worker image yourself (docker run --rm -it <image> bash)
// instead of reaching for Upstash with a container name.
requireBoxProvider(config, "box-exec.mjs")
if (!workerId || !command) throw new Error('Usage: box-exec.mjs <worker id or Box name> "<command>" [--pause]')
const worker = (await getWorkerStates(config)).find((w) => w.id === workerId)
const data = worker?.boxId
  ? { id: worker.boxId, status: worker.boxStatus }
  : (await Box.list({ label: config.factory.boxLabel })).find((b) => b.name === workerId)
if (!data) throw new Error(`No worker and no Box of this factory is called "${workerId}"`)

const box = await Box.get(data.id)
if (data.status === "paused") await box.resume()
const { code, output } = await sh(box, command, { allowFailure: true })
console.log(output)
console.log(`[exit ${code}]`)
if (flag === "--pause") await box.pause()
