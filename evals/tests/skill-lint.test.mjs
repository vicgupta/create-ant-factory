// Skill lint + trigger evals. No network: the model API is a fake fetch.
// Run with: node --test evals/tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  DESCRIPTION_MAX,
  casesProblems,
  frontmatterProblems,
  lintSkill,
  parseFrontmatter,
  referencedPaths,
  templateProblems,
} from "../skill-lint.mjs"
import { buildRouterPrompt, parseChoice, runEvals, score, skillsForCase } from "../trigger-evals.mjs"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const VALIDATE = join(ROOT, "evals/validate-skill.mjs")
const TRIGGER = join(ROOT, "evals/trigger-evals.mjs")

function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "skill-lint-"))
  for (const p of ["SKILL.md", "README.md", "references", "assets", "evals"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true })
  return dir
}

test("this repo's skill passes the linter", () => {
  const { errors, name } = lintSkill(ROOT)
  assert.deepEqual(errors, [])
  assert.equal(name, "create-ant-factory")
})

test("validate-skill CLI exits 0 here and 1 on a broken copy", () => {
  const ok = spawnSync(process.execPath, [VALIDATE], { encoding: "utf8" })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const dir = copyRepo()
  try {
    rmSync(join(dir, "references/pitfalls.md"))
    const bad = spawnSync(process.execPath, [VALIDATE, dir], { encoding: "utf8" })
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /references\/pitfalls\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("frontmatter: missing fences, bad name, long description, angle brackets", () => {
  assert.match(parseFrontmatter("# no frontmatter").error, /must start/)
  assert.match(parseFrontmatter("---\nname: x\n").error, /closing/)
  const fm = (s) => frontmatterProblems(parseFrontmatter(s))
  assert.match(fm("---\nname: Create Factory\ndescription: Use this when x.\n---\n").errors.join(), /kebab-case/)
  assert.match(fm("---\nname: ok\n---\n").errors.join(), /missing `description`/)
  assert.match(fm(`---\nname: ok\ndescription: Use this ${"a".repeat(DESCRIPTION_MAX)}\n---\n`).errors.join(), /limit is 1024/)
  assert.match(fm("---\nname: ok\ndescription: Use this for <tags>\n---\n").errors.join(), /< or >/)
  const quiet = fm('---\nname: ok\ndescription: "Builds things."\nglobs: x\n---\n')
  assert.deepEqual(quiet.errors, [])
  assert.match(quiet.warnings.join(), /when to use/)
  assert.match(quiet.warnings.join(), /unknown frontmatter key "globs"/)
})

test("referencedPaths maps tokens to template locations and skips placeholders", () => {
  const refs = referencedPaths("Run `node --env-file=.env scripts/status.mjs` and `smoke-test.mjs`, read `references/config.md`, not `scripts/box-exec.mjs <box name>` <x> or `https://x.y/a.mjs`.")
  const tokens = refs.map((r) => r.token)
  assert.deepEqual(tokens, ["scripts/status.mjs", "smoke-test.mjs", "references/config.md", "scripts/box-exec.mjs"])
  assert.deepEqual(refs[1].candidates, ["assets/template/scripts/smoke-test.mjs", "assets/template/src/smoke-test.mjs"])
})

test("a user-copied config passes when its .example.json exists", () => {
  const dir = copyRepo()
  try {
    writeFileSync(join(dir, "SKILL.md"), readFileSync(join(dir, "SKILL.md"), "utf8") + "\nCopy `scripts/demo-issues.json` then `scripts/nope.json`.\n")
    const errors = lintSkill(dir).errors
    assert.equal(errors.length, 1, errors.join("\n"))
    assert.match(errors[0], /scripts\/nope\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("templateProblems catches a dangling npm script and a bad workflow step", () => {
  const dir = copyRepo()
  try {
    const pkgPath = join(dir, "assets/template/package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    pkg.scripts.ghost = "node scripts/ghost.mjs"
    writeFileSync(pkgPath, JSON.stringify(pkg))
    const wf = join(dir, "assets/template/.github/workflows/factory.yml")
    writeFileSync(wf, readFileSync(wf, "utf8") + "\n      - run: node --env-file=.env src/missing.mjs\n")
    const errors = templateProblems(dir)
    assert.ok(errors.some((e) => /"ghost" runs scripts\/ghost\.mjs/.test(e)), errors.join("\n"))
    assert.ok(errors.some((e) => /factory\.yml runs src\/missing\.mjs/.test(e)), errors.join("\n"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("casesProblems: shape, duplicates, minimums, anchors against the description", () => {
  const good = { skill: "s", minPositive: 1, minNegative: 1, cases: [
    { id: "a", prompt: "build me a factory please", shouldTrigger: true, why: "x", anchors: ["factory"] },
    { id: "b", prompt: "fix this bug right now", shouldTrigger: false, why: "y" },
  ] }
  assert.deepEqual(casesProblems(good, "s", "Builds a Factory."), [])
  assert.match(casesProblems(good, "other", "factory").join(), /SKILL.md name is "other"/)
  assert.match(casesProblems(good, "s", "Builds pipelines.").join(), /no longer contains the anchor "factory"/)
  const dup = { ...good, cases: [...good.cases, { ...good.cases[1] }] }
  assert.match(casesProblems(dup, "s", "factory").join(), /duplicate id/)
  assert.match(casesProblems(dup, "s", "factory").join(), /duplicate prompt/)
  const fewNeg = { ...good, minNegative: 2 }
  assert.match(casesProblems(fewNeg, "s", "factory").join(), /at least 2 shouldTrigger: false/)
  const anchoredNeg = { ...good, cases: [good.cases[0], { ...good.cases[1], anchors: ["x"] }] }
  assert.match(casesProblems(anchoredNeg, "s", "factory x").join(), /anchors only make sense/)
  assert.match(casesProblems({ ...good, distractors: [{ name: "s", description: "d" }] }, "s", "factory").join(), /reuses this skill's name/)
})

test("router prompt lists every skill, rotation keeps the set", () => {
  const self = { name: "me", description: "mine" }
  const d = [{ name: "a", description: "A" }, { name: "b", description: "B" }]
  assert.deepEqual(skillsForCase(self, d, 0).map((s) => s.name), ["me", "a", "b"])
  assert.deepEqual(skillsForCase(self, d, 1).map((s) => s.name), ["a", "b", "me"])
  const p = buildRouterPrompt(skillsForCase(self, d, 4), "do it")
  for (const n of ["- me: mine", "- a: A", "- b: B", "User request: do it"]) assert.ok(p.includes(n))
})

test("parseChoice tolerates quoting and falls back to none", () => {
  const names = ["create-ant-factory", "pr-review"]
  assert.equal(parseChoice("`create-ant-factory`.", names), "create-ant-factory")
  assert.equal(parseChoice("I would load pr-review", names), "pr-review")
  assert.equal(parseChoice("None", names), "none")
  assert.equal(parseChoice("something else", names), "none")
})

test("runEvals scores a fake model and sends the Anthropic request shape", async () => {
  const spec = JSON.parse(readFileSync(join(ROOT, "evals/trigger-cases.json"), "utf8"))
  const self = { name: spec.skill, description: parseFrontmatter(readFileSync(join(ROOT, "SKILL.md"), "utf8")).data.description }
  const expected = new Map(spec.cases.map((c) => [c.prompt, c.shouldTrigger]))
  const seen = []
  // The fake answers correctly except on the first negative case.
  const firstNeg = spec.cases.find((c) => !c.shouldTrigger).prompt
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    const body = JSON.parse(init.body)
    const request = body.messages[0].content.split("User request: ")[1].split("\n")[0]
    const yes = expected.get(request) || request === firstNeg
    return { ok: true, json: async () => ({ content: [{ type: "text", text: yes ? spec.skill : "none" }] }) }
  }
  const { results, summary } = await runEvals({ self, spec, apiKey: "k", model: "m", fetchImpl })
  assert.equal(results.length, spec.cases.length)
  assert.equal(summary.falsePositives, 1)
  assert.equal(summary.falseNegatives, 0)
  assert.equal(summary.recall, 1)
  assert.equal(summary.passed, spec.cases.length - 1)
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages")
  assert.equal(seen[0].init.headers["x-api-key"], "k")
  assert.equal(seen[0].init.headers["anthropic-version"], "2023-06-01")
  const body = JSON.parse(seen[0].init.body)
  assert.equal(body.model, "m")
  assert.equal(body.temperature, 0)
})

test("runEvals surfaces an API error with the case id", async () => {
  const spec = { cases: [{ id: "x", prompt: "build a factory", shouldTrigger: true }], distractors: [] }
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "bad key" })
  await assert.rejects(runEvals({ self: { name: "s", description: "d" }, spec, apiKey: "k", fetchImpl }), /401 on case "x"/)
})

test("score handles empty and all-negative runs", () => {
  assert.deepEqual(score([]).passRate, 0)
  const s = score([{ shouldTrigger: false, triggered: false, pass: true }])
  assert.equal(s.recall, 1)
  assert.equal(s.precision, 1)
})

test("trigger-evals CLI is a dry run without a key and sends nothing", () => {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  const r = spawnSync(process.execPath, [TRIGGER], { encoding: "utf8", env })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Dry run \(ANTHROPIC_API_KEY is not set\)/)
  assert.match(r.stdout, /Nothing was sent/)
})
