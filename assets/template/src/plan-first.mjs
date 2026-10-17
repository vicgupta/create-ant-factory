// Plan-first phase. Before any implementation, a planning agent run writes
// plan.md (files to touch, and acceptance criteria each mapped to a check),
// the factory validates that file, posts it to the issue, and only then lets
// the implementation agent start — with the validated plan in its prompt.
// The pull request body ticks off the criteria whose check passed.
//
// The file format is deliberately small and line-based, so validation is a
// pure function of the text and the repo's configured checks:
//
//   # Plan
//
//   ## Files to touch
//   - src/example.mjs — why this file changes
//
//   ## Acceptance criteria
//   - [ ] The example works — check: npm test
//   - [ ] The wording reads well — check: manual-review
//
// Every criterion names either one of the repo's checks (exactly as written
// in factory.config.json) or "manual-review", for a person to judge on the
// pull request. Nothing else is a valid mapping: an invented check name
// would tick itself off without ever having run.
import { protectedChanges } from "./changes.mjs"

// Whether the planning phase runs before implementation. Left out means
// false, so an existing factory keeps its old behaviour (one implementation
// run, no plan posted) until the owner opts in. Revision runs
// (resume-from-review) never plan: the review feedback is their plan.
export const planFirstEnabled = (config) => config?.factory?.planFirst === true

export const PLAN_FILE = "plan.md"
export const MANUAL_CHECK = "manual-review"
export const MAX_PLAN_CHARS = 12000
export const MAX_PLAN_FILES = 50
export const MAX_PLAN_CRITERIA = 20
export const MAX_PLAN_FACTS = 20

const heading = (line) => /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1]?.toLowerCase() ?? null

// Reads plan.md into { files, criteria }. Lines outside the two sections and
// blank lines are ignored, so the agent may add a short intro. A criterion's
// mapping is the text after the last "check:"; without one, check is null and
// validation rejects it.
// One stamped fact from the optional "## Facts" section (Context Graph,
// src/context.mjs): "- <claim> — source: <file>; base: <sha>; run: <run id>".
// Kept line-based like the rest of the plan so parsing stays a pure function.
export function parsePlanFact(item) {
  const m = /^(.*?)\s*—\s*source:\s*([^;]+);\s*base:\s*([^;]+);\s*run:\s*([^;]+)(?:;\s*observed_at:\s*(.+))?$/i.exec(item)
  return m ? { text: m[1].trim(), source: m[2].trim(), baseCommit: m[3].trim(), runId: m[4].trim(), observedAt: m[5]?.trim() ?? null } : { text: item, source: null, baseCommit: null, runId: null, observedAt: null }
}

export function parsePlan(text) {
  const plan = { files: [], criteria: [], facts: [] }
  let section = null
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim()
    const head = heading(line)
    if (head !== null) {
      section = head.startsWith("files to touch") ? "files" : head.startsWith("acceptance criteria") ? "criteria" : head.startsWith("facts") ? "facts" : null
      continue
    }
    if (!section || !/^[-*]\s+/.test(line)) continue
    const item = line.replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s+/, "").trim()
    if (!item) continue
    if (section === "facts") {
      plan.facts.push(parsePlanFact(item))
    } else if (section === "files") {
      // "- src/a.mjs — reason" / "- src/a.mjs: reason": the path is the first
      // token; the reason is the agent's note for humans and is not kept.
      plan.files.push(item.split(/\s+/)[0].replace(/`/g, "").replace(/:$/, ""))
    } else {
      const match = /^(.*?)\s*(?:—|–|\||-)\s*check:\s*(.+)$/i.exec(item)
      plan.criteria.push(match ? { text: match[1].trim(), check: match[2].trim().replace(/`/g, "") } : { text: item, check: null })
    }
  }
  return plan
}

const isSafeRelativePath = (path) =>
  typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !/^[A-Za-z]:/.test(path) &&
  !path.split("/").includes("..") && !/\s/.test(path)

