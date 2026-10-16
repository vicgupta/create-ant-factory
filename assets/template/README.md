# Software Factory

Put a `ready` label on a GitHub issue. A coding agent picks it up inside an Upstash Box, makes the change and opens a pull request. You review it and merge it yourself.

Repos, workers and agent types are listed in [factory.config.json](factory.config.json). Workers run in Upstash Boxes by default; set `"worker": { "provider": "docker", ... }` there to run each job in a Docker container on your own host instead (build `worker/Dockerfile` first).

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
- `agent:<name>` — optional. Put this on before `ready` to force a specific
  agent type. The factory reads labels at the moment the run starts.

```
(none) --you add--> ready --factory--> factory:running --+--> factory:review --merge PR--> closed
                                                        |
                                                        +--> factory:needs-attention
                                                        (fix the issue, re-add ready)
```

## Everyday commands

```bash
node --env-file=.env scripts/status.mjs
```

```bash
node --env-file=.env scripts/release-worker.mjs <worker id>
```

```bash
node --env-file=.env scripts/apply-box-settings.mjs
```

The first shows who is free and who is busy. The second frees a worker that a cancelled run left marked busy. The third writes a changed model or effort setting into the Boxes that already exist.
