/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Fixed finite process/table ledger shared by real observer and model controls.
 * No syscall effects or acceptance authority. UNCOMPILED DRAFT SOURCE.
 */
#include "recognition-lifecycle-state.h"
#include <linux/sched.h>
#include <linux/ptrace.h>
#include <limits.h>
#include <signal.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>

enum journal_tag {
    JOURNAL_INITIAL = 1, JOURNAL_DEADLINES = 2, JOURNAL_ENTRY = 3,
    JOURNAL_BIRTH = 4, JOURNAL_NEWBORN = 5, JOURNAL_EXEC = 6,
    JOURNAL_RESULT = 7, JOURNAL_EARLY_EXIT = 8, JOURNAL_TERMINAL = 9,
    JOURNAL_FAILURE = 10, JOURNAL_ARM_CLI = 11, JOURNAL_BIRTH_RETURN = 12,
    JOURNAL_IDENTITY_ABSENT = 13
};

static void store_u32(unsigned char *output, uint32_t value)
{
    unsigned int index;
    for (index = 0; index < 4; index++) output[index] = (unsigned char)(value >> (8U * index));
}

static void store_u64(unsigned char *output, uint64_t value)
{
    unsigned int index;
    for (index = 0; index < 8; index++) output[index] = (unsigned char)(value >> (8U * index));
}

static int journal(struct pdaa_lifecycle_state *state, uint32_t tag, uint32_t record,
                   uint32_t related, uint32_t value, uint64_t now_ns)
{
    unsigned char *output;
    const struct pdaa_native_record *item = NULL;
    if (state->event_count >= PDAA_NATIVE_EVENTS) {
        if (state->failure == PDAA_LIFECYCLE_OK) state->failure = PDAA_LIFECYCLE_OVERFLOW;
        return 0;
    }
    output = state->events[state->event_count++];
    memset(output, 0, PDAA_NATIVE_EVENT_BYTES);
    memcpy(output, "PDAANV01", 8);
    store_u32(output + 8, tag);
    store_u32(output + 12, state->event_count);
    store_u64(output + 16, now_ns);
    store_u32(output + 24, record);
    store_u32(output + 28, related);
    store_u32(output + 32, value);
    store_u32(output + 36, (uint32_t)state->failure);
    if (record > 0 && record <= state->lifetime_records) item = &state->records[record - 1U];
    if (item != NULL) {
        store_u32(output + 40, item->identity.host_tid);
        store_u32(output + 44, item->identity.host_tgid);
        store_u32(output + 48, item->identity.namespace_tid);
        store_u32(output + 52, item->group);
        store_u64(output + 56, item->identity.start_ticks);
        store_u64(output + 64, item->actual_birth_return);
        store_u64(output + 72, item->exec_raw_former_tid);
    }
    return 1;
}

int pdaa_lifecycle_fail(struct pdaa_lifecycle_state *state, enum pdaa_lifecycle_error reason, uint64_t now_ns)
{
    if (state == NULL) return 0;
    if (state->failure == PDAA_LIFECYCLE_OK) {
        state->failure = reason == PDAA_LIFECYCLE_OK ? PDAA_LIFECYCLE_CUSTODY : reason;
        (void)journal(state, JOURNAL_FAILURE, 0, 0, (uint32_t)state->failure, now_ns);
    }
    return 0;
}

int pdaa_lifecycle_tick(struct pdaa_lifecycle_state *state, uint64_t now_ns)
{
    if (state == NULL || !state->initialized) return 0;
    if (now_ns < state->last_monotonic_ns) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_CLOCK, now_ns);
    state->last_monotonic_ns = now_ns; /* retain even an expired genuine sample */
    if (now_ns >= state->host_deadline_ns ||
        (state->phase_deadline_ns != 0 && now_ns >= state->phase_deadline_ns) ||
        (state->cleanup_deadline_ns != 0 && now_ns >= state->cleanup_deadline_ns)) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_CLOCK, now_ns);
    }
    return state->failure == PDAA_LIFECYCLE_OK;
}

