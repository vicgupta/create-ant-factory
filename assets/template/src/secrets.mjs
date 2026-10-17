// Reads a secret's value without ever printing it.
//
// In GitHub Actions every secret arrives as one JSON blob, so adding an
// agent does not mean editing the workflow. On the user's machine the value
// comes from .env, or from the entry's "localFile" (for example
// ~/.codex/auth.json), which is where some CLIs keep their login.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { usedAgents, workerProvider } from "./config.mjs"

export function readSecret(entry) {
  if (process.env[entry.secret]) return process.env[entry.secret]
  try {
    const fromActions = JSON.parse(process.env.FACTORY_SECRETS_JSON ?? "{}")[entry.secret]
    if (fromActions) return fromActions
  } catch {}
  const file = entry.localFile?.replace(/^~/, homedir())
  return file && existsSync(file) ? readFileSync(file, "utf8") : undefined
}

// Which secrets scripts/set-secrets.mjs puts on which repo, as
// [repo, secret name, value] rows. The factory repo gets the GitHub token,
// every sign-in secret of an agent type an enabled worker runs, and each app
// repo's own secrets. The Box key is only needed, and only asked for, with the
// Box provider: a Docker-only factory has no UPSTASH_BOX_API_KEY. Likewise
// DAYTONA_API_KEY only with the Daytona provider. Each app repo gets the
// GitHub token for its trigger workflow.
export function secretPlan(config) {
  const plan = []
  if (workerProvider(config) === "box") plan.push([config.factory.repo, "UPSTASH_BOX_API_KEY", process.env.UPSTASH_BOX_API_KEY])
  if (workerProvider(config) === "daytona") plan.push([config.factory.repo, "DAYTONA_API_KEY", process.env.DAYTONA_API_KEY])
  plan.push([config.factory.repo, "FACTORY_GITHUB_TOKEN", process.env.FACTORY_GITHUB_TOKEN])
  for (const name of usedAgents(config)) {
    for (const entry of config.agents[name]?.auth ?? []) plan.push([config.factory.repo, entry.secret, readSecret(entry)])
  }
  for (const repo of config.repos) {
    plan.push([repo.repo, "FACTORY_GITHUB_TOKEN", process.env.FACTORY_GITHUB_TOKEN])
    // Secrets the repo's own tests need are used by the factory run, so they
    // are stored on the factory repo.
    for (const entry of repo.secrets ?? []) plan.push([config.factory.repo, entry.secret, readSecret(entry)])
  }
  return plan
}
