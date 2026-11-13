# Private browser transport for the Oracle runner

Only browser steps use `/usr/local/libexec/neteco-ci/remote-browser-shell {0}`.
The shell waits for a root-managed Unix socket lease, runs the original blocking
Bash step as the runner user, preserves its exit status, and releases the lease
on completion. A lost lease fails the step. There is no local browser fallback.

The socket admits only root and the isolated `neteco-actions` group. Its accepted
service joins the existing runner network namespace and runs one fixed SSH
command, with read-only access to the existing operator identity and known host.
Neither credentials nor sudo are available to the runner. The private forward
binds `127.0.0.1:8997/neteco-ci-browser`; only one lease/client is admitted.
The service has its own 128 MiB maximum and does not alter runner quotas.

The remote Playwright 1.62.1 toolchain belongs to the Neteco project. Its server
wrapper checks host/cgroup memory, disk reserves and a strict 1 GB retained plus
profile budget, takes the shared E2E lock, mounts project-local native libraries
in a private namespace, drops to ubuntu, and closes when SSH stdin closes.
The socket stays idle between checks, without a remote process or lock.

Installation is an operator action: verify the runner, compatible remote runtime,
private native library gate, ownership of the existing SSH files and resource
headroom; compile `scripts/lib/remote-browser-shell.ts` to ESM with the installed
esbuild; install it and `shell.sh`/`provider.sh` under `/usr/local/libexec/neteco-ci`,
`browser-ssh.conf` under `/etc/neteco-ci` (root-only), and these units under
`/etc/systemd/system`. On SELinux hosts, label only `/var/lib/neteco-ci/browser-transport(/.*)?` as
`var_run_t` using a persistent fcontext entry and restore that own directory.
Keep SELinux enforcing. The service binds the existing identity read-only into
its private runtime directory; it never copies key material.

Validate the effective units and a real lease before
relying on CI. Keep the existing Oracle runner and staging deployment boundaries.
