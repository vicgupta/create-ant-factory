---
name: create-ant-factory
description: Set up a "software factory" that turns labelled GitHub issues into reviewed pull requests, using coding agents (Claude Code, Codex or any other CLI agent) that run in sandboxes (Docker containers by default, Upstash Boxes optionally) and are started by GitHub Actions. Use this whenever someone wants to build, recreate, extend or debug an issue-to-PR pipeline, a pool of background coding agents, "agents that work on my GitHub issues", a label-triggered agent workflow, or anything that combines sandboxes with coding agents and GitHub, even if they never say "software factory". Also use it to add a repo, an agent type, workers, a model or effort setting, or a worker image (snapshot) to a factory built this way.
---

# Create a software factory

You are helping someone build a small system with one job: they put a `ready` label on a GitHub issue, a coding agent implements it inside a sandbox, and a pull request comes back for them to review and merge. This skill carries a working implementation (in `assets/template/`) and the lessons from building it, so you adapt proven code instead of inventing it.

## What gets built

- A **factory repo** (new, usually private) that holds the config, the coordination code, the workflows and the worker image definition.
- A tiny **trigger workflow** in each app repo. When an allowed person adds the `ready` label, it sends the repo name and issue number to the factory repo with `repository_dispatch`.
- The **Factory workflow** in the factory repo. It claims a free worker, runs the agent in that worker's sandbox, runs the repo's checks, pushes a branch and opens a pull request. Labels on the issue show the state: `ready`, `factory:running`, `factory:review`, `factory:needs-attention`.
- A pool of **workers**. One worker is one agent type with its sign-in, command, and model/effort settings. Where it runs depends on the provider below.
- **Worker provider (optional).** Docker is the default (`"worker": { "provider": "docker", "docker": { "image": "create-ant-factory-worker:latest", "cpus": "2", "memory": "4g" } }`): each job runs in one container on a Docker host the user controls (local, or remote via `DOCKER_HOST`), removed when the job ends — free, and the code never leaves their machine. Offer Upstash Box (`"worker": { "provider": "box" }`, one named Box per worker, idle Boxes paused) when the user doesn't want to run a host at all. Read `references/providers.md` first — Docker shares the host kernel, so it suits the user's own repos, not multi-tenant use. When the provider is docker, verify the target at setup time (`check-setup` runs the full daemon/image/smoke verification and must pass before the factory counts as set up) and tell the user they can re-run it any time with `scripts/verify-docker.mjs` (after a host reboot, Docker upgrade, image rebuild or `DOCKER_HOST` change).

Steps below marked **(Box only)** apply only when `worker.provider` is `"box"` — skip them with the default Docker provider. The Docker equivalents (image build, `verify-docker.mjs`) are in `references/providers.md`.

Nearly everything a user may want to change later lives in `factory.config.json`. `references/config.md` lists every key.

Read `references/architecture.md` before you change any code. It explains the claiming protocol and the label states, and why they are the way they are.

## How to work

Work in stages and stop at the end of each one. Each stage ends with something the user can see working. Building everything first and debugging it all at once is how this goes wrong: several bugs in the original build only showed up because each stage was tested on its own.

Rules that apply to every stage:

- **The user does every sign-in and creates every key.** You never need to see a secret's value. Ask them to put values in `.env` themselves. If they paste one in chat anyway, save it to `.env`, do not repeat it, and suggest rotating it when the project is done.
- **Preview before you change anything outside this folder.** The scripts that create or change cloud resources (`smoke-test`, `provision-workers`, `build-snapshot`, `apply-box-settings`, `install-trigger`, `set-secrets`, `create-demo-issues`, `delete-workers`) print a preview and need `--yes` to act. Show the preview first. `check-setup`, `status`, `list-boxes` and `plan` only read. `box-exec` and `release-worker` act at once, on one worker.
- **Permanent deletes belong to the user.** Deleting Boxes, issues or snapshots that hold their data cannot be undone. Give them the command and let them run it. Cleaning up a Box or snapshot that you created minutes ago and that holds nothing is fine.
- **Changes to app repos go through pull requests**, so the owner reviews what lands there.
- **Say what you verified and what you did not.** "Pushed but not yet run" and "tested" are different claims.
- **Keep plain notes.** After each stage, add a short file under `docs/` in the factory repo: what was built, the exact commands, and a test log with the real result, including failures. People use these to follow along, record videos and debug later.

