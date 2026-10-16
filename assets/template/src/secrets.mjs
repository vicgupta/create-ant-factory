// Reads a secret's value without ever printing it.
//
// In GitHub Actions every secret arrives as one JSON blob, so adding an
// agent does not mean editing the workflow. On the user's machine the value
// comes from .env, or from the entry's "localFile" (for example
// ~/.codex/auth.json), which is where some CLIs keep their login.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"

export function readSecret(entry) {
  if (process.env[entry.secret]) return process.env[entry.secret]
  try {
    const fromActions = JSON.parse(process.env.FACTORY_SECRETS_JSON ?? "{}")[entry.secret]
    if (fromActions) return fromActions
  } catch {}
  const file = entry.localFile?.replace(/^~/, homedir())
  return file && existsSync(file) ? readFileSync(file, "utf8") : undefined
}
