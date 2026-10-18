# Changelog

All notable changes to create-ant-factory are documented here. The format is
loosely "Keep a Changelog"; versions are git tags (`0.1`, `0.2`, …).

## Unreleased

## 0.3 — 2026-10-18

Twenty-one pull requests since 0.2 (#32–#52), each reviewed with its test
suite run before merge. Four worker providers (Box, Docker, Daytona, E2B),
a plan-first phase with risk-based human gates and an independent reviewer
pass, run records with a report, resume-from-review, scheduled scans, and a
skill-eval framework with a validator, trigger cases, and a CI template.

### Features

- Skill evals (`evals/`). `node evals/validate-skill.mjs` checks the SKILL.md
  frontmatter (kebab-case `name` up to 64 characters, `description` up to
  1024 with no angle brackets and a "use this when" sentence), that every
  path SKILL.md and README.md mention exists under `references/` or
  `assets/template/`, that every template `npm run` script and workflow
  `node` step points at a real file, and that `evals/trigger-cases.json` is
  well formed, with each positive case's `anchors` still present in the
  description. It is offline and dependency-free and exits 1 on any error
  (`--strict` fails on warnings too). `node evals/trigger-evals.mjs` asks a
  model to route each of the 13 cases among this skill and five distractor
  skills and fails below a 0.85 pass rate; without `ANTHROPIC_API_KEY` it is
  a dry run that sends nothing. `evals/skill-ci.example.yml` wires both into
  GitHub Actions (copy it to `.github/workflows/`). `evals/tests/` covers the
  linter, the CLIs and the eval runner with a fake model.

- E2B worker provider (`"worker": { "provider": "e2b" }`, opt-in; Box,
  Docker and Daytona behave exactly as before). `src/e2b.mjs` creates one
  E2B sandbox per job through E2B's public REST API (`POST /v2/sandboxes`,
  list by metadata, `DELETE` to kill) and drives it through the sandbox's
  envd daemon (`process.Process/Start` over Connect, `POST /files`), behind
  the same `exec.command()` / `files.write()` handle the other providers
  use, so `run.mjs`, `agents.mjs`, `sh()` and `runScript()` are unchanged.
  Settings live under `worker.e2b` (`template`, `timeoutMinutes`, `domain`,
  `apiUrl`), validated by the loader; the key is `E2B_API_KEY` only (a key
  in the config is refused), with optional `E2B_DOMAIN` / `E2B_API_URL`.
  Sandboxes are created with `autoPause: false` and a sliding timeout that
  every command extends, so a live job never expires and an orphan dies
  within `timeoutMinutes` (default 30). A sandbox whose workspace cannot be
  prepared is killed. `check-setup.mjs` requires the key and verifies it,
  the API and the template (read-only); `plan.mjs` prints the create
  request; `set-secrets.mjs` and the workflow pass the key through;
  `release-worker.mjs` kills a worker's leftover sandboxes; run records
  carry `provider: "e2b"`; the Box-only scripts refuse under E2B.
  `tests/e2b.test.mjs` pins every request shape, the Connect framing and
  the keep-alive with a fake `fetch`, without an E2B account.

- Daytona worker provider (`"worker": { "provider": "daytona" }`, opt-in;
  Box and Docker behave exactly as before). `src/daytona.mjs` creates one
  Daytona sandbox per job through Daytona's public REST API (create, wait
  for `started`, toolbox `process/execute` and `files/upload-v2`, delete),
  behind the same `exec.command()` / `files.write()` handle Box and Docker
  use, so `run.mjs`, `agents.mjs`, `sh()` and `runScript()` are unchanged.
  Settings live under `worker.daytona` (`snapshot`, `target`, `apiUrl`,
  `autoStopMinutes`, `startTimeoutMinutes`), validated by the loader; the
  key is `DAYTONA_API_KEY` only (a key in the config is refused), with
  optional `DAYTONA_API_URL` / `DAYTONA_TARGET`. A failed start deletes the
  sandbox; sandboxes are created `public: false` with
  `autoDeleteInterval: 0`, so an orphan stops when idle and deletes itself.
  `check-setup.mjs` requires the key and verifies it, the API and the
  snapshot (read-only); `plan.mjs` prints the create request;
  `set-secrets.mjs` and the workflow pass the key through;
  `release-worker.mjs` deletes a worker's leftover sandboxes; run records
  carry `provider: "daytona"`; the Box-only scripts refuse under Daytona.
  The HTTP layer takes an injectable `fetch`, and `tests/daytona.test.mjs`
  pins every request shape without a Daytona account.