static struct pdaa_native_record *record_at(struct pdaa_lifecycle_state *state, uint32_t number)
{
    if (number == 0 || number > state->lifetime_records) return NULL;
    return &state->records[number - 1U];
}

uint32_t pdaa_lifecycle_find_live(const struct pdaa_lifecycle_state *state, uint32_t host_tid)
{
    uint32_t index;
    if (state == NULL || host_tid == 0) return 0;
    for (index = 0; index < state->lifetime_records; index++) {
        const struct pdaa_native_record *item = &state->records[index];
        if ((item->status == PDAA_RECORD_LIVE || item->status == PDAA_RECORD_NEWBORN) &&
            item->identity.host_tid == host_tid) return index + 1U;
    }
    return 0;
}

static int identity_valid(const struct pdaa_kernel_identity *identity)
{
    return identity != NULL && identity->host_tid > 0 && identity->host_tgid > 0 &&
           identity->namespace_tid > 0 && identity->start_ticks > 0;
}

int pdaa_lifecycle_initialize(struct pdaa_lifecycle_state *state,
                             const struct pdaa_kernel_identity *original,
                             uint64_t now_ns, uint64_t host_deadline_ns)
{
    if (state == NULL) return 0;
    /* Storage is freshly zero-initialized by the sole observer. Reinit denies
     * without erasing previous records, tombstones, failure or deadlines.
     */
    if (state->initialized || state->failure != PDAA_LIFECYCLE_OK) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    }
    if (!identity_valid(original) || original->host_tid != original->host_tgid ||
        original->namespace_tid != 1 || host_deadline_ns <= now_ns || now_ns == 0) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_IDENTITY, now_ns);
    }
    state->initialized = 1;
    state->host_deadline_ns = host_deadline_ns;
    state->last_monotonic_ns = now_ns;
    state->lifetime_records = state->live_records = 1;
    state->groups[0].used = state->groups[0].live = 1;
    state->groups[0].host_tgid = original->host_tgid;
    state->records[0].identity = *original;
    state->records[0].identity_authenticated = 1;
    state->records[0].status = PDAA_RECORD_LIVE;
    return journal(state, JOURNAL_INITIAL, 1, 0, 0, now_ns);
}

int pdaa_lifecycle_deadlines(struct pdaa_lifecycle_state *state, uint64_t now_ns,
                            uint64_t phase_deadline_ns, uint64_t cleanup_deadline_ns)
{
    if (state == NULL || !state->initialized || now_ns < state->last_monotonic_ns) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_CLOCK, now_ns);
    }
    /* A genuine first-abort cleanup deadline may arrive after sticky failure.
     * Retain it without clearing poison or granting healthy progression.
     */
    (void)pdaa_lifecycle_tick(state, now_ns);
    /* Transfer the existing absolute owner deadlines once, then allow only
     * tightening. Zero cannot clear a previously installed deadline.
     */
    if ((state->phase_deadline_ns != 0 && (phase_deadline_ns == 0 || phase_deadline_ns > state->phase_deadline_ns)) ||
        (state->cleanup_deadline_ns != 0 && (cleanup_deadline_ns == 0 || cleanup_deadline_ns > state->cleanup_deadline_ns)) ||
        (phase_deadline_ns != 0 && (phase_deadline_ns > state->host_deadline_ns ||
                                   (phase_deadline_ns > now_ns && phase_deadline_ns - now_ns > UINT64_C(60000000000)))) ||
        (cleanup_deadline_ns != 0 && (cleanup_deadline_ns > state->host_deadline_ns ||
                                     (cleanup_deadline_ns > now_ns && cleanup_deadline_ns - now_ns > UINT64_C(10000000000))))) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_CLOCK, now_ns);
    }
    state->phase_deadline_ns = phase_deadline_ns;
    state->cleanup_deadline_ns = cleanup_deadline_ns;
    if ((phase_deadline_ns != 0 && phase_deadline_ns <= now_ns) || (cleanup_deadline_ns != 0 && cleanup_deadline_ns <= now_ns)) {
        (void)pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_CLOCK, now_ns);
    }
    return journal(state, JOURNAL_DEADLINES, 0, 0, 0, now_ns);
}

