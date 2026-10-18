// Skill lint: pure checks behind evals/validate-skill.mjs. No network, no
// dependencies, so it runs anywhere Node 20.6+ runs (locally or in CI).
//
// It guards the three things that silently break a skill:
//   1. the SKILL.md frontmatter (an agent only ever sees `name` and
//      `description` when deciding to load it),
//   2. paths SKILL.md and README.md tell the agent to open or run, which
//      must exist in references/ or assets/template/,
//   3. the trigger cases in evals/trigger-cases.json, whose `anchors`
//      pin the phrases the description must keep so it still triggers.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export const NAME_MAX = 64
export const DESCRIPTION_MAX = 1024
export const BODY_LINES_WARN = 500
export const KNOWN_KEYS = ["name", "description", "license", "allowed-tools", "metadata", "compatibility"]

// Minimal frontmatter parser: `key: value` lines between the first two `---`.
// Values may be quoted. Nested YAML (metadata:) is kept as raw text.
export function parseFrontmatter(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n")
  if (lines[0] !== "---") return { error: "SKILL.md must start with a '---' frontmatter line" }
  const end = lines.indexOf("---", 1)
  if (end === -1) return { error: "frontmatter has no closing '---' line" }
  const data = {}
  let last = null
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (m) {
      let value = m[2].trim()
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
      data[m[1]] = value
      last = m[1]
    } else if (last && /^\s/.test(line)) {
      data[last] = (data[last] ? data[last] + "\n" : "") + line
    } else {
      return { error: `frontmatter line is not "key: value": ${line}` }
    }
  }
  return { data, body: lines.slice(end + 1).join("\n"), bodyStartLine: end + 2 }
}

export function frontmatterProblems(fm) {
  const errors = []
  const warnings = []
  if (fm.error) return { errors: [fm.error], warnings }
  const { name, description } = fm.data
  if (!name) errors.push("frontmatter is missing `name`")
  else {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`name "${name}" must be lowercase kebab-case (a-z, 0-9, single hyphens)`)
    if (name.length > NAME_MAX) errors.push(`name is ${name.length} characters; the limit is ${NAME_MAX}`)
  }
  if (!description) errors.push("frontmatter is missing `description`")
  else {
    if (description.length > DESCRIPTION_MAX) errors.push(`description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}`)
    if (/[<>]/.test(description)) errors.push("description must not contain < or > (some loaders reject angle brackets)")
    if (!/\buse (it|this)\b/i.test(description)) warnings.push('description never says when to use the skill ("Use this when …"); agents trigger on that sentence')
  }
  for (const key of Object.keys(fm.data)) {
    if (!KNOWN_KEYS.includes(key)) warnings.push(`unknown frontmatter key "${key}" (known: ${KNOWN_KEYS.join(", ")})`)
  }
  const bodyLines = fm.body.split("\n").length
  if (bodyLines > BODY_LINES_WARN) warnings.push(`SKILL.md body is ${bodyLines} lines; keep it under ${BODY_LINES_WARN} and move detail into references/`)
  return { errors, warnings }
}

