/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Actual installer callthrough with link-time fixed syscall/proc replacements.
 * SOURCE ONLY. NO compilation, policy installation or kernel characterization.
 * Required isolated control link wraps EVERY boundary listed at bottom.
 * No __real_* fallback exists; unknown requests set an explicit test failure.
 */
#define _GNU_SOURCE
#include "recognition-lifecycle-policy.h"
#include <dirent.h>
#include <errno.h>
#include <linux/magic.h>
#include <linux/seccomp.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <unistd.h>

enum injected_fault {
    FAULT_NONE = 0, FAULT_PID, FAULT_UID, FAULT_EUID,
    FAULT_TASK_OPEN, FAULT_TASK_FS, FAULT_TASK_FS_CALL, FAULT_TASK_EMPTY, FAULT_TASK_MULTIPLE, FAULT_TASK_NAME,
    FAULT_TASK_READ, FAULT_TASK_CLOSE,
    FAULT_FD_OPEN, FAULT_FD_FS, FAULT_FD_FS_CALL, FAULT_FD_EMPTY, FAULT_FD_MANY, FAULT_FD_192,
    FAULT_FD_NAME, FAULT_FD_LONG_NAME, FAULT_FD_READ, FAULT_FD_CLOSE,
    FAULT_FD_191, FAULT_FD_EXACT,
    FAULT_LIMIT_READ, FAULT_LIMIT_LOW, FAULT_LIMIT_SET, FAULT_CORE_SET,
    FAULT_LIMIT_READBACK, FAULT_LIMIT_SOFT, FAULT_LIMIT_HARD,
    FAULT_NNP_SET, FAULT_NNP_GET, FAULT_NNP_QUERY_ERROR, FAULT_FILTER,
    FAULT_COUNT
};

static enum injected_fault fault;
static max_align_t fake_directories[2];
static unsigned int positions[2], closes[2], opens[2], successful_opens[2], filesystem_checks[2];
static unsigned int pid_reads, uid_reads, euid_reads, limits_read, limits_set, cores_set, nnp_set, nnp_get, filter_calls;
static unsigned int unexpected;
static struct dirent entry;

static int directory_index(DIR *directory)
{
    if (directory == (DIR *)&fake_directories[0]) return 0;
    if (directory == (DIR *)&fake_directories[1]) return 1;
    unexpected = 1;
    return -1;
}

pid_t __wrap_getpid(void) { pid_reads++; return fault == FAULT_PID ? 2 : 1; }
uid_t __wrap_getuid(void) { uid_reads++; return fault == FAULT_UID ? 0 : 1000; }
uid_t __wrap_geteuid(void) { euid_reads++; return fault == FAULT_EUID ? 0 : 1000; }

DIR *__wrap_opendir(const char *path)
{
    int index;
    if (strcmp(path, "/proc/self/task") == 0) index = 0;
    else if (strcmp(path, "/proc/self/fd") == 0) index = 1;
    else { unexpected = 1; return NULL; }
    opens[index]++;
    if ((index == 0 && fault == FAULT_TASK_OPEN) || (index == 1 && fault == FAULT_FD_OPEN)) { errno = EACCES; return NULL; }
    successful_opens[index]++;
    return (DIR *)&fake_directories[index];
}

int __wrap_dirfd(DIR *directory)
{
    int index = directory_index(directory);
    return index < 0 ? -1 : 10 + index;
}

int __wrap_fstatfs(int descriptor, struct statfs *filesystem)
{
    if (descriptor != 10 && descriptor != 11) { unexpected = 1; return -1; }
    filesystem_checks[descriptor - 10]++;
    if ((descriptor == 10 && fault == FAULT_TASK_FS_CALL) || (descriptor == 11 && fault == FAULT_FD_FS_CALL)) return -1;
    memset(filesystem, 0, sizeof(*filesystem));
    filesystem->f_type = ((descriptor == 10 && fault == FAULT_TASK_FS) ||
                         (descriptor == 11 && fault == FAULT_FD_FS)) ? 0 : PROC_SUPER_MAGIC;
    return 0;
}

struct dirent *__wrap_readdir(DIR *directory)
{
    int index = directory_index(directory);
    const char *name = NULL;
    char numeric_name[16];
    unsigned int position;
    if (index < 0) return NULL;
    position = positions[index]++;
    errno = 0;
    if (position == 0) name = ".";
    else if (position == 1) name = "..";
    else if (index == 0) {
        if (fault == FAULT_TASK_EMPTY) return NULL;
        if (position == 2) name = fault == FAULT_TASK_NAME ? "x" : "1";
        else if (position == 3 && fault == FAULT_TASK_MULTIPLE) name = "2";
        else if (position == 3 && fault == FAULT_TASK_READ) errno = EIO;
    } else {
        if (fault == FAULT_FD_EMPTY) return NULL;
        if (fault == FAULT_FD_EXACT) {
            if (position < 194) {
                if (snprintf(numeric_name, sizeof(numeric_name), "%u", position - 2U) <= 0) { unexpected = 1; return NULL; }
                name = numeric_name;
            }
        }
        else if (fault == FAULT_FD_191 && position == 5) name = "191";
        else if (fault == FAULT_FD_191 && position == 6) name = "11";
        else if (fault == FAULT_FD_191 && position == 7) return NULL;
        else if (fault == FAULT_FD_MANY && position < 195) name = "0";
        else if (position == 2) name = "0";
        else if (position == 3) name = "1";
        else if (position == 4) name = "2";
        else if (position == 5) name = fault == FAULT_FD_192 ? "192" : fault == FAULT_FD_NAME ? "-1" :
                                        fault == FAULT_FD_LONG_NAME ? "99999999999999999999" : "11";
        else if (position == 6 && fault == FAULT_FD_READ) errno = EIO;
    }
    if (name == NULL) return NULL;
    memset(&entry, 0, sizeof(entry));
    memcpy(entry.d_name, name, strlen(name) + 1U);
    return &entry;
}

