# OpenCode agent image.
#
# This is the ONLY image in the platform that runs a networked agent process.
# It is deliberately separate from the executor image (node:20-slim, --network none)
# so the two postures can never be confused: the agent reasons here, the verdict
# is always produced there.
#
# Pinned by version on purpose. `opencode upgrade` inside a task would make runs
# irreproducible, so the version is a build arg and never floats.
FROM node:20-slim

ARG OPENCODE_VERSION=1.18.28

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g opencode-ai@${OPENCODE_VERSION} \
 && npm cache clean --force

LABEL openhours.opencode.version="${OPENCODE_VERSION}"

WORKDIR /workspace
