// Creates a paused Box for every enabled worker in factory.config.json that
// does not have one yet. Safe to run again. It skips workers that already have
// a Box and never deletes anything. Refuses when worker.provider is "docker"
// (there are no Boxes then; job containers are created per run).
//
// Preview: node --env-file=.env scripts/provision-workers.mjs [worker id ...]
// Create:  node --env-file=.env scripts/provision-workers.mjs [worker id ...] --yes
//
// Name worker ids to create only those, for example one Box to build the
// worker image in before the rest are created from it.
import { loadConfig, requireBoxProvider } from "../src/config.mjs"
import { createWorkerBox, describeBoxSettings, wantsBrowser, hasBrowser, browserMissingHelp } from "../src/box.mjs"
import { getWorkerStates } from "../src/workers.mjs"

const config = loadConfig()
// With the Docker provider there are no Boxes to provision: job containers
// are created per run. Refuse instead of creating Upstash Boxes by mistake.
requireBoxProvider(config, "provision-workers.mjs")
const browserNote = wantsBrowser(config) ? "browser access on" : "browser access off"
const confirmed = process.argv.includes("--yes")
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const missing = (await getWorkerStates(config)).filter((w) => w.enabled && !w.boxId && (only.length === 0 || only.includes(w.id)))

if (missing.length === 0) console.log("Every enabled worker already has a Box.")

for (const worker of missing) {
  if (!confirmed) {
    const image = config.agents[worker.agent].snapshotId ? "its own image" : config.factory.snapshotId ? "the shared image" : "a plain Box"
    console.log(`Would create ${worker.boxName} from ${image}, ${browserNote}, with ${describeBoxSettings(config, worker.agent)}`)
    continue
  }
  const box = await createWorkerBox(config, worker)
  // Checked on every new Box, and the first miss stops the run: an image built
  // in a Box without browser access hands that on to every Box made from it.
  const browserOk = !wantsBrowser(config) || (await hasBrowser(box))
  await box.pause()
  console.log(`Created and paused ${worker.boxName} (${box.id}), ${browserOk ? browserNote : "WITHOUT browser access"}, with ${describeBoxSettings(config, worker.agent)}`)
  if (!browserOk) {
    console.error(`\n${worker.boxName} has no browser access although the config asks for it. ${browserMissingHelp(config, worker.agent)}\nStopped before creating more Boxes like it.`)
    process.exitCode = 1
    break
  }
}

if (!confirmed && missing.length) console.log("\nPreview only. Add --yes to create them.")
