# Pitfalls

Every item here happened during the original build. The template already contains the fix. The list is here so you recognise the symptom if a change brings one back, and so you know which checks are worth doing.

## Security

**Secrets that the agent or a check prints end up in pull request text.**
The agent's reply becomes the PR description and failing setup or check output goes into issue comments, so anything printed there is public to the repo. `src/redact.mjs` collects every secret the job knows (the GitHub token, the worker's sign-in secrets, the repo's secrets) and `src/run.mjs` replaces each of them with `***` in everything it posts or logs. Values shorter than 8 characters are skipped, so keep secrets longer than that. The reply is also capped (`capSummary` in `src/github.mjs`, 60,000 characters): a runaway agent reply would otherwise fail the PR creation — GitHub caps bodies at 65,536 characters — after the commit and push were already made.

**Git stores the GitHub token on the Box's disk.**
The Box image configures git with `credential.helper = store`. A clone from a URL that contains the token writes it to `~/.git-credentials`, where the agent can read it. Fix: run the factory's git commands with `-c credential.helper=`, delete `~/.git-credentials` at the start of every job, and reset the remote URL to the token-free one before the agent starts. Verify after the first real run with `box-exec.mjs`.

**A snapshot captures whatever is on the disk, secrets included.**
The first worker image contained `~/.git-credentials`. `build-snapshot.mjs` now deletes known secret paths and then greps the disk for secret-looking text, and refuses to snapshot if anything is found. If you add an agent whose credentials look different, add a pattern to `factory.secretScanPatterns`. Those patterns are added to the built-in list, they do not replace it. If a bad snapshot was taken, delete it and rebuild.

**The cleanup that deletes secrets must quote paths with `q()`.**
A hand-written `'${p}'` breaks on a path with an apostrophe (`'/a'b'` becomes `/ab`), so `rm -rf` misses the secret file or hits the wrong path. `build-snapshot.mjs` and `smoke-test.mjs` quote every config path with the `q()` helper from `src/box.mjs`, the same helper `run.mjs` uses for the same cleanup.

**A paused Box keeps its disk.**
Sign-in files written for a job are still there after the pause. The template deletes them in `finally`. Keep it that way. A cancelled run never reaches `finally`, so `release-worker.mjs` deletes them too.

**Anyone who can label can spend the subscription.**
The trigger checks `github.actor` against `allowedActors`. Do not remove that check. The comparison is case-insensitive, like the one in `src/run.mjs`: a mixed-case entry still matches. A refused actor fails the trigger step with a message instead of the job silently skipping. `github.repository_owner` is the organisation for org repos, so a comparison against it never matches a person there. The "Run workflow" button on the factory repo is a second way in, open to everyone with write access to that repo, so `src/run.mjs` checks the actor against the same list.

**Agent transcripts end up in an image.**
Images are built in worker Boxes that may have done jobs. Claude Code and Codex keep full transcripts, app code included, under `~/.claude/projects` and `~/.codex/sessions`. `build-snapshot.mjs` deletes those, the agent types' `jobFiles`, and anything in `factory.imageCleanPaths` before the snapshot.

**A shared image must not carry one agent type's model.**
The build Box has its own type's `boxSettings` on disk. JSON settings are merged, so another type created from that image would inherit keys it does not set itself, such as an effort level. `--shared` removes the settings files for the snapshot and writes them back afterwards.

**The agent reads text that anyone may have written.**
It runs with its permission prompts off, holds its own sign-in during the job, and with a browser it also reads web pages. `allowedActors` limits who can label, not who wrote the issue. Read issues before labelling them, above all in public repos.

**Repo names in the config are limited to GitHub's real characters.**
`factory.repo` and each `repos[].repo` may only contain letters, digits, `.`, `-` and `_` in each half. `install-trigger.mjs` pastes `factory.repo` into the `run:` block of the trigger workflow and `run.mjs` interpolates `repos[].repo` into the remote URL, so a quote, semicolon or `$(...)` in either place would be shell code, not a name. `config.mjs` rejects anything outside that character class. Do not loosen this to "no whitespace".

**Secrets pasted in chat or shown on screen** are exposed. Save them, do not repeat them, and list them for rotation at hand-over.

## GitHub Actions

**Two runs per issue.**
Creating an issue that already has the label sends `opened` and `labeled`. Listening to both starts the factory twice, and two workers build the same issue. Fix: the trigger listens to `labeled` only (it also fires for an issue created with the label), and the factory workflow has a `concurrency` group per repo and issue, so a second run waits, finds `ready` gone and stops.

