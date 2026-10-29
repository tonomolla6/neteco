import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'neteco-egress-seccomp-'))
const binary = join(directory, 'probe')
const source = resolve('infra/oracle-runner/neteco-egress-seccomp.c')
// Include the real filter but never invoke the launcher or installed script.
const harness = `
#define main neteco_launcher_main
#include ${JSON.stringify(source)}
#undef main
#include <fcntl.h>
#include <sys/ioctl.h>
#include <linux/sockios.h>
#include <sys/wait.h>
int main(int argc, char **argv) {
  if (argc != 2) return 90;
  if (!strcmp(argv[1], "launcher-args")) {
    char *args[] = {"probe", "--exec=/tmp/untrusted", NULL};
    return neteco_launcher_main(2, args);
  }
  pid_t child = fork();
  if (child < 0) return 91;
  if (!child) {
    /* Signal zero checks only this child and sends no signal. */
    if (syscall(SYS_kill, getpid(), 0) != 0) _exit(98);
    if (neteco_install_egress_seccomp() < 0) {
      _exit(92);
    }
    long signal_result = 0;
    int signal_case = 1;
    errno = 0;
    if (!strcmp(argv[1], "kill")) signal_result = syscall(SYS_kill, getpid(), 0);
    else if (!strcmp(argv[1], "tkill")) signal_result = syscall(SYS_tkill, syscall(SYS_gettid), 0);
    else if (!strcmp(argv[1], "tgkill")) signal_result = syscall(SYS_tgkill, getpid(), syscall(SYS_gettid), 0);
    else if (!strcmp(argv[1], "rt_sigqueueinfo")) signal_result = syscall(SYS_rt_sigqueueinfo, getpid(), 0, NULL);
    else if (!strcmp(argv[1], "rt_tgsigqueueinfo")) signal_result = syscall(SYS_rt_tgsigqueueinfo, getpid(), syscall(SYS_gettid), 0, NULL);
    else if (!strcmp(argv[1], "pidfd_send_signal")) signal_result = syscall(SYS_pidfd_send_signal, -1, 0, NULL, 0);
    else if (!strcmp(argv[1], "ptrace")) signal_result = syscall(SYS_ptrace, 2, getpid(), NULL, NULL);
    else if (!strcmp(argv[1], "process_vm_readv")) signal_result = syscall(SYS_process_vm_readv, getpid(), NULL, 0, NULL, 0, 0);
    else if (!strcmp(argv[1], "process_vm_writev")) signal_result = syscall(SYS_process_vm_writev, getpid(), NULL, 0, NULL, 0, 0);
    else if (!strcmp(argv[1], "pidfd_getfd")) signal_result = syscall(SYS_pidfd_getfd, -1, -1, 0);
    else if (!strcmp(argv[1], "pidfd_open")) signal_result = syscall(SYS_pidfd_open, getpid(), 0);
    else if (!strcmp(argv[1], "process_madvise")) signal_result = syscall(SYS_process_madvise, -1, NULL, 0, 0, 0);
    else if (!strcmp(argv[1], "process_mrelease")) signal_result = syscall(SYS_process_mrelease, -1, 0);
    else signal_case = 0;
    if (signal_case) _exit(signal_result == -1 && errno == EPERM ? 0 : 99);
    if (!strncmp(argv[1], "fcntl-", 6) || !strncmp(argv[1], "ioctl-", 6)) {
      int pair[2], owner = getpid();
      if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) _exit(100);
      struct f_owner_ex extended = {.type = F_OWNER_PID, .pid = owner};
      unsigned long high = strstr(argv[1], "high") ? 1UL << 32 : 0;
      long result;
      errno = 0;
      if (!strcmp(argv[1], "fcntl-flags")) {
        int flags = fcntl(pair[0], F_GETFL);
        _exit(flags >= 0 && fcntl(pair[0], F_SETFL, flags | O_NONBLOCK) == 0 ? 0 : 101);
      }
      if (!strncmp(argv[1], "fcntl-own-ex", 12)) result = syscall(SYS_fcntl, pair[0], high | F_SETOWN_EX, &extended);
      else if (!strncmp(argv[1], "fcntl-own", 9)) result = syscall(SYS_fcntl, pair[0], high | F_SETOWN, owner);
      else if (!strcmp(argv[1], "fcntl-signal")) result = syscall(SYS_fcntl, pair[0], F_SETSIG, 0);
      else if (!strncmp(argv[1], "ioctl-owner", 11)) result = syscall(SYS_ioctl, pair[0], high | FIOSETOWN, &owner);
      else if (!strncmp(argv[1], "ioctl-group", 11)) result = syscall(SYS_ioctl, pair[0], high | SIOCSPGRP, &owner);
      else _exit(102);
      _exit(result == -1 && errno == EPERM ? 0 : 103);
    }
    int fds[2], type = SOCK_STREAM, family = AF_UNIX, protocol = 0;
    unsigned long extra = 0, domain_extra = 0, protocol_extra = 0;
    int denied = 0;
    if (!strcmp(argv[1], "stream-flags")) type |= SOCK_CLOEXEC | SOCK_NONBLOCK;
    else if (!strcmp(argv[1], "dgram")) { type = SOCK_DGRAM; denied = 1; }
    else if (!strcmp(argv[1], "seqpacket")) { type = SOCK_SEQPACKET; denied = 1; }
    else if (!strcmp(argv[1], "badflags")) { type |= 0x10000000; denied = 1; }
    else if (!strcmp(argv[1], "badfamily")) { family = AF_INET; denied = 1; }
    else if (!strcmp(argv[1], "protocol")) { protocol = 17; denied = 1; }
    else if (!strcmp(argv[1], "highbits")) { extra = 1UL << 32; denied = 1; }
    else if (!strcmp(argv[1], "highdomain")) { domain_extra = 1UL << 32; denied = 1; }
    else if (!strcmp(argv[1], "highprotocol")) { protocol_extra = 1UL << 32; denied = 1; }
    else if (strcmp(argv[1], "stream")) _exit(93);
    errno = 0;
    long result = syscall(SYS_socketpair, (unsigned long) family | domain_extra,
                          (unsigned long) type | extra, (unsigned long) protocol | protocol_extra, fds);
    if (denied) _exit(result == -1 && errno == EPERM ? 0 : 94);
    if (result || getpid() <= 0) _exit(95);
    char byte = 'x', received = 0;
    if (write(fds[0], &byte, 1) != 1 || read(fds[1], &received, 1) != 1 || received != byte) _exit(96);
    close(fds[0]); close(fds[1]);
    _exit(0);
  }
  int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 97;
  return WEXITSTATUS(status);
}
`