// Paths mentioned inside backticks that the agent is told to read or run.
// Returns repo-relative candidates such as "references/config.md" or
// "assets/template/scripts/status.mjs" plus the line they appeared on.
const TEMPLATE_DIRS = ["scripts", "src", "worker", "templates", "tests", ".github/workflows"]
export function referencedPaths(markdown) {
  const out = []
  const lines = String(markdown).split("\n")
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      for (const token of m[1].split(/\s+/)) {
        const clean = token.replace(/^[("']+|[)"',:;]+$/g, "")
        if (!clean || clean.includes("<") || clean.includes("*") || /^https?:/.test(clean)) continue
        if (/^references\/[\w.-]+\.md$/.test(clean)) out.push({ token: clean, line: i + 1, candidates: [clean] })
        else if (/^assets\/template\//.test(clean)) out.push({ token: clean, line: i + 1, candidates: [clean.replace(/\/$/, "")] })
        else if (TEMPLATE_DIRS.some((d) => clean.startsWith(d + "/")) && /\.(mjs|js|sh|yml|json)$|Dockerfile$/.test(clean)) {
          out.push({ token: clean, line: i + 1, candidates: [`assets/template/${clean}`] })
        } else if (/^[\w-]+\.mjs$/.test(clean)) {
          out.push({ token: clean, line: i + 1, candidates: [`assets/template/scripts/${clean}`, `assets/template/src/${clean}`] })
        }
      }
    }
  })
  return out
}

// A config the user copies from an *.example.json (scripts/demo-issues.json)
// does not exist in the template on purpose; the example must.
function exampleOf(path) {
  return path.replace(/\.json$/, ".example.json")
}

export function missingPaths(root, refs) {
  const missing = []
  for (const ref of refs) {
    const ok = ref.candidates.some((c) => existsSync(join(root, c)) || (c.endsWith(".json") && existsSync(join(root, exampleOf(c)))))
    if (!ok) missing.push(ref)
  }
  return missing
}

// Every `npm run <x>` in the template must point at a file that exists, and
// every workflow step that runs `node scripts/x.mjs` / `node src/x.mjs` too.
export function templateProblems(root) {
  const errors = []
  const tpl = join(root, "assets/template")
  if (!existsSync(tpl)) return ["assets/template/ is missing"]
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(tpl, "package.json"), "utf8"))
  } catch (e) {
    return [`assets/template/package.json does not parse: ${e.message}`]
  }
  for (const [script, cmd] of Object.entries(pkg.scripts || {})) {
    for (const m of String(cmd).matchAll(/\b((?:scripts|src)\/[\w./-]+\.mjs)\b/g)) {
      if (!existsSync(join(tpl, m[1]))) errors.push(`package.json script "${script}" runs ${m[1]}, which does not exist`)
    }
  }
  for (const file of ["factory.config.json", ...listJson(join(tpl, "scripts")).map((f) => `scripts/${f}`)]) {
    try {
      JSON.parse(readFileSync(join(tpl, file), "utf8"))
    } catch (e) {
      errors.push(`assets/template/${file} is not valid JSON: ${e.message}`)
    }
  }
  const wfDir = join(tpl, ".github/workflows")
  const ymls = [
    ...(existsSync(wfDir) ? readdirSync(wfDir).filter((f) => f.endsWith(".yml")).map((f) => `.github/workflows/${f}`) : []),
    ...(existsSync(join(tpl, "templates")) ? readdirSync(join(tpl, "templates")).filter((f) => f.endsWith(".yml")).map((f) => `templates/${f}`) : []),
  ]
  for (const file of ymls) {
    const text = readFileSync(join(tpl, file), "utf8")
    for (const m of text.matchAll(/\bnode\s+(?:--[\w=.-]+\s+)*((?:scripts|src)\/[\w./-]+\.mjs)\b/g)) {
      if (!existsSync(join(tpl, m[1]))) errors.push(`${file} runs ${m[1]}, which does not exist`)
    }
  }
  return errors
}

function listJson(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []
}