int __wrap_closedir(DIR *directory)
{
    int index = directory_index(directory);
    if (index < 0) return -1;
    closes[index]++;
    if (closes[index] > 1) unexpected = 1;
    return ((index == 0 && fault == FAULT_TASK_CLOSE) || (index == 1 && fault == FAULT_FD_CLOSE)) ? -1 : 0;
}

int __wrap_getrlimit(int resource, struct rlimit *limit)
{
    if (resource != RLIMIT_NOFILE) { unexpected = 1; return -1; }
    limits_read++;
    if ((limits_read == 1 && fault == FAULT_LIMIT_READ) || (limits_read == 2 && fault == FAULT_LIMIT_READBACK)) return -1;
    limit->rlim_cur = limits_read == 1 ? 1024 : PDAA_TARGET_NOFILE;
    limit->rlim_max = limits_read == 1 ? (fault == FAULT_LIMIT_LOW ? 191 : 1024) : PDAA_TARGET_NOFILE;
    if (limits_read == 2 && fault == FAULT_LIMIT_SOFT) limit->rlim_cur = 191;
    if (limits_read == 2 && fault == FAULT_LIMIT_HARD) limit->rlim_max = 193;
    return 0;
}

int __wrap_setrlimit(int resource, const struct rlimit *limit)
{
    if (resource == RLIMIT_NOFILE) {
        limits_set++;
        if (limit->rlim_cur != PDAA_TARGET_NOFILE || limit->rlim_max != PDAA_TARGET_NOFILE) unexpected = 1;
        return fault == FAULT_LIMIT_SET ? -1 : 0;
    }
    if (resource == RLIMIT_CORE) {
        cores_set++;
        if (limit->rlim_cur != 0 || limit->rlim_max != 0 || limits_set != 1) unexpected = 1;
        return fault == FAULT_CORE_SET ? -1 : 0;
    }
    unexpected = 1;
    return -1;
}

int __wrap_prctl(int option, ...)
{
    va_list arguments;
    long first, second, third, fourth;
    va_start(arguments, option);
    first = va_arg(arguments, long);
    second = va_arg(arguments, long);
    third = va_arg(arguments, long);
    fourth = va_arg(arguments, long);
    va_end(arguments);
    if (second != 0 || third != 0 || fourth != 0 || limits_read != 2 || cores_set != 1) unexpected = 1;
    if (option == PR_SET_NO_NEW_PRIVS) {
        nnp_set++;
        if (first != 1) unexpected = 1;
        return fault == FAULT_NNP_SET ? -1 : 0;
    }
    if (option == PR_GET_NO_NEW_PRIVS) {
        nnp_get++;
        if (first != 0 || nnp_set != 1) unexpected = 1;
        if (fault == FAULT_NNP_QUERY_ERROR) return -1;
        return fault == FAULT_NNP_GET ? 0 : 1;
    }
    unexpected = 1;
    return -1;
}

long __wrap_syscall(long number, ...)
{
    va_list arguments;
    int operation, flags;
    const struct sock_fprog *program;
    const struct sock_filter *actual;
    size_t count = 0;
    if (number != SYS_seccomp) { unexpected = 1; return -1; }
    va_start(arguments, number);
    operation = va_arg(arguments, int);
    flags = va_arg(arguments, int);
    program = va_arg(arguments, struct sock_fprog *);
    va_end(arguments);
    actual = pdaa_lifecycle_policy_instructions(&count);
    filter_calls++;
    if (operation != SECCOMP_SET_MODE_FILTER || flags != 0 || program == NULL ||
        program->filter != actual || program->len != count || nnp_set != 1 || nnp_get != 1 ||
        closes[0] != 1 || closes[1] != 1 || limits_set != 1 || cores_set != 1 || filter_calls != 1) unexpected = 1;
    return fault == FAULT_FILTER ? -1 : 0;
}

