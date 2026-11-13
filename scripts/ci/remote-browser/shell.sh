#!/usr/bin/env bash
set -euo pipefail
exec /opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node /usr/local/libexec/neteco-ci/remote-browser-shell.mjs "$@"