int pdaa_lifecycle_arm_cli(struct pdaa_lifecycle_state *state, uint64_t now_ns)
{
    if (!pdaa_lifecycle_tick(state, now_ns)) return 0;
    if (state->cli_armed || state->phase_deadline_ns == 0 || state->groups[PDAA_ROLE_CLI].used ||
        state->groups[PDAA_ROLE_ORIGINAL].exec_observed != 1) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    state->cli_armed = 1;
    return journal(state, JOURNAL_ARM_CLI, 1, 0, PDAA_ROLE_CLI, now_ns);
}

static int group_exclusive(const struct pdaa_lifecycle_state *state, uint32_t group)
{
    uint32_t index;
    if (group >= PDAA_TARGET_TABLES || state->groups[group].live != 1 || state->groups[group].reserved != 0) return 0;
    for (index = 0; index < state->lifetime_records; index++) {
        const struct pdaa_native_record *item = &state->records[index];
        if (item->group == group && item->status != PDAA_RECORD_TERMINAL &&
            item->status != PDAA_RECORD_FAILED_BIRTH && item->pending != PDAA_PENDING_NONE) return 0;
    }
    return 1;
}

static int reserve_birth(struct pdaa_lifecycle_state *state, struct pdaa_native_record *parent,
                         int is_thread, uint64_t now_ns)
{
    uint32_t group = parent->group;
    struct pdaa_native_record *child;
    if (state->live_records + state->reserved_records >= PDAA_ACTIVE_TIDS ||
        state->lifetime_records >= PDAA_LIFETIME_TIDS) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_RESOURCE, now_ns);
    if (!is_thread) {
        if (group == PDAA_ROLE_ORIGINAL) {
            if (state->cli_armed != 1) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
            state->cli_armed = 2;
            group = PDAA_ROLE_CLI;
        }
        else if (group == PDAA_ROLE_CLI) {
            for (group = PDAA_ROLE_VERSION; group <= PDAA_ROLE_RPC && state->groups[group].used; group++) {}
        } else return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_TOPOLOGY, now_ns);
        if (group >= PDAA_TARGET_TABLES || state->groups[group].used) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_RESOURCE, now_ns);
        if (group > PDAA_ROLE_VERSION && (state->groups[group - 1U].live != 0 || state->groups[group - 1U].reserved != 0)) {
            return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_TOPOLOGY, now_ns);
        }
        state->groups[group].used = 1; /* never recycled, even on failed birth */
    }
    child = &state->records[state->lifetime_records++];
    child->group = group;
    child->status = PDAA_RECORD_RESERVED;
    state->reserved_records++;
    state->groups[group].reserved++;
    parent->reserved_record = state->lifetime_records;
    parent->reserved_group = group;
    parent->pending = is_thread ? PDAA_PENDING_THREAD : PDAA_PENDING_PROCESS;
    return 1;
}

