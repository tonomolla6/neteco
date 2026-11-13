#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 0 ]]
# Fixed operator-owned transport. No command or SSH option comes from the runner.
exec /usr/bin/ssh -T -e none -F /etc/neteco-ci/browser-ssh.conf \
  -o BatchMode=yes -o ExitOnForwardFailure=yes -o PermitLocalCommand=no \
  -o ForwardAgent=no -o ControlMaster=no -o ControlPath=none -o ControlPersist=no \
  -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
  -L 127.0.0.1:8997:127.0.0.1:8997 devtono-e2e \
  'bash /home/ubuntu/e2e-projects/neteco-playwright-1.62.1/native-browser-server-test-fix-20261112.sh serve'
