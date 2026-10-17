// Writes each agent type's boxSettings (model, reasoning effort and so on) into
// the worker Boxes that already exist. Use it after changing boxSettings in
// factory.config.json. New Boxes get the settings when they are created, so
// they do not need this.
//
// Busy workers are skipped. Run it again later for those.
//
// Preview: node --env-file=.env scripts/apply-box-settings.mjs [agent type]
// Apply:   node --env-file=.env scripts/apply-box-settings.mjs [agent type] --yes
import { Box } from "@upstash/box"
import { loadConfig, requireBoxProvider } from "../src/config.mjs"
import { applyBoxSettings, describeBoxSettings } from "../src/box.mjs"
import { getWorkerStates } from "../src/workers.mjs"

const config = loadConfig()
// Settings are written into worker Boxes. Under the Docker provider there
// are no Boxes, so refuse instead of Box.get()ing a container name.
requireBoxProvider(config, "apply-box-settings.mjs")
const apply = process.argv.includes("--yes")
const onlyAgent = process.argv.slice(2).find((a) => !a.startsWith("--"))

const workers = (await getWorkerStates(config)).filter((w) => w.boxId && (!onlyAgent || w.agent === onlyAgent))
for (const worker of workers) {
  const line = `${worker.boxName}: ${describeBoxSettings(config, worker.agent)}`
  if (worker.state === "busy") {
    console.log(`Skipping, busy   ${line}`)
    continue
  }
  if (!apply) {
    console.log(`Would apply      ${line}`)
    continue
  }
  const box = await Box.get(worker.boxId)
  await box.labels.add(config.factory.busyLabel) // keeps the factory away meanwhile
  try {
    if (worker.boxStatus === "paused") await box.resume()
    await applyBoxSettings(box, config, worker.agent)
    console.log(`Applied          ${line}`)
  } finally {
    await box.labels.remove(config.factory.busyLabel).catch(() => {})
    await box.pause().catch(() => {})
  }
}

if (!apply) console.log("\nPreview only. Add --yes to apply. Settings that were removed from the config are not removed from a Box. Recreate the Box for that.")