int pdaa_lifecycle_enter(struct pdaa_lifecycle_state *state, uint32_t number,
                        uint32_t syscall_number, uint64_t clone_flags, uint64_t now_ns)
{
    struct pdaa_native_record *item;
    if (!pdaa_lifecycle_tick(state, now_ns)) return 0;
    item = record_at(state, number);
    if (item == NULL || item->status != PDAA_RECORD_LIVE || item->early_exit_seen || item->pending != PDAA_PENDING_NONE) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    }
    if (syscall_number == __NR_clone || syscall_number == __NR_fork || syscall_number == __NR_vfork) {
        uint64_t flags = clone_flags;
        const uint64_t thread_allowed = CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD |
            CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID;
        const uint64_t thread_required = CLONE_VM | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD;
        const uint64_t process_allowed = CLONE_VM | CLONE_VFORK | CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID | SIGCHLD;
        int is_thread;
        if (state->groups[item->group].exec_observed != 1) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
        if (syscall_number == __NR_fork) flags = SIGCHLD;
        if (syscall_number == __NR_vfork) flags = CLONE_VM | CLONE_VFORK | SIGCHLD;
        is_thread = (flags & CLONE_THREAD) != 0;
        if ((is_thread && ((flags & ~thread_allowed) != 0 || (flags & thread_required) != thread_required)) ||
            (!is_thread && ((flags & ~process_allowed) != 0 || (flags & 0xFFU) != SIGCHLD ||
                           (((flags & CLONE_VM) != 0) != ((flags & CLONE_VFORK) != 0))))) {
            return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_TOPOLOGY, now_ns);
        }
        if (!reserve_birth(state, item, is_thread, now_ns)) return 0;
        item->expected_birth_event = is_thread ? PTRACE_EVENT_CLONE :
            (flags & CLONE_VFORK) != 0 ? PTRACE_EVENT_VFORK : PTRACE_EVENT_FORK;
    } else if (syscall_number == __NR_execve || syscall_number == __NR_execveat) {
        if (state->groups[item->group].exec_observed || item->identity.host_tid != item->identity.host_tgid || !group_exclusive(state, item->group)) {
            return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_TOPOLOGY, now_ns);
        }
        item->pending = PDAA_PENDING_EXEC;
    } else if (syscall_number == __NR_close || syscall_number == __NR_close_range ||
               syscall_number == __NR_shutdown || syscall_number == __NR_exit || syscall_number == __NR_exit_group) {
        item->pending = PDAA_PENDING_RETIREMENT;
        /* A potential operation is not an irreversible recognition cleanup.
         * Clock transfer belongs to the genuine owner, never to this tag.
         */
    } else return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_SYSCALL, now_ns);
    item->syscall_number = syscall_number;
    return journal(state, JOURNAL_ENTRY, number, item->reserved_record, syscall_number, now_ns);
}

int pdaa_lifecycle_capture_birth(struct pdaa_lifecycle_state *state, uint32_t number, uint64_t actual_tid, uint32_t event)
{
    struct pdaa_native_record *parent, *child;
    if (state == NULL) return 0;
    parent = record_at(state, number);
    if (parent == NULL || parent->birth_raw_seen) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, state->last_monotonic_ns);
    parent->birth_raw_return = actual_tid;
    parent->birth_raw_event = event;
    parent->birth_raw_seen = 1;
    child = record_at(state, parent->reserved_record);
    if (child == NULL) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, state->last_monotonic_ns);
    child->actual_birth_return = actual_tid;
    return 1;
}

int pdaa_lifecycle_capture_exec(struct pdaa_lifecycle_state *state, uint32_t number, uint64_t former_tid)
{
    struct pdaa_native_record *item;
    if (state == NULL) return 0;
    item = record_at(state, number);
    if (item == NULL || item->exec_raw_seen) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, state->last_monotonic_ns);
    item->exec_raw_former_tid = former_tid;
    item->exec_raw_seen = 1;
    return 1;
}

