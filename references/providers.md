# Worker providers: Docker, Box, Daytona or E2B

A worker is wherever one job's agent actually runs. `worker.provider` in
`factory.config.json` chooses it. Docker is the default for new factories:
free, local, and the code never leaves your machine. Upstash Box remains
for when you'd rather not run a host at all. Daytona runs one cloud
sandbox per job, created and deleted like a Docker container (see
"Daytona" below), and E2B does the same on E2B's sandboxes (see "E2B").

```json
"worker": {
  "provider": "docker",
  "docker": { "image": "create-ant-factory-worker:latest", "cpus": "2", "memory": "4g" }
}
```

```json
"worker": { "provider": "box" }
```

| | Docker (`"docker"`, default) | Box (`"box"`) |
|---|---|---|
| Where it runs | One container per job on a Docker host you control | Upstash's cloud, one named Box per worker |
| Idle workers | Nothing: no container exists between jobs | Paused Boxes (they still count toward the plan limit) |
| Claiming | A running container labelled `worker=<id>` is the busy marker | Box labels (`busy`, `run-<id>`) are the shared state |
| Worker image | `worker/Dockerfile`, built with `docker build` | A Box snapshot (`worker/setup.sh` + `build-snapshot.mjs`) |
| Browser | No built-in browser; install one in the image if the agent needs it | Upstash Chromium, if `factory.browser` is on |
| Cleanup | Container removed (`docker rm -f`) at the end, success or failure — workspace and sign-in files go with it | Sign-in files deleted, Box paused, workspace wiped next job |
| Best for | Your own repos on a machine/VPC you already run, predictable cost, keeping code on your network | Not running a host at all |

Pick Docker unless there is a reason. Pick Box when you'd rather not
run a host at all, or when a paused-Box pool fits how you want to pay
better than per-job containers. Do not pick Docker to run other people's
code: see the isolation caveat below.

## Docker setup

1. Put a Docker host where the factory run can reach it. That is the
   machine running `src/run.mjs` (a GitHub-hosted runner usually cannot
   reach a private host, so this pairs with a self-hosted runner or a
   local run), or set `DOCKER_HOST` (for example
   `DOCKER_HOST=tcp://10.0.1.20:2376`, with TLS) or a `docker context`
   for a remote host. The factory never sets the host itself; the docker
   CLI's own `DOCKER_HOST`/context decides. Optionally pin it in config with `worker.docker.host` (one endpoint, e.g. `"tcp://10.0.1.20:2376"`); a configured host wins over `DOCKER_HOST`.
2. Build the worker image:
   `docker build -f worker/Dockerfile -t create-ant-factory-worker:latest .`
   Add toolchains to `worker/Dockerfile` the way `worker/setup.sh` adds
   them to a Box (`references/worker-image.md`); keep its final check.
3. Set `worker.provider` to `"docker"` and the image/limits under
   `worker.docker` in `factory.config.json`.
4. Verify the target host at setup time: `node --env-file=.env scripts/check-setup.mjs`.
   With the Docker provider it runs the full verification (below) against
   the configured host — not just "a docker CLI exists here" — and skips
   the Upstash key/Box checks. `src/plan.mjs` prints the exact `docker run`
   command it would use, and starts nothing.
5. `UPSTASH_BOX_API_KEY` is not needed with this provider.

## Verifying Docker: at setup, and any time later

One implementation (`verifyDocker()` in `src/docker.mjs`) serves both
moments, always against the configured target (`worker.docker.host`, else
`DOCKER_HOST` / docker context):

- **At creation/setup time**, `scripts/check-setup.mjs` runs it. Do not
  treat the factory as set up until it passes with `provider: "docker"`.
- **On demand, any time after**, run:
  `node --env-file=.env scripts/verify-docker.mjs`
  (also `npm run verify-docker`). Add `--pull` to pull the worker image
  first if it is missing; without it the script changes nothing except
  one self-removing smoke container.

Each check prints one `ok` / `FIX` line and the command exits non-zero on
any failure:

1. docker CLI present (and which target it will talk to),
2. daemon reachable there (`docker version`),
3. host CPU/RAM sane against `worker.docker` limits, plus docker disk use,
4. worker image present (or pullable with `--pull`; otherwise the exact
   `docker build` / `docker pull` commands to run),
5. smoke: `docker run --rm <image> true` exits 0, with the same limits and
   no published ports / no Docker socket,
6. running factory containers are listed (none between jobs is normal).

