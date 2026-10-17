// The workflow_dispatch actor guard compares GitHub logins case-insensitively,
// like trustedComments does. Pure logic, no network.
// Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { isAllowedActor } from "../src/github.mjs"

test("a differently-cased username in allowedActors still matches", () => {
  assert.equal(isAllowedActor(["VicGupta"], "vicgupta"), true)
  assert.equal(isAllowedActor(["vicgupta"], "VicGupta"), true)
})

test("someone not on the list is refused", () => {
  assert.equal(isAllowedActor(["vicgupta"], "stranger"), false)
})

test("an empty or missing list refuses everyone", () => {
  assert.equal(isAllowedActor([], "vicgupta"), false)
  assert.equal(isAllowedActor(undefined, "vicgupta"), false)
})

test("a missing actor never matches", () => {
  assert.equal(isAllowedActor(["vicgupta"], undefined), false)
  assert.equal(isAllowedActor(["vicgupta"], ""), false)
})
