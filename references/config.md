# factory.config.json

Every key, what it does, and whether it is required. `src/config.mjs` validates the file and explains what is wrong. The template ships with placeholders (`OWNER`, `"ask"`) that the loader or the Box-creating scripts refuse, so nothing runs on values nobody chose.

## factory

| Key | Required | Meaning |
|---|---|---|
| `repo` | yes | `owner/name` of the factory repo. The trigger workflows send their event here. |
| `boxNamePrefix` | yes | Every Box is named `<prefix><worker id>`. Pick one nothing else on the Upstash account uses. Letters, digits, `.`, `_` and `-`, starting with a letter or digit; the loader rejects anything else. |
| `boxLabel` | yes | Label on every Box of this factory. At most 20 characters. The factory only ever lists Boxes with this label. |
| `busyLabel` | yes | Label a Box carries while it works on an issue. |
| `branchPrefix` | yes | Branches are `<prefix><issue number>`, for example `factory/issue-12`. Must be a non-empty string that forms a legal git branch name once the issue number is appended (no spaces or any of `~ ^ : ? * [ \`, no `..`, no `@{`), or the loader refuses the config. |
| `gitAuthor.name`, `gitAuthor.email` | yes | Author of the factory's commits. The address of a real person on the team, or preview hosts block the deployment. |
| `allowedActors` | yes | GitHub usernames that may start the factory, by label or by the "Run workflow" button. Each must look like a GitHub username (letters, digits, hyphens); the loader refuses anything else, because the names go into the generated trigger workflow and a typo'd one would otherwise silently match nobody. |
| `boxLimit` | no | The Upstash plan's Box limit, a positive whole number of Boxes. With it, `check-setup.mjs` works out whether the workers fit next to whatever else is on the account. |
| `browser` | no | Browser access for every Box the factory creates: a Chromium that Upstash runs, reachable as `box.browser` and shown in the Upstash console. Default `true`. It is fixed when a Box is created, and a Box made from a worker image gets whatever the Box the image was built in had. So changing it later means deleting the workers and rebuilding the image. See `upstash-box.md`. |
| `runRecords` | no | Run records. Default `true`. Every run writes `runs/run-<run id>.json` (worker, provider, agent, mode, run and agent minutes, check attempts, files changed, outcome and a short reason code such as `checks-failed`; never logs, prompts or the agent's reply), adds a table to the Actions job summary, and the workflow uploads the folder as a `run-record-<run id>-<attempt>` artifact kept 90 days. `scripts/report.mjs` aggregates downloaded records into pass rate, median time to PR and rework. `FACTORY_RUN_RECORD_DIR` changes the folder. Set `false` to write nothing. |
| `resumeFromReview` | no | Resume-from-review mode. Default `false`; the template sets `true`. With it on, re-adding `ready` to an issue whose factory pull request (`<branchPrefix><issue number>`) is still open revises that pull request instead of rebuilding it: the factory clones the existing branch, gives the agent the review comments, inline comments and failing check runs on the PR (only from `allowedActors` and the issue author), pushes normally without `--force`, and replies on the PR. With nothing to act on, or when the branch moved during the run, the issue goes to `factory:needs-attention`. Reading check runs needs the token's Checks read access; without it only the review comments are used. Off, a re-run force-pushes a fresh branch from the base, as before. |
| `planFirst` | no | Plan-first phase. Default `false`; the template sets `true`. With it on (new pull requests only; resume-from-review revisions skip it), a separate planning agent run first writes `plan.md` in the job folder listing files to touch and acceptance criteria, each mapped to one of the repo's configured `checks` copied exactly or to `manual-review`. The factory validates it as a pure function (`src/plan-first.mjs`: at least one safe relative file — never under `.github/` — and one criterion, no invented check names, size/count caps, and no repository changes from the planning pass), posts it to the issue before implementation, and puts it in the implementation prompt. An invalid plan, a planning error, or a `NEEDS_CLARIFICATION:` reply hands the issue to `factory:needs-attention` with reason `plan-invalid` (or the usual reasons) and nothing is implemented. The pull request body lists the criteria and ticks those mapped to a real check — they passed for the PR to open — while `manual-review` criteria stay unticked for the reviewer. It costs one extra agent run: `check-setup.mjs` counts three agent runs in the workflow-timeout sum. Off, a run goes straight to implementation as before. |
| `runtime` | no | Upstash Box runtime. Default `node`. Check the Box docs for other values, and re-run the smoke test if you change it, because other runtimes may not ship the agent CLIs. |
| `waitForWorkerMinutes` | no | How long a run waits for a free worker. Default 30. Must be a positive number. The runner is billed while it waits. |
| `agentTimeoutMinutes` | no | Limit for one agent run. Default 25. Must be a positive number. |
| `commandTimeoutMinutes` | no | Limit for a repo's setup, and for its checks. Default 20. Must be a positive number. |
| `imageBuildTimeoutMinutes` | no | Limit for `worker/setup.sh` during an image build. Default 30. Must be a positive number. |
| `snapshotId` | no | Shared worker image, written by `build-snapshot.mjs --shared`. |
| `imageCleanPaths` | no | Extra paths under `/workspace/home` to delete before a snapshot, such as the transcript folder of a third agent CLI. Claude Code's and Codex's are removed already. |
| `secretScanPatterns` | no | Extra text patterns (grep -E) that mark a secret, added to the built-in list used before a snapshot. |

Keep the workflow's `timeout-minutes` (150 in the template) above the worst case: waiting, setup, two agent runs (three with `planFirst`) and two rounds of checks. `check-setup.mjs` does that sum and complains when it does not fit. A run that the workflow limit kills skips its cleanup and leaves the worker busy.

## labels

`ready`, `running`, `review`, `needsAttention`: the issue label names. All required. `install-trigger.mjs` creates them in each app repo. None may contain a single quote: the ready label is written into a single-quoted workflow expression, and a quote would generate an invalid trigger workflow.

## agents

One entry per agent type. The name is 1 to 14 lowercase letters, digits or dashes, because each Box gets the label `agent-<name>` and issues use `agent:<name>`.

| Key | Required | Meaning |
|---|---|---|
| `command` | yes | Shell command that runs the agent without any prompt. `{prompt}` is a file with the task. `{summary}` is the file the final reply has to end up in. |
| `cli` | no | Name of the agent's executable, for the smoke test's "is it installed" check. Default: the first word of `command`. Set it when the command starts with something else, such as a variable assignment or `timeout`. |
| `priority` | no | A number. The agent type with the highest priority that has a free worker takes an unlabelled issue. Types without one count as 0. Among equals, the type with the smaller share of busy workers goes first. |
| `promptExtra` | no | Text added to the end of every task for this agent type. `{summary}` in it becomes the summary file's path. For a CLI that cannot deliver a clean final reply through the command line: "When you are done, write your summary to the file {summary}." |
| `auth` | no | Secrets placed in the Box before each job and removed after it. Each entry: `secret` (name of the GitHub secret and `.env` key), plus `env` (export as this variable) or `file` (write to this path in the Box). Optional `localFile`: where the value lives on the user's machine when it is not in `.env`. |
| `env` | no | Extra environment variables for the agent. Not secret. Every variable name here, and every `env` in `auth` and in a repo's `secrets`, must be a shell variable name (letters, digits and `_`, not starting with a digit); the config is rejected otherwise. |
| `boxSettings` | yes | The model and effort stored in the Box. `"ask"` until the user has been asked, `[]` for the CLI's own defaults, or a list of settings files. See `agents.md`. |
| `jobFiles` | no | Files from the factory repo copied into the Box at the start of every job: `{ "from": "worker/CLAUDE.md", "to": "/workspace/home/.claude/CLAUDE.md" }`. For house rules the user edits often. Read fresh each job, so no image rebuild is needed. |
| `setup` | no | This agent type's own image setup script. Default `worker/setup.sh`. |
| `snapshotId` | no | This agent type's worker image, written by `build-snapshot.mjs`. Wins over `factory.snapshotId`. |
| `description` | no | A note for humans. |

## repos

| Key | Required | Meaning |
|---|---|---|
| `repo` | yes | `owner/name`. Same owner as the factory repo, because one fine-grained token covers one owner. |
| `baseBranch` | yes | Branch that factory pull requests target, and that each job clones. It may differ from the repo's default branch. |
| `setup` | no | Commands that install dependencies, run after the clone. |
| `checks` | no | Commands that must pass before a pull request is opened. The agent gets one retry with the failure output. |
| `secrets` | no | Secrets the repo's own setup, tests and checks need: `{ "secret": "TEST_DATABASE_URL", "env": "DATABASE_URL" }`. The value comes from `.env` locally and from the factory repo's GitHub secrets in a run. They are written to their own file in the Box for the job and removed after it. The agent sees them too, since it runs the tests. |
| `exclude` | no | Patterns added to `.git/info/exclude` for the job, for things the setup creates inside the repo folder that the repo's `.gitignore` misses, such as `.venv/`. |

`setup`, `checks` and `exclude` are each a list of strings, even for one entry (`["npm ci"]`, not `"npm ci"`). `loadConfig()` refuses anything else.

All `setup` commands run as one bash login script, and so do all `checks`. State carries from one line to the next, so `python3 -m venv .venv` followed by `source .venv/bin/activate` works, and tools that the worker image put on `PATH` through `/etc/profile.d` are found. The first failing command stops the script, and its name is reported on the issue. A failing setup is reported as a factory problem, not as the agent's fault.

## worker

| Key | Required | Meaning |
|---|---|---|
| `provider` | no | `"docker"` (default; one container per job on your own Docker host) or `"box"` (Upstash Boxes). See `providers.md`. |
| `docker.image` | no | Worker image for the Docker provider. Default `create-ant-factory-worker:latest`, built from `worker/Dockerfile`. |
| `docker.cpus`, `docker.memory` | no | Per-container limits for the Docker provider (`--cpus` / `--memory`). Defaults `"2"` and `"4g"`. |
| `docker.host` | no | One Docker endpoint (`-H`), for example `"tcp://10.0.1.20:2376"`. Wins over `DOCKER_HOST`. Left out: `DOCKER_HOST` / docker context decides. Verification (`check-setup`, `scripts/verify-docker.mjs`) reports against this target. |

The Docker host itself is not config: the docker CLI's `DOCKER_HOST` environment variable or `docker context` decides where it talks.

## workers

A list of `{ "id": "claude-01", "agent": "claude", "enabled": true }`. The id is lowercase letters, digits and dashes. `enabled: false` parks a worker without deleting its Box. Count the Boxes against the Upstash plan's limit. Paused Boxes count.

An agent type with no enabled worker gets no `agent:` label and no secrets. An issue that asks for it is handed back at once with `factory:needs-attention`.
