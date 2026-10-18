#!/usr/bin/env node
// Validate this skill: frontmatter, referenced paths, template wiring and
// the trigger cases. Offline and dependency-free. Exit code 1 on any error.
//
//   node evals/validate-skill.mjs            # this repo
//   node evals/validate-skill.mjs <dir>      # another skill folder
//   node evals/validate-skill.mjs --strict   # warnings fail too
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { lintSkill } from "./skill-lint.mjs"

const args = process.argv.slice(2)
const strict = args.includes("--strict")
const dir = args.find((a) => !a.startsWith("--"))
const root = resolve(dir ?? fileURLToPath(new URL("..", import.meta.url)))

const { errors, warnings, name } = lintSkill(root)
for (const w of warnings) console.log(`warning: ${w}`)
for (const e of errors) console.log(`error: ${e}`)
const failed = errors.length > 0 || (strict && warnings.length > 0)
console.log(failed ? `skill ${name ?? "?"}: ${errors.length} error(s), ${warnings.length} warning(s)` : `skill ${name}: ok (${warnings.length} warning(s))`)
process.exit(failed ? 1 : 0)
