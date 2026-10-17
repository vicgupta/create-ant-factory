// The factory refuses to push an agent's change under .github/. Uses a real
// git repo in a temp folder, so the parsing is checked against git's own output.
// Run with: npm test   (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { changedPaths, protectedChanges } from "../src/changes.mjs"

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "factory-changes-"))
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
  git("init", "--quiet")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.com")
  mkdirSync(join(dir, ".github/workflows"), { recursive: true })
  writeFileSync(join(dir, ".github/workflows/ci.yml"), "on: push\n")
  writeFileSync(join(dir, "app.js"), "1\n")
  git("add", "-A")
  git("commit", "--quiet", "-m", "init")
  const staged = () => {
    git("add", "-A")
    return changedPaths(git("diff", "--cached", "--name-only", "--no-renames"))
  }
  return { dir, staged }
}

test("an ordinary change passes", () => {
  const { dir, staged } = repo()
  writeFileSync(join(dir, "app.js"), "2\n")
  assert.deepEqual(protectedChanges(staged()), [])
})

test("an edited workflow is refused", () => {
  const { dir, staged } = repo()
  writeFileSync(join(dir, ".github/workflows/ci.yml"), "on: [push, pull_request]\n")
  writeFileSync(join(dir, "app.js"), "2\n")
  assert.deepEqual(protectedChanges(staged()), [".github/workflows/ci.yml"])
})

test("a new workflow is refused", () => {
  const { dir, staged } = repo()
  writeFileSync(join(dir, ".github/workflows/leak.yml"), "on: push\n")
  assert.deepEqual(protectedChanges(staged()), [".github/workflows/leak.yml"])
})

test("a workflow moved out of .github/ is refused", () => {
  const { dir, staged } = repo()
  renameSync(join(dir, ".github/workflows/ci.yml"), join(dir, "ci.yml"))
  assert.deepEqual(protectedChanges(staged()), [".github/workflows/ci.yml"])
})

test("a quoted unusual path is still recognised", () => {
  assert.deepEqual(protectedChanges(changedPaths('".github/workflows/caf\\303\\251.yml"\nsrc/a.js\n')), [".github/workflows/caf\\303\\251.yml"])
})

test("a differently-cased .github folder is refused", () => {
  assert.deepEqual(protectedChanges([".GitHub/workflows/x.yml", "docs/.github-notes.md"]), [".GitHub/workflows/x.yml"])
})

test("empty git output means no changes", () => {
  assert.deepEqual(changedPaths(""), [])
  assert.deepEqual(changedPaths(undefined), [])
})
