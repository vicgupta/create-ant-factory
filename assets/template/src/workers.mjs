// Works out which workers are free. With the Box provider a worker is one
// named Box, busy while its Box carries the busy label. With the Docker
// provider (worker.provider: "docker") a worker is busy while a container
// labelled worker=<id> is running; containers are one-per-job and removed
// at the end, so there is no paused/idle state to report.
import { Box } from "@upstash/box"
import { boxNameFor, workerProvider } from "./config.mjs"
import { listDockerWorkers } from "./docker.mjs"

export async function getWorkerStates(config) {
  if (workerProvider(config) === "docker") {
    const containers = await listDockerWorkers(config)
    return config.workers.map((worker) => {
      const container = containers.find((c) => c.labels.worker === worker.id)
      let state = "free"
      if (!worker.enabled) state = "disabled"
      else if (container) state = "busy"
      return { ...worker, boxName: container?.name ?? `${config.factory.boxNamePrefix}${worker.id}`, boxId: container?.name ?? null, boxStatus: container?.status ?? "not created", state }
    })
  }

  const boxes = await Box.list({ label: config.factory.boxLabel })
  const byName = new Map(boxes.map((b) => [b.name, b]))

  return config.workers.map((worker) => {
    const box = byName.get(boxNameFor(config, worker))
    let state = "free"
    if (!worker.enabled) state = "disabled"
    else if (box && (box.labels ?? []).includes(config.factory.busyLabel)) state = "busy"
    return { ...worker, boxName: boxNameFor(config, worker), boxId: box?.id ?? null, boxStatus: box?.status ?? "not created", state }
  })
}

// Picks a free worker for an issue.
//
// 1. An issue label "agent:<name>" forces that agent type.
// 2. Otherwise the agent type with the highest "priority" in the config that
//    has a free worker takes the issue. Use this when one type should do most
//    of the work, for example a flat-rate subscription before a pay-per-token
//    key. Types without a priority count as 0.
// 3. Among types with the same priority, the one with the smaller SHARE of busy
//    workers goes first, so work spreads evenly whatever the pool sizes are.
//
// When many issues arrive at once, every run sees the same free workers. The
// spread number (the run id) makes each run start at a different worker, so
// they rarely reach for the same one.
export function pickWorker(states, issueLabels = [], spread = 0, agents = {}) {
  const forced = issueLabels.map((l) => /^agent:(.+)$/.exec(l)?.[1]).find(Boolean)
  const free = states.filter((w) => w.state === "free" && (!forced || w.agent === forced))
  if (free.length === 0) return null

  const priority = (agent) => agents[agent]?.priority ?? 0
  const busyShare = (agent) => {
    const pool = states.filter((w) => w.agent === agent && w.state !== "disabled")
    return pool.filter((w) => w.state === "busy").length / pool.length
  }
  const rank = (agent) => [-priority(agent), busyShare(agent)]
  const better = (a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]

  const bestAgent = [...new Set(free.map((w) => w.agent))].sort(better)[0]
  const candidates = free.filter((w) => better(w.agent, bestAgent) === 0).sort((a, b) => a.id.localeCompare(b.id))
  return candidates[Math.abs(Number(spread) || 0) % candidates.length]
}
