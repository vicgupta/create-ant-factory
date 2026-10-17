// Builds the flat precedents index (precedents.json) from downloaded run
// records, so a later run can retrieve past runs by exact label/path match
// (src/context.mjs). No database, no embeddings: plain JSON, committed to
// the factory repo and read at the start of a run when factory.contextGraph
// is on.
//
//   gh run download -R OWNER/FACTORY-REPO --pattern 'run-record-*' --dir runs
//   node scripts/precedents.mjs runs            # writes precedents.json
//   node scripts/precedents.mjs runs --out docs/precedents.json
//   node scripts/precedents.mjs runs --json     # print instead of writing
import { existsSync, writeFileSync } from "node:fs"
import { readRecords, DEFAULT_RECORD_DIR } from "../src/record.mjs"
import { buildPrecedentsIndex } from "../src/context.mjs"

const args = process.argv.slice(2)
const json = args.includes("--json")
const outIndex = args.indexOf("--out")
const out = outIndex >= 0 ? args[outIndex + 1] : "precedents.json"
if (outIndex >= 0 && !out) {
  console.error("--out needs a file name")
  process.exit(2)
}
const dir = args.find((a, i) => !a.startsWith("--") && !(outIndex >= 0 && i === outIndex + 1)) ?? DEFAULT_RECORD_DIR
if (!existsSync(dir)) {
  console.error(`No folder ${dir}. Download the records first:\n  gh run download --pattern 'run-record-*' --dir ${dir}`)
  process.exit(1)
}
const index = buildPrecedentsIndex(readRecords(dir))
if (json) {
  process.stdout.write(`${JSON.stringify(index, null, 2)}\n`)
} else {
  writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`)
  console.log(`Wrote ${out} (${index.precedents.length} precedent(s), ${Object.keys(index.byLabel).length} label key(s), ${Object.keys(index.byPath).length} path key(s)).`)
}
