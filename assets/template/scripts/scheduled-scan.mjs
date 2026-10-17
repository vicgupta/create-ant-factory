// Scheduled scan: propose candidate issues from TODO/FIXME markers (and/or a
// candidates JSON file) without ever starting the factory.
//
// Preview (default):  node scripts/scheduled-scan.mjs [--root <dir>] [--candidates <file>]
// File issues:        node scripts/scheduled-scan.mjs --yes [...]
// Force while off:    node scripts/scheduled-scan.mjs --force [...]
//
// Dry-run is the default: nothing is created on GitHub. With --yes the script
// opens issues labelled factory:candidate (or factory.scheduledScan.candidateLabel)
// and NEVER applies the ready label — a human still does that.
//
// Marker scanning walks --root (default ".") for text files under the
// allowlisted paths. Pass --candidates <json> for an explicit list
// ([{ "repo", "title", "body"?, "labels"? }]) instead of or as well as markers.
// Existing issues are read with `gh` when creating or previewing against a
// real repo; tests inject via FACTORY_SCAN_ISSUES_JSON.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "../src/config.mjs"
import {
  assertSafeCandidateLabels,
  buildCandidateBody,
  candidateIssueLabels,
  findMarkersInText,
  pathAllowed,
  planScan,
  scanRepos,
  scanSettings,
  scheduledScanEnabled,
} from "../src/scan.mjs"

const args = process.argv.slice(2)
const has = (flag) => args.includes(`--${flag}`)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] ?? "" : undefined
}
const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const confirmed = has("yes")
const force = has("force")
const jsonOut = has("json")
const root = resolve(flag("root") ?? ".")
const candidatesFile = flag("candidates")

let config
try {
  config = process.env.FACTORY_CONFIG ? loadConfig(pathToFileURL(process.env.FACTORY_CONFIG)) : loadConfig()
} catch (error) {
  fail(error.message)
}

const settings = scanSettings(config)
if (!scheduledScanEnabled(config) && !force) {
  const msg = 'factory.scheduledScan is off (missing, or "enabled": false). Set "enabled": true under factory.scheduledScan, or pass --force for a one-off.'
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "disabled", message: msg }, null, 2)}\n`)
    process.exit(0)
  }
  console.log(msg)
  process.exit(0)
}

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".swift", ".md", ".txt", ".yml", ".yaml", ".toml", ".json", ".sh", ".bash", ".zsh", ".css", ".scss", ".html", ".vue", ".svelte"])
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "vendor", "target", "__pycache__"])

function walkFiles(dir, allowlist, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, allowlist, out)
      continue
    }
    if (!entry.isFile()) continue
    const rel = relative(root, full).split("\\").join("/")
    const ext = rel.includes(".") ? `.${rel.split(".").pop()}` : ""
    if (!TEXT_EXT.has(ext.toLowerCase())) continue
    if (!pathAllowed(rel, allowlist)) continue
    out.push({ full, rel })
  }
  return out
}

function loadCandidatesFromJson(file) {
  if (!file) return []
  if (!existsSync(file)) fail(`--candidates file not found: ${file}`)
  let data
  try {
    data = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    fail(`--candidates is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(data)) fail("--candidates must be a JSON array of { repo, title, body?, labels? }")
  return data.map((item) => ({
    repo: item.repo,
    title: item.title,
    body: item.body ?? "",
    labels: item.labels ?? [],
    source: item.source ?? "candidates-json",
    path: item.path ?? null,
    line: item.line ?? null,
    marker: item.marker ?? null,
  }))
}

function loadCandidatesFromMarkers() {
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const found = []
  for (const { full, rel } of walkFiles(root, settings.paths)) {
    let text
    try {
      text = readFileSync(full, "utf8")
    } catch {
      continue
    }
    // Cap per file so a generated blob cannot flood the plan.
    if (text.length > 500_000) continue
    for (const hit of findMarkersInText(text, { path: rel, markers: settings.markers })) {
      found.push(hit)
    }
  }
  return found
}

function defaultRepo() {
  const repos = scanRepos(config)
  return repos[0] ?? config.factory.repo
}

function listExistingIssues(repo) {
  if (process.env.FACTORY_SCAN_ISSUES_JSON) {
    const all = JSON.parse(process.env.FACTORY_SCAN_ISSUES_JSON)
    return (all[repo] ?? all["*"] ?? []).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state ?? "open",
      closedAt: i.closedAt ?? i.closed_at ?? null,
    }))
  }
  const result = spawnSync(
    "gh",
    ["issue", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json", "number,title,state,closedAt"],
    { encoding: "utf8" },
  )
  if (result.status !== 0) {
    // Preview without gh still works for marker discovery; creating needs gh.
    if (!confirmed) {
      console.warn(`Warning: could not list issues in ${repo} (${(result.stderr || result.stdout || "").trim() || "gh failed"}). Dedupe will see an empty list.`)
      return []
    }
    fail(`gh issue list failed for ${repo}: ${(result.stderr || result.stdout || "").trim()}`)
  }
  return JSON.parse(result.stdout || "[]")
}

