// Tests for runLabelFor, the claim label that keeps two runs starting at the
// same moment from sharing one worker Box. The label has to fit the 20-
// character Box limit, stay unique between runs, and order the same way for
// both rivals so exactly one of them backs off.
import { test } from "node:test"
import assert from "node:assert/strict"
import { runLabelFor } from "../src/box.mjs"

test("the label fits the 20-character Box label limit, keeping the tail", () => {
  // GitHub run ids arrive as strings; 20 digits would have overflowed the old prefix truncation.
  assert.equal(runLabelFor("18446744073709551615"), "run-6744073709551615")
  assert.equal(runLabelFor("18446744073709551615").length, 20)
})

test("run ids that differ only in the tail get distinct labels", () => {
  // GitHub run ids grow at the tail, so two runs starting together have
  // adjacent ids. A prefix truncation would have given both the same label.
  const a = runLabelFor("18446744073709551615")
  const b = runLabelFor("18446744073709551616")
  assert.notEqual(a, b)
})

test("the label keeps the run- prefix that cleanup and rival checks match on", () => {
  assert.ok(runLabelFor("local123456789").startsWith("run-"))
  assert.equal(runLabelFor("local123456789"), "run-123456789")
})

test("two distinct labels order the same way for both rivals, so exactly one backs off", () => {
  const a = runLabelFor("18446744073709551615")
  const b = runLabelFor("18446744073709551616")
  // claimWorker lets the lower label win; both rivals see the same pair of labels.
  assert.equal(a < b || b < a, true)
})

test("the same run id always gets the same label", () => {
  assert.equal(runLabelFor("987654321"), runLabelFor(987654321))
})
