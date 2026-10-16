# Minimal worker image for the Docker provider (worker.provider: "docker").
# Build:  docker build -f worker/Dockerfile -t create-ant-factory-worker:latest .
#
# This is the Docker counterpart of a worker snapshot: slow, rarely changing
# tools only. No secrets and no app code belong in an image — the factory
# clones the repo and writes sign-in files inside the container at job time,
# then removes the container. Add language toolchains here the way
# worker/setup.sh adds them to a Box (see references/worker-image.md), and
# keep the final check so a broken image fails the build, not the first job.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git ca-certificates curl python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

# The two agent CLIs the template ships with. Pin or drop as needed.
RUN npm install --global --silent @anthropic-ai/claude-code @openai/codex

RUN mkdir -p /workspace/home/work /workspace/home/.factory
WORKDIR /workspace/home/work

# --- check -------------------------------------------------------------------
RUN node --version && git --version && claude --version && codex --version

# The factory keeps the container alive and drives it with `docker exec`;
# it is removed when the job ends.
CMD ["sleep", "infinity"]
