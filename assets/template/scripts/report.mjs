// Turns a folder of run records (written by src/run.mjs, uploaded by the
// workflow as run-record-* artifacts) into a markdown report: pass rate,
// median time to a pull request, rework, and the same per agent type and
// per worker provider. Reads files only; it calls no API.
//
// Fetch the records first, then report:
//   gh run download -R OWNER/FACTORY-REPO --pattern 'run-record-*' --dir runs
//   node scripts/report.mjs runs
// Options: --json prints the numbers as JSON, --out FILE writes the report to a file.
import { existsSync, writeFileSync } from "node:fs"
import { readRecords, summarizeRecords, formatReport, DEFAULT_RECORD_DIR } from "../src/record.mjs"

const args = process.argv.slice(2)
const json = args.includes("--json")
const outIndex = args.indexOf("--out")
const out = outIndex >= 0 ? args[outIndex + 1] : null
if (outIndex >= 0 && !out) {
  console.error("--out needs a file name")
  process.exit(2)
}
const dir = args.find((a, i) => !a.startsWith("--") && !(outIndex >= 0 && i === outIndex + 1)) ?? DEFAULT_RECORD_DIR

if (!existsSync(dir)) {
  console.error(`No folder ${dir}. Download the records first:\n  gh run download -R OWNER/FACTORY-REPO --pattern 'run-record-*' --dir ${dir}`)
  process.exit(1)
}
const summary = summarizeRecords(readRecords(dir))
const text = json ? `${JSON.stringify(summary, null, 2)}\n` : formatReport(summary)
if (out) {
  writeFileSync(out, text)
  console.log(`Wrote ${out} (${summary.total} run record(s)).`)
} else {
  process.stdout.write(text)
}
