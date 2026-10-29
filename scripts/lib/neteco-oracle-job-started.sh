#!/bin/bash
# Install root-owned outside the checkout at the fixed path below. Never source
# repository scripts. Operator approval is deliberately absent until acceptance.
# GitHub runs this synchronously before steps; nonzero blocks the whole job:
# https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts
set -euo pipefail
export PATH=/usr/bin:/bin
readonly PATH
unset BASH_ENV ENV CDPATH
umask 077

deny() { printf 'neteco-oracle-job: denied: %s\n' "$1" >&2; exit 1; }
trap 'deny check_failed' ERR

# This MUST precede all job admission logic. No argument/environment can approve.
readonly approval=/etc/neteco-ci/jobs-approved
[[ -f "$approval" && ! -L "$approval" ]] || deny jobs_not_approved

root_managed() {
  local path="$1" owner mode
  while :; do
    [[ -e "$path" && ! -L "$path" ]] || deny untrusted_operator_path
    read -r owner mode <<< "$(/usr/bin/stat -c '%u %a' -- "$path")"
    [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || deny untrusted_operator_path
    (( (8#$mode & 0022) == 0 )) || deny untrusted_operator_path
    [[ "$path" != / ]] || break
    path="$(/usr/bin/dirname -- "$path")"
  done
}
verify_job_resources() {
  # Fixed additional peak (measured UI build), not a job/environment override.
  # Host service reserve is separate; cgroups must fit current + peak only.
  local -r peak=4294967296 reserve=4294967296
  local -r host_memory=/run/neteco-ci-resources/meminfo
  local available path directory current maximum swap_current swap_maximum groups=0
  # ProcSubset=pid deliberately hides /proc/meminfo. Read only the operator's
  # live, read-only bind view; never weaken proc isolation or fall back.
  root_managed "$host_memory"
  /usr/bin/test -f "$host_memory" && /usr/bin/test ! -L "$host_memory" || deny job_resources_unknown
  available="$(/usr/bin/awk '$1 == "MemAvailable:" {print $2, $3}' "$host_memory")" || deny job_resources_unknown
  [[ "$available" =~ ^[0-9]{1,12}\ kB$ ]] || deny job_resources_unknown
  available="${available% kB}"
  (( 10#$available * 1024 > peak + reserve )) || deny job_resources_memory
  path="$(/usr/bin/cat -- /proc/self/cgroup)" || deny job_resources_unknown
  [[ "$path" =~ ^0::/[a-zA-Z0-9_./@:-]*$ ]] || deny job_resources_unknown
  path="${path#0::}"
  [[ "$path" != *'//'* && "/$path/" != *'/../'* && "/$path/" != *'/./'* ]] || deny job_resources_unknown
  # The cgroup v2 root has no memory controller files; every controlled
  # ancestor below it must be readable. Never skip an unreadable parent.
  while [[ "$path" != / ]]; do
    directory="/sys/fs/cgroup$path"
    current="$(/usr/bin/cat -- "$directory/memory.current")" || deny job_resources_unknown
    maximum="$(/usr/bin/cat -- "$directory/memory.max")" || deny job_resources_unknown
    swap_current="$(/usr/bin/cat -- "$directory/memory.swap.current")" || deny job_resources_unknown
    swap_maximum="$(/usr/bin/cat -- "$directory/memory.swap.max")" || deny job_resources_unknown
    [[ "$current" =~ ^[0-9]{1,15}$ && "$swap_current" =~ ^[0-9]{1,15}$ ]] || deny job_resources_unknown
    if [[ "$maximum" != max ]]; then
      [[ "$maximum" =~ ^[0-9]{1,15}$ ]] || deny job_resources_unknown
      (( 10#$current + peak <= 10#$maximum )) || deny job_resources_cgroup
    fi
    if [[ "$swap_maximum" != max ]]; then
      [[ "$swap_maximum" =~ ^[0-9]{1,15}$ ]] || deny job_resources_unknown
      (( 10#$swap_current <= 10#$swap_maximum )) || deny job_resources_swap
    fi
    ((groups+=1))
    path="${path%/*}"
    [[ -n "$path" ]] || path=/
  done
  (( groups > 0 )) || deny job_resources_unknown
}
verify_build_storage() {
  local -r gate=/usr/local/libexec/neteco-ci/build-storage.mjs
  local -r node=/opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node
  root_managed "$gate"
  root_managed "$node"
  verify_job_resources
  "$node" "$gate" --estimated-output-gib 2 || deny build_storage_failed
}
verify_private_docker() {
  local -r wrapper=/usr/local/libexec/neteco-ci/bin/docker
  local -r cli=/usr/local/libexec/neteco-ci/docker-cli
  local -r directory=/run/neteco-container
  local -r socket=/run/neteco-container/docker.sock
  local owner group mode
  root_managed "$wrapper"
  root_managed "$cli"
  /usr/bin/test -f "$wrapper" && /usr/bin/test -x "$wrapper" || deny untrusted_operator_path
  /usr/bin/test -f "$cli" && /usr/bin/test -x "$cli" || deny untrusted_operator_path
  [[ "${DOCKER_HOST:-}" == unix:///run/neteco-container/docker.sock && -z "${DOCKER_CONTEXT:-}" ]] || deny docker_override
  root_managed /run
  /usr/bin/test -d "$directory" && /usr/bin/test ! -L "$directory" || deny private_docker_socket
  read -r owner group mode <<< "$(/usr/bin/stat -c '%u %g %a' -- "$directory")"
  [[ "$owner" == 11080 && "$group" == 11080 && "$mode" == 750 ]] || deny private_docker_socket
  /usr/bin/test -S "$socket" && /usr/bin/test ! -L "$socket" || deny private_docker_socket
  read -r owner group mode <<< "$(/usr/bin/stat -c '%u %g %a' -- "$socket")"
  [[ "$owner" == 11080 && "$group" == 11080 && "$mode" == 660 ]] || deny private_docker_socket
}
root_managed "$approval"
readonly installed=/usr/local/libexec/neteco-ci/job-started.sh
[[ "${BASH_SOURCE[0]}" == "$installed" && -f "$installed" ]] || deny untrusted_hook
root_managed "$installed"
[[ $# == 0 ]] || deny unexpected_arguments
[[ "${GITHUB_REPOSITORY:-}" == tonomolla6/neteco ]] || deny repository
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || deny reference
case "${GITHUB_EVENT_NAME:-}" in push|workflow_dispatch|schedule) ;; *) deny event ;; esac
[[ "${RUNNER_NAME:-}" == neteco-oracle-arm64-01 ]] || deny runner
[[ "$(/usr/bin/uname -m)" == aarch64 ]] || deny architecture
[[ "$(/usr/bin/id -u)" != 0 && "$(/usr/bin/id -un)" == neteco-actions ]] || deny identity
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == self-hosted ]] || deny context

readonly work_root=/var/lib/neteco-ci/runner/_work
[[ -d "$work_root" && "$(/usr/bin/realpath -e -- "$work_root")" == "$work_root" ]] || deny work_root
for directory in "${GITHUB_WORKSPACE:-}" "${RUNNER_TEMP:-}"; do
  [[ "$directory" == "$work_root/"* && -d "$directory" ]] || deny job_path
  [[ "$(/usr/bin/realpath -e -- "$directory")" == "$directory" ]] || deny job_path
  read -r blocks block_size inodes <<< "$(/usr/bin/stat -f -c '%a %S %d' -- "$directory")"
  [[ "$blocks" =~ ^[0-9]+$ && "$block_size" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ ]] || deny storage_unknown
  (( blocks * block_size >= 4294967296 && inodes >= 100000 )) || deny storage_insufficient
done

# Fail closed for privileged group membership or any noninteractive sudo grant.
case " $(/usr/bin/id -Gn) " in *' sudo '*|*' wheel '*|*' docker '*|*' root '*) deny privileged_group ;; esac
if [[ -x /usr/bin/sudo ]]; then
  if /usr/bin/timeout 2 /usr/bin/sudo -n -l >/dev/null 2>&1; then deny sudo_access; else
    sudo_status=$?
    [[ "$sudo_status" == 1 ]] || deny sudo_unknown
  fi
fi
verify_private_docker
for socket in /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock; do
  [[ ! -r "$socket" && ! -w "$socket" ]] || deny root_container_access
done

verify_build_storage
printf 'neteco-oracle-job: approved\n'
