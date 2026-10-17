# Software Factory

Put a `ready` label on a GitHub issue. A coding agent picks it up inside a Docker container on your own machine, makes the change and opens a pull request. You review it and merge it yourself.

Repos, workers and agent types are listed in [factory.config.json](factory.config.json). Workers run in Docker containers by default (build `worker/Dockerfile` first); set `"worker": { "provider": "box" }` there to use Upstash Boxes instead.

<!-- Stage 9 of the skill: still to add here are the architecture diagrams,
how to add a repo, a worker or an agent type. -->

## How to read the labels

The issue labels are the factory's status board. The factory moves them
itself; you only ever add `ready` (and optionally `agent:<name>`).

- `ready` — start a run. Put this on an issue and the factory picks it up.
  The factory removes it when the run starts.
- `factory:running` — a worker has claimed the issue and the agent is
  working. The issue comment names the worker and links the run.
- `factory:review` — the agent finished and opened (or updated) a pull
  request. The issue comment links the PR. Review it and merge it yourself;
  merging closes the issue through `Closes #N`.
- `factory:needs-attention` — something stopped the run: the agent exited
  non-zero, asked a clarifying question (`NEEDS_CLARIFICATION:`), the checks
  still failed after a retry, or nothing changed. Read the issue comments for
  the log tail or the question, fix the issue text if it was unclear, then
  re-add `ready` to run it again.
- Send a pull request back: review it on GitHub (request changes, leave
  inline comments), then re-add `ready` to the issue. With
  `"resumeFromReview": true` in `factory.config.json` (the template's
  default) the factory checks out the same branch, gives the agent your
  review and any failing checks, pushes a normal commit on top, replies on
  the pull request and moves the issue back to `factory:review`. Only
  feedback from `allowedActors` and the issue author is read.
- Plan first: with `"planFirst": true` in `factory.config.json` (the
  template's default) a new run starts with a planning pass. The agent
  writes `plan.md` (files to touch, acceptance criteria each mapped to one
  of the repo's checks or to `manual-review`), the factory validates it and
  posts it to the issue *before* anything is implemented, and the
  implementation works from that plan. An invalid plan stops the run to
  `factory:needs-attention` (`plan-invalid`) with nothing implemented. The
  pull request ticks off each criterion whose check passed;
  `manual-review` criteria stay unticked for you. Revision runs after a
  review skip planning — the review feedback is their plan. Set
  `"planFirst": false` to go straight to implementation. Planning costs
  one extra agent run.
- `agent:<name>` — optional. Put this on before `ready` to force a specific
  agent type. The factory reads labels at the moment the run starts.

```
(none) --you add--> ready --factory--> factory:running --+--> factory:review --merge PR--> closed
                      ^                                 |          |
                      +-------- review the PR, re-add ready -------+
                                                        |
                                                        +--> factory:needs-attention
                                                        (fix the issue, re-add ready)
```

## Everyday commands

How the factory is doing: every run leaves a small run record (worker,
provider, agent, minutes, check attempts, files changed, outcome) as a
`run-record-*` artifact and in the run's job summary. Pull them down and
report on them:

```bash
gh run download --pattern 'run-record-*' --dir runs
node scripts/report.mjs runs
```

The report gives the pass rate, the median time to a pull request and the
rework (revisions after review, runs that needed a second check attempt),
overall and per agent type and provider. Add `--json` for the numbers or
`--out report.md` to save it. Set `"runRecords": false` under `factory` to
turn records off.

```bash
node --env-file=.env scripts/status.mjs
```

```bash
node --env-file=.env scripts/release-worker.mjs <worker id>
```

```bash
node --env-file=.env scripts/apply-box-settings.mjs
```

With the Docker worker provider (`"worker": { "provider": "docker" }`), check the Docker host any time with:

```bash
node --env-file=.env scripts/verify-docker.mjs
```

The first shows who is free and who is busy. The second frees a worker that a cancelled run left marked busy. The third writes a changed model or effort setting into the workers that already exist.
