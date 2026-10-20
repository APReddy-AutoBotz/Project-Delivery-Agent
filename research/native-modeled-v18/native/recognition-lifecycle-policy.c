/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Acceptance-only x86_64 Linux kernel policy; architecture V2 f1914103a1bf...
 * DRAFT SOURCE ONLY. Production native qualification remains hard closed.
 */
#define _GNU_SOURCE
#include "recognition-lifecycle-policy.h"

#if !defined(__linux__) || !defined(__x86_64__)
#error "The reviewed native policy supports Linux x86_64 only"
#endif

#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/close_range.h>
#include <linux/magic.h>
#include <linux/seccomp.h>
#include <stdint.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <unistd.h>

#define ARG_LOW(n) ((unsigned int)offsetof(struct seccomp_data, args[(n)]))
#define ARG_HIGH(n) (ARG_LOW(n) + 4U)
#define RETURN_ERRNO(value) BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (value))
#define RETURN_ALLOW BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
#define DENY_CALL(number, error) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), RETURN_ERRNO(error)
#define TRACE_CALL(number, tag) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE | (tag))
#define ALLOW_OPTION(option) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (option), 0, 1), RETURN_ALLOW

/* A RET_TRACE is a pre-entry stop, not permission or a successful operation.
 * The fixed observer must validate/reserve and handle the actual result/birth.
 * Clone flags and single-threaded/exclusive-table exec are observer checks.
 * Missing observer/unsupported transition can never supply native admission.
 */
static const struct sock_filter lifecycle_policy[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    /* Historical x32 aliases without the ABI bit on kernels before 5.4.
     * Reject the entire legacy range without assuming a qualified kernel.
     */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 512U, 0, 2),
    BPF_JUMP(BPF_JMP | BPF_JGT | BPF_K, 547U, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

    /* No pointer-based clone3 interpretation or hidden table split. ENOSYS is
     * an explicitly proposed compatibility probe, not a proven libc fallback.
     */
    DENY_CALL(__NR_clone3, ENOSYS),
    DENY_CALL(__NR_unshare, EPERM),
    DENY_CALL(__NR_setns, EPERM),
    DENY_CALL(__NR_setrlimit, EPERM),
    DENY_CALL(__NR_ptrace, EPERM),
    DENY_CALL(__NR_process_vm_readv, EPERM),
    DENY_CALL(__NR_process_vm_writev, EPERM),
    DENY_CALL(__NR_pidfd_getfd, EPERM),
    DENY_CALL(__NR_bpf, EPERM),
    DENY_CALL(__NR_seccomp, EPERM),
    DENY_CALL(__NR_io_uring_setup, EPERM),
    DENY_CALL(__NR_io_uring_register, EPERM),
    DENY_CALL(__NR_io_uring_enter, EPERM),
    DENY_CALL(__NR_recvmsg, EPERM),
    DENY_CALL(__NR_recvmmsg, EPERM),

    /* prlimit64 may query but never change a limit. Check both pointer halves;
     * accepting only a zero low word would admit a non-null 64-bit pointer.
     * Both outcomes return here, so the next rule still has syscall nr in A.
     */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prlimit64, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_HIGH(2)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    RETURN_ERRNO(EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LOW(2)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    RETURN_ERRNO(EPERM),
    RETURN_ALLOW,

    /* close_range without UNSHARE preserves topology. Trace retirement before
     * its possible physical edge for the genuine shared cleanup clock; this
     * is not universal FD/OFD accounting. Include ordinary close/shutdown too.
     */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_close_range, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LOW(2)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLOSE_RANGE_UNSHARE, 0, 1),
    RETURN_ERRNO(EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE | PDAA_TRACE_RETIREMENT),

    /* Fixed harmless naming/query operations only; block policy/dumpability/
     * ptracer changes. The bootstrap sets no_new_privs before this program.
     */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prctl, 0, 12),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LOW(0)),
    ALLOW_OPTION(PR_SET_NAME),
    ALLOW_OPTION(PR_GET_NAME),
    ALLOW_OPTION(PR_GET_NO_NEW_PRIVS),
    ALLOW_OPTION(PR_GET_SECCOMP),
    ALLOW_OPTION(PR_GET_DUMPABLE),
    RETURN_ERRNO(EPERM),

    TRACE_CALL(__NR_fork, PDAA_TRACE_BIRTH),
    TRACE_CALL(__NR_vfork, PDAA_TRACE_BIRTH),
    TRACE_CALL(__NR_clone, PDAA_TRACE_BIRTH),
    TRACE_CALL(__NR_execve, PDAA_TRACE_EXEC),
    TRACE_CALL(__NR_execveat, PDAA_TRACE_EXEC),
    TRACE_CALL(__NR_close, PDAA_TRACE_RETIREMENT),
    TRACE_CALL(__NR_shutdown, PDAA_TRACE_RETIREMENT),
    TRACE_CALL(__NR_exit, PDAA_TRACE_RETIREMENT),
    TRACE_CALL(__NR_exit_group, PDAA_TRACE_RETIREMENT),
    RETURN_ALLOW
};

