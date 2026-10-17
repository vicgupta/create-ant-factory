// Plan-first: parsing and validation of plan.md, the issue/PR rendering, and
// the config switch. Pure logic, no network.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePlan, validatePlan, validatePlanText, renderPlanComment, planSection, criteriaChecklist, planFirstEnabled, MANUAL_CHECK } from "../src/plan-first.mjs"
import { loadConfig } from "../src/config.mjs"

const repo = { checks: ["npm test", "npm run build"] }
const GOOD = `# Plan

A short intro the parser ignores.

## Files to touch
- src/plan-first.mjs — new module
- \`src/run.mjs\`: wiring

## Acceptance criteria
- [ ] The plan parses — check: npm test
- [ ] It still builds — check: npm run build
- [ ] The wording reads well — check: manual-review
`

test("a well-formed plan parses files (hyphens and backticks kept) and criteria with their checks", () => {
  const plan = parsePlan(GOOD)
  assert.deepEqual(plan.files, ["src/plan-first.mjs", "src/run.mjs"])
  assert.deepEqual(plan.criteria, [
    { text: "The plan parses", check: "npm test" },
    { text: "It still builds", check: "npm run build" },
    { text: "The wording reads well", check: MANUAL_CHECK },
  ])
  assert.deepEqual(validatePlan(plan, repo), [])
})

test("a plan with no files or no criteria is rejected", () => {
  assert.match(validatePlan(parsePlan("## Acceptance criteria\n- [ ] X — check: npm test\n"), repo).join(" "), /no files to touch/)
  assert.match(validatePlan(parsePlan("## Files to touch\n- a.mjs\n"), repo).join(" "), /no acceptance criteria/)
  assert.deepEqual(validatePlanText("", repo).errors.length, 2)
})

test("criteria must map to a configured check or manual-review", () => {
  const plan = parsePlan("## Files to touch\n- a.mjs\n## Acceptance criteria\n- [ ] X — check: npm run lint\n- [ ] Y\n")
  const errors = validatePlan(plan, repo)
  assert.match(errors.join(" "), /not one of this repo's checks/)
  assert.match(errors.join(" "), /names no check/)
  // With no checks configured, only manual-review is a valid mapping.
  const noChecks = validatePlan(parsePlan(GOOD), { checks: [] })
  assert.match(noChecks.join(" "), /not one of this repo's checks \(none configured\)/)
})

test("unsafe, duplicated and protected files are rejected", () => {
  const plan = { files: ["../secret.mjs", "/etc/passwd", "src/a.mjs", "src/a.mjs", ".github/workflows/x.yml", "has space.mjs"], criteria: [{ text: "X", check: "npm test" }] }
  const errors = validatePlan(plan, repo).join(" ")
  assert.match(errors, /"\.\.\/secret\.mjs" is not a safe relative/)
  assert.match(errors, /"\/etc\/passwd" is not a safe relative/)
  assert.match(errors, /listed twice/)
  assert.match(errors, /under \.github\//)
  assert.match(errors, /"has space\.mjs" is not a safe relative/)
})

test("an oversized plan is rejected before it can swallow the prompt", () => {
  const errors = validatePlanText(`## Files to touch\n- ${"a".repeat(13000)}.mjs\n`, repo).errors
  assert.match(errors.join(" "), /limit is 12000/)
})

test("the issue comment is unticked, the PR checklist ticks only real checks on a passing run", () => {
  const plan = parsePlan(GOOD)
  const comment = renderPlanComment(plan, { runUrl: "https://example/run/1" })
  assert.match(comment, /posted it before implementation/)
  assert.match(comment, /- \[ \] The plan parses — check: `npm test`/)
  assert.match(comment, /\[Factory run\]\(https:\/\/example\/run\/1\)/)
  const done = criteriaChecklist(plan, { checksPassed: true })
  assert.match(done, /- \[x\] The plan parses/)
  assert.match(done, /- \[ \] The wording reads well/)
  const failed = criteriaChecklist(plan, { checksPassed: false })
  assert.ok(!failed.includes("[x]"))
  assert.equal(criteriaChecklist({ files: [], criteria: [] }, { checksPassed: true }), "")
})

test("the implementation prompt section carries the validated plan", () => {
  const section = planSection(parsePlan(GOOD))
  assert.match(section, /# Validated plan/)
  assert.match(section, /- src\/plan-first\.mjs/)
  assert.match(section, /check: manual-review/)
  assert.equal(planSection(null), "")
  assert.equal(planSection({ files: [], criteria: [] }), "")
})

function configWith(planFirst) {
  const config = {
    factory: {
      repo: "me/factory", boxNamePrefix: "factory-", boxLabel: "factory", busyLabel: "busy",
      branchPrefix: "factory/issue-", gitAuthor: { name: "Me", email: "123+me@users.noreply.github.com" },
      allowedActors: ["me"], ...(planFirst === undefined ? {} : { planFirst }),
    },
    labels: { ready: "ready", running: "factory:running", review: "factory:review", needsAttention: "factory:needs-attention" },
    agents: { claude: { boxSettings: [], command: 'claude -p "$(cat {prompt})" > {summary}' } },
    repos: [{ repo: "me/app", baseBranch: "main" }],
    workers: [{ id: "claude-01", agent: "claude" }],
  }
  const file = join(mkdtempSync(join(tmpdir(), "factory-plan-first-")), "factory.config.json")
  writeFileSync(file, JSON.stringify(config))
  return () => loadConfig(file)
}

test("planFirst is opt-in and must be a boolean", () => {
  assert.equal(planFirstEnabled(configWith(undefined)()), false)
  assert.equal(planFirstEnabled(configWith(false)()), false)
  assert.equal(planFirstEnabled(configWith(true)()), true)
  assert.throws(configWith("yes"), /factory\.planFirst must be true or false/)
})
