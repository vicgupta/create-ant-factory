// The trigger workflow's actor guard: the inline node script must accept the
// configured actors whatever their case, and refuse anyone else. The script
// is extracted from the shipped template (rendered the way
// scripts/install-trigger.mjs renders it), not copied, so the test stays
// honest if the template changes.
//
// Run with: npm test (node --test tests/)
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Renders the template exactly the way scripts/install-trigger.mjs does.
function render(allowedActors) {
  return readFileSync(new URL("../templates/factory-ready.yml", import.meta.url), "utf8")
    .replaceAll("__FACTORY_REPO__", "me/factory")
    .replaceAll("__READY_LABEL__", "ready")
    .replaceAll("__ALLOWED_ACTORS_JSON__", JSON.stringify(allowedActors))
}

function guardScript(rendered) {
  const match = /node <<'EOF'\n([\s\S]*?)\n\s*EOF/.exec(rendered)
  assert.ok(match, "the trigger template must hold the actor-guard node script")
  return match[1]
}

// Runs the shipped script the way the workflow step does: ALLOWED_ACTORS and
// ACTOR in the environment, exit 0 for an allowed actor.
function check(script, allowedActors, actor) {
  const file = join(mkdtempSync(join(tmpdir(), "trigger-guard-")), "guard.mjs")
  writeFileSync(file, script)
  try {
    execFileSync(process.execPath, [file], {
      env: { ...process.env, ALLOWED_ACTORS: JSON.stringify(allowedActors), ACTOR: actor },
      stdio: "pipe",
    })
    return true
  } catch (error) {
    if (typeof error.status === "number") return false // the script refused the actor
    throw error // node itself failed: a broken script, not a refusal
  }
}

test("the actor guard accepts a configured actor in any case", () => {
  const script = guardScript(render(["Vic", "octocat"]))
  for (const actor of ["Vic", "vic", "VIC", "OctoCat", "OCTOCAT"]) {
    assert.equal(check(script, ["Vic", "octocat"], actor), true, `${actor} should be allowed`)
  }
})

test("the actor guard refuses anyone not on the list", () => {
  const script = guardScript(render(["vic"]))
  assert.equal(check(script, ["vic"], "mallory"), false)
  assert.equal(check(script, ["vic"], ""), false)
  assert.equal(check(script, ["vic"], "vic2"), false)
})

test("the rendered workflow still gates on the ready label and an open issue", () => {
  const rendered = render(["vic"])
  assert.match(rendered, /github\.event\.label\.name == 'ready'/)
  assert.match(rendered, /github\.event\.issue\.state == 'open'/)
  assert.doesNotMatch(rendered, /contains\(fromJSON/, "the actor check must not stay in the job if:")
})
