/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Single-thread external ptrace adapter; no fork, target memory/argv/env reads,
 * FD duplication, ptrace detach or numeric identity repair. UNCOMPILED SOURCE.
 * A complete build/host/protocol packet remains required before invocation.
 */
#define _GNU_SOURCE
#include "recognition-lifecycle-observer.h"
#if !defined(__linux__) || !defined(__x86_64__)
#error "The reviewed native observer supports Linux x86_64 only"
#endif
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/magic.h>
#include <linux/ptrace.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define OBSERVER_OPTIONS (PTRACE_O_TRACEFORK | PTRACE_O_TRACEVFORK | PTRACE_O_TRACECLONE | \
    PTRACE_O_TRACEEXEC | PTRACE_O_TRACEEXIT | PTRACE_O_TRACESYSGOOD | PTRACE_O_EXITKILL | PTRACE_O_TRACESECCOMP)

static int observation_io_allowed(struct pdaa_lifecycle_observer *observer);

static uint64_t monotonic_now(void)
{
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0 || value.tv_sec < 0 || value.tv_nsec < 0 ||
        value.tv_nsec >= 1000000000L || (uint64_t)value.tv_sec > (UINT64_MAX - 999999999U) / 1000000000U) return 0;
    return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}

static uint64_t observer_now(struct pdaa_lifecycle_observer *observer)
{
    uint64_t now = monotonic_now();
    if (now == 0 || now < observer->clock_high_water_ns) {
        (void)pdaa_lifecycle_fail(&observer->state, PDAA_LIFECYCLE_CLOCK, now);
        return 0;
    }
    observer->clock_high_water_ns = now;
    return now;
}

static int refuse(struct pdaa_lifecycle_observer *observer, enum pdaa_lifecycle_error reason)
{
    return pdaa_lifecycle_fail(&observer->state, reason, observer_now(observer));
}

static int trace_call(unsigned int request, uint32_t tid, unsigned long address, unsigned long data)
{
    return syscall(SYS_ptrace, (long)request, (long)tid, address, data) == 0;
}

static int proc_read(int directory, const char *name, char *output, size_t capacity)
{
    int descriptor = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    size_t used = 0;
    int valid = descriptor >= 0;
    if (!valid) return 0;
    while (valid) {
        ssize_t count;
        if (used == capacity - 1U) { valid = 0; break; }
        count = read(descriptor, output + used, capacity - 1U - used);
        if (count < 0) { valid = 0; break; } /* no repair/retry on EINTR */
        if (count == 0) break;
        used += (size_t)count;
    }
    output[used] = '\0';
    if (close(descriptor) != 0) valid = 0; /* one close attempt */
    return valid && used > 0;
}

static int guarded_proc_read(struct pdaa_lifecycle_observer *observer, int directory, const char *name, char *output, size_t capacity)
{
    return observation_io_allowed(observer) && proc_read(directory, name, output, capacity);
}

static int decimal(const char **cursor, uint64_t *value)
{
    const char *position = *cursor;
    uint64_t parsed = 0;
    unsigned int digits = 0;
    while (*position >= '0' && *position <= '9') {
        unsigned int digit = (unsigned int)(*position++ - '0');
        if (++digits > 20 || parsed > (UINT64_MAX - digit) / 10U) return 0;
        parsed = parsed * 10U + digit;
    }
    if (digits == 0) return 0;
    *cursor = position;
    *value = parsed;
    return 1;
}

static const char *status_field(const char *body, const char *field)
{
    size_t length = strlen(field);
    const char *line = body;
    const char *result = NULL;
    while (*line != '\0') {
        if (strncmp(line, field, length) == 0) {
            if (result != NULL) return NULL;
            result = line + length;
        }
        line = strchr(line, '\n');
        if (line == NULL) break;
        line++;
    }
    return result;
}

static void spaces(const char **position)
{
    while (**position == ' ' || **position == '\t') (*position)++;
}

static int one_status_number(const char *body, const char *field, uint32_t *result)
{
    const char *position = status_field(body, field);
    uint64_t value;
    if (position == NULL) return 0;
    spaces(&position);
    if (!decimal(&position, &value) || value == 0 || value > INT_MAX) return 0;
    spaces(&position);
    if (*position != '\n') return 0;
    *result = (uint32_t)value;
    return 1;
}