- Scheduled scan template (`factory.scheduledScan`, off for existing configs;
  the template ships the block with `"enabled": false`). An optional
  `.github/workflows/scheduled-scan.yml` runs on a weekly cron (and
  `workflow_dispatch`) and calls `scripts/scheduled-scan.mjs`, which proposes
  **candidate** issues from TODO/FIXME/XXX/HACK markers under allowlisted
  paths and/or a `scripts/scan-candidates.json` list. Candidates get
  `factory:candidate` only — **never** the ready label — and each issue body
  states that a human still applies ready to start work. Dedupe skips open
  issues with the same title fingerprint, recently closed ones
  (`skipClosedDays`, default 30), and duplicates inside one run; `maxPerRun`
  caps filing. Pure helpers live in `src/scan.mjs` (fingerprint, plan,
  marker parse, label safety); the loader validates every key.
  `npm run scheduled-scan` dry-runs by default (`--yes` to create).

- Independent reviewer pass (`factory.reviewer`, off for existing configs;
  the template ships the block with `"enabled": false` because it adds one
  agent run to the timeout budget). After checks pass and the change is
  staged, `src/reviewer.mjs` runs a second, fresh agent session — another
  agent type of an enabled worker by default (`"agent": "auto"`) — that
  reviews the staged diff against the issue, the validated plan, the
  `decisions[]` trace and the precedents used, never the author's reply,
  and writes a line-based `review.md` of findings by severity. The factory
  decides from severities alone: findings at or above `blockOn` open a
  draft PR and park the issue (`review-blocked`); a reviewer that errors,
  times out, writes an invalid review or edits the repo parks it too
  (`onError`, `review-error`), and the staged change is snapshotted and
  restored exactly. The review merges with `riskGates` (strictest wins), is
  listed in the PR body and issue comment, stored on the run record
  (`review`, counts only), totalled by `report.mjs`, and counted by
  `check-setup.mjs` in the timeout sum. `scripts/review-check.mjs`
  (`npm run review-check`) validates a review file offline. The loader
  validates every key.
- Risk-based human gates (`factory.riskGates`, off for existing configs,
  shipped in the template; optional per-repo `tier`). After checks pass,
  `src/gates.mjs` computes ready / draft / needs-attention from touched
  paths, diff size, missing checks, tier, issue labels/text and failed
  precedents on the same files; the strictest rule wins and the agent's
  reply is never an input. Draft and needs-attention open draft PRs;
  needs-attention parks the issue (`risk-gate`). The decision is listed in
  the PR body and issue comment, stored on the run record (`gate`) and
  traced in `decisions[]`. `scripts/risk-gate.mjs` (`npm run risk-gate`)
  dry-runs a change from `git diff --numstat` or a file list. The loader
  validates every rule.
- Plan-first phase (`factory.planFirst`). A separate planning agent run
  writes `plan.md` (files to touch, acceptance criteria each mapped to a
  configured check or `manual-review`); the factory validates it
  (`src/plan-first.mjs`: safe relative files, never `.github/`, no invented
  check names, caps, no repo changes from the planning pass), posts it to
  the issue before implementation, and implements from it. The PR body
  ticks off criteria whose check passed; `manual-review` stays unticked.
  An invalid plan stops with `factory:needs-attention` / `plan-invalid`
  and nothing built. Revisions skip planning. Off by default for existing
  configs; the template turns it on, and `check-setup.mjs` counts the
  extra agent run in the timeout sum.
- Precedent-aware context bundle, the Context Graph (`factory.contextGraph`,
  off for existing configs, on in the template). Run records gain `labels`,
  `files`, a validated `decisions[]` trace and a `contextBundle` layer log.
  `scripts/precedents.mjs` builds a flat `precedents.json` keyed by labels
  and touched paths (exact matching, top 3, failed/rejected/reverted runs
  included; no embeddings or graph database). Runs inject short-term /
  long-term / reasoning layers into the plan and implementation prompts,
  refined by the plan's files once a plan exists. Plan `## Facts` carry
  provenance stamps (source file, base commit SHA, observing run id);
  stale stamps are flagged before coding, including on resume-from-review.
- Run records and a report (`factory.runRecords`, on by default). Every run
  writes `runs/run-<id>.json` (worker, provider, agent, minutes, check
  attempts, files changed, outcome and reason code; never logs or replies),
  adds it to the Actions job summary, and the workflow uploads it as an
  artifact even when the run fails. `scripts/report.mjs` (`npm run report`)
  aggregates downloaded records into pass rate, median time to PR and
  rework, per agent type and per provider.
