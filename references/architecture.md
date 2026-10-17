# Architecture

## Contents

- Components
- What happens for one issue
- Label states
- How a worker is claimed
- File map
- Diagrams for the README

## Components

| Part | Where it lives | Job |
|---|---|---|
| Trigger workflow | `.github/workflows/factory-ready.yml` in each app repo | On the `labeled` event, if the label is `ready` and the actor is allowed, send `repository_dispatch` (`issue-ready`, with repo and issue number) to the factory repo. |
| Factory workflow | `.github/workflows/factory.yml` in the factory repo | Receives the event, runs `src/plan.mjs` then `src/run.mjs` on a GitHub-hosted runner. One run per issue at a time. |
| Coordination code | `src/` in the factory repo | Picks and claims a worker, drives the worker's sandbox, talks to GitHub. |
| Workers | One Docker container per job (default), or named Upstash Boxes `<prefix><worker id>` with `"provider": "box"` | Where the agent runs. Containers are removed when the job ends; Boxes are paused when idle. |
| Config | `factory.config.json` | Repos, checks, workers, agent types with their model and effort settings and image/snapshot ids, labels, allowed actors. |

GitHub Actions cannot trigger across repos on label events. That is why each app repo needs the small trigger workflow, and why the app repo needs a secret holding a token that can write to the factory repo.

The GitHub runner does the orchestration and holds the secrets. The worker sandbox only does the work. The runner is idle most of the time, waiting on the Box. It is still held, and in private repos billed, for the whole run, including the wait for a free worker.

## What happens for one issue

1. Check the issue is open and carries `ready`. If not, stop. This is what makes a duplicate run harmless. A manual run by someone outside `allowedActors` is refused, and an `agent:` label that no enabled worker serves hands the issue back at once.
2. Claim a free worker (see below). With the Box provider, create its Box if missing and resume it if paused; with Docker, start its one-job container.
3. On the issue: remove `ready`, add `factory:running`, comment with the worker name and a link to the run.
4. In the worker's sandbox: delete the old workspace and any saved git credentials, clone the repo with the token in the URL and git's credential helper switched off, reset the remote URL to the token-free one, create the branch `factory/issue-N`, set the git author from the config, add the repo's `exclude` patterns, run the repo's setup commands as one bash login script. A failing setup hands the issue back as a factory problem and the agent is not started.
5. Write the agent's sign-in files and its `jobFiles`, then run the agent in the background. Its prompt holds the issue's title, body and the comments written by the issue's author or someone on `allowedActors` (other people's comments are left out), plus the factory's rules, which win over any house rules file. Poll until it exits or times out. The model and effort are already in the worker's settings.
6. Decide:
   - agent exit code not zero: needs attention, with the log tail
   - reply starts with `NEEDS_CLARIFICATION:`: needs attention, with the question
   - a check fails: give the agent one more run with the failure output, then check again. Still failing: needs attention
   - no files changed: needs attention