const struct sock_filter *pdaa_lifecycle_policy_instructions(size_t *count)
{
    if (count != NULL) {
        *count = sizeof(lifecycle_policy) / sizeof(lifecycle_policy[0]);
    }
    return lifecycle_policy;
}

/* /proc metadata only, no target argv/environment or raw exception output.
 * Validate the procfs mount and cap every scan. The listing FD itself counts.
 */
static int bounded_proc_inventory(const char *path, unsigned int maximum,
                                  int only_pid_one)
{
    DIR *directory = opendir(path);
    struct statfs filesystem;
    struct dirent *entry;
    unsigned int count = 0;
    int valid = 1;
    if (directory == NULL) return 0;
    if (fstatfs(dirfd(directory), &filesystem) != 0 || filesystem.f_type != PROC_SUPER_MAGIC) {
        valid = 0;
    }
    errno = 0;
    while (valid && (entry = readdir(directory)) != NULL) {
        const unsigned char *name = (const unsigned char *)entry->d_name;
        unsigned int number = 0;
        unsigned int digits = 0;
        if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) continue;
        if (++count > maximum) { valid = 0; break; }
        while (*name != '\0') {
            if (*name < '0' || *name > '9' || ++digits > 10 || number > (UINT_MAX - 9U) / 10U) {
                valid = 0;
                break;
            }
            number = number * 10U + (unsigned int)(*name - '0');
            name++;
        }
        if (digits == 0 || (only_pid_one ? number != 1U : number >= PDAA_TARGET_NOFILE)) valid = 0;
        errno = 0;
    }
    if (errno != 0) valid = 0;
    if (closedir(directory) != 0) valid = 0; /* once only; caller terminates */
    return valid && (only_pid_one ? count == 1U : count > 0U);
}

enum pdaa_policy_result pdaa_install_lifecycle_policy(void)
{
    struct rlimit descriptors, cores = {0, 0};
    struct sock_fprog program;
    if (sizeof(void *) != 8 || sizeof(struct seccomp_data) != 64) return PDAA_POLICY_PLATFORM;
    if (getpid() != 1 || getuid() != 1000 || geteuid() != 1000) return PDAA_POLICY_IDENTITY;
    if (!bounded_proc_inventory("/proc/self/task", 1U, 1) ||
        !bounded_proc_inventory("/proc/self/fd", PDAA_TARGET_NOFILE, 0)) return PDAA_POLICY_INVENTORY;
    if (getrlimit(RLIMIT_NOFILE, &descriptors) != 0 || descriptors.rlim_max < PDAA_TARGET_NOFILE) return PDAA_POLICY_LIMIT;
    descriptors.rlim_cur = PDAA_TARGET_NOFILE;
    descriptors.rlim_max = PDAA_TARGET_NOFILE;
    if (setrlimit(RLIMIT_NOFILE, &descriptors) != 0 || setrlimit(RLIMIT_CORE, &cores) != 0) return PDAA_POLICY_LIMIT;
    if (getrlimit(RLIMIT_NOFILE, &descriptors) != 0 || descriptors.rlim_cur != PDAA_TARGET_NOFILE ||
        descriptors.rlim_max != PDAA_TARGET_NOFILE) return PDAA_POLICY_LIMIT;
    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0 || prctl(PR_GET_NO_NEW_PRIVS, 0L, 0L, 0L, 0L) != 1) {
        return PDAA_POLICY_NO_NEW_PRIVILEGES;
    }
    program.len = (unsigned short)(sizeof(lifecycle_policy) / sizeof(lifecycle_policy[0]));
    program.filter = (struct sock_filter *)lifecycle_policy;
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) != 0) return PDAA_POLICY_FILTER;
    return PDAA_POLICY_OK;
}
