// Checks on the files an agent changed, before the factory commits them.
//
// The agent is told not to touch .github/, but a prompt is only a request: an
// issue body or a confused agent can still edit a workflow. A workflow change
// pushed with the factory's token would run in the app repo with that repo's
// secrets, so the factory refuses it here instead of trusting the prompt.
const PROTECTED_DIRS = [".github/"]

// Turns `git diff --cached --name-only --no-renames` output into paths. Git
// wraps unusual paths in double quotes (core.quotePath), so those are unwrapped
// enough to compare their start.
export function changedPaths(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line))
}

// The changed paths inside a directory the agent may not edit. Compared
// case-insensitively so a case-insensitive checkout cannot slip past.
export function protectedChanges(paths) {
  return paths.filter((path) => PROTECTED_DIRS.some((dir) => path.toLowerCase().replace(/^\.\//, "").startsWith(dir)))
}
