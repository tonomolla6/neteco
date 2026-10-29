#!/bin/bash
# Operator-installed, root-owned, outside any checkout. No job-controlled input.
# Existing slirp4netns provides the stack; this wrapper only selects our anchor.
set -euo pipefail
export PATH=/usr/bin:/bin
readonly PATH
unset BASH_ENV ENV CDPATH LD_PRELOAD LD_LIBRARY_PATH
deny() { printf 'neteco-oracle-egress: denied: %s\n' "$1" >&2; exit 1; }
trap 'deny check_failed' ERR
[[ $# == 0 ]] || deny unexpected_arguments
[[ "$(/usr/bin/id -u)" == 0 ]] || deny identity
readonly installed=/usr/local/libexec/neteco-ci/network-egress.sh
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
readonly pid_file=/run/neteco-ci-network/anchor.pid
[[ -f "$pid_file" ]] || deny anchor_pid_file
root_managed "$pid_file"
[[ "$(/usr/bin/stat -c %a -- /run/neteco-ci-network)" == 700 ]] || deny runtime_mode
[[ "$(/usr/bin/stat -c %a -- "$pid_file")" == 600 ]] || deny pid_mode
anchor_pid="$(< "$pid_file")"
[[ "$anchor_pid" =~ ^[1-9][0-9]{0,9}$ ]] || deny anchor_pid
readonly anchor_pid
readonly target="/proc/$anchor_pid/ns/net"
[[ "$(/usr/bin/stat -c %u "/proc/$anchor_pid")" == 0 ]] || deny anchor_identity
[[ "$(< "/proc/$anchor_pid/cgroup")" == '0::/system.slice/devtono-neteco-network.service' ]] || deny anchor_cgroup
anchor_netns="$(/usr/bin/readlink "$target")"
[[ "$anchor_netns" =~ ^net:\[[0-9]+\]$ && "$anchor_netns" != "$(/usr/bin/readlink /proc/self/ns/net)" ]] || deny anchor_namespace
# All mounts below must remain private. systemd filesystem/chroot sandboxing
# cannot be used for this helper: upstream slirp's pivot_root returns EINVAL.
[[ "$(/usr/bin/readlink /proc/self/ns/mnt)" != "$(/usr/bin/readlink /proc/1/ns/mnt)" ]] || deny mount_namespace
# Capture only the operator-managed DNS file before hiding the whole of /etc.
# No host /etc secrets or runtime sockets remain visible to the serving stack.
root_managed /etc/neteco-ci/resolv.conf
[[ -f /etc/neteco-ci/resolv.conf ]] || deny dns_file
exec 9< /etc/neteco-ci/resolv.conf
/usr/bin/mount -t tmpfs -o mode=0755,size=64k,nodev,nosuid,noexec tmpfs /etc
/usr/bin/install -m 0444 /proc/self/fd/9 /etc/resolv.conf
exec 9<&-
/usr/bin/mount -o remount,ro /etc
/usr/bin/mount -t tmpfs -o mode=0755,size=4k,nodev,nosuid,noexec,ro tmpfs /run
# No API socket, host forwards, IPv6 translation or host DNS redirect. The
# helper cgroup also blocks private/link-local/self-public IPv4/IPv6 targets.
exec /usr/bin/slirp4netns --configure --mtu=65520 --disable-host-loopback --disable-dns \
  --enable-sandbox --enable-seccomp --netns-type=path "$target" tap0
