// Builds a worker image. It runs the setup script inside one worker's Box,
// writes that agent type's default settings (model, effort), removes anything
// secret or job-specific, takes a snapshot, and saves the snapshot id in
// factory.config.json. New Boxes of that agent type are then created from it.
//
// Preview: node --env-file=.env scripts/build-snapshot.mjs <worker id> [--shared]
// Build:   node --env-file=.env scripts/build-snapshot.mjs <worker id> [--shared] --yes
//
// Without --shared the image belongs to the worker's agent type and is saved as
// agents.<name>.snapshotId. With --shared it is one tools-only image for every
// agent type, saved as factory.snapshotId.
//
// The worker needs a Box. Create one with: scripts/provision-workers.mjs <worker id> --yes
import { readFileSync, writeFileSync } from "node:fs"
import { Box } from "@upstash/box"
import { loadConfig, boxNameFor, requireBoxProvider } from "../src/config.mjs"
import { sh, q, runScript, applyBoxSettings, describeBoxSettings, requireBoxSettings, wantsBrowser, hasBrowser } from "../src/box.mjs"
import { getWorkerStates } from "../src/workers.mjs"
import { secretPaths } from "../src/agents.mjs"

const CONFIG_FILE = new URL("../factory.config.json", import.meta.url)
const config = loadConfig()
// Snapshots are built inside a worker's Box. Under the Docker provider there
// are no Boxes (one container per job), so refuse instead of reaching for
// Upstash with a worker id or a container name.
requireBoxProvider(config, "build-snapshot.mjs")
const shared = process.argv.includes("--shared")

// Text that gives away a secret. factory.secretScanPatterns ADDS to this list,
// for agents whose credentials look different.
const SECRET_PATTERNS = ["github_pat_", "ghp_", "gho_", "sk-ant-", "sk-proj-", "sk-svcacct-", "sk-or-", '"refresh_token"', ...(config.factory.secretScanPatterns ?? [])]

const workerId = process.argv.slice(2).find((a) => !a.startsWith("--"))
const worker = (await getWorkerStates(config)).find((w) => w.id === workerId)
if (!worker) throw new Error(`Usage: build-snapshot.mjs <worker id> [--shared] [--yes]. Known workers: ${config.workers.map((w) => w.id).join(", ")}`)
if (!worker.boxId) throw new Error(`Worker ${workerId} has no Box yet. Create it first: node --env-file=.env scripts/provision-workers.mjs ${workerId} --yes`)
if (worker.state === "busy") throw new Error(`Worker ${workerId} is busy. Pick a free one.`)
if (!shared) requireBoxSettings(config, worker.agent)

const agent = config.agents[worker.agent]
const snapshotName = `${config.factory.boxNamePrefix}${shared ? "worker" : worker.agent}-base`
const setupPath = (!shared && agent.setup) || "worker/setup.sh"
console.log(`Image:         ${shared ? "shared by every agent type" : `for agent type "${worker.agent}"`}, snapshot name ${snapshotName}`)
console.log(`Built in:      ${boxNameFor(config, worker)} (${worker.boxId})`)
console.log(`Setup script:  ${setupPath}`)
console.log(`Baked in:      ${shared ? "tools only. A shared image holds no model settings" : describeBoxSettings(config, worker.agent)}`)
console.log(`Browser:       ${wantsBrowser(config) ? "on. The image passes on the browser access of the Box it is built in, so that is checked first" : 'off ("browser": false in the config)'}`)
if (!process.argv.includes("--yes")) {
  console.log("\nPreview only. Add --yes to build.")
  process.exit(0)
}

const box = await Box.get(worker.boxId, { timeout: 15 * 60 * 1000 })
await box.labels.add(config.factory.busyLabel) // keeps the factory away while we build