## What the user's machine needs

Node 20.6 or newer, git, and the GitHub CLI `gh`, signed in as someone who can create the factory repo, set secrets and variables on it and on the app repos (that needs admin rights on each), and push workflow files (the `workflow` scope). With the default Docker provider, a Docker daemon the factory can reach — local, or remote via `DOCKER_HOST` or a docker context (optionally pinned as `worker.docker.host`). `scripts/check-setup.mjs` checks most of this once the project is scaffolded.

## Stage 0: make sure you have current docs

Claude Code and Codex change often — and the Upstash Box SDK too, when the provider is Box. The template was correct when written, but check the parts you depend on against current docs before you rely on them.

If the user has already said they do not want Context7 or anything extra installed, skip straight to step 3.

1. Look for Context7: a Context7 MCP server in this session, or a `ctx7` command that is already installed. Either is fine.
2. **(Box only — skip with Docker.)** If there is none, ask the user whether you may use it. The lightest way is `npx ctx7@latest library "Upstash Box" "create a box and run shell commands"`, which downloads the CLI on the fly and needs no sign-in for light use. For a proper install, follow Context7's own current instructions (https://context7.com and https://github.com/upstash/context7) rather than commands from memory, and let the user complete any sign-in. `npx ctx7@latest login` or a `CONTEXT7_API_KEY` raises the quota. With Context7, the Box docs are library `/websites/upstash_box`.
3. Without Context7, read the official pages directly:
   - Claude Code: https://code.claude.com/docs
   - Codex: https://developers.openai.com/codex and https://github.com/openai/codex
   - (Box only) Box quickstart: https://upstash.com/docs/box/overall/quickstart
   - (Box only) Running shell commands: https://upstash.com/docs/box/overall/shell
   - (Box only) Snapshots: https://upstash.com/docs/box/overall/snapshots
   - (Box only) Lifecycle, pause and resume: https://upstash.com/docs/box/overall/how-it-works

Look up the headless mode, sign-in and model settings of each agent CLI the user picks. (Box only: Box creation, shell commands, snapshots, pause and resume. `references/upstash-box.md` lists what was verified and the SDK calls the template uses, so you know what to compare.)

## Stage 1: interview

Ask these before writing anything. Most have sensible defaults, so offer the default and move on. Look at the repos yourself first (`gh repo view`, the README, `package.json` or its equivalent, `.gitignore`, existing workflows) and propose answers instead of asking cold.

1. **App repos.** Which repos? For each:
   - the **default branch**, and the branch factory pull requests should target (`baseBranch`). They can differ. The trigger workflow has to live on the default branch, and `install-trigger.mjs` handles that.
   - **setup commands** (install dependencies) and **check commands** that must pass before a PR (tests, build, lint). A repo with no checks is allowed, but say clearly that the human review is then the only check.
   - the **language and toolchain**, with versions. A stock worker has Node, npm, pnpm, yarn, bun, git and Python 3.11 without pip or venv (Docker: `worker/Dockerfile`; Box: the stock Box, `references/upstash-box.md`). Anything else, including a usable Python, means a worker image, and that image has to exist **before** the first real run (Stage 6).
   - what the tests need: services such as a database, environment variables, and roughly how long they take. Setup and checks each get `factory.commandTimeoutMinutes` (default 20).
   - secrets the tests need, such as a test database URL. They go under the repo's `secrets` and reach setup, checks and the agent, but never the image.
   - files that the setup, or the agent's own tools, leave inside the repo folder and that the repo's `.gitignore` does not cover: a virtualenv, caches, a browser tool's screenshots folder. List them under the repo's `exclude`, or they end up in the pull request.
