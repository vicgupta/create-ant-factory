// Shows every worker, whether it is free or busy, and the state of its Box
// (Box provider) or container (Docker provider).
// Read-only.
//
// Run with: node --env-file=.env scripts/status.mjs
import { loadConfig, workerNoun } from "../src/config.mjs"
import { getWorkerStates } from "../src/workers.mjs"

const config = loadConfig()
const noun = workerNoun(config)
const states = await getWorkerStates(config)
for (const w of states) {
  console.log(`${w.id.padEnd(16)} ${w.agent.padEnd(15)} ${w.state.padEnd(9)} ${noun}: ${w.boxStatus.padEnd(12)} ${w.boxId ?? ""}`)
}
const count = (state) => states.filter((w) => w.state === state).length
console.log(`\n${count("free")} free, ${count("busy")} busy, ${count("disabled")} disabled`)
