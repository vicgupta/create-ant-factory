#!/usr/bin/env node
// Trigger evals: does an agent pick this skill for the requests in
// evals/trigger-cases.json, and leave it alone for the rest?
//
// Each case is shown to a model as a routing question: here are the
// available skills (this one plus the distractors), which one would you load
// for this request, or "none"? A case passes when the answer matches
// shouldTrigger. The run fails when the pass rate is below passThreshold.
//
// Without ANTHROPIC_API_KEY (or with --dry-run) it prints the requests it
// would send and exits 0, so CI stays green on forks without the secret.
//
//   node evals/trigger-evals.mjs [--dry-run] [--json] [--model <id>] [--only <case id>]
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseFrontmatter } from "./skill-lint.mjs"

export const DEFAULT_MODEL = "claude-haiku-4-5"
export const API_URL = "https://api.anthropic.com/v1/messages"

export function buildRouterPrompt(skills, request) {
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
  return [
    "You are routing a user request to at most one skill. Load a skill only when its description says it applies.",
    "",
    "Available skills:",
    list,
    "",
    `User request: ${request}`,
    "",
    'Answer with only the skill name to load, or "none".',
  ].join("\n")
}

// Order the skill list deterministically but not always with ours first, so
// the eval does not reward position. Rotation is keyed by the case index.
export function skillsForCase(self, distractors, index) {
  const all = [self, ...distractors]
  const k = all.length ? index % all.length : 0
  return [...all.slice(k), ...all.slice(0, k)]
}

export function parseChoice(text, names) {
  const t = String(text ?? "").trim().toLowerCase().replace(/[`"'.]/g, "")
  if (!t || t.startsWith("none")) return "none"
  const hit = names.find((n) => t === n.toLowerCase()) ?? names.find((n) => t.includes(n.toLowerCase()))
  return hit ?? "none"
}

export function score(results) {
  const tp = results.filter((r) => r.shouldTrigger && r.triggered).length
  const fn = results.filter((r) => r.shouldTrigger && !r.triggered).length
  const fp = results.filter((r) => !r.shouldTrigger && r.triggered).length
  const passed = results.filter((r) => r.pass).length
  return {
    cases: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    recall: tp + fn ? tp / (tp + fn) : 1,
    precision: tp + fp ? tp / (tp + fp) : 1,
    falsePositives: fp,
    falseNegatives: fn,
  }
}

export function requestBody(model, prompt) {
  return { model, max_tokens: 20, temperature: 0, messages: [{ role: "user", content: prompt }] }
}

export async function runEvals({ self, spec, apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, only } = {}) {
  const distractors = spec.distractors ?? []
  const names = [self.name, ...distractors.map((d) => d.name)]
  const results = []
  const cases = spec.cases.filter((c) => !only || c.id === only)
  for (const [i, c] of cases.entries()) {
    const prompt = buildRouterPrompt(skillsForCase(self, distractors, i), c.prompt)
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(requestBody(model, prompt)),
    })
    if (!res.ok) throw new Error(`model API returned ${res.status} on case "${c.id}": ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("")
    const choice = parseChoice(text, names)
    const triggered = choice === self.name
    results.push({ id: c.id, shouldTrigger: c.shouldTrigger, choice, triggered, pass: triggered === c.shouldTrigger })
  }
  return { results, summary: score(results) }
}

function loadSelf(root) {
  const fm = parseFrontmatter(readFileSync(new URL("SKILL.md", root), "utf8"))
  if (fm.error) throw new Error(fm.error)
  return { name: fm.data.name, description: fm.data.description }
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (n) => args.includes(n)
  const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
  const root = new URL("../", import.meta.url)
  const self = loadSelf(root)
  const spec = JSON.parse(readFileSync(fileURLToPath(new URL("evals/trigger-cases.json", root)), "utf8"))
  const model = value("--model") ?? process.env.SKILL_EVAL_MODEL ?? DEFAULT_MODEL
  const apiKey = process.env.ANTHROPIC_API_KEY
  const threshold = spec.passThreshold ?? 0.85

  if (flag("--dry-run") || !apiKey) {
    const why = apiKey ? "--dry-run" : "ANTHROPIC_API_KEY is not set"
    console.log(`Dry run (${why}): ${spec.cases.length} case(s), model ${model}, threshold ${threshold}. Nothing was sent.`)
    const first = spec.cases[0]
    if (first) console.log(`\nFirst request would be:\n\n${buildRouterPrompt(skillsForCase(self, spec.distractors ?? [], 0), first.prompt)}`)
    return
  }
  const { results, summary } = await runEvals({ self, spec, apiKey, model, only: value("--only") })
  if (flag("--json")) console.log(JSON.stringify({ model, threshold, summary, results }, null, 2))
  else {
    for (const r of results) console.log(`${r.pass ? "pass" : "FAIL"}  ${r.id}  expected ${r.shouldTrigger ? "trigger" : "no trigger"}, model chose ${r.choice}`)
    const pct = (x) => `${Math.round(x * 100)}%`
    console.log(`\n${summary.passed}/${summary.cases} passed (${pct(summary.passRate)}), recall ${pct(summary.recall)}, precision ${pct(summary.precision)}, threshold ${pct(threshold)}`)
  }
  if (summary.passRate < threshold) process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`trigger-evals: ${e.message}`)
    process.exit(2)
  })
}
