// Dry-runs the risk gate (src/gates.mjs) without a worker, a run or any
// GitHub call: shows which decision a change would get and why.
//
// Run with:
//   git -C ../app diff --numstat main...HEAD > /tmp/numstat
//   node scripts/risk-gate.mjs owner/app-repo --numstat /tmp/numstat [--title "..."] [--labels a,b] [--precedents precedents.json]
//   node scripts/risk-gate.mjs owner/app-repo --files src/a.ts,migrations/1.sql [--lines 120]
// FACTORY_CONFIG=<path> reads another config file. Add --json for
// machine-readable output. Exit code 0 for every decision;
// 2 for bad arguments or config.
import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { loadConfig, findRepo } from "../src/config.mjs"
import { riskGatesEnabled, gateSettings, evaluateRiskGate, parseNumstat, renderGate } from "../src/gates.mjs"
import { findPrecedents, loadPrecedents } from "../src/context.mjs"

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] ?? "" : undefined
}
const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const VALUE_FLAGS = new Set(["--numstat", "--files", "--lines", "--title", "--body", "--labels", "--precedents"])
const repoName = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]))
if (!repoName) fail("Usage: node scripts/risk-gate.mjs <owner/app-repo> (--numstat <file> | --files a,b [--lines N]) [--title T] [--body B] [--labels a,b] [--precedents file] [--json]")

let config
try {
  config = process.env.FACTORY_CONFIG ? loadConfig(pathToFileURL(process.env.FACTORY_CONFIG)) : loadConfig()
} catch (error) {
  fail(error.message)
}
const repo = findRepo(config, repoName)
if (!repo) fail(`${repoName} is not in factory.config.json`)
if (!riskGatesEnabled(config)) console.error("Note: factory.riskGates is not set, so real runs open ready pull requests. Showing what the default settings would decide.")

let files = []
let lines = Number(flag("lines") ?? 0)
const numstatFile = flag("numstat")
if (numstatFile !== undefined) {
  if (!numstatFile || !existsSync(numstatFile)) fail(`--numstat needs an existing file (got "${numstatFile}")`)
  const parsed = parseNumstat(readFileSync(numstatFile, "utf8"))
  files = parsed.files.map((f) => f.path)
  lines = parsed.lines
} else if (flag("files") !== undefined) {
  files = flag("files").split(",").map((f) => f.trim()).filter(Boolean)
} else {
  fail("Give the change with --numstat <file> or --files a,b")
}
if (!Number.isFinite(lines) || lines < 0) fail("--lines must be a number of changed lines")

const precedentsFile = flag("precedents") ?? process.env.FACTORY_PRECEDENTS_FILE ?? config.factory.precedentsFile ?? "precedents.json"
const precedents = findPrecedents(loadPrecedents({ indexFile: precedentsFile, recordsDir: "runs" }), { files })

const gate = evaluateRiskGate(gateSettings(config), {
  files,
  lines,
  hasChecks: repo.checks.length > 0,
  tier: repo.tier ?? null,
  issue: { title: flag("title") ?? "", body: flag("body") ?? "", labels: (flag("labels") ?? "").split(",").map((l) => l.trim()).filter(Boolean) },
  precedents,
})
if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ repo: repo.repo, files: files.length, lines, ...gate }, null, 2)}\n`)
else console.log(`${repo.repo}: ${files.length} file(s), ${lines} line(s) → ${gate.decision}\n\n${renderGate(gate)}`)