int pdaa_lifecycle_birth_return(struct pdaa_lifecycle_state *state, uint32_t number,
                               uint64_t actual_tid, uint32_t actual_event, uint64_t now_ns)
{
    struct pdaa_native_record *parent, *child;
    uint32_t index;
    if (state == NULL || !state->initialized) return 0;
    (void)pdaa_lifecycle_tick(state, now_ns);
    parent = record_at(state, number);
    if (parent == NULL || parent->status != PDAA_RECORD_LIVE || parent->birth_event_seen ||
        (parent->pending != PDAA_PENDING_THREAD && parent->pending != PDAA_PENDING_PROCESS)) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    }
    child = record_at(state, parent->reserved_record);
    if (!parent->birth_raw_seen || parent->birth_raw_return != actual_tid || parent->birth_raw_event != actual_event ||
        child == NULL || child->status != PDAA_RECORD_RESERVED || child->actual_birth_return != actual_tid) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    if (actual_tid == 0 || actual_tid > INT_MAX) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_IDENTITY, now_ns);
    for (index = 0; index < state->lifetime_records; index++) {
        const struct pdaa_native_record *previous = &state->records[index];
        if (previous != child && (previous->status == PDAA_RECORD_LIVE || previous->status == PDAA_RECORD_NEWBORN) &&
            previous->identity.host_tid == actual_tid) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_IDENTITY, now_ns);
    }
    child->identity.host_tid = (uint32_t)actual_tid;
    child->status = PDAA_RECORD_NEWBORN;
    state->reserved_records--;
    state->live_records++;
    state->groups[child->group].reserved--;
    state->groups[child->group].live++;
    parent->birth_event_seen = 1;
    if (!journal(state, JOURNAL_BIRTH_RETURN, parent->reserved_record, number, actual_event, now_ns)) return 0;
    if (parent->expected_birth_event != actual_event) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    return 1; /* observed acquisition, never permission to resume */
}

int pdaa_lifecycle_birth(struct pdaa_lifecycle_state *state, uint32_t number,
                        const struct pdaa_kernel_identity *identity, uint64_t now_ns)
{
    struct pdaa_native_record *parent, *child;
    uint32_t index;
    if (state == NULL || !state->initialized) return 0;
    (void)pdaa_lifecycle_tick(state, now_ns);
    parent = record_at(state, number);
    if (parent == NULL || !parent->birth_event_seen || !identity_valid(identity)) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    child = record_at(state, parent->reserved_record);
    if (child == NULL || child->status != PDAA_RECORD_NEWBORN || child->identity_authenticated || child->actual_birth_return != identity->host_tid ||
        (parent->pending == PDAA_PENDING_THREAD ? identity->host_tgid != parent->identity.host_tgid : identity->host_tid != identity->host_tgid)) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_IDENTITY, now_ns);
    }
    for (index = 0; index < state->lifetime_records; index++) {
        const struct pdaa_native_record *previous = &state->records[index];
        if (previous == child || !previous->identity_authenticated) continue;
        if ((previous->identity.host_tid == identity->host_tid && previous->identity.start_ticks == identity->start_ticks) ||
            ((previous->status == PDAA_RECORD_LIVE || previous->status == PDAA_RECORD_NEWBORN) &&
             previous->identity.namespace_tid == identity->namespace_tid)) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_IDENTITY, now_ns);
    }
    child->identity = *identity;
    child->identity_authenticated = 1;
    if (parent->pending == PDAA_PENDING_PROCESS) state->groups[child->group].host_tgid = identity->host_tgid;
    return journal(state, JOURNAL_BIRTH, number, parent->reserved_record, child->group, now_ns);
}

int pdaa_lifecycle_newborn_stop(struct pdaa_lifecycle_state *state, uint32_t number, uint64_t now_ns)
{
    struct pdaa_native_record *item;
    if (!pdaa_lifecycle_tick(state, now_ns)) return 0;
    item = record_at(state, number);
    if (item == NULL || item->status != PDAA_RECORD_NEWBORN || !item->identity_authenticated) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    item->status = PDAA_RECORD_LIVE;
    return journal(state, JOURNAL_NEWBORN, number, 0, 0, now_ns);
}

