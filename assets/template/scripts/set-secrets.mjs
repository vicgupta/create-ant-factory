// Copies secrets into GitHub Actions secrets with the gh CLI. Values go through
// stdin and are never printed.
//
// The factory repo gets the GitHub token, every agent sign-in secret named in
// factory.config.json and, with the Box provider only, the Box key (with the
// Daytona provider only, DAYTONA_API_KEY). Each app
// repo only gets the GitHub token, which its trigger workflow uses to start
// the factory. src/secrets.mjs secretPlan() builds the list.
//
// A secret's value comes from .env, or from the agent's "localFile" when the
// config names one (for example ~/.codex/auth.json).
//
// Preview: node --env-file=.env scripts/set-secrets.mjs
// Apply:   node --env-file=.env scripts/set-secrets.mjs --yes
import { spawnSync } from "node:child_process"
import { loadConfig } from "../src/config.mjs"
import { secretPlan } from "../src/secrets.mjs"

const config = loadConfig()
const apply = process.argv.includes("--yes")
const plan = secretPlan(config)

const missing = plan.filter(([, , value]) => !value).map(([, name]) => name)
if (missing.length) {
  console.error(`No value found for: ${[...new Set(missing)].join(", ")}. Fill in .env first.`)
  process.exit(1)
}

for (const [repo, name, value] of plan) {
  if (!apply) {
    console.log(`Would set ${name} on ${repo} (${value.length} characters)`)
    continue
  }
  const result = spawnSync("gh", ["secret", "set", name, "--repo", repo], { input: value, encoding: "utf8" })
  if (result.status !== 0) {
    console.error(`Failed to set ${name} on ${repo}: ${result.stderr}`)
    process.exit(1)
  }
  console.log(`Set ${name} on ${repo}`)
}

if (!apply) console.log("\nPreview only. Add --yes to set them.")