static int namespace_number_and_uid(const char *body, uint32_t host_tid, uint32_t *namespace_tid)
{
    const char *position = status_field(body, "NSpid:");
    uint64_t value = 0;
    unsigned int count = 0;
    if (position == NULL) return 0;
    for (;;) {
        spaces(&position);
        if (*position == '\n') break;
        if (!decimal(&position, &value) || value == 0 || value > INT_MAX || ++count > 2) return 0;
        if (count == 1 && value != host_tid) return 0;
        if (*position != ' ' && *position != '\t' && *position != '\n') return 0;
    }
    /* Fixed supported topology: observer in initial PID namespace, target in
     * exactly one nested namespace. Other topologies need a reviewed change.
     */
    if (count != 2) return 0;
    *namespace_tid = (uint32_t)value;
    position = status_field(body, "Uid:");
    if (position == NULL) return 0;
    for (count = 0; count < 4; count++) {
        spaces(&position);
        if (!decimal(&position, &value) || value != 1000) return 0;
    }
    spaces(&position);
    return *position == '\n';
}

static int start_from_stat(const char *body, uint32_t host_tid, uint64_t *start)
{
    const char *position = body;
    uint64_t value;
    unsigned int field;
    if (!decimal(&position, &value) || value != host_tid || *position++ != ' ' || *position != '(') return 0;
    /* comm may contain spaces/right parentheses. The kernel appends only
     * numeric stat fields after its final right parenthesis.
     */
    position = strrchr(position, ')');
    if (position == NULL || position[1] != ' ' || position[2] == '\0' || position[3] != ' ') return 0;
    position += 4; /* field 4: skip the single state character (field 3) */
    for (field = 4; field <= 22; field++) {
        int negative;
        spaces(&position);
        negative = *position == '-';
        if (negative) position++;
        if (!decimal(&position, &value) || (*position != ' ' && *position != '\n')) return 0;
        if (field == 22) {
            if (negative || value == 0) return 0;
            *start = value;
            return 1;
        }
    }
    return 0;
}