- Resume-from-review mode (`factory.resumeFromReview`). Re-adding `ready` to
  an issue whose factory pull request is still open revises that pull
  request in place: the existing branch is checked out, trusted review
  feedback and failing check runs go into the prompt, the revision is a
  normal push (never `--force`), and the factory replies on the pull request
  before moving the issue back to `factory:review`. `plan.mjs` shows when a
  run would revise. Off by default for existing configs; the template turns
  it on.

### Fixed

- The three missed box-only scripts (`build-snapshot`, `apply-box-settings`,
  `box-exec`) now refuse first under the Docker provider with a pointer to
  `scripts/verify-docker.mjs`, like `provision-workers`, `delete-workers`
  and `smoke-test` already did. Without it, a Docker factory would have
  addressed a running container's name as an Upstash Box. The
  `requireBoxProvider` comment in `src/config.mjs` now names all six scripts
  so the list cannot go stale unnoticed again.

## 0.2 — 2026-10-17

Thirty-one pull requests since 0.1, each reviewed with its test suite run
before merge. The factory is materially harder to misconfigure, harder to
attack through its own inputs, and louder when something is wrong.

### Security

- Repo names are restricted to GitHub's character set and `git remote set-url`
  is quoted (#31). `factory.repo` and `repos[].repo` were interpolated unquoted
  into the generated trigger workflow and the remote URL — a quote, semicolon
  or `$(...)` in either place would have become shell code.
- The factory refuses to push an agent's changes under `.github/` (#26). A
  prompt telling the agent not to touch workflows is only a request; a workflow
  change pushed with the factory token would run with the app repo's secrets.
- Job secrets are redacted from PRs, comments and logs, and overlapping
  secrets are redacted longest-first so a short secret can't break up a longer
  one and leak its tail (#5, #12).
- Only trusted authors' issue comments reach the agent prompt, and every page
  of comments is read so the newest answer is never the one dropped (#4, #6).

### Configuration: fail fast at load

`loadConfig` now rejects bad configs with a clear message instead of failing
mid-run inside a claimed worker:

- `boxNamePrefix` must be a non-empty safe name (#16); `branchPrefix` must be
  non-empty and form a legal git branch name with the issue number appended
  (#11, #19); timeouts must be positive numbers (#11); `boxLimit` must be a
  positive whole number (#25).
- Label names must be non-empty, unique, and contain no single quotes (a quote
  would generate an invalid trigger workflow) (#15, #17).
- `allowedActors` entries must look like GitHub usernames — a typo'd name
  otherwise matches nobody and every manual run is silently refused (#17).
- Agent env keys, auth env names and repo secret env names must be shell
  identifiers, or the sourced env files fail inside the Box (#28).
- `setup`, `checks` and `exclude` must be lists of non-empty strings (#30).

### Robustness

- `claimWorker` keeps the run-id tail in the 20-character claim label, so two
  runs starting together can't compute the same label and share one Box (#21).
- The trigger workflow checks the actor case-insensitively (in Node, since
  GitHub expressions have no `lowercase()`) and refuses visibly instead of
  silently skipping (#7, #23).
- The agent's PR summary is capped at 60,000 characters before PR creation —
  past GitHub's 65,536-char body limit the creation 422'd after commit+push
  (#27). Issue comments in the prompt are capped at 8,000 chars, newest first
  (#13).
- `release-worker.mjs` frees stuck Docker workers, including stopped
  containers that still hold the job's sign-in files (#9, #22).
- `set-secrets.mjs` no longer requires the Box key for Docker-only factories
  (#24).
- Snapshot/smoke-test cleanup paths are quoted with `q()` instead of
  hand-written quotes, which broke on apostrophes (#29).

### Developer experience

- Template declares `engines: node >= 20.6` (#10); README documents the label
  lifecycle (#2); `secretPlan()` extracted as a pure, tested function (#24);
  `mergeBoxSetting()` extracted for testability (#18).
- Test coverage added for worker routing, secret lookup order, settings merge,
  shell-quoting round-trips, the trigger actor guard, the `.github/` refusal
  and repo command validation. The suite is green: 162/162 on main.

## 0.1 — 2026-09-28

Initial release: the agent-neutral create-ant-factory skill (SKILL.md,
stages 0–9), a working factory template (`factory.config.json`, scripts,
`src/`, workflows, worker image), references (architecture, config, agents,
upstash-box, worker-image, pitfalls), README and `.env.example`.
