// Scheduled scan: propose candidate work items as GitHub issues without ever
// starting the factory. A human still applies the ready label.
//
// Off unless factory.scheduledScan is an object (and "enabled" is not false).
// The scanner may only apply the candidate label (default factory:candidate).
// It must never apply labels.ready, labels.running, labels.review or
// labels.needsAttention — applying ready would start work through the
// existing trigger, which is the opposite of a human gate.
//
// Pure helpers here (fingerprint, dedupe, plan, marker scan, label pick,
// issue body) are testable with no network and no Docker. The live GitHub
// calls live in scripts/scheduled-scan.mjs.
import { pathMatches } from "./gates.mjs"

export const SCAN_DEFAULTS = {
  enabled: false,
  candidateLabel: "factory:candidate",
  paths: ["src/", "lib/", "app/", "packages/"],
  markers: ["TODO", "FIXME", "XXX", "HACK"],
  skipClosedDays: 30,
  maxPerRun: 10,
  repos: [],
}

export const scheduledScanEnabled = (config) => {
  const s = config?.factory?.scheduledScan
  return Boolean(s) && typeof s === "object" && !Array.isArray(s) && s.enabled !== false
}

export function scanSettings(config) {
  const s = config?.factory?.scheduledScan
  const base = s && typeof s === "object" && !Array.isArray(s) ? s : {}
  return {
    ...SCAN_DEFAULTS,
    ...base,
    paths: Array.isArray(base.paths) ? base.paths : SCAN_DEFAULTS.paths,
    markers: Array.isArray(base.markers) ? base.markers : SCAN_DEFAULTS.markers,
    repos: Array.isArray(base.repos) ? base.repos : SCAN_DEFAULTS.repos,
  }
}

// Labels the scanner is never allowed to apply. Ready is the hard one: the
// app-repo trigger starts the factory on that label. The other three are the
// factory's own status board and must stay factory-owned.
export function forbiddenScanLabels(config) {
  const labels = config?.labels ?? {}
  return [labels.ready, labels.running, labels.review, labels.needsAttention]
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim())
}