2. **Agents.** Claude Code, Codex, both, or something else? For each: subscription sign-in or API key? See `references/agents.md`. One agent type is a perfectly good factory. Do not settle the model here. That question has its own moment, described below.
3. **Workers.** How many of each agent type? **(Box only:)** check the Box limit of their Upstash plan first (the Upstash console shows the plan, and `scripts/list-boxes.mjs` shows what already exists). On the free plan it was 10 Boxes in total, and paused Boxes count. Leave one slot for smoke tests. Put the plan's limit in `factory.boxLimit` and `check-setup.mjs` does the arithmetic, including Boxes of other projects on the same account. With Docker there is no provider pool limit — size the workers to what the host can run at once (`worker.docker` cpus/memory). With more than one agent type, also ask **which type should take unlabelled issues first**. Without an answer the work spreads evenly, which is wrong when one type is a flat-rate subscription and the other bills per token. The answer becomes `priority` on the agent types.
4. **Who may start the factory.** Real GitHub usernames for `allowedActors`. A run spends the user's agent quota or API budget, so this list matters. Ask who has write access to the factory repo too, because they can see its Actions logs.
5. **Factory repo and ownership.** Name, private or public, and owner. The owner has to be the **same account or organisation that owns the app repos**, because one fine-grained GitHub token covers one owner. Check the name is free and that nothing from an older attempt already exists (an old factory repo, old trigger workflows in the app repos, old workers (Box: old Boxes on the Upstash account)). Leftovers caused real confusion in the original build.
6. **Whose name is on the work.** Pull requests and comments appear under the owner of the GitHub token, and commits carry `gitAuthor`. Ask which real person that should be. They need to be a member of any preview-hosting team (see the commit author pitfall), and they cannot approve their own pull requests if the branch requires a review. A dedicated machine user avoids both problems. Use their noreply address, which for newer accounts looks like `12345678+username@users.noreply.github.com`.
7. **Organisation rules**, if the repos belong to one: does the org allow fine-grained tokens, and does it have to approve them? SSO? Branch rules that would reject a push of `factory/issue-N` (required signed commits, branch name patterns)? An Actions allow-list? Are Actions minutes billed? A run holds a runner for its whole length.
8. **Worker image.** Settle what belongs in it now, before any worker exists, because the image is built first and the workers are created from it. Finding out later means deleting and recreating workers. Beyond toolchains: skills, MCP servers, a browser tool, another agent CLI? **(Box only.)** Browser access itself is on by default for every Box (`factory.browser`). Tell the user so, and that it can only be chosen when a Box is created. It gives the Box a Chromium that Upstash runs and shows in its console. With Docker there is no built-in browser; if the agent needs one, install it in `worker/Dockerfile`. The agent still needs a tool in the image to drive it, such as `agent-browser`. House instruction files such as a `CLAUDE.md` or `AGENTS.md` that they edit often do not go in the image. They become `jobFiles` (`references/config.md`). Read such a file with the user before using it: it will sit in a GitHub repo and run in a Linux Box, so private notes, local paths and references to tools that only exist on their machine should go, and rules that clash with the factory's (commit, push, open pull requests) lose to the factory's prompt. See `references/worker-image.md`.
9. **Hosting quirks.** Do the app repos deploy previews (Vercel, Netlify) or run review bots? These react to the factory's commits.

## Before you create any worker: ask about model and effort

A worker's model and reasoning effort live in the settings file its CLI reads. With the Box provider they are stored **in the Box**, so they become part of any snapshot taken from it. They are not command-line flags added by the factory. This is what lets one factory hold different kinds of worker: a pool of cheap, fast workers next to a pool for hard engineering work.

The template ships every agent type with `"boxSettings": "ask"`. The config loads that way, so the early stages work, but every script that creates a worker refuses it. So the first time you are about to create a worker for an agent type (normally the smoke test in Stage 4, and again whenever a new kind of worker is added), stop and ask the user:

> "For the Claude Code workers: use Claude Code's own default model and reasoning effort, or a specific model and effort?" (and the same for each other harness)