function ensureLabels(repo, labels) {
  for (const name of labels) {
    const result = spawnSync(
      "gh",
      ["label", "create", name, "--repo", repo, "--color", "C5DEF5", "--description", "Factory scan candidate: a human still applies ready", "--force"],
      { encoding: "utf8" },
    )
    if (result.status !== 0) {
      console.warn(`Warning: could not ensure label "${name}" on ${repo}: ${(result.stderr || result.stdout || "").trim()}`)
    }
  }
}

function createIssue(repo, title, body, labels) {
  assertSafeCandidateLabels(config, labels)
  if (process.env.FACTORY_SCAN_DRY_CREATE === "1") {
    return { url: `dry-run://${repo}/issues/new`, number: 0, title, labels }
  }
  ensureLabels(repo, labels)
  const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body]
  if (labels.length) args.push("--label", labels.join(","))
  const result = spawnSync("gh", args, { encoding: "utf8" })
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "").trim() || `gh issue create failed for ${repo}`)
  return { url: result.stdout.trim(), title, labels }
}

const fromJson = loadCandidatesFromJson(candidatesFile)
const fromMarkers = candidatesFile && !has("also-scan") ? [] : loadCandidatesFromMarkers()
const raw = [...fromJson, ...fromMarkers]

const byRepo = new Map()
for (const item of raw) {
  const repo = item.repo || defaultRepo()
  if (!repo) fail("No repo to file into: set repos in factory.config.json or pass repo on each candidate")
  const allowed = new Set(scanRepos(config).map((r) => r.toLowerCase()))
  // Candidates JSON may name any configured repo; markers inherit defaultRepo.
  if (config.repos?.length && !allowed.has(repo.toLowerCase()) && !config.repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) {
    // Still allow factory.repo for factory-local notes.
    if (repo.toLowerCase() !== config.factory.repo.toLowerCase()) {
      console.warn(`Skipping candidate for ${repo}: not in factory.config.json repos`)
      continue
    }
  }
  if (!byRepo.has(repo)) byRepo.set(repo, [])
  byRepo.get(repo).push({ ...item, repo })
}

const summary = { dryRun: !confirmed, created: [], skipped: [], repos: [] }

for (const [repo, candidates] of byRepo) {
  const existing = listExistingIssues(repo)
  const planned = planScan(candidates, existing, settings)
  summary.repos.push(repo)
  for (const s of planned.skip) {
    summary.skipped.push({
      repo,
      title: s.candidate.title,
      reason: s.reason,
      issue: s.issue ? `#${s.issue.number}` : undefined,
    })
  }
  for (const c of planned.create) {
    let labels
    try {
      labels = candidateIssueLabels(config, c.labels ?? [])
      assertSafeCandidateLabels(config, labels)
    } catch (error) {
      summary.skipped.push({ repo, title: c.title, reason: "unsafe-labels", error: error.message })
      continue
    }
    const body = buildCandidateBody({
      body: c.body,
      source: c.source,
      repo,
      path: c.path,
      line: c.line,
      marker: c.marker,
    })
    if (!confirmed) {
      summary.created.push({ repo, title: c.title, labels, action: "would-create" })
      continue
    }
    try {
      const created = createIssue(repo, c.title, body, labels)
      summary.created.push({ repo, title: c.title, labels, url: created.url, action: "created" })
    } catch (error) {
      summary.skipped.push({ repo, title: c.title, reason: "create-failed", error: error.message })
    }
  }
}

if (jsonOut) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
} else {
  console.log(confirmed ? "Scheduled scan (creating issues)" : "Scheduled scan (dry-run; pass --yes to create)")
  console.log(`Candidate label: ${settings.candidateLabel}`)
  console.log(`Human gate: a person must apply "${config.labels.ready}" to start work. The scanner never does.`)
  console.log(`Repos: ${summary.repos.join(", ") || "(none)"}`)
  console.log(`Would create / created: ${summary.created.length}`)
  for (const c of summary.created) {
    console.log(`  + [${c.repo}] ${c.title} [${c.labels.join(", ")}]${c.url ? ` -> ${c.url}` : ""}`)
  }
  console.log(`Skipped: ${summary.skipped.length}`)
  for (const s of summary.skipped) {
    console.log(`  - [${s.repo}] ${s.title ?? "(no title)"} (${s.reason}${s.issue ? ` ${s.issue}` : ""})`)
  }
  if (!confirmed && summary.created.length) console.log("\nPreview only. Add --yes to file these as candidate issues.")
}

process.exit(0)
