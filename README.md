# create-ant-factory

A skill that builds a software factory: label a GitHub issue with `ready`, a coding agent implements it inside a Docker container on your own machine, and a pull request comes back for review. (Upstash Box is still available when you'd rather not run a host.)

## Quickstart (Docker, the default)

In the factory repo (the copied template):

1. Build the worker image: `docker build -f worker/Dockerfile -t create-ant-factory-worker:latest .`
2. Copy `.env.example` to `.env` and fill in the two tokens below.
3. `node --env-file=.env scripts/check-setup.mjs` — verifies the Docker daemon, the image, and a smoke container. It must pass before the factory counts as set up.
4. Install the trigger in an app repo (`node scripts/install-trigger.mjs`), label an issue `ready`, and watch the PR come back.

## Contents

- `SKILL.md` — the full workflow (Stages 0–9): interview, scaffold, secrets, smoke test, trigger dry run, worker image, first run, scale test, handover.
- `assets/template/` — working factory implementation to copy into a new factory repo: `factory.config.json`, `scripts/`, `src/`, `.github/workflows/factory.yml`, `templates/`, `worker/setup.sh`.
- `references/` — `architecture.md`, `config.md`, `agents.md`, `providers.md`, `upstash-box.md`, `worker-image.md`, `pitfalls.md`.
- `.env.example` — the secrets every factory needs (values stay local, never committed).
- `evals/` — skill checks for maintainers: `node evals/validate-skill.mjs` (frontmatter, referenced paths, template wiring, trigger cases; offline) and `node evals/trigger-evals.mjs` (model-graded trigger tests, needs `ANTHROPIC_API_KEY`). See `evals/README.md`; `evals/skill-ci.example.yml` wires both into CI.

## Use

Copy this folder into your agent's skills directory (e.g. `<skills-dir>/create-ant-factory`) or point your agent at this repo. The skill tells the agent to adapt the template instead of inventing a pipeline, to work stage by stage, and to keep notes under `docs/` in the factory repo.

Requires on the user's machine: Node 20.6+, git, GitHub CLI `gh` with `repo` + `workflow` scopes.

## The two tokens (Docker quickstart)

See `.env.example`. The user creates each one and puts values in a local `.env` (ignored by git):

1. `FACTORY_GITHUB_TOKEN` — fine-grained token covering the factory repo and every app repo (Contents, Pull requests, Issues: read + write).
2. `CLAUDE_CODE_OAUTH_TOKEN` — from `claude setup-token` (subscription) or `ANTHROPIC_API_KEY`. Other agents (e.g. Codex) use their own secret per `references/agents.md`.

A third token, `UPSTASH_BOX_API_KEY` (Upstash console, Box section), is only needed when `worker.provider` is `"box"`; likewise `DAYTONA_API_KEY` (Daytona dashboard) only when it is `"daytona"`, and `E2B_API_KEY` (E2B dashboard) only when it is `"e2b"` (one cloud sandbox per job in either case). See `references/providers.md` for choosing.

`node --env-file=.env scripts/check-setup.mjs` verifies setup without printing values.

## Docs

Upstash Box: https://upstash.com/docs/box/overall/quickstart — Claude Code: https://code.claude.com/docs — Codex: https://developers.openai.com/codex
