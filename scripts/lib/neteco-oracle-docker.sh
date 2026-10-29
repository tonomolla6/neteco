#!/bin/bash
# Operator installs this file root-managed; never use a production Docker socket.
# Delegate flag validation to the official CLI. Buildx drivers/endpoints are
# independent configuration: this wrapper is not universal Docker API confinement.
exec /usr/local/libexec/neteco-ci/docker-cli --host=unix:///run/neteco-container/docker.sock "$@"
