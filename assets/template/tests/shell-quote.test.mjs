import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { q } from "../src/box.mjs"

// q() is what keeps issue-derived and config values (branch names, repo
// folders, the token-bearing clone URL, git author, excludes, secret paths)
// from being run as shell code inside a worker. sh() runs commands with plain
// `sh` and runScript() with bash, so both must read q()'s output back as the
// exact original value and never execute any part of it.

const NEEDS_POSIX = process.platform === "win32" && "needs a POSIX sh and bash"

const values = [
  "plain",
  "",
  "factory/issue-12",
  "with spaces  and\ttabs",
  "don't ship",
  "''",
  "'leading and trailing'",
  `"double" quotes`,
  "$HOME and ${PATH}",
  "$(touch /tmp/should-not-exist) and `id`",
  "a; rm -rf / && echo pwned | cat > /dev/null",
  "back\\slash\\",
  "glob * ? [a-z]",
  "line one\nline two\n",
  "!history !! ~tilde #hash",
  "https://x-access-token:ghp_ab'c$d@github.com/o/r.git",
  "ünïcødé ✓",
]

// Runs `printf %s <quoted value>` and returns exactly what the shell printed.
const echoBack = (shell, value) => execFileSync(shell, ["-c", `printf '%s' ${q(value)}`], { encoding: "utf8" })

for (const shell of ["sh", "bash"]) {
  test(`${shell} reads every q()-quoted value back unchanged`, { skip: NEEDS_POSIX }, () => {
    for (const value of values) assert.equal(echoBack(shell, value), value, `value: ${JSON.stringify(value)}`)
  })

  test(`${shell} keeps a q()-quoted value as one argument`, { skip: NEEDS_POSIX }, () => {
    const out = execFileSync(shell, ["-c", `printf '%s|' ${values.map(q).join(" ")}`], { encoding: "utf8" })
    assert.equal(out, values.map((v) => `${v}|`).join(""))
  })
}

test("q() stringifies non-string values", () => {
  assert.equal(q(12), "'12'")
  assert.equal(q(null), "'null'")
})

test("q() wraps the value in single quotes and escapes embedded ones", () => {
  assert.equal(q("it's"), `'it'\\''s'`)
})