int pdaa_lifecycle_exec(struct pdaa_lifecycle_state *state, uint32_t number,
                       const struct pdaa_kernel_identity *identity, uint64_t now_ns)
{
    struct pdaa_native_record *item;
    if (state == NULL || !state->initialized) return 0;
    (void)pdaa_lifecycle_tick(state, now_ns);
    item = record_at(state, number);
    if (item == NULL || item->status != PDAA_RECORD_LIVE || item->pending != PDAA_PENDING_EXEC || item->exec_event_seen ||
        !item->exec_raw_seen || item->exec_raw_former_tid != item->identity.host_tid ||
        !identity_valid(identity) || item->identity.host_tid != identity->host_tid ||
        item->identity.host_tgid != identity->host_tgid || item->identity.start_ticks != identity->start_ticks ||
        item->identity.namespace_tid != identity->namespace_tid) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_IDENTITY, now_ns);
    item->exec_event_seen = 1;
    state->groups[item->group].exec_observed = 1;
    return journal(state, JOURNAL_EXEC, number, 0, 0, now_ns);
}

static void clear_pending(struct pdaa_native_record *item)
{
    item->pending = PDAA_PENDING_NONE;
    item->reserved_record = item->reserved_group = 0;
    item->syscall_number = item->birth_event_seen = item->exec_event_seen = 0;
    item->expected_birth_event = 0;
    item->birth_raw_seen = item->birth_raw_event = 0;
    item->birth_raw_return = 0; /* retained in the actual child + journal */
}

int pdaa_lifecycle_result(struct pdaa_lifecycle_state *state, uint32_t number,
                         int64_t result, int is_error, uint64_t now_ns)
{
    struct pdaa_native_record *item, *child;
    if (!pdaa_lifecycle_tick(state, now_ns)) return 0;
    item = record_at(state, number);
    if (item == NULL || item->status != PDAA_RECORD_LIVE || item->pending == PDAA_PENDING_NONE ||
        (is_error != 0 && is_error != 1) || (is_error ? (result >= 0 || result < -4095) : result < 0)) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    }
    if (item->pending == PDAA_PENDING_THREAD || item->pending == PDAA_PENDING_PROCESS) {
        child = record_at(state, item->reserved_record);
        if (child == NULL) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
        if (is_error) {
            if (item->birth_event_seen || child->status != PDAA_RECORD_RESERVED) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
            child->status = PDAA_RECORD_FAILED_BIRTH;
            state->reserved_records--;
            state->groups[child->group].reserved--;
            /* Failed birth consumes its one-use slot and denies this run. */
            clear_pending(item);
            return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_SYSCALL, now_ns);
        }
        if (!item->birth_event_seen || result != (int64_t)child->identity.namespace_tid) {
            return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_IDENTITY, now_ns);
        }
    } else if (item->pending == PDAA_PENDING_EXEC) {
        if (is_error || !item->exec_event_seen || result != 0) return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_SYSCALL, now_ns);
    }
    /* Close/shutdown failure is retained as a fixed error bit. It does not
     * mean a descriptor is closed or license an unsafe numeric-FD retry.
     */
    if (!journal(state, JOURNAL_RESULT, number, item->reserved_record, (uint32_t)is_error, now_ns)) return 0;
    clear_pending(item);
    return 1;
}

int pdaa_lifecycle_early_exit(struct pdaa_lifecycle_state *state, uint32_t number, uint64_t now_ns)
{
    struct pdaa_native_record *item;
    if (state == NULL || !state->initialized) return 0;
    (void)pdaa_lifecycle_tick(state, now_ns);
    item = record_at(state, number);
    if (item == NULL || (item->status != PDAA_RECORD_LIVE && item->status != PDAA_RECORD_NEWBORN) || item->early_exit_seen) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    }
    item->early_exit_seen = 1;
    item->exit_stop_held = 1;
    return journal(state, JOURNAL_EARLY_EXIT, number, 0, 0, now_ns);
}

