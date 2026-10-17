# Worker providers: Box or Docker

A worker is wherever one job's agent actually runs. `worker.provider` in
`factory.config.json` chooses it. Upstash Box is the default, and nothing
changes for an existing factory until somebody sets `"docker"`.

```json
"worker": { "provider": "box" }
```

```json
"worker": {
  "provider": "docker",
  "docker": { "image": "create-ant-factory-worker:latest", "cpus": "2", "memory": "4g" }
}
```

| | Box (`"box"`, default) | Docker (`"docker"`) |
|---|---|---|
| Where it runs | Upstash's cloud, one named Box per worker | One container per job on a Docker host you control |
| Idle workers | Paused Boxes (they still count toward the plan limit) | Nothing: no container exists between jobs |
| Claiming | Box labels (`busy`, `run-<id>`) are the shared state | A running container labelled `worker=<id>` is the busy marker |
| Worker image | A Box snapshot (`worker/setup.sh` + `build-snapshot.mjs`) | `worker/Dockerfile`, built with `docker build` |
| Browser | Upstash Chromium, if `factory.browser` is on | No built-in browser; install one in the image if the agent needs it |
| Cleanup | Sign-in files deleted, Box paused, workspace wiped next job | Container removed (`docker rm -f`) at the end, success or failure — workspace and sign-in files go with it |
| Best for | Not running a host at all | Your own repos on a machine/VPC you already run, predictable cost, keeping code on your network |

Pick Box unless there is a reason. Pick Docker when the work must stay on
your own host or network, or when a paused-Box pool does not fit how you
want to pay. Do not pick Docker to run other people's code: see the
isolation caveat below.

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

It removes every factory container labelled `worker=<id>`; removing a
container is the whole cleanup, the workspace and every sign-in file go
with it. By hand it is:

```bash
docker ps --filter label=create-ant-factory=true
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

## Future providers

Daytona, E2B and similar sandboxes would slot in behind the same seam
used here: a provider that starts one isolated workspace per job, exposes
shell + file-write to it, reports busy workers, and removes the workspace
at the end (`src/docker.mjs` is the worked example). They are not
implemented; do not add config for them until one is.
