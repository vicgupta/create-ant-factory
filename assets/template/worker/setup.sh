#!/bin/bash
# Defines what goes into the worker image. scripts/build-snapshot.mjs runs this
# inside a Box and then takes a snapshot of the result.
#
# Put slow, rarely changing things here: agent CLIs the Box image lacks, agent
# skills, MCP servers, a browser, language toolchains. Keep app code and secrets
# out. Code goes stale, and the factory writes secrets at the start of each job.
#
# Facts about a Box: Debian 12 on ARM64, user "boxuser" with passwordless sudo,
# Node, git, Claude Code and Codex already installed.
set -euo pipefail

# --- Agent skills (example) ------------------------------------------------
# Installs one skill globally for the listed agents. Claude Code reads
# ~/.claude/skills, Codex reads ~/.agents/skills.
add_skill() {
  echo "--- skill: $2"
  npx -y skills@latest add "$1" --skill "$2" --global --agent claude-code codex --copy --yes
}
# add_skill https://github.com/anthropics/skills frontend-design

# --- A browser tool for agents that check their own work (example) ----------
# The Box itself has browser access ("browser": true in factory.config.json,
# the default): Upstash runs a Chromium that the factory starts before each job
# and that then listens on port 9222. This installs the tool the agent drives it
# with. Build this image in a Box that has browser access, because every Box
# made from the image gets the browser access of the Box it was built in.
#
# Auto-connect makes agent-browser attach to Upstash's Chromium, so the Upstash
# console shows what the agent does. With auto-connect on and no Chromium
# running it fails instead of starting one, so it is switched on only when port
# 9222 answers. Otherwise agent-browser starts Debian's Chromium (Chrome has no
# ARM64 Linux download).
# sudo apt-get update -qq
# sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium > /dev/null
# sudo npm install --global --silent agent-browser
# sudo tee /etc/profile.d/agent-browser.sh > /dev/null <<'PROFILE'
# export AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
# if (exec 3<>/dev/tcp/127.0.0.1/9222) 2>/dev/null; then export AGENT_BROWSER_AUTO_CONNECT=1; fi
# PROFILE

# --- Another agent CLI (example) ---------------------------------------------
# sudo npm install --global --silent <agent-cli-package>

# --- OpenCode ------------------------------------------------------------------
# Third first-class agent option, alongside Claude Code and Codex.
sudo npm install --global --silent opencode-ai

# --- Check ---------------------------------------------------------------------
# The build log is the only evidence of what is in the image, and the build
# must fail when something is missing. List every tool the workers rely on.
echo "--- check"
node --version
git --version
opencode --version
# claude --version
# codex --version