static enum pdaa_policy_result expected_result(enum injected_fault selected)
{
    if (selected == FAULT_NONE || selected == FAULT_FD_191 || selected == FAULT_FD_EXACT) return PDAA_POLICY_OK;
    if (selected <= FAULT_EUID) return PDAA_POLICY_IDENTITY;
    if (selected <= FAULT_FD_CLOSE) return PDAA_POLICY_INVENTORY;
    if (selected <= FAULT_LIMIT_HARD) return PDAA_POLICY_LIMIT;
    if (selected <= FAULT_NNP_QUERY_ERROR) return PDAA_POLICY_NO_NEW_PRIVILEGES;
    return PDAA_POLICY_FILTER;
}

/* Exact stage custody for every row, including every failing inventory.
 * This independently rejects missing closes and effects after refusal.
 */
static int stage_counts_match(void)
{
    unsigned int expected_task_positions = 4, expected_fd_positions = 7;
    unsigned int identity_failure = fault >= FAULT_PID && fault <= FAULT_EUID;
    unsigned int task_failure = fault >= FAULT_TASK_OPEN && fault <= FAULT_TASK_CLOSE;
    unsigned int fd_failure = fault >= FAULT_FD_OPEN && fault <= FAULT_FD_CLOSE;
    unsigned int task_open = !identity_failure;
    unsigned int task_success = task_open && fault != FAULT_TASK_OPEN;
    unsigned int fd_open = task_open && !task_failure;
    unsigned int fd_success = fd_open && fault != FAULT_FD_OPEN;
    unsigned int reached_limits = fd_open && !fd_failure;
    unsigned int expected_limit_reads = reached_limits ? ((fault >= FAULT_LIMIT_READ && fault <= FAULT_CORE_SET) ? 1U : 2U) : 0U;
    unsigned int expected_limit_sets = reached_limits && fault != FAULT_LIMIT_READ && fault != FAULT_LIMIT_LOW;
    unsigned int expected_core_sets = expected_limit_sets && fault != FAULT_LIMIT_SET;
    unsigned int expected_nnp_set = reached_limits && !(fault >= FAULT_LIMIT_READ && fault <= FAULT_LIMIT_HARD);
    unsigned int expected_nnp_get = expected_nnp_set && fault != FAULT_NNP_SET;
    unsigned int expected_filter = expected_nnp_get && fault != FAULT_NNP_GET && fault != FAULT_NNP_QUERY_ERROR;
    if (!task_success || fault == FAULT_TASK_FS || fault == FAULT_TASK_FS_CALL) expected_task_positions = 0;
    else if (fault == FAULT_TASK_EMPTY || fault == FAULT_TASK_NAME) expected_task_positions = 3;
    if (!fd_success || fault == FAULT_FD_FS || fault == FAULT_FD_FS_CALL) expected_fd_positions = 0;
    else if (fault == FAULT_FD_EMPTY) expected_fd_positions = 3;
    else if (fault == FAULT_FD_MANY || fault == FAULT_FD_EXACT) expected_fd_positions = 195;
    else if (fault == FAULT_FD_192 || fault == FAULT_FD_NAME || fault == FAULT_FD_LONG_NAME) expected_fd_positions = 6;
    else if (fault == FAULT_FD_191) expected_fd_positions = 8;
    return pid_reads == 1 && uid_reads == (fault != FAULT_PID) &&
        euid_reads == (fault != FAULT_PID && fault != FAULT_UID) &&
        opens[0] == task_open && successful_opens[0] == task_success && closes[0] == task_success &&
        opens[1] == fd_open && successful_opens[1] == fd_success && closes[1] == fd_success &&
        filesystem_checks[0] == task_success && filesystem_checks[1] == fd_success &&
        positions[0] == expected_task_positions && positions[1] == expected_fd_positions &&
        limits_read == expected_limit_reads && limits_set == expected_limit_sets && cores_set == expected_core_sets &&
        nnp_set == expected_nnp_set && nnp_get == expected_nnp_get && filter_calls == expected_filter;
}

int main(void)
{
    unsigned int selected;
    for (selected = FAULT_NONE; selected < FAULT_COUNT; selected++) {
        enum pdaa_policy_result result;
        fault = (enum injected_fault)selected;
        memset(positions, 0, sizeof(positions));
        memset(closes, 0, sizeof(closes));
        memset(opens, 0, sizeof(opens));
        memset(successful_opens, 0, sizeof(successful_opens));
        memset(filesystem_checks, 0, sizeof(filesystem_checks));
        pid_reads = uid_reads = euid_reads = 0;
        limits_read = limits_set = cores_set = nnp_set = nnp_get = filter_calls = unexpected = 0;
        result = pdaa_install_lifecycle_policy(); /* REAL installer, all I/O mocked */
        if (result != expected_result(fault) || unexpected || !stage_counts_match()) {
            fprintf(stderr, "Native installer modeled case failed: %u\n", selected + 1U);
            return 1;
        }
    }
    printf("Native installer modeled cases passed: %u; kernel installs: 0\n", selected);
    return 0;
}

/* Complete reviewed build packet must bind all of these --wrap symbols:
 * getpid getuid geteuid opendir dirfd fstatfs readdir closedir getrlimit
 * setrlimit prctl syscall. This file must never be linked as a runtime source.
 * Missing/misresolved wrappers are a build failure, not permission to execute.
 */
