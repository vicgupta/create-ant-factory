// Risk-based human gates. After the agent's change has passed the checks and
// is staged, a pure function decides how the pull request goes out:
//
//   ready            a normal pull request, labelled factory:review
//   draft            a draft pull request, still labelled factory:review
//   needs-attention  a draft pull request, and the issue is parked at
//                    factory:needs-attention for a person to decide
//
// The decision is computed only from things the factory measured itself:
// the paths the change touches, the diff size, whether the repo has checks,
// the repo's service tier, the issue's own labels/title/body, and the
// outcomes of past runs that touched the same files. The agent's reply is
// never an input, so the agent can explain a gate in its summary but can
// never waive its own gate. Same inputs, same decision, every time.
//
// Off unless factory.riskGates is an object: an existing factory keeps
// opening ready pull requests exactly as before.
import { isFailedOutcome } from "./context.mjs"

export const GATE_ACTIONS = ["ready", "draft", "needs-attention"]
const RANK = { ready: 0, draft: 1, "needs-attention": 2 }
export const stricter = (a, b) => (RANK[b] > RANK[a] ? b : a)

export const riskGatesEnabled = (config) => {
  const gates = config?.factory?.riskGates
  return Boolean(gates) && typeof gates === "object" && !Array.isArray(gates) && gates.enabled !== false
}

// Defaults applied when a key is left out of factory.riskGates.
export const GATE_DEFAULTS = { maxFilesForReady: null, maxLinesForReady: null, noChecks: "draft", failedPrecedent: "draft", rules: [] }

export function gateSettings(config) {
  const gates = config?.factory?.riskGates ?? {}
  return { ...GATE_DEFAULTS, ...gates, rules: Array.isArray(gates.rules) ? gates.rules : [] }
}

