# Changelog

All notable changes to create-ant-factory are documented here. The format is
loosely "Keep a Changelog"; versions are git tags (`0.1`, `0.2`, …).

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
