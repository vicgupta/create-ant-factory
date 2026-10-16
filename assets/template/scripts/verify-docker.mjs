// On-demand health check for the Docker worker provider. Re-runs the same
// verification check-setup runs at creation time (src/docker.mjs
// verifyDocker), against the configured Docker host, any time the owner
// wants it: after building the image, after a host reboot or Docker
// upgrade, after changing DOCKER_HOST, or when jobs fail to claim a worker.
//
//   node --env-file=.env scripts/verify-docker.mjs          health check
//   node --env-file=.env scripts/verify-docker.mjs --pull   pull the worker image first if it is missing
//
// Read-only except --pull and the one `docker run --rm <image> true` smoke
// container, which removes itself. Exit code 1 when anything fails.
import { loadConfig, workerProvider } from "../src/config.mjs"
import { verifyDocker } from "../src/docker.mjs"

const config = loadConfig()
if (workerProvider(config) !== "docker") {
  console.log('worker.provider is not "docker", so there is no Docker host to verify. This script only applies to the Docker provider.')
  process.exit(0)
}

let problems = 0
const ok = (text) => console.log(`  ok    ${text}`)
const bad = (text) => (problems++, console.log(`  FIX   ${text}`))
const note = (text) => console.log(`  note  ${text}`)

console.log("Docker worker provider")
const result = await verifyDocker(config, { pullIfMissing: process.argv.includes("--pull") })
for (const check of result.checks) {
  if (check.status === "ok") ok(check.message)
  else if (check.status === "fail") bad(check.message)
  else note(check.message)
}
console.log(problems ? `\n${problems} thing(s) to fix.` : `\nAll good. Docker at ${result.target} can run factory workers.`)
process.exitCode = problems ? 1 : 0