beforeAll(() => {
  const result = spawnSync(
    '/usr/bin/cc',
    ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-x', 'c', '-', '-o', binary],
    {
      input: harness,
      encoding: 'utf8',
      timeout: 5000
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('real Oracle AARCH64 seccomp filter (requires native ARM64; no unsupported-host PASS)', () => {
  it.each([
    'stream',
    'stream-flags',
    'dgram',
    'seqpacket',
    'badflags',
    'badfamily',
    'protocol',
    'highbits',
    'highdomain',
    'highprotocol',
    'kill',
    'tkill',
    'tgkill',
    'rt_sigqueueinfo',
    'rt_tgsigqueueinfo',
    'pidfd_send_signal',
    'ptrace',
    'process_vm_readv',
    'process_vm_writev',
    'pidfd_getfd',
    'pidfd_open',
    'process_madvise',
    'process_mrelease',
    'fcntl-own',
    'fcntl-own-ex',
    'fcntl-signal',
    'ioctl-owner',
    'ioctl-group',
    'fcntl-own-high',
    'fcntl-own-ex-high',
    'ioctl-owner-high',
    'ioctl-group-high',
    'fcntl-flags'
  ])('enforces %s in an isolated fork, never running operator bootstrap', (mode) => {
    const result = spawnSync(binary, [mode], { env: {}, encoding: 'utf8', timeout: 1000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('rejects arbitrary command-line execution before bootstrap', () => {
    const result = spawnSync(binary, ['launcher-args'], { env: {}, encoding: 'utf8', timeout: 1000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe('neteco-egress-seccomp: denied: unexpected_arguments')
  })

  it('keeps the private mount bootstrap and fixed root-managed launcher in the unit', () => {
    const unit = readFileSync(resolve('infra/oracle-runner/devtono-neteco-egress.service'), 'utf8')
    expect(unit).toMatch(
      /^ExecStart=\/usr\/bin\/unshare --mount --propagation private \/usr\/local\/libexec\/neteco-ci\/egress-seccomp$/m
    )
    expect(unit).toMatch(/^RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK$/m)
    expect(unit).toMatch(/^SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register$/m)
  })
})
