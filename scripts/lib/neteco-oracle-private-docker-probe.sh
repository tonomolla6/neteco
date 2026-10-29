#!/bin/bash
# Operator acceptance only: temporarily replace ExecStart in the real isolated
# runner unit. Does not approve jobs, read credentials or contact host Docker.
set -euo pipefail
trap 'printf "private-docker-probe: failed at line %s\n" "$LINENO" >&2' ERR
[[ "$#" == 0 ]] || exit 1
[[ "$(/usr/bin/id -u)" == 980 && "$(/usr/bin/id -g)" == 979 ]]
[[ " $(/usr/bin/id -G) " == *' 11080 '* ]]
[[ "${DOCKER_HOST:-}" == unix:///run/neteco-container/docker.sock ]]
[[ -z "${DOCKER_CONTEXT:-}" ]]
[[ "$(command -v docker)" == /usr/local/libexec/neteco-ci/bin/docker ]]
[[ -S /run/neteco-container/docker.sock ]]
[[ "$(/usr/bin/stat -c '%u %g %a' /run/neteco-container/docker.sock)" == '11080 11080 660' ]]
for denied in /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /run/user/11080/bus /root /home; do
  [[ ! -r "$denied" && ! -w "$denied" ]]
done
/opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node /usr/local/libexec/neteco-ci/build-storage.mjs --estimated-output-gib 2
/opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node --input-type=module -e '
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  import { execFileSync } from "node:child_process";
  const status = readFileSync("/proc/self/status", "utf8");
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  const result = JSON.parse(execFileSync("/usr/local/libexec/neteco-ci/bin/docker", ["info", "--format", "{{json .}}"], { encoding: "utf8", timeout: 15000 }));
  assert.equal(result.DockerRootDir, "/var/lib/neteco-ci-runtime/builder/data");
  assert.equal(result.CgroupDriver, "systemd");
  assert.equal(result.CgroupVersion, "2");
  assert(result.SecurityOptions.includes("name=rootless"));
  assert(result.SecurityOptions.some(value => value.startsWith("name=seccomp")));
  console.log(JSON.stringify({ acceptance: "private-docker", uid: process.getuid(), serverVersion: result.ServerVersion, cgroupDriver: result.CgroupDriver, cgroupVersion: result.CgroupVersion, rootless: true, images: result.Images, containers: result.Containers }));
'
