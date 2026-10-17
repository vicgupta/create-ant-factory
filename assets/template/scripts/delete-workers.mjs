// Deletes worker Boxes so they can be recreated from the worker image. Deleting
// a Box is permanent. Worker Boxes hold nothing of value between jobs, but busy
// workers are always skipped. Refuses when worker.provider is "docker" (there
// are no Boxes then; leftover job containers go through scripts/release-worker.mjs).
//
// Preview:            node --env-file=.env scripts/delete-workers.mjs
// Delete all free:    node --env-file=.env scripts/delete-workers.mjs --yes
// Keep some workers:  node --env-file=.env scripts/delete-workers.mjs --keep claude-01 --yes
// Only some workers:  node --env-file=.env scripts/delete-workers.mjs claude-01 codex-01 --yes
//
// Afterwards run scripts/provision-workers.mjs --yes to create them again.
import { Box } from "@upstash/box"
import { loadConfig, requireBoxProvider } from "../src/config.mjs"
import { getWorkerStates } from "../src/workers.mjs"

const args = process.argv.slice(2)
const config = loadConfig()
// With the Docker provider there are no Boxes to delete: job containers are
// removed when the run ends. Refuse instead of misreading the state.
requireBoxProvider(config, "delete-workers.mjs")
const states = await getWorkerStates(config)
const confirmed = args.includes("--yes")
const keepIndex = args.indexOf("--keep")
const keep = keepIndex >= 0 ? args[keepIndex + 1].split(",") : []
const only = args.filter((a, i) => !a.startsWith("--") && (keepIndex < 0 || i !== keepIndex + 1))

const unknown = only.filter((id) => !states.some((w) => w.id === id))
if (unknown.length) throw new Error(`Unknown worker id: ${unknown.join(", ")}. Known workers: ${states.map((w) => w.id).join(", ")}`)
const targets = states.filter((w) => w.boxId && w.state !== "busy" && !keep.includes(w.id) && (only.length === 0 || only.includes(w.id)))
for (const w of states.filter((w) => w.boxId && !targets.includes(w))) console.log(`Keeping ${w.boxName} (${w.state})`)

if (targets.length === 0) {
  console.log("Nothing to delete.")
} else {
  console.log(`${confirmed ? "Deleting" : "Would delete"} ${targets.length} worker Boxes:`)
  for (const w of targets) console.log(`  ${w.boxName} (${w.boxId})`)
  if (confirmed) {
    await Box.delete({ boxIds: targets.map((w) => w.boxId) })
    console.log("Deleted. Run scripts/provision-workers.mjs --yes to create them again.")
  } else {
    console.log("\nPreview only. Add --yes to delete them for good.")
  }
}
