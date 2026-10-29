/* Operator-owned AARCH64 launcher. No arguments, arbitrary exec or job input.
 * Build: cc -std=c11 -Wall -Wextra -Werror -O2 neteco-egress-seccomp.c -o egress-seccomp
 * Install/restart/admission are separate operator actions, never done here.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/sockios.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define DENIED (SECCOMP_RET_ERRNO | EPERM)
#define DENY_SYSCALL(number) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, DENIED)
#define EXACT_ARGUMENT(index, value) \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[index]) + 4), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0), \
    BPF_STMT(BPF_RET | BPF_K, DENIED), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[index])), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (value), 1, 0), \
    BPF_STMT(BPF_RET | BPF_K, DENIED)

int neteco_install_egress_seccomp(void)
{
#if defined(__aarch64__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        DENY_SYSCALL(SYS_kill),
        DENY_SYSCALL(SYS_tkill),
        DENY_SYSCALL(SYS_tgkill),
        DENY_SYSCALL(SYS_rt_sigqueueinfo),
        DENY_SYSCALL(SYS_rt_tgsigqueueinfo),
#ifdef SYS_pidfd_send_signal
        DENY_SYSCALL(SYS_pidfd_send_signal),
#endif
        DENY_SYSCALL(SYS_ptrace),
        DENY_SYSCALL(SYS_process_vm_readv),
        DENY_SYSCALL(SYS_process_vm_writev),
#ifdef SYS_pidfd_getfd
        DENY_SYSCALL(SYS_pidfd_getfd),
#endif
#ifdef SYS_pidfd_open
        DENY_SYSCALL(SYS_pidfd_open),
#endif
#ifdef SYS_process_madvise
        DENY_SYSCALL(SYS_process_madvise),
#endif
#ifdef SYS_process_mrelease
        DENY_SYSCALL(SYS_process_mrelease),
#endif
        /* fcntl/ioctl commands are truncated to 32 bits by Linux. Reject any
         * nonzero high word too, never allowing a dangerous low-word alias.
         * Keep ordinary F_GETFL/F_SETFL and TUN ioctls for the TAP bootstrap.
         */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fcntl, 0, 11),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1]) + 4),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, DENIED),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        DENY_SYSCALL(F_SETOWN),
        DENY_SYSCALL(F_SETOWN_EX),
        DENY_SYSCALL(F_SETSIG),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ioctl, 0, 9),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1]) + 4),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, DENIED),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        DENY_SYSCALL(FIOSETOWN),
        DENY_SYSCALL(SIOCSPGRP),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        EXACT_ARGUMENT(0, AF_UNIX),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1]) + 4),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, DENIED),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_CLOEXEC | SOCK_NONBLOCK)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, DENIED),
        EXACT_ARGUMENT(2, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
        .filter = instructions,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0)
        return -1;
    return (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program);
#else
    errno = ENOTSUP;
    return -1;
#endif
}

static int deny(const char *reason)
{
    fprintf(stderr, "neteco-egress-seccomp: denied: %s\n", reason);
    return 1;
}

static int root_managed(const char *path)
{
    char current[PATH_MAX];
    struct stat entry;
    size_t length = strlen(path);
    if (!length || length >= sizeof(current) || path[0] != '/')
        return 0;
    memcpy(current, path, length + 1);
    for (;;) {
        if (lstat(current, &entry) < 0 || S_ISLNK(entry.st_mode) ||
            entry.st_uid != 0 || (entry.st_mode & 0022) != 0)
            return 0;
        if (!strcmp(current, "/"))
            return 1;
        char *slash = strrchr(current, '/');
        if (!slash)
            return 0;
        if (slash == current)
            current[1] = '\0';
        else
            *slash = '\0';
    }
}

int main(int argc, char **argv)
{
    (void)argv;
    const char installed[] = "/usr/local/libexec/neteco-ci/egress-seccomp";
    const char script[] = "/usr/local/libexec/neteco-ci/network-egress.sh";
    char executable[PATH_MAX];
    struct stat entry;
    if (argc != 1)
        return deny("unexpected_arguments");
    if (getuid() != 0 || geteuid() != 0)
        return deny("identity");
    ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (length < 0 || (size_t)length >= sizeof(executable) - 1)
        return deny("untrusted_launcher");
    executable[length] = '\0';
    if (strcmp(executable, installed) || !root_managed(installed) ||
        lstat(installed, &entry) < 0 || !S_ISREG(entry.st_mode))
        return deny("untrusted_launcher");
    if (!root_managed(script) || lstat(script, &entry) < 0 || !S_ISREG(entry.st_mode) ||
        !root_managed("/usr/bin/bash"))
        return deny("untrusted_operator_path");
    if (neteco_install_egress_seccomp() < 0)
        return deny("seccomp");
    char *const arguments[] = {"/usr/bin/bash", "--noprofile", "--norc",
                              "/usr/local/libexec/neteco-ci/network-egress.sh", NULL};
    char *const environment[] = {"PATH=/usr/bin:/bin", NULL};
    execve("/usr/bin/bash", arguments, environment);
    return deny("exec_failed");
}
