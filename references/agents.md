# Agents

An agent type is an entry under `agents` in `factory.config.json`. No code changes are needed to add one.

```json
"name": {
  "auth": [ { "secret": "SECRET_NAME", "env": "VAR" } ],
  "env": { "EXTRA_VAR": "value" },
  "command": "the shell command, with {prompt} and {summary}"
}
```

- `auth` lists secrets the factory places in the Box before each job and removes after it. `env` exports the secret as an environment variable. `file` writes it to a path in the Box instead. `localFile` tells `set-secrets.mjs` where to read the value on the user's machine when it is not in `.env`.
- `command` runs with the repo as the working folder. `{prompt}` is a file that holds the task. `{summary}` is a file that must end up holding the agent's final reply. It becomes the PR description, and a reply that starts with `NEEDS_CLARIFICATION:` hands the issue back to the user.
- The command must run with no prompts at all: no permission questions, no login flow, no pager.
- The Box is the sandbox. It is reasonable to switch off the agent's own sandbox and approval prompts inside it. Many agent sandboxes do not work in a Box anyway (Codex warned that `bubblewrap` was missing).

Why the factory runs the CLI itself instead of using Upstash's built-in `box.agent.run`: the built-in agents take a provider API key. Running the CLI with `box.exec` works with any sign-in the CLI supports, including subscriptions, and with any CLI at all.

The secret names appear in the workflow only as `toJSON(secrets)`, so a new agent never needs a workflow edit. It needs its secret set on the factory repo (`set-secrets.mjs`) and its `agent:<name>` label in the app repos (`install-trigger.mjs`).

Always finish with `scripts/smoke-test.mjs <name>`. It uses the same sign-in and run code as the factory.

Check the current docs for each CLI before trusting the flags below. They were correct when this was written. Claude Code: https://code.claude.com/docs (Context7 library `/websites/code_claude`). Codex: https://developers.openai.com/codex and https://github.com/openai/codex (Context7 library `/openai/codex`).

## Model and reasoning effort

These are stored in the Box, not passed by the factory. Each agent type has a `boxSettings` list. The factory writes those settings into a Box when it creates it and into an image when it builds one, so a Box is a Haiku worker or a high-effort worker from the moment it exists. SKILL.md says when to ask the user about this.

`Box.create` also has an `agent.model` option. Ignore it. It belongs to Upstash's built-in agent runner, which this factory does not use.

Each entry names a settings file and how to write it:

| format | what happens |
|---|---|
| `json` | `values` are merged into the JSON file, keeping other keys |
| `toml` | `values` are merged as top-level keys, above the first `[table]`, keeping everything else |
| `text` | `content` replaces the file |

Merging matters because CLIs keep their own state in these files. Codex writes `[projects...]` trust entries into `config.toml` during normal use.

**Claude Code** reads `~/.claude/settings.json`, which in a Box is `/workspace/home/.claude/settings.json`:

```json
"boxSettings": [
  { "path": "/workspace/home/.claude/settings.json", "format": "json", "values": { "model": "haiku", "effortLevel": "low" } }
]
```

`model` takes an alias (`haiku`, `sonnet`, `opus`) or a full model name. `effortLevel` takes `low`, `medium`, `high`, `xhigh` or `max`, depending on the model. A level the model does not support falls back to the highest one it does. Verified in a Box: the default on a subscription was Sonnet, and with the file above the run used Haiku.

**Codex** reads `$CODEX_HOME/config.toml`, here `/workspace/home/.codex/config.toml`:

```json
"boxSettings": [
  { "path": "/workspace/home/.codex/config.toml", "format": "toml", "values": { "model": "MODEL-NAME", "model_reasoning_effort": "high" } }
]
```

Verified in a Box: the default reasoning effort was `none`, and with the file it reported `high`. `codex exec` prints the model and effort at the top of its log, which makes it easy to confirm.

**Any other harness:** find the user-level settings file its CLI reads and the key names for model and effort, and write a `boxSettings` entry for it. If the CLI only takes these as flags or environment variables, put them in `command` or in the agent's `env` instead and tell the user, since that is then not stored in the Box.

**Several kinds of worker on one harness.** Give each kind its own agent type. They share `auth` and `command` and differ in `boxSettings`:

```json
"claude-fast": { "auth": [ ...same... ], "command": "...same...", "boxSettings": [{ "path": "/workspace/home/.claude/settings.json", "format": "json", "values": { "model": "haiku" } }] },
"claude-deep": { "auth": [ ...same... ], "command": "...same...", "boxSettings": [{ "path": "/workspace/home/.claude/settings.json", "format": "json", "values": { "model": "opus", "effortLevel": "xhigh" } }] }
```