Run it after building or rebuilding the worker image, after a VPS reboot
or Docker upgrade, after changing the host/`DOCKER_HOST`, and whenever a
job fails to claim a Docker worker — it separates "host is down" from
"agent is broken" in one pass.

Secrets reach the job the same way as with a Box: they are written inside
the running container at job time (agent sign-in and repo env files,
mode 600), never baked into the image and never placed in the
`docker run` arguments, where `docker inspect` would show them.

## Network shape (VPC note)

Run the Docker host in a private subnet. It needs egress only to:

- GitHub (cloning, pushing, the API),
- the model/agent APIs or subscription endpoints your agent CLIs use,
- the container registry you pull the worker image (and base images) from.

No inbound ports: the factory publishes none (`docker run` gets no `-p`),
and the containers need none. Keep the Docker daemon's own port, if you
use `DOCKER_HOST=tcp://…`, inside the private network with TLS — never
expose an unauthenticated daemon port. There is deliberately no Terraform
or cloud networking in the template; this is the shape to build, in
whatever tool owns the VPC.

## Cleanup and stuck containers

Normal cleanup is automatic: `releaseWorker` removes the container in the
`finally` of every run. After a killed runner a container can survive. Free
the worker (and remove its stuck containers) with the same script the Box
provider uses:

```bash
node --env-file=.env scripts/release-worker.mjs <worker id>
```

It removes every factory container labelled `worker=<id>`, running or
stopped; removing a container is the whole cleanup, the workspace and every
sign-in file go with it. A stopped one matters too: after a Docker host
reboot or an OOM kill the job container exits without being removed, so the
worker shows as free but the container still holds that job's sign-in files.
By hand it is:

```bash
docker ps -a --filter label=create-ant-factory=true
```

and remove a stuck one with `docker rm -f <name>`. Container names are
`<boxNamePrefix><worker id>-<run id>`. Images are yours to prune
(`docker image prune`); the factory never builds or deletes images.

## Isolation caveat

Docker containers share the host kernel. `no-new-privileges`, CPU/memory
limits and one-container-per-job removal reduce the blast radius, but a
container is not a VM and not a multi-tenant sandbox — and this factory
runs agents with broad permissions inside it, by design. That is a
reasonable trade for **your own repos on your own host**. For untrusted
code or other people's repos, use the Box provider (or a stronger
sandbox), not this one. Never mount `/var/run/docker.sock` into the
worker container: that is root on the host. The factory's generated
`docker run` never does, and the tests assert it stays that way.

## Daytona

```json
"worker": {
  "provider": "daytona",
  "daytona": { "snapshot": "create-ant-factory-worker", "target": "us" }
}
```

One Daytona sandbox per job, through Daytona's public REST API
(`src/daytona.mjs`; no SDK dependency, the HTTP layer is a thin injectable
`fetch`). It is the Docker shape in someone else's cloud: nothing exists
between jobs, a running sandbox labelled `worker=<id>` is the busy marker,
and the sandbox is deleted at the end of the job, success or failure. A
GitHub-hosted runner can reach it, so it needs no self-hosted runner.

Setup:

1. Create an API key in the Daytona dashboard and put it in `.env` as
   `DAYTONA_API_KEY`. `scripts/set-secrets.mjs` copies it to the factory
   repo's secrets when the provider is `"daytona"`; the workflow passes it
   through, plus the optional repository variables `DAYTONA_API_URL`
   (self-hosted Daytona) and `DAYTONA_TARGET` (region). The key never goes
   in `factory.config.json` and is never sent into a sandbox.
2. Turn the worker image into a Daytona snapshot (Daytona expects
   `linux/amd64`):
   `docker build --platform=linux/amd64 -f worker/Dockerfile -t create-ant-factory-worker:latest .`
   then `daytona snapshot push create-ant-factory-worker:latest --name create-ant-factory-worker`
   (add `--cpu`, `--memory`, `--disk` to size the sandboxes). Set
   `worker.daytona.snapshot` to that name. Without a snapshot, sandboxes
   start from Daytona's default image, which has no agent CLIs.
3. `node --env-file=.env scripts/check-setup.mjs` verifies the key (it must
   list sandboxes), the API URL and that the snapshot is `active`. It creates
   nothing. `src/plan.mjs` prints the exact create request and calls nothing.