// The labels a candidate issue may carry. Always the candidate label, never
// any forbidden label. Extra labels from a candidate source are kept only
// when they do not collide with a forbidden name (case-insensitive).
export function candidateIssueLabels(config, extra = []) {
  const settings = scanSettings(config)
  const candidate = String(settings.candidateLabel ?? "").trim()
  if (!candidate) throw new Error("factory.scheduledScan.candidateLabel must be a non-empty label name")
  const forbidden = new Set(forbiddenScanLabels(config).map((n) => n.toLowerCase()))
  if (forbidden.has(candidate.toLowerCase())) {
    throw new Error(
      `factory.scheduledScan.candidateLabel "${candidate}" collides with a factory status label (ready/running/review/needs-attention). The scanner must never apply those.`,
    )
  }
  const out = [candidate]
  const seen = new Set([candidate.toLowerCase()])
  for (const raw of extra) {
    const name = String(raw ?? "").trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (forbidden.has(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

// Assert the label list a create call would send never includes a forbidden
// label. Call this immediately before opening an issue so a bug in label
// assembly cannot start the factory.
export function assertSafeCandidateLabels(config, labels) {
  const forbidden = forbiddenScanLabels(config).map((n) => n.toLowerCase())
  const list = Array.isArray(labels) ? labels : []
  for (const label of list) {
    if (forbidden.includes(String(label).toLowerCase())) {
      throw new Error(
        `Refusing to create a scan candidate with label "${label}": the scanner must never apply ready or other factory status labels. A human applies the ready label.`,
      )
    }
  }
  return list
}

// Normalize a title into a stable fingerprint for dedupe. Case, punctuation
// and whitespace differences should not open a second issue for the same work.
export function fingerprint(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[`'"*_~\[\](){}<>#]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

export function isDuplicateIssue(existing, candidate, { skipClosedDays = SCAN_DEFAULTS.skipClosedDays, now = Date.now() } = {}) {
  const needle = fingerprint(candidate.title)
  if (!needle) return { duplicate: false }
  const cutoff = Number.isFinite(skipClosedDays) && skipClosedDays > 0 ? now - skipClosedDays * 24 * 60 * 60 * 1000 : null
  for (const issue of existing ?? []) {
    if (fingerprint(issue.title) !== needle) continue
    const state = String(issue.state ?? "open").toLowerCase()
    if (state === "open") return { duplicate: true, reason: "open", issue }
    if (state === "closed") {
      if (cutoff === null) return { duplicate: true, reason: "closed", issue }
      const closedAt = issue.closedAt ?? issue.closed_at
      const when = closedAt ? Date.parse(closedAt) : NaN
      if (!Number.isFinite(when) || when >= cutoff) return { duplicate: true, reason: "recently-closed", issue }
    }
  }
  return { duplicate: false }
}

// Decide which candidates to file. Caps at maxPerRun after skips. Pure:
// existing issues and candidates are injected by the caller.
export function planScan(candidates, existingIssues, settings = {}) {
  const max = Number.isInteger(settings.maxPerRun) && settings.maxPerRun > 0 ? settings.maxPerRun : SCAN_DEFAULTS.maxPerRun
  const skipClosedDays = settings.skipClosedDays ?? SCAN_DEFAULTS.skipClosedDays
  const now = settings.now ?? Date.now()
  const create = []
  const skip = []
  const seen = new Set()
  for (const candidate of candidates ?? []) {
    const title = String(candidate.title ?? "").trim()
    if (!title) {
      skip.push({ candidate, reason: "empty-title" })
      continue
    }
    const fp = fingerprint(title)
    if (seen.has(fp)) {
      skip.push({ candidate: { ...candidate, title }, reason: "duplicate-in-batch" })
      continue
    }
    const dup = isDuplicateIssue(existingIssues, { title }, { skipClosedDays, now })
    if (dup.duplicate) {
      skip.push({ candidate: { ...candidate, title }, reason: dup.reason, issue: dup.issue })
      continue
    }
    if (create.length >= max) {
      skip.push({ candidate: { ...candidate, title }, reason: "max-per-run" })
      continue
    }
    seen.add(fp)
    create.push({ ...candidate, title, fingerprint: fp })
  }
  return { create, skip }
}

// Human-gate notice every candidate issue must carry. Applying ready is still
// a person; the scanner never starts work.
export const HUMAN_GATE_NOTICE = [
  "## Human gate",
  "",
  "This issue was filed by the **scheduled scan**. It is a **candidate** only.",
  "",
  "- A person reviews it and decides whether it is real work.",
  "- To start the factory, a person applies the **ready** label.",
  "- The scanner never applies the ready label and never starts a factory run.",
].join("\n")

export function buildCandidateBody({ body = "", source = null, repo = null, path = null, line = null, marker = null } = {}) {
  const parts = []
  const trimmed = String(body ?? "").trim()
  if (trimmed) parts.push(trimmed)
  const provenance = []
  if (repo) provenance.push(`- Repo: \`${repo}\``)
  if (path) provenance.push(`- Path: \`${path}${line ? `:${line}` : ""}\``)
  if (marker) provenance.push(`- Marker: \`${marker}\``)
  if (source) provenance.push(`- Source: ${source}`)
  if (provenance.length) {
    parts.push("## Scan provenance")
    parts.push("")
    parts.push(...provenance)
  }
  parts.push(HUMAN_GATE_NOTICE)
  parts.push("")
  parts.push("<!-- software-factory-scan -->")
  return parts.filter((p, i, arr) => !(p === "" && arr[i - 1] === "")).join("\n").trim() + "\n"
}

// Find TODO/FIXME-style markers in text for one file. Paths outside the
// allowlist are ignored by the caller; this only parses content.
export function findMarkersInText(text, { path, markers = SCAN_DEFAULTS.markers } = {}) {
  const list = (markers ?? []).map((m) => String(m).trim()).filter(Boolean)
  if (!list.length) return []
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])(${list.map(escapeRe).join("|")})(?:\\b|\\s*[:\\-–—])\\s*(.*)$`, "i")
  const found = []
  const lines = String(text ?? "").replaceAll("\r\n", "\n").split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip obvious non-code noise and our own notice.
    if (/software-factory-scan/.test(line)) continue
    const m = re.exec(line)
    if (!m) continue
    const marker = m[1].toUpperCase()
    const rest = (m[2] ?? "").trim().replace(/\*\/\s*$/, "").replace(/-->\s*$/, "").trim()
    if (!rest || rest.length < 3) continue
    const title = `${marker}: ${rest}`.slice(0, 120)
    found.push({
      title,
      path,
      line: i + 1,
      marker,
      body: `Found \`${marker}\` in \`${path}:${i + 1}\`:\n\n\`\`\`\n${line.trim().slice(0, 400)}\n\`\`\`\n`,
      source: "marker-scan",
    })
  }
  return found
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Keep only paths that match at least one allowlist pattern (same tiny
// matcher as risk gates). Empty allowlist means "no path filter" so a
// candidates JSON can still file issues with no tree walk.
export function pathAllowed(path, allowlist) {
  const list = Array.isArray(allowlist) ? allowlist : []
  if (!list.length) return true
  return list.some((pattern) => pathMatches(pattern, path))
}

// Which app repos the scan covers. Empty factory.scheduledScan.repos means
// every repo listed under "repos".
export function scanRepos(config) {
  const settings = scanSettings(config)
  const all = config?.repos ?? []
  if (!settings.repos.length) return all.map((r) => r.repo)
  const want = new Set(settings.repos.map((r) => String(r).toLowerCase()))
  return all.filter((r) => want.has(String(r.repo).toLowerCase())).map((r) => r.repo)
}

// Config errors for factory.scheduledScan, in the loader's message style.
export function scheduledScanErrors(config) {
  const s = config?.factory?.scheduledScan
  if (s === undefined) return []
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return ['factory.scheduledScan must be an object like { "enabled": false, "candidateLabel": "factory:candidate" }']
  }
  const errors = []
  if (s.enabled !== undefined && typeof s.enabled !== "boolean") errors.push("factory.scheduledScan.enabled must be true or false")
  if (s.candidateLabel !== undefined) {
    if (typeof s.candidateLabel !== "string" || !s.candidateLabel.trim()) {
      errors.push("factory.scheduledScan.candidateLabel must be a non-empty label name")
    } else if (s.candidateLabel.includes("'")) {
      errors.push("factory.scheduledScan.candidateLabel must not contain a single quote")
    } else {
      const forbidden = forbiddenScanLabels(config).map((n) => n.toLowerCase())
      if (forbidden.includes(s.candidateLabel.trim().toLowerCase())) {
        errors.push(
          `factory.scheduledScan.candidateLabel "${s.candidateLabel}" must not be the same as labels.ready, labels.running, labels.review or labels.needsAttention`,
        )
      }
    }
  }
  if (s.skipClosedDays !== undefined && !(Number.isInteger(s.skipClosedDays) && s.skipClosedDays >= 0)) {
    errors.push("factory.scheduledScan.skipClosedDays must be a whole number of days (0 = treat every closed duplicate as a skip forever)")
  }
  if (s.maxPerRun !== undefined && !(Number.isInteger(s.maxPerRun) && s.maxPerRun > 0)) {
    errors.push("factory.scheduledScan.maxPerRun must be a positive whole number")
  }
  for (const key of ["paths", "markers", "repos"]) {
    if (s[key] !== undefined) {
      if (!Array.isArray(s[key]) || s[key].some((item) => typeof item !== "string" || !item.trim())) {
        errors.push(`factory.scheduledScan.${key} must be a list of non-empty strings`)
      }
    }
  }
  if (Array.isArray(s.repos) && config?.repos) {
    const known = new Set(config.repos.map((r) => r.repo.toLowerCase()))
    for (const name of s.repos) {
      if (typeof name === "string" && name.trim() && !known.has(name.trim().toLowerCase())) {
        errors.push(`factory.scheduledScan.repos lists "${name}", which is not in "repos"`)
      }
    }
  }
  return errors
}
