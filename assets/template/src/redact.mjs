// Keeps secrets out of anything the factory posts or logs.
//
// The agent runs with its sign-in in the environment, and the repo's own
// secrets are sourced for setup, checks and the agent. If the agent's reply
// or a failing command happens to print one of them, the text would land in
// a pull request description or an issue comment verbatim: run.mjs used to
// redact only the GitHub token. Every secret the factory knows for the job
// is collected here and replaced with *** before anything is posted.
import { readSecret } from "./secrets.mjs"

// Values shorter than this are skipped: redacting them would mangle innocent
// text (a port number, a short word), and a secret this short should be
// replaced anyway.
const MIN_SECRET_LENGTH = 8

// All secret values the factory knows for this job: the GitHub token, the
// secrets blob GitHub Actions delivers, the sign-in secrets of the agent
// type running the job (or every agent type when none is claimed yet), and
// the repo's own secrets.
export function collectSecrets(config, { agentName, repo } = {}) {
  const values = new Set()
  const add = (value) => {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) values.add(value)
  }
  add(process.env.FACTORY_GITHUB_TOKEN)
  // Never sent into a sandbox, but an API error could still echo it.
  add(process.env.DAYTONA_API_KEY)
  try {
    for (const value of Object.values(JSON.parse(process.env.FACTORY_SECRETS_JSON ?? "{}"))) add(value)
  } catch {
    // Not JSON: the individual lookups below still apply.
  }
  const names = agentName ? [agentName] : Object.keys(config?.agents ?? {})
  for (const name of names) for (const entry of config?.agents?.[name]?.auth ?? []) add(readSecret(entry))
  for (const entry of repo?.secrets ?? []) add(readSecret(entry))
  return [...values]
}

// Pure and safe to test: replaces every occurrence of every value. Longer
// values go first: when one secret contains another (a token inside an auth
// JSON file, a key that starts with a shorter secret), replacing the short
// one first would break up the long one and leave the rest of it in the text.
export function redactSecrets(text, values) {
  let out = String(text)
  for (const value of [...values].sort((a, b) => b.length - a.length)) out = out.split(value).join("***")
  return out
}