// evals/trigger-cases.json shape:
// { "skill": "<name>", "minPositive": n, "minNegative": n,
//   "distractors": [{ "name", "description" }],
//   "cases": [{ "id", "prompt", "shouldTrigger", "why", "anchors"?: [..] }] }
export function casesProblems(spec, skillName, description) {
  const errors = []
  if (!spec || typeof spec !== "object") return ["trigger-cases.json must be a JSON object"]
  if (spec.skill !== skillName) errors.push(`trigger-cases.json "skill" is "${spec.skill}", but SKILL.md name is "${skillName}"`)
  const cases = Array.isArray(spec.cases) ? spec.cases : []
  if (!cases.length) errors.push('trigger-cases.json needs a non-empty "cases" list')
  const ids = new Set()
  const prompts = new Set()
  cases.forEach((c, i) => {
    const where = `case ${c && c.id ? `"${c.id}"` : `#${i + 1}`}`
    if (!c || typeof c !== "object") return errors.push(`${where} is not an object`)
    if (typeof c.id !== "string" || !/^[a-z0-9-]+$/.test(c.id)) errors.push(`${where}: id must be kebab-case`)
    else if (ids.has(c.id)) errors.push(`${where}: duplicate id`)
    ids.add(c.id)
    if (typeof c.prompt !== "string" || c.prompt.trim().length < 10) errors.push(`${where}: prompt must be a real request (10+ characters)`)
    else {
      const key = c.prompt.trim().toLowerCase()
      if (prompts.has(key)) errors.push(`${where}: duplicate prompt`)
      prompts.add(key)
    }
    if (typeof c.shouldTrigger !== "boolean") errors.push(`${where}: shouldTrigger must be true or false`)
    if (typeof c.why !== "string" || !c.why.trim()) errors.push(`${where}: say why in "why"`)
    if (c.anchors !== undefined) {
      if (!Array.isArray(c.anchors) || c.anchors.some((a) => typeof a !== "string" || !a.trim())) errors.push(`${where}: anchors must be a list of non-empty strings`)
      else if (c.shouldTrigger === false) errors.push(`${where}: anchors only make sense on shouldTrigger: true cases`)
      else if (description) {
        for (const a of c.anchors) {
          if (!description.toLowerCase().includes(a.toLowerCase())) errors.push(`${where}: the description no longer contains the anchor "${a}", so this request may stop triggering the skill`)
        }
      }
    }
  })
  const pos = cases.filter((c) => c && c.shouldTrigger === true).length
  const neg = cases.filter((c) => c && c.shouldTrigger === false).length
  if (pos < (spec.minPositive ?? 1)) errors.push(`need at least ${spec.minPositive ?? 1} shouldTrigger: true cases, have ${pos}`)
  if (neg < (spec.minNegative ?? 1)) errors.push(`need at least ${spec.minNegative ?? 1} shouldTrigger: false cases, have ${neg}`)
  const distractors = spec.distractors ?? []
  if (!Array.isArray(distractors)) errors.push('"distractors" must be a list')
  else {
    distractors.forEach((d, i) => {
      if (!d || typeof d.name !== "string" || typeof d.description !== "string" || !d.description.trim()) errors.push(`distractor #${i + 1} needs a name and a description`)
      else if (d.name === skillName) errors.push(`distractor #${i + 1} reuses this skill's name`)
    })
  }
  return errors
}

export function lintSkill(root) {
  const errors = []
  const warnings = []
  const skillPath = join(root, "SKILL.md")
  if (!existsSync(skillPath)) return { errors: ["SKILL.md is missing"], warnings, name: null }
  const skill = readFileSync(skillPath, "utf8")
  const fm = parseFrontmatter(skill)
  const f = frontmatterProblems(fm)
  errors.push(...f.errors)
  warnings.push(...f.warnings)
  for (const doc of ["SKILL.md", "README.md"]) {
    if (!existsSync(join(root, doc))) continue
    for (const ref of missingPaths(root, referencedPaths(readFileSync(join(root, doc), "utf8")))) {
      errors.push(`${doc}:${ref.line} mentions \`${ref.token}\`, but ${ref.candidates.join(" or ")} does not exist`)
    }
  }
  errors.push(...templateProblems(root))
  const casesPath = join(root, "evals/trigger-cases.json")
  if (!existsSync(casesPath)) errors.push("evals/trigger-cases.json is missing")
  else {
    let spec
    try {
      spec = JSON.parse(readFileSync(casesPath, "utf8"))
    } catch (e) {
      errors.push(`evals/trigger-cases.json is not valid JSON: ${e.message}`)
    }
    if (spec) errors.push(...casesProblems(spec, fm.data?.name, fm.data?.description))
  }
  return { errors, warnings, name: fm.data?.name ?? null }
}