**An invalid workflow file fails silently.**
A YAML typo (in the original: a missing space after `run-name:`) makes GitHub reject the file. The only sign is a failed run on the push, titled with the commit message, and the trigger stops working. After every workflow edit, parse the file (`npx js-yaml file.yml`) and check the Actions tab for a failed push run.

**No run appears after labelling.**
Check: trigger PR merged, actor in `allowedActors`, `FACTORY_GITHUB_TOKEN` secret present in the app repo, and that token has write access to the factory repo (needed for `repository_dispatch`).

**Old automation still wired in.**
A previous attempt can leave a trigger workflow, secrets, labels, open PRs and Boxes behind. An old trigger will wake the old factory. Look for leftovers during the interview.

**The trigger only runs from the default branch.**
GitHub runs an `issues` workflow from the repo's default branch and nowhere else. A team that wants factory pull requests against `develop` while `main` is the default still needs the trigger on `main`. `install-trigger.mjs` looks up the default branch and opens its PR there. `baseBranch` only decides where the factory's own pull requests go.

**One fine-grained token, one owner.**
A fine-grained token has a single resource owner. If the factory repo sits under a personal account and the app repos under an organisation, no single token reaches both, and the dispatch fails with a 404 that looks like a typo. Keep all repos under one owner. In an organisation, fine-grained tokens may be switched off or need an owner's approval, and `gh` may need SSO authorisation.

**Organisation rules can reject the factory's push.**
Rulesets that require signed commits or restrict branch names reject `factory/issue-N`. An Actions allow-list or disabled Actions stops both workflows. Setting secrets and variables needs admin rights on the repo.

**A run holds a runner the whole time.**
The runner mostly waits for the Box. In private repos those minutes count against the plan, including up to `waitForWorkerMinutes` spent waiting for a free worker.

## Setup and check commands

**Each command used to run in its own plain `sh`.**
That was invisible with npm and breaks everything else: `source` does not exist in `sh`, an activated virtualenv did not reach the next command, and tools the worker image put on `PATH` through `/etc/profile.d` were visible to the agent but not to the factory's checks. Now all `setup` commands run as one bash login script, and so do all `checks`, in the background with polling like the agent.

**A stock Box cannot install Python packages.**
It has Python 3.11 but no pip, and `python3 -m venv` fails because `ensurepip` is missing. Debian's pip also refuses to install outside a virtualenv. A Python repo needs a worker image with `sudo apt-get install -y python3-venv python3-pip`, a virtualenv in the repo's `setup`, and that folder under the repo's `exclude` if its `.gitignore` does not cover it.

**`git add -A` commits whatever the setup leaves behind.**
`node_modules` is ignored almost everywhere. A virtualenv, a cache folder or build output may not be. Read the app repo's `.gitignore` during the interview and use `exclude`.

**A failing setup is not the agent's fault.**
The factory reports it on the issue as a factory or image problem and does not start the agent.

## The agent run

**Empty PR summary.**
`cmd > summary > log`: with two redirects of standard output on one command, the last one wins and the summary file stays empty. `runScript` sends the whole script's output to the log with `exec > log 2>&1` on its first line, which leaves the agent command's own `> summary` alone.

**Long runs on one HTTP request.**
`box.exec.command` holds a request open until the command ends. Agent runs take minutes. `runScript` starts the script with `nohup setsid` in the background and polls an exit-code file every 10 seconds. Repo setup, checks and the image build run the same way.

**The default shell in a Box is `sh`.**
`source` and other bash features fail in `box.exec.command`, which is what the `sh()` helper uses. Keep `sh()` for short plumbing commands. Anything that needs bash, the image's environment or more than a minute goes through `runScript()`.

**Processes outlive the job.**
An agent that starts a dev server and forgets it leaves it running, and a timed-out agent keeps working. `runScript` gives each script its own process group with `setsid` and stops the whole group when the script ends or times out. It uses `/bin/kill`: the `kill` built into the Box's `sh` rejects `kill -- -PGID` with "Illegal number".

**Tools the agent uses leave files in the repo folder.**
A browser tool may write screenshots or traces into the working folder, and `git add -A` commits them. Put such folders under the repo's `exclude`.

