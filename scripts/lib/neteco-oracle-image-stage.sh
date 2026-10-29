#!/bin/bash
# Root-managed, manually started staging only. No CI admission or installation.
set -euo pipefail
export PATH=/usr/bin:/bin
readonly PATH
unset BASH_ENV ENV CDPATH LD_PRELOAD LD_LIBRARY_PATH
umask 077
deny() { printf 'neteco-oracle-image-stage: denied: %s\n' "$1" >&2; exit 1; }
trap 'deny check_failed' ERR
readonly installed=/usr/local/libexec/neteco-ci/image-stage.sh
# This precedes identity checks and all filesystem writes, even on approved CI.
[[ "${BASH_SOURCE[0]:-}" == "$installed" && -f "$installed" ]] || deny untrusted_hook
[[ $# == 0 ]] || deny unexpected_arguments
[[ "$(/usr/bin/id -u)" == 980 && "$(/usr/bin/id -g)" == 979 ]] || deny identity
[[ "$(< /proc/self/cgroup)" == '0::/system.slice/devtono-neteco-image-stage.service' ]] || deny staging_cgroup

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

readonly volume=/var/lib/neteco-ci-runtime
readonly stage=/var/lib/neteco-ci-runtime/stage
readonly crane=/usr/local/libexec/neteco-ci/crane
readonly image=mcr.microsoft.com/playwright@sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd
root_managed "$installed"
root_managed "$crane"
[[ -f "$crane" && -x "$crane" ]] || deny crane_binary
root_managed "$volume"
[[ -d "$stage" && ! -L "$stage" && "$(/usr/bin/realpath -e -- "$stage")" == "$stage" ]] || deny stage_path
[[ "$(/usr/bin/stat -c '%u:%g:%a' -- "$stage")" == 980:979:700 ]] || deny stage_permissions
/usr/bin/mountpoint -q -- "$volume" || deny runtime_mount
read -r mount_target mount_type mount_device <<< "$(/usr/bin/findmnt --noheadings --output TARGET,FSTYPE,MAJ:MIN --target "$volume")"
[[ "$mount_target" == "$volume" && "$mount_type" == ext4 && "$mount_device" != "$(/usr/bin/findmnt --noheadings --output MAJ:MIN --target /)" ]] || deny runtime_filesystem
# ReadWritePaths may bind-mount stage onto itself in the service namespace.
# Compare filesystem devices rather than requiring stage's mount target name.
[[ "$(/usr/bin/stat -c %d -- "$stage")" == "$(/usr/bin/stat -c %d -- "$volume")" ]] || deny stage_filesystem

storage_gate() {
  local path="$1" blocks block_size inodes
  read -r blocks block_size inodes <<< "$(/usr/bin/stat -f -c '%a %S %d' -- "$path")"
  [[ "$blocks" =~ ^[0-9]+$ && "$block_size" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ ]] || deny storage_unknown
  (( blocks * block_size >= 12884901888 && inodes >= 100000 )) || deny storage_insufficient
}
storage_gate /
storage_gate "$stage"
# No reuse, cleanup or partial retry: the operator must inspect any leftovers.
[[ -z "$(/usr/bin/find "$stage" -mindepth 1 -maxdepth 1 -print -quit)" ]] || deny stage_not_empty
/usr/bin/mkdir --mode=0700 -- "$stage/docker-config" "$stage/tmp" "$stage/rootfs"

# Public immutable image, empty auth config, no host HOME/config/daemon access.
# A full successful export verifies all layers before extraction can begin.
/usr/bin/env -i PATH=/usr/bin:/bin DOCKER_CONFIG="$stage/docker-config" TMPDIR="$stage/tmp" \
  GOMAXPROCS=1 GOMEMLIMIT=512MiB \
  "$crane" --platform linux/arm64 export "$image" "$stage/rootfs.tar"
[[ -s "$stage/rootfs.tar" && ! -L "$stage/rootfs.tar" ]] || deny empty_archive
# Extraction remains UID980 inside the stage-only RW service. A conventional
# image umask preserves public read/execute bits for the later root-owned seal;
# neither archive owners nor special host labels/ACLs are imported.
umask 022
/usr/bin/env -i PATH=/usr/bin:/bin TMPDIR="$stage/tmp" \
  /usr/bin/tar --extract --file "$stage/rootfs.tar" --directory "$stage/rootfs" \
  --no-same-owner --no-same-permissions --delay-directory-restore --no-xattrs --no-acls
printf 'neteco-oracle-image-stage: staged; operator verification and sealing required\n'