// Path patterns: "dir/" matches everything under dir, "*" matches within one
// path segment, "**" matches across segments, anything else is an exact path.
// Deliberately tiny so a reader can predict every match.
export function pathMatches(pattern, path) {
  const p = String(pattern).trim().replace(/^\.\//, "")
  const file = String(path).trim().replace(/^\.\//, "")
  if (!p) return false
  if (p.endsWith("/")) return file.startsWith(p)
  if (!p.includes("*")) return file === p
  const source = p
    .split(/(\*\*\/?|\*)/)
    .map((part) => (part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("")
  return new RegExp(`^${source}$`).test(file)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// Whole-word, case-insensitive: "auth" matches "Auth flow" and "src/auth.ts"
// but not "author".
export function keywordMatches(keyword, text) {
  const k = String(keyword).trim()
  if (!k) return false
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(k)}($|[^A-Za-z0-9])`, "i").test(text)
}

// `git diff --cached --numstat --no-renames` output: "added<TAB>removed<TAB>path".
// Binary files show "-" for both counts and count as zero lines.
export function parseNumstat(text = "") {
  const files = []
  let added = 0
  let removed = 0
  for (const line of String(text).split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim())
    if (!m) continue
    const a = m[1] === "-" ? 0 : Number(m[1])
    const r = m[2] === "-" ? 0 : Number(m[2])
    files.push({ path: m[3], added: a, removed: r })
    added += a
    removed += r
  }
  return { files, added, removed, lines: added + removed }
}

// Config errors for factory.riskGates, in the loader's message style.
export function riskGateErrors(config) {
  const gates = config?.factory?.riskGates
  if (gates === undefined) return []
  const errors = []
  if (!gates || typeof gates !== "object" || Array.isArray(gates)) return ['factory.riskGates must be an object like { "rules": [ { "name": "migrations", "paths": ["migrations/"], "action": "needs-attention" } ] }']
  if (gates.enabled !== undefined && typeof gates.enabled !== "boolean") errors.push("factory.riskGates.enabled must be true or false")
  for (const key of ["maxFilesForReady", "maxLinesForReady"]) {
    const v = gates[key]
    if (v !== undefined && v !== null && !(Number.isInteger(v) && v > 0)) errors.push(`factory.riskGates.${key} must be a positive whole number, or left out for no limit`)
  }
  for (const key of ["noChecks", "failedPrecedent"]) {
    if (gates[key] !== undefined && !GATE_ACTIONS.includes(gates[key])) errors.push(`factory.riskGates.${key} must be one of: ${GATE_ACTIONS.join(", ")}`)
  }
  if (gates.rules !== undefined && !Array.isArray(gates.rules)) errors.push("factory.riskGates.rules must be a list")
  const names = new Set()
  for (const [i, rule] of (Array.isArray(gates.rules) ? gates.rules : []).entries()) {
    const where = `factory.riskGates.rules[${i}]`
    if (!rule || typeof rule !== "object") { errors.push(`${where} must be an object`); continue }
    if (typeof rule.name !== "string" || !rule.name.trim()) errors.push(`${where} needs a name`)
    else if (names.has(rule.name)) errors.push(`${where}: the rule name "${rule.name}" is used twice`)
    else names.add(rule.name)
    if (!GATE_ACTIONS.includes(rule.action) || rule.action === "ready") errors.push(`${where} needs an action of "draft" or "needs-attention"`)
    let matchers = 0
    for (const key of ["paths", "keywords", "tiers", "labels"]) {
      if (rule[key] === undefined) continue
      matchers++
      if (!Array.isArray(rule[key]) || rule[key].length === 0 || rule[key].some((v) => typeof v !== "string" || !v.trim())) errors.push(`${where}.${key} must be a non-empty list of non-empty strings`)
    }
    if (!matchers) errors.push(`${where} needs at least one of paths, keywords, tiers or labels`)
  }
  return errors
}

// The gate itself. Pure: no I/O, no clock, no randomness.
//   files       paths the staged change touches
//   lines       added + removed lines (from parseNumstat)
//   hasChecks   whether the repo has configured checks (they passed to get here)
//   tier        the repo's "tier" from factory.config.json, if any
//   issue       { title, body, labels } of the issue
//   precedents  past runs that touched the same files (src/context.mjs)
// Returns { decision, reasons: [{ rule, action, why }] }.
export function evaluateRiskGate(settings, { files = [], lines = 0, hasChecks = true, tier = null, issue = {}, precedents = [] } = {}) {
  const s = { ...GATE_DEFAULTS, ...settings, rules: settings?.rules ?? [] }
  const reasons = []
  const add = (rule, action, why) => reasons.push({ rule, action, why })
  const issueText = [issue.title ?? "", issue.body ?? ""].join("\n")
  const issueLabels = (issue.labels ?? []).map((l) => String(l).toLowerCase())

  for (const rule of s.rules) {
    const hits = []
    for (const pattern of rule.paths ?? []) {
      const matched = files.filter((f) => pathMatches(pattern, f))
      if (matched.length) hits.push(`touches ${matched.slice(0, 5).map((f) => `\`${f}\``).join(", ")}${matched.length > 5 ? ` and ${matched.length - 5} more` : ""} (path \`${pattern}\`)`)
    }
    for (const keyword of rule.keywords ?? []) {
      if (keywordMatches(keyword, issueText) || files.some((f) => keywordMatches(keyword, f))) hits.push(`mentions "${keyword}"`)
    }
    if ((rule.tiers ?? []).some((t) => tier && t.toLowerCase() === String(tier).toLowerCase())) hits.push(`the repo's tier is "${tier}"`)
    for (const label of rule.labels ?? []) if (issueLabels.includes(label.toLowerCase())) hits.push(`the issue has the label \`${label}\``)
    if (hits.length) add(rule.name, rule.action, hits.join("; "))
  }

  if (s.maxFilesForReady && files.length > s.maxFilesForReady) add("diff-size", "draft", `changes ${files.length} files, more than maxFilesForReady (${s.maxFilesForReady})`)
  if (s.maxLinesForReady && lines > s.maxLinesForReady) add("diff-size", "draft", `changes ${lines} lines, more than maxLinesForReady (${s.maxLinesForReady})`)
  if (!hasChecks && s.noChecks !== "ready") add("no-checks", s.noChecks, "this repo has no automated checks, so nothing verified the change")

  const failed = precedents.filter((p) => isFailedOutcome(p.outcome))
  if (failed.length && s.failedPrecedent !== "ready") {
    add("failed-precedent", s.failedPrecedent, `${failed.length} earlier run(s) on the same files did not land: ${failed.slice(0, 3).map((p) => `run ${p.runId} (${p.outcome}${p.reason ? `, ${p.reason}` : ""})`).join(", ")}`)
  }

  const decision = reasons.reduce((d, r) => stricter(d, r.action), "ready")
  return { decision, reasons }
}

// Markdown for the pull request body and the issue comment.
export function renderGate(gate) {
  if (!gate) return ""
  const head = {
    ready: "Low risk: no gate rule matched, so this pull request is ready for review.",
    draft: "Opened as a **draft** because a risk gate matched. A person marks it ready for review.",
    "needs-attention": "Parked for a person: a risk gate requires a human decision before this goes further. The pull request is a **draft**.",
  }[gate.decision]
  const lines = gate.reasons.map((r) => `- \`${r.rule}\` → ${r.action}: ${r.why}`)
  return ["## Risk gate", "", head, ...(lines.length ? ["", ...lines] : []), "", "The gate is computed by the factory from the paths, diff size, checks and past runs, not by the agent, and the agent cannot waive it."].join("\n")
}