**The clarification marker is not always first.**
Some CLIs print text before the final reply. The factory looks for `NEEDS_CLARIFICATION:` at the start of any line of the summary. People answer such questions in comments, so the prompt includes the issue's comments. The factory's own comments carry a hidden marker and are left out. Only comments by the issue's author or someone on `allowedActors` are included: on a public repo anyone can comment after `ready` is added, and the agent runs with its sign-in secrets, so a stranger's comment is a prompt-injection path.

**`process.exit()` after `fetch` crashes Node on Windows** with a libuv assertion. Set `process.exitCode` and return instead.

**An `agent:` label that no worker serves.**
The run used to wait the full `waitForWorkerMinutes` for a worker that could never come, on a billed runner. Now the issue is handed back at once with an explanation. `install-trigger.mjs` only creates `agent:` labels for agent types that have an enabled worker, so remove unused agent types from the config instead of leaving them without workers.

## Pull requests

**Preview deployments blocked.**
Vercel (and similar) block deployments for commits whose author is not on the team. An invented address such as `factory@users.noreply.github.com` belongs to some unrelated GitHub user. Use the noreply address of a real person who is on the hosting team in `factory.gitAuthor`. For an organisation repo that is never the organisation's name.

**Parallel PRs conflict with each other.**
Several agents working on one small repo all edit the same few files. Each PR is fine alone. After the first merge the rest may need conflicts resolved or a re-run. Warn the user before a scale test.

**`Closes #N` closes the issue on merge**, but the `factory:review` label stays on the closed issue. Harmless.

## Upstash Box

**Two runs can claim the same worker if their run labels collide.**
`claimWorker` marks a claimed Box with `run-<run id>`, and a rival run that reaches the same worker at the same moment backs off when it sees a lower label. The label is capped at 20 characters (the Box limit), and truncating the front of a long run id would discard exactly the digits that tell two runs starting together apart: GitHub run ids grow at the tail, so adjacent runs would compute the same label, the rival check would see no difference, and both agents would share one Box, each `rm -rf`-ing the other's work directory. `runLabelFor` keeps the last 16 digits instead, which always fits and stays readable, so a stale label still matches its run in the console.

**The Box limit counts paused Boxes.**
The free plan allowed 10 Boxes in total. Creating one more fails with "Box limit reached". Count existing Boxes before provisioning, and leave a slot for smoke tests if you can.

**The stock image already has Claude Code and Codex.**
Do not install them again. An `npm install -g` without sudo fails with a permissions error.

**Boxes are ARM64 Debian.**
Chrome for Testing has no ARM64 Linux build, so tools that download their own Chrome fail. Install Debian's `chromium` with apt. `boxuser` has passwordless sudo.

**Workers without browser access, and no way to add it.**
The first factory created its Boxes and its image without `browser: true`. Browser calls answered "browser is not enabled for this box". Setting the option and recreating a worker from the same image changed nothing, because `Box.fromSnapshot` does not send `browser` and a snapshot passes on the browser access of the Box it was taken from. It took two rounds of deleting and recreating workers, and a new image built in a browser-enabled Box, to fix. Now `factory.browser` defaults to `true`, `build-snapshot.mjs` refuses to build in a Box without browser access, and `provision-workers.mjs` and `smoke-test.mjs` test each Box they create.

**The Box's Chromium is not running until a tab is opened.**
Listing tabs does not start it, so a tool that attaches to port 9222 finds nothing at the start of a job. The factory opens a blank tab before each agent run (`startBrowser` in `src/box.mjs`).

**`agent-browser` with auto-connect on fails when there is nothing to attach to.**
It does not fall back to starting its own browser. The image turns auto-connect on only when port 9222 answers.

**Labels are limited.**
At most five labels per Box, at most 20 characters each. The claiming protocol uses up to five: factory label, agent label, `busy`, and up to two `run-` labels during a collision.

**Racing to create the same Box.**
If worker Boxes do not exist yet, parallel runs may each try to create the same named Box. Provision all workers before any burst of issues.

## Tooling

**Inline `node -e` scripts with quotes and backticks break in bash**, and a Unicode escape for the NUL character typed in a command can turn into a real NUL byte that makes a file look binary to grep. For anything beyond a one-liner, write a small script file or use an editor tool.

**Windows line endings.**
A `setup.sh` checked out with CRLF fails in the Box. The template has `.gitattributes` with `*.sh text eol=lf`, and `build-snapshot.mjs` strips `\r` before uploading.

**`claude setup-token` needs a real terminal.**
Run without one, it prints nothing and exits. The user has to run it themselves.