- If they want the defaults, set `"boxSettings": []` for that agent type. The empty list is the record that they chose defaults.
- If they name a model or an effort, look up what that harness accepts (`references/agents.md` has the verified recipes for Claude Code and Codex, and current docs have the model names) and fill in `boxSettings`.
- Ask whether they want **more than one kind of worker on the same harness**, for example a small model for quick chores and a larger model at high effort for difficult issues. Each kind is its own agent type with the same `auth` and `command` and different `boxSettings`, its own workers, its own `agent:<name>` label, and its own snapshot if they use images. Agent names are at most 14 lowercase characters.
- Tell them the trade-off once: bigger models and higher effort use up a subscription's limits, or an API budget, faster, and parallel workers multiply that.

The previews of `smoke-test.mjs`, `provision-workers.mjs` and `build-snapshot.mjs` print the model and effort a worker will get. Show that line to the user before you add `--yes`.

Changing it later: edit `boxSettings`, run `scripts/apply-box-settings.mjs --yes` for the workers that exist — and rebuild the worker image (Docker) or that agent type's snapshot (Box) if it has one.

### Browser access is decided at the same moment (Box only)

Every Box the factory creates gets browser access, because `factory.browser` defaults to `true`. Leave it on unless the user says no. Unlike the model, it **cannot be changed on a Box that exists**: `Box.create({ browser: true })` is the only switch. Two facts follow, and both cost a full round of deleting and recreating workers in the original build:

- `Box.fromSnapshot` ignores `browser: true`. The SDK does not send it.
- A Box made from a snapshot has browser access exactly when the Box the snapshot was taken from had it. So an image has to be **built in a browser-enabled Box**. `build-snapshot.mjs` checks that and refuses otherwise.

The same previews print a browser line. `provision-workers.mjs` and `smoke-test.mjs` test every Box they create and stop at the first one without browser access. Details are in `references/upstash-box.md`. With Docker there is no browser decision to make: the worker image either contains a browser or it doesn't.

## Stage 2: scaffold the factory repo

1. Copy everything in `assets/template/` into the project folder, including the dotfiles and `.github/`.
2. Fill in `factory.config.json` from the interview. The loader rejects the placeholders, so every `OWNER` has to go. Pick a `boxNamePrefix` (worker and container names start with it). **(Box only:)** also pick a `boxLabel` that nothing else on the Upstash account uses (Stage 3 checks this). Remove agent types the user will not use. Leave `boxSettings` as `"ask"`.
3. `npm install`, and commit `package-lock.json`. The workflow runs `npm ci`, which fails without it.
4. `git init`, confirm `.env` is ignored, commit, then `gh repo create OWNER/NAME --private --source . --push` (or `--public`).

The template is plain Node ES modules with one dependency, `@upstash/box`. Keep it that way unless the user asks otherwise. It is meant to be read and changed by the person who owns it.

## Stage 3: accounts and secrets

Ask the user to:

- **(Box only.)** Create a **Box API key** in the Upstash console and put it in `.env` as `UPSTASH_BOX_API_KEY`. With Docker this key is not needed.
- Create a **fine-grained GitHub token**. Resource owner: the account or organisation that owns the repos. Repository access: the factory repo and every app repo. Permissions: Contents, Pull requests and Issues, all read and write. It goes in `.env` as `FACTORY_GITHUB_TOKEN`. The factory repo must be included, because the trigger in each app repo uses this token to send the dispatch event there. In an organisation the token may need an owner's approval before it works.
- Sign each agent in, as described in `references/agents.md`, and put the resulting secret in `.env` (or leave it in its local file when the config has a `localFile`). For API keys, suggest a key made for this project with a spending limit.

Then run `node --env-file=.env scripts/check-setup.mjs`. It checks the tools, the config, which secrets have a value (never the values), whether the token can see every repo, and the provider's prerequisites — the Box key and what is already on the Upstash account (Box), or the Docker daemon, the worker image and a smoke container (Docker). Fix what it reports before going on.

## Stage 4: smoke test one worker per agent type

Ask the model and effort question first, because this is the first worker. Then, for every agent type:

```bash
node --env-file=.env scripts/smoke-test.mjs claude
```

Show the preview, then run it with `--yes`. It creates one worker (a Box, or a container with Docker), prints which toolchains it has, writes the agent type's default settings, signs the agent in exactly the way the factory will, asks it to reply `BOX OK`, and removes the worker. (Box only: it also confirms browser access.) It proves the things most likely to be wrong: the provider prerequisites, the agent CLI being present, the sign-in method, and the summary file.

