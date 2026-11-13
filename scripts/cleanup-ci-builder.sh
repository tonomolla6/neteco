#!/usr/bin/env bash
set -euo pipefail

[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]{1,20}$ ]]
[[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]{1,10}$ ]]
[[ "${ARTIFACT_DIR:-}" == /* ]]
artifact_name="${ARTIFACT_DIR##*/}"
[[ "$artifact_name" =~ ^neteco-container\.([A-Za-z0-9]{8})$ ]]
expected="neteco-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${BASH_REMATCH[1]}"
[[ "${BUILDER_NAME:-}" == "$expected" ]]

# setup-buildx-action installs its standalone client in this isolated runner.
# The general Docker CLI is deliberately unavailable here.
export DOCKER_HOST=unix:///run/neteco-container/docker.sock
exec buildx rm "$BUILDER_NAME"