Workers then name their type (`{ "id": "fast-01", "agent": "claude-fast" }`), `install-trigger.mjs` creates the labels `agent:claude-fast` and `agent:claude-deep`, and the user picks per issue. An issue without an `agent:` label goes to the type with the highest `priority` that has a free worker, and among equal priorities to the type with the smaller share of busy workers. Ask the user which type should take unlabelled work first. It matters most when one type is a flat-rate subscription and another bills per token. Agent names are limited to 14 characters.

A flag in `command` overrides the Box's settings file. Keep model flags out of `command` so the Box stays the single place where this is decided.

## Claude Code

Already installed in the Upstash Node Box image (2.1.x at the time).

**With a Claude subscription** (Pro, Max, Team or Enterprise):

1. The user runs `claude setup-token` in a real terminal. It opens a browser sign-in and prints a token that lasts a year. It is not saved anywhere, so they copy it into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. It needs a real terminal: it prints nothing when run without one, so you cannot run it for them.
2. Config:

```json
"claude": {
  "auth": [{ "secret": "CLAUDE_CODE_OAUTH_TOKEN", "env": "CLAUDE_CODE_OAUTH_TOKEN" }],
  "command": "claude -p \"$(cat {prompt})\" --dangerously-skip-permissions --output-format text > {summary}"
}
```