The smoke test creates its worker the way a real job's worker is created — from the agent type's image when one exists. So for an agent whose CLI is not in the stock image, the order is: build the image first (Stage 6), then run this smoke test, which then starts from the image. **(Box only:)** to find the right install command beforehand, run the smoke test with `--keep` and try commands by hand with `scripts/box-exec.mjs <box name> "<command>"`. (With Docker, run the image yourself: `docker run --rm -it <image> bash`.)

**(Box only.)** If creating a Box fails with a limit error, the account is full. Paused Boxes count. The user decides what to delete.

## Stage 5: prove the trigger with a dry run

1. Turn on dry-run mode first, so nothing real can start while you wire things up: `gh variable set FACTORY_DRY_RUN --body true --repo OWNER/FACTORY-REPO`.
2. `node --env-file=.env scripts/set-secrets.mjs` (preview), then `--yes` once the user agrees. This changes repo settings, so ask first.
3. `node scripts/install-trigger.mjs` (preview), then `--yes`. It creates the issue labels and one `agent:<name>` label per agent type in use, and opens a PR against each app repo's default branch that adds the trigger workflow. The user merges the PRs.
4. The user creates a test issue in one app repo and adds the `ready` label.
5. Read the run in the factory repo's Actions tab. The "Show the plan" step should print the issue, every worker, and the worker it would pick. Exactly one run should appear per label.

Leave dry-run mode on until the workers are ready for a real job.

If no run appears, check in this order: the trigger PR is merged into the default branch, the person who labelled is in `allowedActors`, the app repo has the `FACTORY_GITHUB_TOKEN` secret, that token can write to the factory repo, and Actions are allowed to run in both repos.

## Stage 6: the worker image

**Docker (the default): build it now, always** — the image is how every worker runs:

1. Add toolchains to `worker/Dockerfile` the way `worker/setup.sh` adds them to a Box (`references/worker-image.md`); keep its final check.
2. `docker build -f worker/Dockerfile -t create-ant-factory-worker:latest .`
3. `node --env-file=.env scripts/verify-docker.mjs` must pass — it checks the daemon, the image, and a smoke container.

**(Box only — the rest of this stage.)** With Box the image is a snapshot, and it is optional: do this now if any repo's setup or checks need something a stock Box lacks (the smoke test printed what it has), if an agent CLI was missing, or if the user asked for skills, MCP servers or a browser. Otherwise skip it. It can be added later.

1. Edit `worker/setup.sh`. Read `references/worker-image.md` first. It covers what belongs in an image and the facts about Boxes that decide how the script has to be written.
2. Create one worker's Box and no more: `node --env-file=.env scripts/provision-workers.mjs <worker id> --yes`. The other workers wait until the image exists. This Box gets browser access from `factory.browser`, and the image passes that on to every worker.
3. Build: `node --env-file=.env scripts/build-snapshot.mjs <worker id>`, show the preview, then `--yes`. It checks that the Box has browser access, runs the setup in that Box, writes the agent type's `boxSettings`, removes secrets and old workspaces, scans the disk for anything that looks like a secret, takes a snapshot and saves its id as `agents.<name>.snapshotId`. Commit the config.
4. Repeat steps 2 and 3 once per agent type that should have an image. With `--shared` the script builds one tools-only image for all agent types instead, saved as `factory.snapshotId`.
5. Verify inside the Box with `scripts/box-exec.mjs`: tool versions, and a real action with each tool.

Boxes created after this start from the image. The Box you built in already holds everything, so nobody has to delete anything. Only Boxes that existed before need recreating (`delete-workers.mjs`, run by the user, then `provision-workers.mjs`).

## Stage 7: the first real run

Turn dry-run mode off: `gh variable delete FACTORY_DRY_RUN --repo OWNER/FACTORY-REPO`. Have the user re-add `ready` on the test issue (remove it, then add it again). Watch the run, then check every one of these, because each failed at least once in the original build:

