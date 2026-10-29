#!/bin/bash
# Operator-installed root-owned namespace anchor, never run from a checkout.
set -euo pipefail
export PATH=/usr/bin:/bin
readonly PATH
unset BASH_ENV ENV CDPATH LD_PRELOAD LD_LIBRARY_PATH
umask 077
deny() { printf 'neteco-oracle-anchor: denied: %s\n' "$1" >&2; exit 1; }
trap 'deny check_failed' ERR
[[ $# == 0 ]] || deny unexpected_arguments
[[ "$(/usr/bin/id -u)" == 0 ]] || deny identity
readonly installed=/usr/local/libexec/neteco-ci/network-anchor.sh
[[ "${BASH_SOURCE[0]}" == "$installed" && -f "$installed" ]] || deny untrusted_hook

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
root_managed "$installed"
readonly runtime=/run/neteco-ci-network
[[ "${RUNTIME_DIRECTORY:-}" == "$runtime" && -d "$runtime" ]] || deny runtime_directory
root_managed "$runtime"
[[ "$(/usr/bin/stat -c %a -- "$runtime")" == 700 ]] || deny runtime_mode
[[ "$(< /proc/self/cgroup)" == '0::/system.slice/devtono-neteco-network.service' ]] || deny anchor_cgroup
readonly pid_file="$runtime/anchor.pid"
# systemd owns creation/removal of RuntimeDirectory. Never overwrite a leftover
# or symlink: stale bookkeeping requires operator inspection, not cleanup here.
[[ ! -e "$pid_file" && ! -L "$pid_file" ]] || deny pid_exists
set -o noclobber
printf '%s\n' "$$" > "$pid_file"
# Ordering alone is insufficient: the helper must not start before the PID file
# exists. Notify only after its root-owned bookkeeping has been persisted.
/usr/bin/systemd-notify --ready
exec /usr/bin/sleep infinity
