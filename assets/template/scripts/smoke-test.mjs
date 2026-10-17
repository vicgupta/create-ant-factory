// Proves one agent type works inside a Box before anything else is built on it.
// Creates ONE Box, writes the agent type's default settings into it, signs the
// agent in exactly the way the factory will, and asks it to reply "BOX OK".
// No repo is touched. Refuses when worker.provider is "docker": use
// scripts/verify-docker.mjs there instead.
//
// Preview: node --env-file=.env scripts/smoke-test.mjs <agent type>
// Run:     node --env-file=.env scripts/smoke-test.mjs <agent type> --yes [--keep]
//
// Without --keep the Box is deleted at the end. It was created by this script
// seconds earlier and holds nothing. With --keep it is paused instead, and
// scripts/box-exec.mjs can reach it by its name.
import { loadConfig, requireBoxProvider } from "../src/config.mjs"
import { sh, q, createAgentBox, describeBoxSettings, requireBoxSettings, imageFor, wantsBrowser, hasBrowser, browserMissingHelp } from "../src/box.mjs"
import { signIn, writeJobFiles, runAgent, secretPaths } from "../src/agents.mjs"

const config = loadConfig()
// The Docker factory's equivalent is scripts/verify-docker.mjs (which runs a
// smoke container). Refuse here instead of creating a real Upstash Box.
requireBoxProvider(config, "smoke-test.mjs")
const agentName = process.argv.slice(2).find((a) => !a.startsWith("--"))
const keep = process.argv.includes("--keep")
if (!config.agents[agentName]) {
  console.error(`Usage: smoke-test.mjs <${Object.keys(config.agents).join("|")}> [--yes] [--keep]`)
  process.exit(1)
}
requireBoxSettings(config, agentName)

const name = `${config.factory.boxNamePrefix}smoke-${agentName}`
console.log(`Box to create: ${name}, from ${imageFor(config, agentName) ? "this agent type's worker image" : "the stock Upstash image"}`)
console.log(`Model and effort for this agent type: ${describeBoxSettings(config, agentName)}`)
console.log(`Browser access: ${wantsBrowser(config) ? "on" : 'off ("browser": false in the config)'}`)
console.log(`At the end the Box is ${keep ? "paused and kept" : "deleted"}.`)
if (!process.argv.includes("--yes")) {
  console.log("\nPreview only. Add --yes to run the test. It uses one Box slot and a little of the agent's quota.")
  process.exit(0)
}

// Same image and same settings a worker of this type would get.
const box = await createAgentBox(config, agentName, name, [config.factory.boxLabel, "smoke-test"])
console.log(`Created Box ${box.id}`)

let passed = false
try {
  // Facts worth knowing before any repo is set up in a Box.
  const facts = await sh(
    box,
    'echo "user=$(whoami) home=$HOME arch=$(uname -m)"; for t in node npm pnpm yarn bun python3 pip3 go cargo java make gcc docker; do printf "%s: " $t; ($t --version 2>/dev/null || $t version 2>/dev/null || echo "not installed") | head -n 1; done; printf "git credential helper: "; git config --global --get credential.helper || echo none',
  )
  console.log(facts.output)

  // Browser access is fixed at creation, so a worker created the same way
  // would lack it too.
  if (wantsBrowser(config)) {
    if (!(await hasBrowser(box))) throw new Error(`This Box has no browser access although the config asks for it. ${browserMissingHelp(config, agentName)}`)
    console.log("browser access: yes")
  }

  // The CLI is the first word of the command, unless the config names it with "cli".
  const binary = config.agents[agentName].cli ?? config.agents[agentName].command.trim().split(/\s+/)[0]
  const found = await sh(box, `command -v ${binary} && ${binary} --version`, { allowFailure: true })
  if (found.code !== 0) {
    throw new Error(`"${binary}" is not installed in this Box. It has to go into a worker image (worker/setup.sh, Stage 6). Build that image, then run this test again: it will start from the image. To find the right install command first, run this with --keep and try it by hand with scripts/box-exec.mjs ${name} "<install command>".`)
  }
  console.log(`Agent CLI found:\n${found.output}`)

  await signIn(box, config, agentName)
  await writeJobFiles(box, config, agentName)
  const result = await runAgent(box, config, agentName, {
    workDir: "/workspace/home/smoke",
    jobDir: "/workspace/home/smoke/.job",
    prompt: "Reply with exactly: BOX OK",
    timeoutMinutes: 5,
  })
  console.log(`\nExit code ${result.code} after ${result.minutes} min`)
  console.log(`Summary file: ${result.summary || "(empty)"}`)
  console.log(`Log tail:\n${result.log}`)
  passed = result.code === 0 && `${result.summary}\n${result.log}`.includes("BOX OK")
  if (passed && !result.summary.includes("BOX OK")) {
    console.log('\nNOTE: the reply reached the log but not the summary file. Fix the agent "command" so the final reply lands in {summary}, or pull request descriptions will be empty.')
  }
} catch (error) {
  console.error(`\n${error.message}`)
} finally {
  // q(), not a hand-written `'${p}'`: a config path with an apostrophe would break the quotes and rm -rf would hit the wrong path.
  await sh(box, `rm -rf /workspace/home/smoke ${secretPaths(config).map(q).join(" ")}`, { allowFailure: true }).catch(() => {})
  if (keep) {
    await box.pause()
    console.log(`\nPaused Box ${name} (${box.id}). It still counts toward the Box limit.`)
  } else {
    await box.delete()
    console.log(`\nDeleted Box ${box.id}.`)
  }
}

console.log(passed ? "\nPASS: the agent answered from inside a Box." : "\nFAIL: see the output above.")
process.exitCode = passed ? 0 : 1
