// Claiming, using and releasing a worker Box.
import { Box } from "@upstash/box"
import { getWorkerStates, pickWorker } from "./workers.mjs"
import { workerProvider } from "./config.mjs"
import { createDockerWorker, removeDockerWorker } from "./docker.mjs"

const BOX_TIMEOUT_MS = 15 * 60 * 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Quotes a value for use inside a shell command.
export const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

// Runs a short shell command in the Box and returns its output and exit code.
// Throws on a non-zero exit code unless allowFailure is set.
//
// The Box runs this with plain `sh`, not bash, and the call holds one HTTP
// request open until the command ends. Use runScript for anything that needs
// bash or may run for more than a minute.
export async function sh(box, command, { allowFailure = false } = {}) {
  const run = await box.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`)
  const match = /__EXIT__(\d+)\s*$/.exec(run.result ?? "")
  const code = match ? Number(match[1]) : run.status === "completed" ? 0 : 1
  const output = (run.result ?? "").replace(/__EXIT__\d+\s*$/, "").trimEnd()
  if (code !== 0 && !allowFailure) {
    throw new Error(`Command failed with exit code ${code}:\n${output.slice(-2000)}`)
  }
  return { code, output }
}

// Runs a bash script in the Box in the background and polls until it ends.
// This is how everything slow runs: the agent, repo setup, checks, the image
// build. The script runs as a login shell, so /etc/profile.d applies, and all
// its lines share one shell, so `source venv/bin/activate` carries over.
//
// A line "#STEP some name" in the body marks a step. The name of the last
// step that started comes back as `step`, which tells you which check failed.
export async function runScript(box, { name, dir, body, timeoutMinutes = 20, onTick }) {
  const base = `${dir}/${name}`
  const script = ["#!/bin/bash", `exec > ${base}.log 2>&1`, ...body.map((line) => (line.startsWith("#STEP ") ? `echo ${q(line.slice(6))} > ${base}.step` : line)), ""].join("\n")
  await sh(box, `mkdir -p ${q(dir)} && rm -f ${base}.exit ${base}.step ${base}.log ${base}.pid`)
  await box.files.write({ path: `${base}.sh`, content: script })
  // setsid gives the script its own process group, so everything it starts (the
  // agent, a dev server the agent forgot) can be stopped together afterwards.
  await sh(box, `nohup setsid bash -lc ${q(`echo $$ > ${base}.pid; bash ${base}.sh; echo $? > ${base}.exit`)} > /dev/null 2>&1 & echo started`)
  // /bin/kill, because the kill built into the Box's sh does not accept a process group.
  const stopGroup = () => sh(box, `/bin/kill -TERM -- -$(cat ${base}.pid) 2>/dev/null; sleep 1; /bin/kill -KILL -- -$(cat ${base}.pid) 2>/dev/null; true`, { allowFailure: true })

  const started = Date.now()
  while (Date.now() - started < timeoutMinutes * 60 * 1000) {
    await sleep(10_000)
    const { output } = await sh(box, `cat ${base}.exit 2>/dev/null || echo running`)
    const minutes = ((Date.now() - started) / 60000).toFixed(1)
    if (output.trim() === "running") {
      onTick?.(minutes)
      continue
    }
    const log = (await sh(box, `tail -n 80 ${base}.log 2>/dev/null`, { allowFailure: true })).output
    const step = (await sh(box, `cat ${base}.step 2>/dev/null`, { allowFailure: true })).output.trim()
    await stopGroup() // background processes the script left running
    return { code: Number(output.trim()), log, step, minutes }
  }
  await stopGroup()
  throw new Error(`"${name}" did not finish within ${timeoutMinutes} minutes.`)
}

// The model and effort question must be answered before a Box is made. The
// template ships with "boxSettings": "ask", and this is where that is refused.
export function requireBoxSettings(config, agentName) {
  if (!Array.isArray(config.agents[agentName].boxSettings)) {
    throw new Error(
      `Agent type "${agentName}" still has "boxSettings": "ask". Before any Box or snapshot is created for it, ask the user whether these workers should use the CLI's own default model and reasoning effort or specific ones. Then set boxSettings to [] for the defaults, or fill it in (see references/agents.md in the skill).`,
    )
  }
}

// Writes an agent type's default settings into a Box: the model, the reasoning
// effort, or anything else its CLI reads from a user-level settings file. They
// live in the Box (and in any snapshot taken from it), not on the command line.
// mergeBoxSetting below works out each file's new content.
export async function applyBoxSettings(box, config, agentName) {
  requireBoxSettings(config, agentName)
  for (const setting of config.agents[agentName].boxSettings) {
    const dir = setting.path.slice(0, setting.path.lastIndexOf("/"))
    await sh(box, `mkdir -p ${q(dir)}`)
    const existing = (await sh(box, `cat ${q(setting.path)} 2>/dev/null`, { allowFailure: true })).output
    await box.files.write({ path: setting.path, content: mergeBoxSetting(existing, setting) })
  }
}