- The issue went `ready` to `factory:running` to `factory:review`, with a comment naming the worker.
- The PR exists, says `Closes #N`, and its description holds the agent's own summary, not "(The agent gave no summary.)".
- The repo's setup and checks ran and passed in the log.
- Preview deployments and other bots on the PR are green. A blocked deployment usually means the commit author is wrong.
- The worker was released: `node --env-file=.env scripts/status.mjs` shows it free (Box: its Box paused; Docker: its container gone).
- **(Box only.)** No credentials were left behind: `node --env-file=.env scripts/box-exec.mjs <worker> "ls -d ~/.git-credentials /workspace/home/.factory" --pause` should find neither. (With Docker this check is unnecessary — the container is removed when the job ends, credentials with it.)

Repeat with one issue per agent type. Put `agent:<name>` on the issue before `ready` to force the type.

## Stage 8: scale test

1. **(Box only — skip with Docker.)** Run `node --env-file=.env scripts/provision-workers.mjs` and show the user the preview. It lists each Box with its image and its model and effort. Then run it with `--yes`. It creates a paused Box for every worker, so that runs never race to create the same Box. (With Docker there is nothing to pre-create: containers are per-job.)
2. Write `scripts/demo-issues.json` from `demo-issues.example.json`, with small, independent features that fit the user's repos. Write more issues than there are workers so that some have to wait.
3. `node scripts/create-demo-issues.mjs --yes` creates them without labels, so the user can label them on their own schedule. `--ready` starts them all at once, and needs `gh` to be signed in as someone in `allowedActors`.
4. Afterwards, check: one run per issue, every issue ended in `factory:review` or `factory:needs-attention`, all workers free again, no rate-limit failures. With API keys, have the user look at the provider's usage page.

Warn the user beforehand that parallel PRs in one small repo touch the same files. Each works alone, and later merges may conflict. That is a property of parallel work, not a factory bug.

## Stage 9: hand over

- Write the factory repo's README: what it does, how to add a repo, a worker or an agent type, how to read the labels, and the diagrams from `references/architecture.md`.
- List the secrets that were exposed during setup (pasted in chat, shown on screen) and recommend rotating them. Note when the GitHub token and any agent token expire.
- Say this plainly once: the agent runs with its own permission prompts switched off, holds its sign-in for the length of the job, and reads issue text. With a browser or web access it also reads web pages. `allowedActors` controls who may label, not who wrote the issue. So read an issue before labelling it, especially in a public repo.
- Show the everyday commands: `scripts/status.mjs`, `scripts/release-worker.mjs` for a worker stuck as busy after a cancelled run, `scripts/apply-box-settings.mjs` for a model change, and `scripts/verify-docker.mjs` (Docker) for host health checks.

## Changing an existing factory

