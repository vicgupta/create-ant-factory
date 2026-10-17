// Tests for pickWorker, the pure routing rule that decides which worker takes
// an issue. No network: getWorkerStates is not called, states are built here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { pickWorker } from "../src/workers.mjs"

const w = (id, agent, state = "free") => ({ id, agent, state })

test("no free worker means null, so the run waits", () => {
  assert.equal(pickWorker([w("c1", "claude", "busy"), w("c2", "claude", "disabled")]), null)
  assert.equal(pickWorker([]), null)
})

test("an agent:<name> label forces that agent type", () => {
  const states = [w("c1", "claude"), w("x1", "codex")]
  assert.equal(pickWorker(states, ["bug", "agent:codex"]).id, "x1")
  assert.equal(pickWorker(states, ["agent:claude"]).id, "c1")
})

test("a forced agent type with no free worker gets null, not another type", () => {
  const states = [w("c1", "claude"), w("x1", "codex", "busy")]
  assert.equal(pickWorker(states, ["agent:codex"]), null)
  assert.equal(pickWorker(states, ["agent:nobody"]), null)
})

test("disabled and busy workers are never picked", () => {
  const states = [w("c1", "claude", "disabled"), w("c2", "claude", "busy"), w("c3", "claude")]
  for (let spread = 0; spread < 5; spread++) assert.equal(pickWorker(states, [], spread).id, "c3")
})

test("higher priority wins even when its pool is busier", () => {
  const states = [w("c1", "claude", "busy"), w("c2", "claude"), w("x1", "codex"), w("x2", "codex")]
  const agents = { claude: { priority: 10 }, codex: {} }
  assert.equal(pickWorker(states, [], 0, agents).agent, "claude")
})

test("with equal priority the pool with the smaller busy share goes first", () => {
  // claude: 1 of 2 busy (50%). codex: 1 of 4 busy (25%). Disabled workers do not count.
  const states = [
    w("c1", "claude", "busy"), w("c2", "claude"),
    w("x1", "codex", "busy"), w("x2", "codex"), w("x3", "codex"), w("x4", "codex"), w("x5", "codex", "disabled"),
  ]
  assert.equal(pickWorker(states, [], 0, {}).agent, "codex")
})

test("spread rotates through tied workers in id order", () => {
  const states = [w("c3", "claude"), w("c1", "claude"), w("c2", "claude")]
  assert.deepEqual([0, 1, 2, 3].map((s) => pickWorker(states, [], s).id), ["c1", "c2", "c3", "c1"])
})

test("odd spread values fall back to the first tied worker or wrap safely", () => {
  const states = [w("c1", "claude"), w("c2", "claude")]
  assert.equal(pickWorker(states, [], undefined).id, "c1")
  assert.equal(pickWorker(states, [], "not-a-number").id, "c1")
  assert.equal(pickWorker(states, [], -3).id, "c2")
  assert.equal(pickWorker(states, [], "7").id, "c2")
})