// Everything wrong with a parsed plan, in plain words for the issue comment
// that hands the run back to a human. An empty list means the plan may be
// posted and implemented from.
export function validatePlan(plan, repo = {}) {
  const errors = []
  const checks = repo.checks ?? []
  if (!plan.files?.length) errors.push("the plan lists no files to touch")
  if (plan.files?.length > MAX_PLAN_FILES) errors.push(`the plan lists ${plan.files.length} files to touch; the limit is ${MAX_PLAN_FILES}`)
  for (const file of plan.files ?? []) {
    if (!isSafeRelativePath(file)) errors.push(`"${file}" is not a safe relative file path`)
  }
  const seen = new Set()
  for (const file of plan.files ?? []) {
    if (seen.has(file)) errors.push(`"${file}" is listed twice under files to touch`)
    seen.add(file)
  }
  for (const file of protectedChanges(plan.files ?? [])) errors.push(`"${file}" is under .github/, which the factory never pushes`)
  if (!plan.criteria?.length) errors.push("the plan lists no acceptance criteria")
  if (plan.criteria?.length > MAX_PLAN_CRITERIA) errors.push(`the plan lists ${plan.criteria.length} acceptance criteria; the limit is ${MAX_PLAN_CRITERIA}`)
  if (plan.facts?.length > MAX_PLAN_FACTS) errors.push(`the plan lists ${plan.facts.length} facts; the limit is ${MAX_PLAN_FACTS}`)
  // Facts are optional (older agents write none), but a stamped fact must
  // carry its whole stamp or the stale-check in src/context.mjs is a guess.
  for (const fact of plan.facts ?? []) {
    if (!fact.text) errors.push("a plan fact has no claim text")
    if (!fact.source) errors.push(`fact "${fact.text}" has no source stamp (write "— source: <file>; base: <commit sha>; run: <run id>")`)
    else if (!isSafeRelativePath(fact.source)) errors.push(`fact "${fact.text}" source "${fact.source}" is not a safe relative file path`)
    if (fact.source && !/^[0-9a-f]{7,40}$/i.test(fact.baseCommit ?? "")) errors.push(`fact "${fact.text}" base stamp "${fact.baseCommit}" is not a commit SHA (7-40 hex characters)`)
    if (fact.source && !fact.runId) errors.push(`fact "${fact.text}" has no observing run id stamp`)
  }
  for (const criterion of plan.criteria ?? []) {
    if (!criterion.text) errors.push("an acceptance criterion has no text")
    if (!criterion.check) errors.push(`criterion "${criterion.text}" names no check (write "— check: <a configured check>" or "— check: ${MANUAL_CHECK}")`)
    else if (criterion.check !== MANUAL_CHECK && !checks.includes(criterion.check))
      errors.push(`criterion "${criterion.text}" maps to "${criterion.check}", which is not one of this repo's checks (${checks.join(", ") || "none configured"}) or ${MANUAL_CHECK}`)
  }
  return errors
}

// Parse and validate in one step, with the size cap applied to the raw text
// first: an unbounded plan would swallow the implementation prompt.
export function validatePlanText(text, repo = {}) {
  if (String(text ?? "").length > MAX_PLAN_CHARS) return { plan: parsePlan(text), errors: [`the plan is ${String(text).length} characters; the limit is ${MAX_PLAN_CHARS}`] }
  const plan = parsePlan(text)
  return { plan, errors: validatePlan(plan, repo) }
}

// The markdown posted to the issue before implementation starts. Criteria
// are unticked here: nothing has been built or checked yet.
export function renderPlanComment(plan, { runUrl = null } = {}) {
  return [
    "Plan-first: the factory validated this plan and posted it before implementation. The implementation agent works from it, and the pull request will tick off each criterion whose check passes.",
    "",
    "## Files to touch",
    "",
    ...plan.files.map((file) => `- \`${file}\``),
    "",
    "## Acceptance criteria",
    "",
    ...plan.criteria.map((c) => `- [ ] ${c.text} — check: \`${c.check}\``),
    ...(plan.facts?.length ? ["", "## Facts (provenance-stamped)", "", ...plan.facts.map((f) => `- ${f.text} — source: ${f.source}; base: ${f.baseCommit}; run: ${f.runId}${f.observedAt ? `; observed_at: ${f.observedAt}` : ""}`)] : []),
    ...(runUrl ? ["", `[Factory run](${runUrl})`] : []),
  ].join("\n")
}

// The prompt section the implementation agent works from.
export function planSection(plan) {
  if (!plan?.files?.length && !plan?.criteria?.length) return ""
  return [
    "",
    "# Validated plan",
    "",
    "This plan was written in a separate planning pass, validated by the factory and posted to the issue before you started. Follow it. If part of it turns out to be wrong, make the smallest change that still meets the acceptance criteria and say so in your summary; do not widen the scope beyond the files below without that note.",
    "",
    "Files to touch:",
    ...plan.files.map((file) => `- ${file}`),
    "",
    "Acceptance criteria (each mapped to the check that proves it):",
    ...plan.criteria.map((c) => `- ${c.text} — check: ${c.check}`),
    ...(plan.facts?.length ? ["", "Facts the planning pass stamped (source file, base commit, observing run). Re-check any that look stale from the current code:", ...plan.facts.map((f) => `- ${f.text} — source: ${f.source}; base: ${f.baseCommit}; run: ${f.runId}`)] : []),
    "",
  ].join("\n")
}

// The checklist for the pull request body. A criterion is ticked only when
// the run's checks passed and its mapping is a real repo check; a
// manual-review criterion stays unticked for the reviewer to judge, even on
// a passing run. A failed run opens no pull request, so nothing is ticked
// dishonestly.
export function criteriaChecklist(plan, { checksPassed = false } = {}) {
  if (!plan?.criteria?.length) return ""
  return plan.criteria
    .map((c) => `- [${checksPassed && c.check !== MANUAL_CHECK ? "x" : " "}] ${c.text} — check: \`${c.check}\``)
    .join("\n")
}