int pdaa_lifecycle_terminal(struct pdaa_lifecycle_state *state, uint32_t number,
                           uint32_t status, uint64_t now_ns)
{
    struct pdaa_native_record *item;
    int actual_status = (int)status;
    if (state == NULL || !state->initialized) return 0;
    /* Terminal facts remain recordable after failure/deadline. They never
     * clear the failure, manufacture an exit, or discharge pending births.
     */
    (void)pdaa_lifecycle_tick(state, now_ns);
    item = record_at(state, number);
    if (item == NULL || (item->status != PDAA_RECORD_LIVE && item->status != PDAA_RECORD_NEWBORN) ||
        (status & 0xFFFF0000U) != 0 || (!WIFEXITED(actual_status) && !WIFSIGNALED(actual_status))) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    }
    item->status = PDAA_RECORD_TERMINAL;
    item->exit_stop_held = 0;
    item->terminal_wait_status = status;
    state->live_records--;
    state->groups[item->group].live--;
    return journal(state, JOURNAL_TERMINAL, number, item->reserved_record, status, now_ns);
}

int pdaa_lifecycle_identity_absent(struct pdaa_lifecycle_state *state, uint32_t number, uint64_t now_ns)
{
    struct pdaa_native_record *item;
    if (state == NULL || !state->initialized) return 0;
    (void)pdaa_lifecycle_tick(state, now_ns);
    item = record_at(state, number);
    if (item == NULL || item->status != PDAA_RECORD_TERMINAL || !item->identity_authenticated || item->original_identity_absent) {
        return pdaa_lifecycle_fail(state, PDAA_LIFECYCLE_ORDER, now_ns);
    }
    item->original_identity_absent = 1;
    return journal(state, JOURNAL_IDENTITY_ABSENT, number, 0, 0, now_ns);
}

int pdaa_lifecycle_tree_exits_observed(const struct pdaa_lifecycle_state *state)
{
    uint32_t index;
    if (state == NULL || !state->initialized || state->live_records != 0 || state->reserved_records != 0) return 0;
    for (index = 0; index < state->lifetime_records; index++) {
        if (state->records[index].status != PDAA_RECORD_TERMINAL &&
            state->records[index].status != PDAA_RECORD_FAILED_BIRTH) return 0;
        if (state->records[index].reserved_record != 0 && !state->records[index].birth_event_seen) return 0;
    }
    return 1;
}

int pdaa_lifecycle_tree_terminal(const struct pdaa_lifecycle_state *state)
{
    uint32_t index;
    if (!pdaa_lifecycle_tree_exits_observed(state)) return 0;
    for (index = 0; index < state->lifetime_records; index++) {
        const struct pdaa_native_record *item = &state->records[index];
        if (item->status == PDAA_RECORD_TERMINAL && (!item->identity_authenticated ||
            (item->identity.host_tid == item->identity.host_tgid && !item->original_identity_absent))) return 0;
    }
    return 1;
}

int pdaa_lifecycle_children_terminal(const struct pdaa_lifecycle_state *state)
{
    uint32_t index;
    if (state == NULL || !state->initialized || !state->groups[PDAA_ROLE_CLI].used) return 0;
    for (index = 0; index < state->lifetime_records; index++) {
        const struct pdaa_native_record *item = &state->records[index];
        if (item->group == PDAA_ROLE_ORIGINAL && item->status != PDAA_RECORD_FAILED_BIRTH && !item->identity_authenticated) return 0;
        if (item->group != PDAA_ROLE_ORIGINAL && item->status != PDAA_RECORD_TERMINAL &&
            item->status != PDAA_RECORD_FAILED_BIRTH) return 0;
        if (item->group != PDAA_ROLE_ORIGINAL && item->status == PDAA_RECORD_TERMINAL &&
            (!item->identity_authenticated || (item->identity.host_tid == item->identity.host_tgid && !item->original_identity_absent))) return 0;
        if (item->group == PDAA_ROLE_ORIGINAL && item->reserved_record != 0 &&
            state->records[item->reserved_record - 1U].group != PDAA_ROLE_ORIGINAL && !item->birth_event_seen) return 0;
    }
    return 1;
}