What a job does: `POST /sandbox` (snapshot, target, labels
`create-ant-factory=true`, `worker`, `run-id`, `env.HOME=/workspace/home`,
`public: false`, `autoStopInterval`, `autoDeleteInterval: 0`), waits for
state `started`, then drives it with the toolbox API (`process/execute`
for every command, `files/upload-v2` for prompt and sign-in files), exactly
the two primitives a Box offers. The sandbox is deleted if it fails to
start or its workspace cannot be prepared, and always when the job ends.

Cleanup: `scripts/release-worker.mjs <worker id>` deletes every factory
sandbox of that worker, running or stopped. One a killed runner left behind
also cleans itself up: it stops after `autoStopMinutes` idle and, being
created with `autoDeleteInterval: 0`, is then deleted. The Box-only scripts
(`provision-workers`, `delete-workers`, `smoke-test`, `build-snapshot`,
`apply-box-settings`, `box-exec`) refuse to run under Daytona.

Not there yet: no Upstash-style browser (install one in the snapshot if the
agent needs it), and resources come from the snapshot (`daytona snapshot
push --cpu/--memory/--disk`), not from `factory.config.json`.

## E2B

```json
"worker": {
  "provider": "e2b",
  "e2b": { "template": "create-ant-factory-worker", "timeoutMinutes": 30 }
}
```

One E2B sandbox per job, through E2B's public REST API and the sandbox's
own daemon (envd) (`src/e2b.mjs`; no SDK dependency, the same thin
injectable-`fetch` layer as Daytona). Same Docker shape again: nothing
exists between jobs, a running sandbox whose metadata says `worker=<id>` is
the busy marker, and the sandbox is killed at the end of the job, success
or failure. A GitHub-hosted runner can reach it, so no self-hosted runner.

Setup:

1. Create an API key in the E2B dashboard and put it in `.env` as
   `E2B_API_KEY`. `scripts/set-secrets.mjs` copies it to the factory repo's
   secrets when the provider is `"e2b"`; the workflow passes it through,
   plus the optional repository variables `E2B_DOMAIN` and `E2B_API_URL`
   (self-hosted E2B). The key never goes in `factory.config.json` and is
   never sent into a sandbox.
2. Build the worker image as an E2B template from `worker/Dockerfile`,
   with the E2B CLI (`e2b template build --dockerfile worker/Dockerfile
   --name create-ant-factory-worker`) or the E2B Template SDK
   (`Template().fromDockerfile(...)`, then `Template.build`). Set
   `worker.e2b.template` to its name or id. Left out, sandboxes start from
   E2B's public `base` template, which has no agent CLIs. CPU and memory
   come from the template.
3. `node --env-file=.env scripts/check-setup.mjs` verifies the key (it must
   list sandboxes), the API and that the template exists on your team and is
   `ready`. It creates nothing. `src/plan.mjs` prints the exact create
   request and calls nothing.

What a job does: `POST /v2/sandboxes` (`templateID`, `timeout`,
`autoPause: false`, metadata `create-ant-factory=true`, `worker`, `run-id`,
`name`), then drives the sandbox through envd at
`https://49983-<id>.<domain>` with the per-sandbox access token from the
create response: `process.Process/Start` (a Connect stream; each command
runs as `/bin/bash -l -c`, with `HOME=/workspace/home`) and `POST /files`
for prompt and sign-in files. Those are exactly the two primitives a Box
offers. The sandbox is killed if its workspace cannot be prepared, and
always when the job ends.

Timeout, the E2B way: an E2B sandbox lives for `timeout` seconds and is
then killed. The factory makes that a sliding deadline: every command the
job sends first extends it to `timeoutMinutes` from now (at most once a
minute; `runScript` polls every 10 s, so a long agent run keeps it alive).
A sandbox a killed runner left behind therefore dies on its own within
`timeoutMinutes`, default 30. E2B caps the value by plan (1 hour on Hobby, 24 hours
on Pro); the loader accepts 1 to 1440.

Cleanup: `scripts/release-worker.mjs <worker id>` kills every factory
sandbox of that worker, running or paused. The Box-only scripts
(`provision-workers`, `delete-workers`, `smoke-test`, `build-snapshot`,
`apply-box-settings`, `box-exec`) refuse to run under E2B.

Not there yet: no Upstash-style browser (install one in the template if the
agent needs it), and resources come from the template, not from
`factory.config.json`.

## Future providers

Other sandboxes slot in behind the same seam: a provider that starts one
isolated workspace per job, exposes shell + file-write to it, reports busy
workers, and removes the workspace at the end (`src/docker.mjs`,
`src/daytona.mjs` and `src/e2b.mjs` are the worked examples). Do not add
config for one until it is implemented.