7. Commit, push the branch with `--force` (a re-run replaces the old attempt), open or update the PR with `Closes #N` and the agent's summary.

   **Resume-from-review** (`factory.resumeFromReview: true`, `src/review.mjs`): when the branch already has an open PR, the run revises it instead. Step 4 clones that branch rather than the base; the prompt says to revise the earlier attempt and adds the trusted review feedback (reviews, inline comments with file and line, PR conversation, from `allowedActors` and the issue author only, and only what came after the factory's last "Revised after review" reply) and the failing check runs on the PR's head commit, capped to the newest 8000 characters. Step 7 becomes a normal push (no `--force`) of an "Address review feedback" commit; a rejected push hands the issue back instead of overwriting anyone's commits. The factory then replies on the PR with the agent's summary, and step 8 runs as usual. No feedback and no failing checks means needs attention: there is nothing to revise.
   **Risk gate** (`factory.riskGates`, `src/gates.mjs`): before step 7 commits, the factory computes ready / draft / needs-attention from the staged paths, `git diff --numstat` size, whether checks exist, the repo's `tier`, the issue's labels and text, and failed precedents on the same files. Draft and needs-attention open the PR as a draft; needs-attention then parks the issue at `factory:needs-attention` (reason `risk-gate`) instead of step 8. The agent's reply is not an input.
   **Independent review** (`factory.reviewer`, `src/reviewer.mjs`): after the risk gate and before step 7, a second, fresh agent session (another agent type when an enabled worker has one) reviews the staged diff against the issue, the plan, the `decisions[]` trace and the precedents used, and writes `review.md`; it never sees the author's reply and must change no file (the factory snapshots the staged tree and restores it exactly otherwise). Findings at or above `blockOn` turn the decision into needs-attention (reason `review-blocked`), merged with the risk gate so the strictest wins; a reviewer that fails parks the issue too (`onError`, reason `review-error`).
8. On the issue: remove `factory:running`, add `factory:review`, comment with the PR link.
9. Always, in `finally`: delete the sign-in files and release the worker — with Box, remove the busy label and pause the Box; with Docker, remove the container.
10. Always, last: write the run record (`src/record.mjs`, unless `factory.runRecords` is `false`) to `runs/run-<id>.json` and the job summary. The workflow's `if: always()` step uploads it as an artifact, so failed and timed-out runs are counted too. `scripts/report.mjs` turns downloaded records into a report.

The agent is told not to commit, push, touch git settings or edit `.github/`. The factory does the git work so that the token is never available to the agent, and before it commits it refuses any change under `.github/` (`src/changes.mjs`): the issue gets the needs-attention label and nothing is pushed, because a workflow pushed with the factory token would run with the app repo's secrets.

## Label states

```
(none) --user adds--> ready --factory--> factory:running --+--> factory:review ---merge PR---> closed by "Closes #N"
                        ^                                  |
                        |                                  +--> factory:needs-attention
                        +------------- user fixes the issue and re-adds ready ------------+
```

`agent:<name>` is an optional label the user adds before `ready` to force an agent type. The factory reads labels at the moment the run starts.

## How a worker is claimed

There is no database. The busy marker lives on the provider: with Box, labels are the shared state, because every run can read and write them through the Upstash API; with Docker, a running container labelled `worker=<id>` is the busy marker (see `providers.md`).

- A worker is **busy** when its Box has the `busy` label (Box), or when its container is running (Docker).
- Which agent type takes an unlabelled issue: the highest `priority` with a free worker, then the smaller share of busy workers.
- Runs that start together would all pick the same worker, so the pick starts at an offset derived from the run id.
- With Box, each run also adds its own `run-<GitHub run id>` label. After adding its labels, a run waits four seconds and lists the Box's labels again. If another `run-` label sorts lower than its own, it lost: it removes its own run label and tries another worker. A Box holds at most five labels; if adding a label fails, treat that as losing too. (Docker has no equivalent: one container per job, and a lost race fails on the container name.)
- No free worker: sleep 30 seconds and look again, up to `waitForWorkerMinutes`.

Two things make this safe enough without locks: the workflow's `concurrency` group allows one run per issue, and with Box every worker Box is created ahead of time by `provision-workers.mjs`, so runs never race to create the same Box name.

If a run is cancelled or the runner dies, `finally` does not run and the worker stays busy. `scripts/release-worker.mjs` clears it.

## File map

```
factory.config.json          everything a user edits
src/config.mjs               load and validate the config
src/workers.mjs              worker states and the pick
src/box.mjs                  sh() and runScript(), Box settings, create/claim/release a worker (Box provider; Docker goes through src/docker.mjs)
src/docker.mjs               Docker provider: one container per job behind the same exec/files handle (worker.provider: "docker")
src/agents.mjs               secrets, sign-in files, jobFiles and the agent run
src/github.mjs               issues, labels, comments, pull requests
src/plan.mjs                 dry run: what would happen for this issue
src/run.mjs                  the job, start to pull request
src/record.mjs               run records and the report math (pass rate, time to PR, rework)
scripts/check-setup.mjs      tools, config, secrets, token reach, provider checks (Box key / Docker host). Read-only
scripts/smoke-test.mjs       one worker, one agent, "BOX OK"
scripts/install-trigger.mjs  labels and trigger PRs in the app repos
scripts/set-secrets.mjs      .env to GitHub Actions secrets
scripts/provision-workers.mjs  create missing workers (Box: paused Boxes; Docker: nothing to pre-create, containers are per-job)
scripts/build-snapshot.mjs   build a worker image (per agent type, or --shared)
scripts/apply-box-settings.mjs  write changed model and effort settings into existing Boxes
scripts/status.mjs           who is free, who is busy
scripts/report.mjs           markdown or JSON report from downloaded run records
scripts/release-worker.mjs   free a stuck worker
scripts/delete-workers.mjs   delete worker Boxes, Box provider (user runs this)
scripts/box-exec.mjs         run one command in a worker's Box (Box provider)
scripts/list-boxes.mjs       every Box on the account (Box provider)
scripts/create-demo-issues.mjs  test issues, unlabelled by default
templates/factory-ready.yml  trigger workflow with placeholders
worker/setup.sh              what goes into the worker image
```

## Diagrams for the README

Mermaid renders on GitHub. In a `sequenceDiagram`, do not name a participant `Box`, `box` is a reserved word and the diagram fails to parse. Use an id like `Worker` with the display name you want.

```mermaid
flowchart LR
    You([You]) -->|add the ready label| Issue[Issue in an app repo]
    Issue --> Factory[Software Factory]
    Factory -->|picks a free worker| W[Agent in a worker sandbox]
    W -->|writes the change| PR[Pull request]
    PR -->|review and merge| You
```

```mermaid
sequenceDiagram
    actor You
    participant App as App repo
    participant Factory as Factory repo
    participant Worker as Worker sandbox

    You->>App: Add the ready label to an issue
    App->>Factory: Trigger workflow sends repo name and issue number
    Factory->>Factory: Factory workflow starts and claims a free worker
    Factory->>Worker: Start the worker and hand it the issue
    Worker->>Worker: Agent writes the change, factory runs the checks
    Worker->>App: Push a branch and open a pull request
    You->>App: Review and merge
```