try {
  if (worker.boxStatus === "paused") await box.resume()

  // Every Box made from this image gets the browser access of this Box, and
  // nothing passed to Box.fromSnapshot changes that. So an image built here
  // without it could never give a worker a browser.
  if (wantsBrowser(config) && !(await hasBrowser(box))) {
    throw new Error(`${boxNameFor(config, worker)} was created without browser access, and the image would pass that on to every worker. Browser access cannot be added to an existing Box. The user deletes this one (scripts/delete-workers.mjs ${workerId} --yes), then create it again as a plain Box: scripts/provision-workers.mjs ${workerId} --yes, with any snapshotId removed from factory.config.json first if the old image was built the same way. Or set "browser": false under "factory". No snapshot was taken.`)
  }

  const setup = readFileSync(new URL(setupPath, config.baseUrl), "utf8").replace(/\r\n/g, "\n")
  await box.files.write({ path: "/workspace/home/.image-build/setup.sh", content: setup })
  const result = await runScript(box, {
    name: "build",
    dir: "/workspace/home/.image-build",
    timeoutMinutes: config.factory.imageBuildTimeoutMinutes ?? 30,
    onTick: (minutes) => console.log(`  setup still running (${minutes} min)`),
    body: ["bash /workspace/home/.image-build/setup.sh"],
  })
  console.log(result.log)
  if (result.code !== 0) throw new Error(`${setupPath} failed with exit code ${result.code}. No snapshot was taken.`)

  // The agent type's default model and effort become part of its own image. A
  // shared image must hold none, or another agent type would inherit them, so
  // the settings files are removed for the snapshot and written back after it.
  const settingsFiles = Object.values(config.agents).flatMap((a) => (Array.isArray(a.boxSettings) ? a.boxSettings.map((x) => x.path) : []))
  if (shared && settingsFiles.length) await sh(box, `rm -f ${settingsFiles.map(q).join(" ")}`)
  if (!shared) await applyBoxSettings(box, config, worker.agent)

  // Nothing secret and nothing from old jobs may end up in the image.
  // That includes agent transcripts, which hold app code from earlier jobs.
  // jobFiles go too. They are written fresh for every job, and a house rules
  // file that mentions a token prefix as an example would trip the scan below.
  const jobFileTargets = Object.values(config.agents).flatMap((a) => (a.jobFiles ?? []).map((f) => q(f.to)))
  const transcripts = [".claude/projects", ".claude/todos", ".claude/shell-snapshots", ".codex/sessions", ".codex/log", ".codex/history.jsonl", ...jobFileTargets, ...(config.factory.imageCleanPaths ?? [])]
  // Paths come from the config and can hold any character (a Windows user syncing a folder, a name with an apostrophe). q() keeps each path one argument; a hand-written `'${p}'` breaks on an embedded quote and rm -rf then hits the wrong path.
  await sh(box, `cd /workspace/home && rm -rf .image-build work smoke .npm/_logs ${transcripts.join(" ")} ~/.git-credentials ${secretPaths(config).map(q).join(" ")}`)
  console.log("\nRemoved sign-in files and old workspaces.")

  // Last line of defence: refuse to snapshot if anything that looks like a
  // secret is still on disk.
  const leaks = await sh(box, `grep -rIlE --exclude-dir=skills --exclude-dir=node_modules --exclude-dir=site-packages '${SECRET_PATTERNS.join("|")}' /home/boxuser /workspace/home 2>/dev/null | head -n 10`, { allowFailure: true })
  if (leaks.output.trim()) throw new Error(`These files still hold something that looks like a secret, so no snapshot was taken:\n${leaks.output}`)
  console.log("Secret scan clean.")

  const snapshot = await box.snapshot({ name: snapshotName })
  console.log(`Snapshot ${snapshot.name}: ${snapshot.id}`)
  if (shared && Array.isArray(agent.boxSettings)) await applyBoxSettings(box, config, worker.agent) // this Box keeps working as before

  // Only one key changes. The file is rewritten as a whole, so hand formatting
  // in it is lost and the diff can look bigger than the change.
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
  if (shared) raw.factory.snapshotId = snapshot.id
  else raw.agents[worker.agent].snapshotId = snapshot.id
  writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + "\n")
  console.log(`Saved the snapshot id in factory.config.json as ${shared ? "factory.snapshotId" : `agents.${worker.agent}.snapshotId`}. Commit that change.`)
  console.log(`This Box already holds the image. Create the remaining workers with scripts/provision-workers.mjs --yes and they start from it.`)
} finally {
  await box.labels.remove(config.factory.busyLabel).catch(() => {})
  await box.pause().catch(() => {})
  console.log("Box released and paused.")
}