- **Add a repo:** add it to `repos`, extend the GitHub token's access, run `install-trigger.mjs --yes` and `set-secrets.mjs --yes`.
- **Add workers:** add lines to `workers` (Box only: check the Box limit), ask the model and effort question if it is a new kind of worker, run `provision-workers.mjs --yes` (Box only; Docker needs nothing pre-created).
- **Add an agent type:** read `references/agents.md`, add it to `agents` with `"boxSettings": "ask"`, ask the model question, run the smoke test, then `install-trigger.mjs --yes` for its label and `set-secrets.mjs --yes` for its secret.
- **Change a model or effort:** edit the agent type's `boxSettings`, run `apply-box-settings.mjs --yes`, and rebuild the worker image (Docker) or that agent type's snapshot (Box) if it has one.
- **Give existing workers browser access (Box only):** it cannot be switched on for a Box that exists, and an image built in a Box without it never passes it on. (With Docker: install a browser in `worker/Dockerfile` and rebuild the image.) Set `"browser": true`, take the `snapshotId` values out of the config, have the user delete the workers (`delete-workers.mjs --yes`), create one plain Box, rebuild the image in it, then create the rest. See `references/worker-image.md`.
- **Let reviewers send a PR back:** set `"resumeFromReview": true` under `factory` (the template does). The user reviews the factory PR, then re-adds `ready` to the issue; the factory revises the same branch from the trusted review comments and failing checks, pushes normally and replies on the PR. Fine-grained tokens need Checks read access for the failing checks part. See `references/config.md`.
- **Precedent-aware context (Context Graph):** set `"contextGraph": true` under `factory` (the template does). Past run records become a precedents index keyed by issue labels and touched paths (`node scripts/precedents.mjs runs` builds the committed `precedents.json`; exact label/path matching, top 3, failed/rejected/reverted runs included — no embeddings or graph database). Each run injects a bundle with named short-term (issue + latest trusted comments), long-term (repo facts: house-rules files, checks, file map, SKILL.md refs) and reasoning (precedents) layers into the plan/implementation prompts, logs which layer each item came from on its run record, and traces its choices in the record's `decisions[]`. Stamped `## Facts` in `plan.md` (source file + base commit SHA + observing run id) are re-verified before coding; resume-from-review flags stale ones. See `references/config.md`.
- **Gate risky changes for a human:** add a `riskGates` block under `factory` (the template ships one) and optionally a `tier` on a repo. Deterministic rules on paths, keywords, tier, issue labels, diff size, missing checks and failed precedents (`src/gates.mjs`) decide ready vs draft PR and when to park at `factory:needs-attention`; the agent cannot waive a gate. Dry-run with `node scripts/risk-gate.mjs`. See `references/config.md`.
- **Add an independent reviewer:** set `"enabled": true` in the template's `factory.reviewer` block (or add one). Before each PR opens, a fresh session of another agent type reviews the staged diff against the issue, the plan and the decision trace/precedents, writing findings by severity; anything at or above `blockOn` (default `critical`) opens a draft PR and parks the issue at `factory:needs-attention`. The factory decides from the severities, and a reviewer that fails or edits the repo also parks the issue. It costs one more agent run, so re-run `check-setup.mjs` and raise the workflow's `timeout-minutes` if it says so. Check a review file with `node scripts/review-check.mjs`. See `references/config.md`.
- **Schedule candidate issues:** set `"enabled": true` in the template's `factory.scheduledScan` block (or add one). The optional `.github/workflows/scheduled-scan.yml` (cron + workflow_dispatch) runs `scripts/scheduled-scan.mjs`, which files deduplicated **candidate** issues from TODO/FIXME markers and/or `scripts/scan-candidates.json`, labelled `factory:candidate` only. It never applies `ready` and never starts a run — a human still does that. Dry-run with `npm run scheduled-scan`; create with `--yes`. See `references/config.md`.
- **Plan before implementing:** set `"planFirst": true` under `factory` (the template does). A new run's planning pass writes `plan.md`, the factory validates it (files to touch, criteria mapped to configured checks or `manual-review`) and posts it to the issue before implementation; the PR ticks off the criteria. An invalid plan stops to `factory:needs-attention` with nothing built. Revisions skip it. It costs one extra agent run, and `check-setup.mjs` counts it in the timeout sum. See `references/config.md`.
- **See how the factory is doing:** every run leaves a run record artifact (`factory.runRecords`, on by default). Download them with `gh run download -R OWNER/FACTORY-REPO --pattern 'run-record-*' --dir runs`, then run `node scripts/report.mjs runs` for pass rate, median time to PR and rework per agent type and provider (`--json` for numbers, `--out report.md` to save it). See `references/config.md`.
- **Change who may start it:** edit `allowedActors`, run `install-trigger.mjs --yes`, merge the PRs.
- **Something is broken:** read `references/pitfalls.md` first. Most failures seen so far are listed there with their cause.

## Reference files

- `references/architecture.md`: components, the job sequence, label states, the worker claiming protocol, file map, README diagrams.
- `references/config.md`: every key in `factory.config.json`.
- `references/agents.md`: sign-in, command lines, and model and effort settings for Claude Code and Codex with a subscription or an API key, and how to add any other agent.
- `references/upstash-box.md` (Box only): the SDK calls the template uses, what a stock Box contains, and where the docs are.
- `references/worker-image.md`: building worker images (Docker) and snapshots (Box).
- `references/providers.md`: Box vs Docker workers — choosing, Docker setup, cleanup, network shape and the isolation caveat.
- `references/pitfalls.md`: every bug and surprise from the original build, with cause and fix. Read this before debugging.