Do not add `--bare`. Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`.

**With an API key:** same command, and `"auth": [{ "secret": "ANTHROPIC_API_KEY", "env": "ANTHROPIC_API_KEY" }]`.

User-level instructions go in `~/.claude/CLAUDE.md`, skills in `~/.claude/skills`. In a Box `~/.claude` is a link to `/workspace/home/.claude`.

## Codex CLI

Already installed in the Upstash Node Box image (0.15x at the time).

**With a ChatGPT plan:**

1. The user runs `codex login` locally and signs in with ChatGPT. This writes `~/.codex/auth.json` with `"auth_mode": "chatgpt"`.
2. Config:

```json
"codex": {
  "auth": [{ "secret": "CODEX_AUTH_JSON", "file": "/workspace/home/.codex/auth.json", "localFile": "~/.codex/auth.json" }],
  "env": { "CODEX_HOME": "/workspace/home/.codex" },
  "command": "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --output-last-message {summary} \"$(cat {prompt})\""
}
```

Caveat to tell the user: the Box gets a copy of the same login their machine uses. Codex replaces its refresh token from time to time, and when one copy does that the other can stop working. For a demo or a short-lived factory this is fine. For a long-lived one, prefer an API key, or a separate sign-in made for the factory and refreshed into the GitHub secret when it expires.

**With an API key.** Keep `CODEX_HOME`, because the Box's `config.toml` with the model and effort lives there. Confirm the variable name in the Codex docs first. It has been `CODEX_API_KEY` for `codex exec`, and `OPENAI_API_KEY` elsewhere. The smoke test shows within a minute whether it is right.

```json
"codex": {
  "auth": [{ "secret": "CODEX_API_KEY", "env": "CODEX_API_KEY" }],
  "env": { "CODEX_HOME": "/workspace/home/.codex" },
  "boxSettings": "ask",
  "command": "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --output-last-message {summary} \"$(cat {prompt})\""
}
```

User-level instructions go in `~/.codex/AGENTS.md`. The `skills` tool installs Codex skills to `~/.agents/skills`.

## OpenCode

Install it in the worker image: `npm install --global opencode-ai` (added to `worker/Dockerfile` and `worker/setup.sh`). It ships for ARM64 Linux through npm's platform packages — the smoke test confirms.

**With an API key** (any provider on OpenCode's provider list): OpenCode reads provider keys from the environment at startup, so an `env` auth entry is enough. No browser sign-in needed.

```json
"opencode": {
  "auth": [{ "secret": "ANTHROPIC_API_KEY", "env": "ANTHROPIC_API_KEY" }],
  "boxSettings": [
    { "path": "/workspace/home/.config/opencode/opencode.json", "format": "json", "values": { "model": "anthropic/claude-sonnet-4-5", "autoupdate": false } }
  ],
  "promptExtra": "When you are done, write your summary to the file {summary}, and nothing else to that file.",
  "command": "opencode run --auto \"$(cat {prompt})\" < /dev/null"
}
```

Why each piece, from the current docs (https://opencode.ai/docs):

- `opencode run` is the non-interactive mode, made for scripting and automation. `--auto` auto-approves permissions that are not explicitly denied, so nothing stops for a question nobody can answer. `--model` takes `provider/model` if you want it in the command instead of `boxSettings`, but keep it in `boxSettings` so the Box stays the single place model choice is decided. The trailing `< /dev/null` matters: with stdin left as an open pipe (as it is under the factory's runner), `run` waits on stdin instead of proceeding; closing it makes the command fail fast on errors instead of hanging.
- The run streams tool results and progress symbols to stdout, so redirecting stdout to `{summary}` would make a noisy PR description. `promptExtra` has the agent write the summary file itself instead — the factory's supported pattern for this case.
- `model` in `opencode.json` takes `provider/model` (Anthropic, OpenAI, Google, and anything models.dev lists). `autoupdate: false` stops the CLI from updating itself inside the worker, so the image stays the version that was tested. OpenCode also reads `auth.json` credentials (`opencode auth login` writes them to `~/.local/share/opencode/auth.json`), which is the `file` auth route if you ever want a subscription-style login instead of a key.

To give it a worker, add `{ "id": "opencode-01", "agent": "opencode", "enabled": true }` to `workers`, run `install-trigger.mjs` for the `agent:opencode` label, and set the provider key with `set-secrets.mjs`. An agent type with no enabled worker gets no label and no secrets, so adding the type alone changes nothing for existing factories.

User-level instructions: OpenCode reads `AGENTS.md` in the repo natively, and `jobFiles` can place a house one. Cost: OpenCode itself is free and open source — billing is whatever the provider key bills.

## Any other agent

Work through these with the user, then prove it with the smoke test.

1. **Is the CLI in the Box image?** The smoke test tells you. If not, it has to be installed in the worker image (`worker/setup.sh`, Stage 6) before that agent type can run. `boxuser` has passwordless sudo, so `sudo npm install --global <package>` works. The Box is ARM64 Linux, so check the CLI ships for that platform.
2. **How does it sign in without a browser?** Usually an API key in an environment variable (`env` auth entry) or a credentials file (`file` auth entry).
3. **What is its non-interactive mode?** Look for a "run", "exec", "print" or "headless" command and for the flag that skips approval prompts.
4. **How do you get the final reply into `{summary}`?** Either a flag that writes the last message to a file, or redirect standard output with `> {summary}` if the CLI prints only the reply. If it prints progress too, the summary will be noisy. Then leave the redirect out and set `promptExtra` to something like "When you are done, write your summary to the file {summary}, and nothing else to that file." No code change is needed. The CLI must be allowed to write outside the repo folder without asking.
5. **Where are its user-level files?** Settings for `boxSettings`, house rules for `jobFiles`, MCP registration. They do not have to be under `/workspace/home`. Writing files anywhere `boxuser` may write works, and snapshots keep the whole disk.
6. **Does it update itself or upload anything?** Switch off self-update, so the image stays the version that was tested, and switch off session sharing or telemetry that uploads conversations.

A sketch for a generic third CLI agent. It loads, but none of it was run, so check every name against that CLI's docs and let the smoke test judge:

```json
"myagent": {
  "auth": [{ "secret": "MY_AGENT_API_KEY", "env": "MY_AGENT_API_KEY" }],
  "boxSettings": [
    { "path": "/home/boxuser/.config/myagent/config.json", "format": "json", "values": { "model": "PROVIDER/MODEL", "autoupdate": false, "share": "disabled" } }
  ],
  "promptExtra": "When you are done, write your summary to the file {summary}, and nothing else to that file.",
  "command": "myagent run \"$(cat {prompt})\""
}
```

The CLI is not in the stock Box, so it goes into the image (`sudo npm install --global my-agent-cli`, if it ships an ARM64 Linux build), and the image comes before this agent type's smoke test. Its permission settings must allow edits, shell commands and writing the summary file without asking, because nobody can answer a prompt in a Box.

## Things to tell the user about cost and limits

With a subscription:

- All workers of one type share that subscription's rate limits. Five parallel sessions per subscription ran without hitting limits in the original build, with small tasks. Heavier tasks may throttle, and those issues end in `factory:needs-attention`.
- They should check that their plan's terms allow automated, unattended use.

With an API key:

- Spend is open-ended. Every labelled issue costs money, a failed check costs a second agent run, and parallel workers multiply both. Suggest a key made for this project, with a spending limit on the provider's side, and a look at the usage page after the scale test.
- Parallel workers share the account's rate-limit tier.

Either way: credentials sit in GitHub secrets and, during a job, on the Box's disk. The factory deletes them after each job. They should still be rotated when the project ends, and anyone in `allowedActors` can spend them.