// The new content of one settings file, given what is in it now ("" when it
// does not exist yet):
//
//   { "path": "...", "format": "json", "values": { ... } }  merged into the JSON file
//   { "path": "...", "format": "toml", "values": { ... } }  merged as top-level TOML keys
//   { "path": "...", "format": "text", "content": "..." }   replaces the file
//
// Merging matters. Codex, for one, keeps its own entries in config.toml.
export function mergeBoxSetting(existing, setting) {
  if (setting.format === "json") {
    let current = {}
    try {
      current = JSON.parse(existing || "{}")
    } catch {}
    return JSON.stringify({ ...current, ...setting.values }, null, 2) + "\n"
  }
  if (setting.format === "toml") {
    // Top-level keys must come before the first [table] header.
    const lines = existing ? existing.split("\n") : []
    const firstTable = lines.findIndex((line) => line.trim().startsWith("["))
    const head = firstTable < 0 ? lines : lines.slice(0, firstTable)
    const tables = firstTable < 0 ? [] : lines.slice(firstTable)
    const keys = Object.keys(setting.values)
    const isOurs = (line) => keys.some((key) => line.trim().startsWith(key) && /^\s*=/.test(line.trim().slice(key.length)))
    const kept = head.filter((line) => line.trim() && !isOurs(line))
    const added = Object.entries(setting.values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    return [...added, ...kept, "", ...tables].join("\n").trimEnd() + "\n"
  }
  return setting.content ?? ""
}

// One line that says which defaults a Box of this agent type gets. Shown in
// previews so nobody bakes in a model without noticing.
export function describeBoxSettings(config, agentName) {
  const settings = config.agents[agentName].boxSettings
  if (!Array.isArray(settings)) return "NOT DECIDED YET (boxSettings is \"ask\")"
  if (settings.length === 0) return "the CLI's own default model and effort"
  return settings.map((s) => `${s.path.split("/").pop()}: ${s.values ? JSON.stringify(s.values) : "custom file"}`).join("; ")
}

// Browser access (Upstash's own Chromium, `box.browser`) is on unless the config
// says otherwise. It is fixed when a Box is created and cannot be added later.
export const wantsBrowser = (config) => config.factory.browser ?? true

// Options for every Box this factory creates. `browser` only counts in
// Box.create. Box.fromSnapshot does not send it: a Box made from a snapshot has
// browser access exactly when the Box the snapshot was taken from had it.
export function boxOptions(config, name, labels) {
  return { name, labels, runtime: config.factory.runtime ?? "node", browser: wantsBrowser(config), timeout: BOX_TIMEOUT_MS }
}

// Whether a Box has browser access. Listing tabs does not start Chromium, and a
// Box without browser access answers "browser is not enabled for this box".
export async function hasBrowser(box) {
  try {
    await box.browser.listTabs()
    return true
  } catch (error) {
    if (/not enabled/i.test(error.message)) return false
    throw error
  }
}

// What to tell someone whose Box lacks the browser access the config asks for.
export const browserMissingHelp = (config, agentName) =>
  imageFor(config, agentName)
    ? `It came from a worker image, and an image passes on the browser access of the Box it was built in. Passing browser: true to Box.fromSnapshot changes nothing. Delete this Box, create a plain browser-enabled one (remove the snapshotId from factory.config.json for a moment), rebuild the image in it with scripts/build-snapshot.mjs, then create the workers from the new image.`
    : `Browser access cannot be added to an existing Box. Delete this Box and create it again (the user runs scripts/delete-workers.mjs, then scripts/provision-workers.mjs), or set "browser": false under "factory" if these workers should not have one.`

// Upstash's Chromium only starts when a first tab is opened. After that it
// listens on port 9222 inside the Box, where a tool such as agent-browser can
// attach to it. A job goes on without a browser when this fails.
export async function startBrowser(box, config) {
  if (box?.kind === "docker") return false // no Upstash Chromium in a container; the agent uses any browser installed in the image
  if (!wantsBrowser(config)) return false
  try {
    await box.browser.tab.create("about:blank")
    return true
  } catch (error) {
    console.warn(`Could not start the Box's browser (${error.message}). The job goes on without it.`)
    return false
  }
}

// Creates a worker's Box. An agent type can have its own worker image
// (agents.<name>.snapshotId). Otherwise the shared image (factory.snapshotId)
// is used, and without any image a plain Upstash Box. The agent type's default
// settings are written into the new Box either way.
export const createWorkerBox = (config, worker) => createAgentBox(config, worker.agent, worker.boxName, [config.factory.boxLabel, `agent-${worker.agent}`])

// Also used by the smoke test, so that it tests the same Box a worker would get,
// including an agent CLI that only exists in the worker image.
export async function createAgentBox(config, agentName, name, labels) {
  requireBoxSettings(config, agentName)
  const options = boxOptions(config, name, labels)
  const snapshotId = imageFor(config, agentName)
  const box = snapshotId ? await Box.fromSnapshot(snapshotId, options) : await Box.create(options)
  await applyBoxSettings(box, config, agentName)
  return box
}

export const imageFor = (config, agentName) => config.agents[agentName].snapshotId ?? config.factory.snapshotId ?? null

// The label a run puts on the Box it claims, so a second run that reaches
// the same worker at the same moment can see the claim and back off (the
// lower label wins). A Box label holds at most 20 characters, and two runs
// must never compute the same label: run ids grow at the tail, so keeping
// the first 20 characters would throw away exactly the digits that tell two
// runs starting together apart. The last 16 digits fit ("run-" + 16 = 20)
// and stay readable, so a stale label still matches its run in the console.
export function runLabelFor(runId) {
  return `run-${String(runId).replace(/\D/g, "").slice(-16)}`
}

// Waits for a free worker, then marks its Box busy. Two factory runs can start
// at the same moment and pick the same worker, so each run also adds its own
// run label. If two run labels show up, the higher one backs off.
export async function claimWorker(config, issueLabels, runId) {
  // Docker provider: no pool to claim from. Pick a worker with no running
  // container, then start its one-job container. The running container is
  // the busy marker other runs see (getWorkerStates), so two runs starting
  // together can still race in the gap before `docker run` returns; the
  // workflow's per-issue concurrency and the one-container-per-worker pick
  // make that window small, and a lost race fails on the container name.
  if (workerProvider(config) === "docker") {
    const deadline = Date.now() + (config.factory.waitForWorkerMinutes ?? 30) * 60 * 1000
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      const spread = Number(String(runId).replace(/\D/g, "").slice(-6)) + attempt
      const worker = pickWorker(await getWorkerStates(config), issueLabels, spread, config.agents)
      if (!worker) {
        console.log("No free worker. Checking again in 30 seconds.")
        await sleep(30_000)
        continue
      }
      const box = await createDockerWorker(config, worker, runId)
      try {
        await applyBoxSettings(box, config, worker.agent)
      } catch (error) {
        await removeDockerWorker(box)
        throw error
      }
      return { worker, box, runLabel: null, provider: "docker" }
    }
    return null
  }

  const runLabel = runLabelFor(runId)
  const deadline = Date.now() + (config.factory.waitForWorkerMinutes ?? 30) * 60 * 1000

  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const spread = Number(String(runId).replace(/\D/g, "").slice(-6)) + attempt
    const worker = pickWorker(await getWorkerStates(config), issueLabels, spread, config.agents)
    if (!worker) {
      console.log("No free worker. Checking again in 30 seconds.")
      await sleep(30_000)
      continue
    }

    let box
    try {
      if (worker.boxId) {
        box = await Box.get(worker.boxId, { timeout: BOX_TIMEOUT_MS })
      } else {
        console.log(`Creating Box ${worker.boxName}...`)
        box = await createWorkerBox(config, worker)
      }
      // A Box holds at most five labels, so a crowded Box can refuse the label.
      // That also means another run got there first.
      await box.labels.add(runLabel)
      await box.labels.add(config.factory.busyLabel)
    } catch (error) {
      console.log(`Could not claim worker ${worker.id} (${error.message}). Trying another.`)
      await box?.labels.remove(runLabel).catch(() => {})
      await sleep(2_000 + Math.random() * 3_000)
      continue
    }

    // Give a rival run a moment to add its label, then look again.
    await sleep(4_000)
    const rivals = (await box.labels.list()).filter((l) => l.startsWith("run-") && l !== runLabel)
    if (rivals.some((l) => l < runLabel)) {
      console.log(`Worker ${worker.id} was claimed by another run at the same moment. Trying another.`)
      await box.labels.remove(runLabel)
      continue
    }

    if (worker.boxStatus === "paused") await box.resume()
    return { worker, box, runLabel }
  }
  return null
}

export async function releaseWorker(config, claim) {
  const { box, runLabel, worker } = claim
  // Docker: removing the container is the release. It also wipes the
  // workspace and every sign-in file written for the job.
  if (claim.provider === "docker" || box?.kind === "docker") {
    await removeDockerWorker(box)
    console.log(`Released worker ${worker.id} and removed its container.`)
    return
  }
  try {
    await box.labels.remove(runLabel)
    await box.labels.remove(config.factory.busyLabel)
    await box.pause()
    console.log(`Released worker ${worker.id} and paused its Box.`)
  } catch (error) {
    console.error(`Could not fully release worker ${worker.id}: ${error.message}`)
  }
}
