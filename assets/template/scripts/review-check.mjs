// Checks a review.md file the way the factory does after the independent
// reviewer pass (src/reviewer.mjs), without a worker, a run or any GitHub
// call: is the file valid, and would it pass or block?
//
// Run with:
//   node scripts/review-check.mjs path/to/review.md [--block-on critical|major|minor] [--json]
// Without --block-on, factory.reviewer.blockOn from factory.config.json is
// used (FACTORY_CONFIG=<path> reads another file), else "critical".
// Exit code 0 for pass, 1 for block, 2 for an invalid file or bad arguments.
import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { loadConfig } from "../src/config.mjs"
import { validateReviewText, decideReview, reviewerSettings, renderReview, SEVERITIES, REVIEWER_DEFAULTS } from "../src/reviewer.mjs"

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] ?? "" : undefined
}
const fail = (message) => {
  console.error(message)
  process.exit(2)
}
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--block-on")
if (!file) fail("Usage: node scripts/review-check.mjs <review.md> [--block-on critical|major|minor] [--json]")
if (!existsSync(file)) fail(`${file} does not exist`)

let settings = { ...REVIEWER_DEFAULTS }
const blockOn = flag("block-on")
if (blockOn !== undefined) {
  if (!SEVERITIES.includes(blockOn)) fail(`--block-on must be one of: ${SEVERITIES.join(", ")}`)
  settings.blockOn = blockOn
} else {
  try {
    settings = reviewerSettings(process.env.FACTORY_CONFIG ? loadConfig(pathToFileURL(process.env.FACTORY_CONFIG)) : loadConfig())
  } catch {
    // No usable config: the defaults above apply.
  }
}

const { review, errors } = validateReviewText(readFileSync(file, "utf8"))
if (errors.length) {
  if (args.includes("--json")) console.log(JSON.stringify({ valid: false, errors }, null, 2))
  else console.log(`Invalid review, so a real run would treat the review as not completed (onError):\n${errors.map((e) => `- ${e}`).join("\n")}`)
  process.exit(2)
}
const decided = decideReview(review.findings, settings)
if (args.includes("--json")) console.log(JSON.stringify({ valid: true, ...decided, findings: review.findings }, null, 2))
else console.log(renderReview({ ...decided, findings: review.findings, agent: "review.md", differentType: true }))
process.exit(decided.decision === "block" ? 1 : 0)