static int identity_read(struct pdaa_lifecycle_observer *observer, uint32_t host_tid,
                         struct pdaa_kernel_identity *identity)
{
    char name[16], body[8192];
    int directory, namespace_fd, valid;
    struct stat namespace_stat;
    int name_length = snprintf(name, sizeof(name), "%u", host_tid);
    if (host_tid == 0 || host_tid > INT_MAX || name_length <= 0 || (size_t)name_length >= sizeof(name)) return 0;
    if (!observation_io_allowed(observer)) return 0;
    directory = openat(observer->proc_root_fd, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (directory < 0) return 0;
    memset(identity, 0, sizeof(*identity));
    identity->host_tid = host_tid;
    valid = guarded_proc_read(observer, directory, "status", body, sizeof(body)) &&
            one_status_number(body, "Tgid:", &identity->host_tgid) &&
            namespace_number_and_uid(body, host_tid, &identity->namespace_tid);
    explicit_bzero(body, sizeof(body));
    if (valid) valid = guarded_proc_read(observer, directory, "stat", body, sizeof(body)) && start_from_stat(body, host_tid, &identity->start_ticks);
    explicit_bzero(body, sizeof(body));
    if (valid) {
        valid = guarded_proc_read(observer, directory, "cgroup", body, sizeof(body)) && strncmp(body, "0::", 3) == 0 &&
                strlen(body + 3) == strlen(observer->cgroup_path) + 1U &&
                strncmp(body + 3, observer->cgroup_path, strlen(observer->cgroup_path)) == 0 &&
                body[strlen(body) - 1U] == '\n';
    }
    explicit_bzero(body, sizeof(body));
    if (valid) {
        /* ns/pid is a kernel procfs magic link, deliberately followed only
         * inside this authenticated proc task directory. Never proc/PID/fd.
         */
        namespace_fd = observation_io_allowed(observer) ? openat(directory, "ns/pid", O_RDONLY | O_CLOEXEC) : -1;
        valid = namespace_fd >= 0;
        if (valid) {
            valid = fstat(namespace_fd, &namespace_stat) == 0 &&
                    (uint64_t)namespace_stat.st_dev == observer->pid_namespace_device &&
                    (uint64_t)namespace_stat.st_ino == observer->pid_namespace_inode;
            if (close(namespace_fd) != 0) valid = 0;
        }
    }
    if (close(directory) != 0) valid = 0;
    return valid;
}

static int original_still_owned(struct pdaa_lifecycle_observer *observer)
{
    return syscall(SYS_pidfd_send_signal, (long)observer->original_pidfd, 0L, NULL, 0L) == 0;
}

static int preclaim_clock(struct pdaa_lifecycle_observer *observer, uint64_t deadline, uint64_t *sample)
{
    uint64_t now = observer_now(observer);
    if (now == 0 || now >= deadline || (observer->state.initialized && !pdaa_lifecycle_tick(&observer->state, now))) {
        return refuse(observer, PDAA_LIFECYCLE_CLOCK);
    }
    if (sample != NULL) *sample = now;
    return 1;
}

static int same_proc_namespace(struct pdaa_lifecycle_observer *observer, uint64_t deadline)
{
    struct stat observed[2];
    struct statfs filesystem;
    const char *paths[2] = {"self/ns/pid", "1/ns/pid"};
    unsigned int index;
    for (index = 0; index < 2; index++) {
        int descriptor, valid;
        if (!preclaim_clock(observer, deadline, NULL)) return 0;
        descriptor = openat(observer->proc_root_fd, paths[index], O_RDONLY | O_CLOEXEC);
        if (descriptor < 0) return refuse(observer, PDAA_LIFECYCLE_IDENTITY);
        valid = fstat(descriptor, &observed[index]) == 0 && fstatfs(descriptor, &filesystem) == 0 && filesystem.f_type == NSFS_MAGIC;
        if (close(descriptor) != 0) valid = 0;
        if (!valid) return refuse(observer, PDAA_LIFECYCLE_IDENTITY);
    }
    return observed[0].st_dev == observed[1].st_dev && observed[0].st_ino == observed[1].st_ino &&
           ((uint64_t)observed[0].st_dev != observer->pid_namespace_device || (uint64_t)observed[0].st_ino != observer->pid_namespace_inode);
}

int pdaa_observer_attach(struct pdaa_lifecycle_observer *observer,
                         int proc_root_fd, int original_pidfd, int namespace_fd,
                         uint32_t original_tid, const char *cgroup_path, uint64_t host_deadline)
{
    struct stat namespace_stat;
    struct statfs proc_filesystem;
    struct rlimit descriptors;
    struct pdaa_kernel_identity before, after;
    uint64_t now;
    size_t length;
    if (observer == NULL || observer->attach_attempted || observer->state.initialized || observer->seized || observer->state.failure != PDAA_LIFECYCLE_OK) return 0;
    observer->attach_attempted = 1; /* before even the first native clock read */
    observer->setup_deadline_ns = host_deadline;
    now = observer_now(observer);
    if (cgroup_path == NULL || proc_root_fd < 3 || proc_root_fd >= 16 || original_pidfd < 3 || original_pidfd >= 16 ||
        namespace_fd < 3 || namespace_fd >= 16 || proc_root_fd == original_pidfd || proc_root_fd == namespace_fd ||
        original_pidfd == namespace_fd || now == 0 || host_deadline <= now || host_deadline - now > UINT64_C(300000000000)) return refuse(observer, PDAA_LIFECYCLE_IDENTITY);
    length = strnlen(cgroup_path, sizeof(observer->cgroup_path));
    if (length == 0 || length >= sizeof(observer->cgroup_path) || cgroup_path[0] != '/' || strchr(cgroup_path, '\n') != NULL ||
        getrlimit(RLIMIT_NOFILE, &descriptors) != 0 || descriptors.rlim_cur != 16 || descriptors.rlim_max != 16 ||
        fstatfs(proc_root_fd, &proc_filesystem) != 0 || proc_filesystem.f_type != PROC_SUPER_MAGIC ||
        fstat(namespace_fd, &namespace_stat) != 0) return refuse(observer, PDAA_LIFECYCLE_IDENTITY);
    observer->proc_root_fd = proc_root_fd;
    observer->original_pidfd = original_pidfd;
    observer->original_host_tid = original_tid;
    observer->pid_namespace_device = (uint64_t)namespace_stat.st_dev;
    observer->pid_namespace_inode = (uint64_t)namespace_stat.st_ino;
    memcpy(observer->cgroup_path, cgroup_path, length + 1U);
    if (!same_proc_namespace(observer, host_deadline) || !preclaim_clock(observer, host_deadline, NULL) ||
        !original_still_owned(observer) || !identity_read(observer, original_tid, &before) ||
        !preclaim_clock(observer, host_deadline, &now) ||
        !pdaa_lifecycle_initialize(&observer->state, &before, now, host_deadline)) return refuse(observer, PDAA_LIFECYCLE_IDENTITY);
    if (!pdaa_lifecycle_tick(&observer->state, observer_now(observer))) return 0;
    if (!trace_call(PTRACE_SEIZE, original_tid, 0UL, OBSERVER_OPTIONS)) return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
    observer->seized = 1;
    if (!pdaa_lifecycle_tick(&observer->state, observer_now(observer))) return 0;
    if (!trace_call(PTRACE_INTERRUPT, original_tid, 0UL, 0UL) || !original_still_owned(observer) ||
        !identity_read(observer, original_tid, &after) || before.host_tid != after.host_tid ||
        before.host_tgid != after.host_tgid || before.namespace_tid != after.namespace_tid || before.start_ticks != after.start_ticks) {
        return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
    }
    return pdaa_lifecycle_tick(&observer->state, observer_now(observer)); /* still held */
}

int pdaa_observer_release_bootstrap(struct pdaa_lifecycle_observer *observer)
{
    if (observer == NULL || !observer->seized || !observer->bootstrap_stop_seen || observer->bootstrap_released ||
        !pdaa_lifecycle_tick(&observer->state, observer_now(observer))) return 0;
    if (!trace_call(PTRACE_CONT, observer->original_host_tid, 0UL, 0UL)) return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
    observer->bootstrap_released = 1;
    return 1;
}

static int resume_record(struct pdaa_lifecycle_observer *observer, uint32_t number, int signal_number)
{
    const struct pdaa_native_record *item = &observer->state.records[number - 1U];
    unsigned int request = item->pending == PDAA_PENDING_NONE ? PTRACE_CONT : PTRACE_SYSCALL;
    if (!pdaa_lifecycle_tick(&observer->state, observer_now(observer))) return 0;
    if (!trace_call(request, item->identity.host_tid, 0UL, (unsigned long)signal_number)) return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
    return 1;
}

static int consume_newborn(struct pdaa_lifecycle_observer *observer, uint32_t number, int status)
{
    if (!WIFSTOPPED(status) || (unsigned int)status >> 16 != PTRACE_EVENT_STOP || WSTOPSIG(status) != SIGTRAP ||
        !pdaa_lifecycle_newborn_stop(&observer->state, number, observer_now(observer))) return refuse(observer, PDAA_LIFECYCLE_ORDER);
    /* Never wait for the parent's vfork return here: the child must progress
     * through exec/exit before that parent can receive its syscall exit stop.
     */
    return resume_record(observer, number, 0);
}

static int birth_event(struct pdaa_lifecycle_observer *observer, uint32_t parent, unsigned int event)
{
    struct pdaa_kernel_identity child;
    struct pdaa_native_record *item = &observer->state.records[parent - 1U];
    unsigned long message = 0;
    uint32_t child_number, index;
    if (item->pending != PDAA_PENDING_THREAD && item->pending != PDAA_PENDING_PROCESS) return refuse(observer, PDAA_LIFECYCLE_ORDER);
    if (!trace_call(PTRACE_GETEVENTMSG, item->identity.host_tid, 0UL, (unsigned long)&message)) return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
    if (!pdaa_lifecycle_capture_birth(&observer->state, parent, message, event)) return 0;
    /* Record the actual kernel return before identity reads and deadline
     * refusal. A partial identity remains retained and cannot grant success.
     */
    if (!pdaa_lifecycle_birth_return(&observer->state, parent, message, event, observer_now(observer)) || !observation_io_allowed(observer) ||
        !identity_read(observer, (uint32_t)message, &child) ||
        !pdaa_lifecycle_birth(&observer->state, parent, &child, observer_now(observer))) return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
    child_number = item->reserved_record;
    for (index = 0; index < observer->orphan_count; index++) {
        if (observer->orphans[index].host_tid == message) {
            int held_status = observer->orphans[index].status;
            observer->orphans[index] = observer->orphans[--observer->orphan_count];
            if (!consume_newborn(observer, child_number, held_status)) return 0;
            break;
        }
    }
    return resume_record(observer, parent, 0);
}

static int seccomp_event(struct pdaa_lifecycle_observer *observer, uint32_t number)
{
    struct ptrace_syscall_info info;
    long size;
    uint32_t expected_tag = 0;
    memset(&info, 0, sizeof(info));
    size = syscall(SYS_ptrace, (long)PTRACE_GET_SYSCALL_INFO,
                   (long)observer->state.records[number - 1U].identity.host_tid, (unsigned long)sizeof(info), &info);
    if (size < (long)(offsetof(struct ptrace_syscall_info, seccomp.ret_data) + sizeof(info.seccomp.ret_data)) ||
        info.op != PTRACE_SYSCALL_INFO_SECCOMP || info.arch != AUDIT_ARCH_X86_64 ||
        info.seccomp.nr > UINT32_MAX || (info.seccomp.nr & UINT64_C(0x40000000)) != 0 ||
        (info.seccomp.nr >= 512 && info.seccomp.nr <= 547)) return refuse(observer, PDAA_LIFECYCLE_ABI);
    if (info.seccomp.nr == __NR_fork || info.seccomp.nr == __NR_vfork || info.seccomp.nr == __NR_clone) expected_tag = PDAA_TRACE_BIRTH;
    else if (info.seccomp.nr == __NR_execve || info.seccomp.nr == __NR_execveat) expected_tag = PDAA_TRACE_EXEC;
    else if (info.seccomp.nr == __NR_close || info.seccomp.nr == __NR_close_range || info.seccomp.nr == __NR_shutdown ||
             info.seccomp.nr == __NR_exit || info.seccomp.nr == __NR_exit_group) expected_tag = PDAA_TRACE_RETIREMENT;
    if (expected_tag == 0 || info.seccomp.ret_data != expected_tag ||
        !pdaa_lifecycle_enter(&observer->state, number, (uint32_t)info.seccomp.nr, info.seccomp.args[0], observer_now(observer))) {
        explicit_bzero(&info, sizeof(info));
        return refuse(observer, PDAA_LIFECYCLE_ORDER);
    }
    explicit_bzero(&info, sizeof(info)); /* never persist pointer/argv values */
    return resume_record(observer, number, 0);
}

static int syscall_result(struct pdaa_lifecycle_observer *observer, uint32_t number)
{
    struct ptrace_syscall_info info;
    long size;
    memset(&info, 0, sizeof(info));
    size = syscall(SYS_ptrace, (long)PTRACE_GET_SYSCALL_INFO,
                   (long)observer->state.records[number - 1U].identity.host_tid, (unsigned long)sizeof(info), &info);
    if (size < (long)(offsetof(struct ptrace_syscall_info, exit.is_error) + sizeof(info.exit.is_error)) ||
        info.op != PTRACE_SYSCALL_INFO_EXIT || info.arch != AUDIT_ARCH_X86_64 ||
        !pdaa_lifecycle_result(&observer->state, number, info.exit.rval, info.exit.is_error, observer_now(observer))) {
        explicit_bzero(&info, sizeof(info));
        return refuse(observer, PDAA_LIFECYCLE_ORDER);
    }
    explicit_bzero(&info, sizeof(info));
    return resume_record(observer, number, 0);
}

static int observation_io_allowed(struct pdaa_lifecycle_observer *observer)
{
    uint64_t now = observer_now(observer);
    if (now == 0 || now < observer->state.last_monotonic_ns) return refuse(observer, PDAA_LIFECYCLE_CLOCK);
    if (!observer->state.initialized) return observer->state.failure == PDAA_LIFECYCLE_OK && observer->setup_deadline_ns != 0 && now < observer->setup_deadline_ns;
    if (observer->state.failure == PDAA_LIFECYCLE_OK) return pdaa_lifecycle_tick(&observer->state, now);
    /* Failed work can perform retirement only under the genuine first-abort
     * cleanup deadline. An expired phase never creates a new cleanup window.
     */
    (void)pdaa_lifecycle_tick(&observer->state, now);
    return observer->state.cleanup_deadline_ns != 0 && now < observer->state.cleanup_deadline_ns && now < observer->state.host_deadline_ns;
}

static int resume_exit(struct pdaa_lifecycle_observer *observer, uint32_t number)
{
    struct pdaa_native_record *item = &observer->state.records[number - 1U];
    if (!item->exit_stop_held || item->exit_resume_attempted || !observation_io_allowed(observer)) return 0;
    item->exit_resume_attempted = 1; /* once, including failure/ESRCH uncertainty */
    if (!trace_call(PTRACE_CONT, item->identity.host_tid, 0UL, 0UL)) return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
    item->exit_stop_held = 0;
    return 1;
}

/* At most five group-leader lookups per call, at most 32768 lifetime lookups.
 * Each uses bounded stat (8192B) and at most two temporary descriptors. The
 * exact proc root and kernel namespace handles provide the identity seam;
 * foreign replacements are observed only, never adopted or signalled.
 */
static int refresh_absences(struct pdaa_lifecycle_observer *observer)
{
    uint32_t index, inspected = 0;
    for (index = 0; index < observer->state.lifetime_records && inspected < PDAA_TARGET_TABLES; index++) {
        struct pdaa_native_record *item = &observer->state.records[index];
        struct stat namespace_stat;
        struct statfs namespace_filesystem;
        char name[16], body[8192];
        uint64_t current_start = 0;
        int directory, namespace_fd = -1, valid = 1, absent = 0;
        if (item->status != PDAA_RECORD_TERMINAL || !item->identity_authenticated ||
            item->identity.host_tid != item->identity.host_tgid || item->original_identity_absent) continue;
        if (!observation_io_allowed(observer)) return 0;
        if (observer->absence_polls >= PDAA_NATIVE_EVENTS) return refuse(observer, PDAA_LIFECYCLE_RESOURCE);
        observer->absence_polls++;
        inspected++;
        if (snprintf(name, sizeof(name), "%u", item->identity.host_tid) <= 0) return refuse(observer, PDAA_LIFECYCLE_IDENTITY);
        directory = openat(observer->proc_root_fd, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (directory < 0) {
            if (errno != ENOENT) return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
            absent = 1; /* only this fresh open's ENOENT establishes absence */
        } else {
            valid = guarded_proc_read(observer, directory, "stat", body, sizeof(body)) && start_from_stat(body, item->identity.host_tid, &current_start);
            explicit_bzero(body, sizeof(body));
            if (valid && current_start != item->identity.start_ticks) {
                namespace_fd = observation_io_allowed(observer) ? openat(directory, "ns/pid", O_RDONLY | O_CLOEXEC) : -1;
                valid = namespace_fd >= 0;
                if (valid) {
                    valid = fstat(namespace_fd, &namespace_stat) == 0 && fstatfs(namespace_fd, &namespace_filesystem) == 0 &&
                            namespace_filesystem.f_type == NSFS_MAGIC && namespace_stat.st_ino != 0;
                    if (valid) absent = 1; /* authenticated different lifetime */
                    if (close(namespace_fd) != 0) valid = 0;
                }
            }
            if (close(directory) != 0) valid = 0;
        }
        if (!valid) return refuse(observer, PDAA_LIFECYCLE_CUSTODY);
        if (absent && !pdaa_lifecycle_identity_absent(&observer->state, index + 1U, observer_now(observer))) return 0;
        /* Same original identity, including a zombie, remains pending. */
    }
    return 1;
}

enum pdaa_observer_step pdaa_observer_step(struct pdaa_lifecycle_observer *observer)
{
    int status;
    pid_t tid;
    uint32_t number, index;
    unsigned int event;
    if (observer == NULL || !observer->seized || !pdaa_lifecycle_tick(&observer->state, observer_now(observer))) return PDAA_OBSERVER_FAILURE;
    if (!refresh_absences(observer)) return PDAA_OBSERVER_FAILURE;
    if (!pdaa_lifecycle_tick(&observer->state, observer_now(observer))) return PDAA_OBSERVER_FAILURE;
    tid = waitpid(-1, &status, __WALL | WNOHANG);
    if (tid == 0) return PDAA_OBSERVER_IDLE;
    if (tid < 0) {
        if (errno == ECHILD && observer->orphan_count == 0 && pdaa_lifecycle_tree_exits_observed(&observer->state)) {
            return pdaa_lifecycle_tree_terminal(&observer->state) ? PDAA_OBSERVER_TARGET_TERMINAL : PDAA_OBSERVER_IDLE;
        }
        (void)refuse(observer, PDAA_LIFECYCLE_CUSTODY);
        return PDAA_OBSERVER_FAILURE;
    }
    number = pdaa_lifecycle_find_live(&observer->state, (uint32_t)tid);
    if (number == 0) {
        if (!WIFSTOPPED(status) || (unsigned int)status >> 16 != PTRACE_EVENT_STOP || WSTOPSIG(status) != SIGTRAP ||
            observer->orphan_count >= PDAA_ACTIVE_TIDS || observer->state.reserved_records == 0) {
            (void)refuse(observer, PDAA_LIFECYCLE_IDENTITY);
            return PDAA_OBSERVER_FAILURE;
        }
        for (index = 0; index < observer->orphan_count; index++) {
            if (observer->orphans[index].host_tid == (uint32_t)tid) {
                (void)refuse(observer, PDAA_LIFECYCLE_ORDER);
                return PDAA_OBSERVER_FAILURE;
            }
        }
        observer->orphans[observer->orphan_count++] = (struct pdaa_native_orphan_stop){(uint32_t)tid, status};
        return PDAA_OBSERVER_EVENT; /* held, never released before enrollment */
    }
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
        if (!pdaa_lifecycle_terminal(&observer->state, number, (uint32_t)status, observer_now(observer))) return PDAA_OBSERVER_FAILURE;
        return PDAA_OBSERVER_EVENT;
    }
    if (!WIFSTOPPED(status)) goto failure;
    event = (unsigned int)status >> 16;
    if (!observer->bootstrap_released && number == 1) {
        if (observer->bootstrap_stop_seen || event != PTRACE_EVENT_STOP || WSTOPSIG(status) != SIGTRAP) goto failure;
        observer->bootstrap_stop_seen = 1;
        return PDAA_OBSERVER_EVENT; /* retain stop until complete host barrier */
    }
    if (observer->state.records[number - 1U].status == PDAA_RECORD_NEWBORN) {
        if (!consume_newborn(observer, number, status)) return PDAA_OBSERVER_FAILURE;
    } else if (event == PTRACE_EVENT_SECCOMP) {
        if (WSTOPSIG(status) != SIGTRAP || !seccomp_event(observer, number)) goto failure;
    } else if (event == PTRACE_EVENT_FORK || event == PTRACE_EVENT_VFORK || event == PTRACE_EVENT_CLONE) {
        if (WSTOPSIG(status) != SIGTRAP || !birth_event(observer, number, event)) goto failure;
    } else if (event == PTRACE_EVENT_EXEC) {
        struct pdaa_kernel_identity identity;
        unsigned long former_tid = 0;
        if (WSTOPSIG(status) != SIGTRAP || !trace_call(PTRACE_GETEVENTMSG, (uint32_t)tid, 0UL, (unsigned long)&former_tid)) goto failure;
        if (!pdaa_lifecycle_capture_exec(&observer->state, number, former_tid)) goto failure;
        if (former_tid != (unsigned long)tid || !identity_read(observer, (uint32_t)tid, &identity) ||
            !pdaa_lifecycle_exec(&observer->state, number, &identity, observer_now(observer)) || !resume_record(observer, number, 0)) goto failure;
        /* Identity alone is not executable/image admission. The complete
         * immutable exec capability barrier remains a required integration.
         */
    } else if (event == PTRACE_EVENT_EXIT) {
        if (WSTOPSIG(status) != SIGTRAP || !pdaa_lifecycle_early_exit(&observer->state, number, observer_now(observer)) ||
            !resume_exit(observer, number)) goto failure;
    } else if (event != 0) goto failure; /* unsupported group-stop/transition */
    else if (WSTOPSIG(status) == (SIGTRAP | 0x80)) {
        if (!syscall_result(observer, number)) return PDAA_OBSERVER_FAILURE;
    } else {
        siginfo_t signal_info;
        int signal_number = WSTOPSIG(status);
        if (signal_number == SIGSTOP || signal_number == SIGTSTP || signal_number == SIGTTIN || signal_number == SIGTTOU ||
            !trace_call(PTRACE_GETSIGINFO, (uint32_t)tid, 0UL, (unsigned long)&signal_info) || signal_info.si_signo != signal_number ||
            !resume_record(observer, number, signal_number)) goto failure;
    }
    return PDAA_OBSERVER_EVENT;
failure:
    (void)refuse(observer, PDAA_LIFECYCLE_CUSTODY);
    return PDAA_OBSERVER_FAILURE;
}

int pdaa_observer_transfer_deadlines(struct pdaa_lifecycle_observer *observer, uint64_t phase, uint64_t cleanup)
{
    if (observer == NULL || !observer->seized) return 0;
    return pdaa_lifecycle_deadlines(&observer->state, observer_now(observer), phase, cleanup);
}

enum pdaa_observer_step pdaa_observer_drain(struct pdaa_lifecycle_observer *observer)
{
    int status;
    pid_t tid;
    uint32_t number, index;
    int may_retire;
    if (observer == NULL || !observer->seized || observer->state.failure == PDAA_LIFECYCLE_OK) return PDAA_OBSERVER_FAILURE;
    if (observer->drain_polls >= PDAA_NATIVE_EVENTS) return PDAA_OBSERVER_FAILURE;
    observer->drain_polls++;
    may_retire = observation_io_allowed(observer); /* fresh entry decision */
    if (may_retire) {
        if (!refresh_absences(observer)) return PDAA_OBSERVER_FAILURE;
        for (index = 0; index < observer->state.lifetime_records; index++) {
            if (observer->state.records[index].exit_stop_held && !observer->state.records[index].exit_resume_attempted) return resume_exit(observer, index + 1U) ? PDAA_OBSERVER_EVENT : PDAA_OBSERVER_FAILURE;
        }
    }
    tid = waitpid(-1, &status, __WALL | WNOHANG);
    if (tid == 0) return may_retire ? PDAA_OBSERVER_IDLE : PDAA_OBSERVER_FAILURE;
    if (tid < 0) {
        if (errno == ECHILD && observer->orphan_count == 0 && pdaa_lifecycle_tree_exits_observed(&observer->state)) {
            return pdaa_lifecycle_tree_terminal(&observer->state) ? PDAA_OBSERVER_TARGET_TERMINAL : may_retire ? PDAA_OBSERVER_IDLE : PDAA_OBSERVER_FAILURE;
        }
        return PDAA_OBSERVER_FAILURE;
    }
    number = pdaa_lifecycle_find_live(&observer->state, (uint32_t)tid);
    if (number == 0) return PDAA_OBSERVER_FAILURE; /* retain unresolved orphan custody */
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
        return pdaa_lifecycle_terminal(&observer->state, number, (uint32_t)status, observer_now(observer)) ? PDAA_OBSERVER_EVENT : PDAA_OBSERVER_FAILURE;
    }
    if (WIFSTOPPED(status) && ((unsigned int)status >> 16) == PTRACE_EVENT_EXIT && WSTOPSIG(status) == SIGTRAP) {
        if (!pdaa_lifecycle_early_exit(&observer->state, number, observer_now(observer)) || !resume_exit(observer, number)) return PDAA_OBSERVER_FAILURE;
        return PDAA_OBSERVER_EVENT;
    }
    /* Every other stop stays held while the original host owner terminates
     * the target cgroup. No late success, detach, clock reset or PID repair.
     */
    return PDAA_OBSERVER_EVENT;
}
