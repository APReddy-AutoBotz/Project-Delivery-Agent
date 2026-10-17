/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Deterministic model controls calling the actual finite-state implementation.
 * NO kernel adapter/installer invocation or production admission. UNRUN SOURCE.
 */
#include "recognition-lifecycle-state.h"
#include <linux/sched.h>
#include <linux/ptrace.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>

static struct pdaa_lifecycle_state state; /* 4 MiB journal stays off the stack */
static uint64_t now_ns;
static unsigned int checked;
#define REQUIRE(value) do { checked++; if (!(value)) { fprintf(stderr, "Native lifecycle modeled check failed: %u\n", checked); return 0; } } while (0)
#define THREAD_FLAGS ((uint64_t)(CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID))

static int fresh(void)
{
    const struct pdaa_kernel_identity original = {100, 100, 1, 1000};
    memset(&state, 0, sizeof(state)); /* model fixture only, not production reset */
    now_ns = 100;
    return pdaa_lifecycle_initialize(&state, &original, now_ns++, UINT64_C(300000000000));
}

static int execute(uint32_t number)
{
    struct pdaa_kernel_identity identity = state.records[number - 1U].identity;
    return pdaa_lifecycle_enter(&state, number, __NR_execve, 0, now_ns++) &&
           pdaa_lifecycle_capture_exec(&state, number, identity.host_tid) &&
           pdaa_lifecycle_exec(&state, number, &identity, now_ns++) &&
           pdaa_lifecycle_result(&state, number, 0, 0, now_ns++);
}

static int running_original(void)
{
    return fresh() && execute(1) &&
        pdaa_lifecycle_deadlines(&state, now_ns++, UINT64_C(60000000000), 0) &&
        pdaa_lifecycle_arm_cli(&state, now_ns++);
}

static uint32_t birth(uint32_t parent, int thread, uint32_t tid, uint32_t namespace_tid, uint64_t start)
{
    struct pdaa_kernel_identity child = {tid, thread ? state.records[parent - 1U].identity.host_tgid : tid, namespace_tid, start};
    uint32_t number;
    if (!pdaa_lifecycle_enter(&state, parent, thread ? __NR_clone : __NR_fork, thread ? THREAD_FLAGS : 0, now_ns++)) return 0;
    number = state.records[parent - 1U].reserved_record;
    if (!pdaa_lifecycle_capture_birth(&state, parent, tid, thread ? PTRACE_EVENT_CLONE : PTRACE_EVENT_FORK) ||
        !pdaa_lifecycle_birth_return(&state, parent, tid, thread ? PTRACE_EVENT_CLONE : PTRACE_EVENT_FORK, now_ns++) ||
        !pdaa_lifecycle_birth(&state, parent, &child, now_ns++) ||
        !pdaa_lifecycle_newborn_stop(&state, number, now_ns++) ||
        !pdaa_lifecycle_result(&state, parent, namespace_tid, 0, now_ns++)) return 0;
    return number;
}

static int normal_tree(void)
{
    uint32_t cli, engine, thread, role;
    REQUIRE(running_original());
    REQUIRE(!pdaa_lifecycle_children_terminal(&state));
    cli = birth(1, 0, 200, 2, 2000);
    REQUIRE(cli == 2 && state.groups[PDAA_ROLE_CLI].live == 1 && state.live_records == 2);
    REQUIRE(execute(cli));
    thread = birth(cli, 1, 201, 3, 2001);
    REQUIRE(thread == 3 && state.records[thread - 1U].group == PDAA_ROLE_CLI && state.groups[PDAA_ROLE_CLI].live == 2);
    REQUIRE(pdaa_lifecycle_enter(&state, thread, __NR_exit, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_early_exit(&state, thread, now_ns++));
    REQUIRE(state.live_records == 3); /* early exit is NOT terminal */
    REQUIRE(pdaa_lifecycle_terminal(&state, thread, 0, now_ns++));
    for (role = PDAA_ROLE_VERSION; role <= PDAA_ROLE_RPC; role++) {
        engine = birth(cli, 0, 300 + role, 10 + role, 3000 + role);
        REQUIRE(engine != 0 && state.records[engine - 1U].group == role);
        REQUIRE(execute(engine));
        REQUIRE(pdaa_lifecycle_enter(&state, engine, __NR_exit_group, 0, now_ns++));
        REQUIRE(pdaa_lifecycle_early_exit(&state, engine, now_ns++));
        REQUIRE(!pdaa_lifecycle_children_terminal(&state));
        REQUIRE(pdaa_lifecycle_terminal(&state, engine, 0, now_ns++));
        REQUIRE(!state.records[engine - 1U].original_identity_absent);
        REQUIRE(pdaa_lifecycle_identity_absent(&state, engine, now_ns++));
    }
    REQUIRE(pdaa_lifecycle_terminal(&state, cli, 0, now_ns++));
    REQUIRE(!pdaa_lifecycle_children_terminal(&state)); /* tracer wait != parent reap */
    REQUIRE(pdaa_lifecycle_identity_absent(&state, cli, now_ns++));
    REQUIRE(pdaa_lifecycle_children_terminal(&state));
    REQUIRE(!pdaa_lifecycle_tree_terminal(&state)); /* original remains for postflight */
    REQUIRE(state.records[0].status == PDAA_RECORD_LIVE && state.live_records == 1);
    REQUIRE(state.groups[4].used && PDAA_TARGET_TABLE_ENTRIES == 960U);
    REQUIRE(pdaa_lifecycle_terminal(&state, 1, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_tree_exits_observed(&state) && !pdaa_lifecycle_tree_terminal(&state));
    REQUIRE(pdaa_lifecycle_identity_absent(&state, 1, now_ns++));
    REQUIRE(pdaa_lifecycle_tree_terminal(&state));
    REQUIRE(state.failure == PDAA_LIFECYCLE_OK);
    return 1;
}

static int vfork_and_order(void)
{
    struct pdaa_kernel_identity child = {200, 200, 2, 2000};
    uint32_t number;
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_vfork, 0, now_ns++));
    number = state.records[0].reserved_record;
    REQUIRE(state.reserved_records == 1 && state.groups[1].used && !state.groups[1].live);
    REQUIRE(state.records[0].expected_birth_event == PTRACE_EVENT_VFORK);
    REQUIRE(pdaa_lifecycle_capture_birth(&state, 1, 200, PTRACE_EVENT_VFORK));
    REQUIRE(pdaa_lifecycle_birth_return(&state, 1, 200, PTRACE_EVENT_VFORK, now_ns++));
    REQUIRE(pdaa_lifecycle_birth(&state, 1, &child, now_ns++));
    REQUIRE(pdaa_lifecycle_newborn_stop(&state, number, now_ns++));
    REQUIRE(execute(number)); /* child progresses BEFORE parent's vfork result */
    REQUIRE(pdaa_lifecycle_result(&state, 1, 2, 0, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_OK);
    REQUIRE(fresh());
    REQUIRE(!pdaa_lifecycle_result(&state, 1, 0, 0, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_ORDER);
    REQUIRE(fresh());
    REQUIRE(!pdaa_lifecycle_birth(&state, 1, &child, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_ORDER);
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    REQUIRE(state.reserved_records == 1); /* uncertainty retained */
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    REQUIRE(!pdaa_lifecycle_result(&state, 1, -11, 1, now_ns++));
    REQUIRE(state.groups[1].used && state.records[1].status == PDAA_RECORD_FAILED_BIRTH && state.reserved_records == 0);
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++)); /* no retry after failure */
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    REQUIRE(!pdaa_lifecycle_result(&state, 1, 2, 0, now_ns++)); /* no matching actual birth */
    REQUIRE(state.reserved_records == 1);
    return 1;
}

static int topology_denials(void)
{
    const uint64_t forbidden_flags[] = {
        THREAD_FLAGS & ~(uint64_t)CLONE_FILES,
        THREAD_FLAGS & ~(uint64_t)CLONE_VM,
        THREAD_FLAGS & ~(uint64_t)CLONE_SIGHAND,
        THREAD_FLAGS | CLONE_UNTRACED,
        THREAD_FLAGS | CLONE_NEWUSER,
        THREAD_FLAGS | CLONE_NEWPID,
        THREAD_FLAGS | CLONE_NEWNS,
        THREAD_FLAGS | CLONE_NEWNET,
        THREAD_FLAGS | CLONE_PARENT,
        THREAD_FLAGS | UINT64_C(0x100000000),
        (uint64_t)(CLONE_FILES | SIGCHLD),
        (uint64_t)(CLONE_VM | SIGCHLD),
        (uint64_t)(CLONE_VFORK | SIGCHLD),
        (uint64_t)SIGUSR1,
        0
    };
    size_t index;
    uint32_t cli, engine, role, lifetime_before;
    REQUIRE(fresh());
    REQUIRE(execute(1));
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++)); /* no genuine CLI arm */
    REQUIRE(fresh());
    REQUIRE(!pdaa_lifecycle_arm_cli(&state, now_ns++)); /* no phase/exec */
    REQUIRE(running_original());
    REQUIRE(!pdaa_lifecycle_arm_cli(&state, now_ns++)); /* one-use arm */
    for (index = 0; index < sizeof(forbidden_flags) / sizeof(forbidden_flags[0]); index++) {
        REQUIRE(running_original());
        REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_clone, forbidden_flags[index], now_ns++));
        REQUIRE(state.failure == PDAA_LIFECYCLE_TOPOLOGY);
    }
    REQUIRE(running_original());
    cli = birth(1, 0, 200, 2, 2000);
    REQUIRE(cli != 0 && execute(cli));
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++)); /* consumed CLI arm/wrong parent */
    REQUIRE(running_original());
    cli = birth(1, 0, 200, 2, 2000);
    REQUIRE(cli != 0 && execute(cli));
    engine = birth(cli, 0, 300, 3, 3000);
    REQUIRE(engine != 0 && execute(engine));
    REQUIRE(!pdaa_lifecycle_enter(&state, cli, __NR_fork, 0, now_ns++)); /* previous engine still live */
    REQUIRE(running_original());
    cli = birth(1, 0, 200, 2, 2000);
    REQUIRE(cli != 0 && execute(cli));
    engine = birth(cli, 0, 300, 3, 3000);
    REQUIRE(engine != 0 && execute(engine));
    REQUIRE(!pdaa_lifecycle_enter(&state, engine, __NR_fork, 0, now_ns++));
    REQUIRE(running_original());
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_execve, 0, now_ns++)); /* reexec denied */
    REQUIRE(running_original());
    cli = birth(1, 0, 200, 2, 2000);
    REQUIRE(cli != 0 && execute(cli));
    for (role = PDAA_ROLE_VERSION; role <= PDAA_ROLE_RPC; role++) {
        engine = birth(cli, 0, 300 + role, 10 + role, 3000 + role);
        REQUIRE(engine != 0 && execute(engine));
        REQUIRE(pdaa_lifecycle_terminal(&state, engine, 0, now_ns++));
        REQUIRE(pdaa_lifecycle_identity_absent(&state, engine, now_ns++));
    }
    lifetime_before = state.lifetime_records;
    REQUIRE(lifetime_before == 5 && state.groups[4].used);
    REQUIRE(!pdaa_lifecycle_enter(&state, cli, __NR_fork, 0, now_ns++)); /* real sixth-process attempt */
    REQUIRE(state.lifetime_records == lifetime_before && state.reserved_records == 0);
    return 1;
}

static int identity_and_terminal(void)
{
    struct pdaa_kernel_identity wrong = {201, 201, 2, 2000};
    struct pdaa_kernel_identity same_root = {100, 100, 1, 1000};
    uint32_t number;
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_clone, THREAD_FLAGS, now_ns++));
    REQUIRE(pdaa_lifecycle_capture_birth(&state, 1, wrong.host_tid, PTRACE_EVENT_CLONE));
    REQUIRE(pdaa_lifecycle_birth_return(&state, 1, wrong.host_tid, PTRACE_EVENT_CLONE, now_ns++));
    REQUIRE(!pdaa_lifecycle_birth(&state, 1, &wrong, now_ns++)); /* thread TGID cannot split */
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_capture_birth(&state, 1, same_root.host_tid, PTRACE_EVENT_FORK));
    REQUIRE(!pdaa_lifecycle_birth_return(&state, 1, same_root.host_tid, PTRACE_EVENT_FORK, now_ns++)); /* actual identity collision */
    REQUIRE(fresh());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_execve, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_capture_exec(&state, 1, same_root.host_tid));
    same_root.start_ticks++;
    REQUIRE(!pdaa_lifecycle_exec(&state, 1, &same_root, now_ns++));
    REQUIRE(fresh());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_execve, 0, now_ns++));
    REQUIRE(!pdaa_lifecycle_result(&state, 1, 0, 0, now_ns++)); /* no actual exec event */
    REQUIRE(fresh());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_execve, 0, now_ns++));
    REQUIRE(!pdaa_lifecycle_result(&state, 1, -2, 1, now_ns++));
    REQUIRE(running_original());
    number = birth(1, 1, 200, 2, 2000);
    REQUIRE(number != 0);
    REQUIRE(pdaa_lifecycle_early_exit(&state, number, now_ns++));
    REQUIRE(pdaa_lifecycle_find_live(&state, 200) == number && state.live_records == 2);
    REQUIRE(!pdaa_lifecycle_tree_terminal(&state));
    REQUIRE(!pdaa_lifecycle_terminal(&state, number, (19U << 8) | 0x7FU, now_ns++)); /* stop != death */
    REQUIRE(pdaa_lifecycle_terminal(&state, number, 9, now_ns++)); /* real signal death retained after failure */
    REQUIRE(state.failure != PDAA_LIFECYCLE_OK && pdaa_lifecycle_find_live(&state, 200) == 0);
    REQUIRE(!pdaa_lifecycle_terminal(&state, number, 9, now_ns++)); /* duplicate terminal */
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_terminal(&state, 1, 9, now_ns++));
    REQUIRE(state.reserved_records == 1 && !pdaa_lifecycle_tree_terminal(&state)); /* unknown birth remains */
    return 1;
}

static int clocks_and_journal(void)
{
    uint64_t host_deadline;
    unsigned int before;
    REQUIRE(fresh());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_close, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_result(&state, 1, 0, 0, now_ns++));
    REQUIRE(state.phase_deadline_ns == 0 && state.cleanup_deadline_ns == 0); /* no fabricated claim/cleanup */
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_deadlines(&state, now_ns++, UINT64_C(60000000000), UINT64_C(10000000000)));
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_close_range, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_result(&state, 1, 0, 0, now_ns++));
    REQUIRE(state.cleanup_deadline_ns == UINT64_C(10000000000));
    REQUIRE(!pdaa_lifecycle_deadlines(&state, now_ns++, UINT64_C(60000000000), UINT64_C(10000000001)));
    REQUIRE(state.cleanup_deadline_ns == UINT64_C(10000000000));
    REQUIRE(running_original());
    REQUIRE(!pdaa_lifecycle_deadlines(&state, now_ns++, 0, 0)); /* cannot clear phase */
    REQUIRE(running_original());
    REQUIRE(!pdaa_lifecycle_tick(&state, state.last_monotonic_ns - 1U));
    REQUIRE(running_original());
    REQUIRE(!pdaa_lifecycle_tick(&state, state.phase_deadline_ns)); /* exact deadline denies */
    REQUIRE(state.failure == PDAA_LIFECYCLE_CLOCK);
    REQUIRE(pdaa_lifecycle_terminal(&state, 1, 9, state.phase_deadline_ns + 1U));
    REQUIRE(state.failure == PDAA_LIFECYCLE_CLOCK); /* terminal cannot erase failure */
    REQUIRE(fresh());
    host_deadline = state.host_deadline_ns;
    REQUIRE(!pdaa_lifecycle_initialize(&state, &state.records[0].identity, now_ns++, host_deadline + 1U));
    REQUIRE(state.host_deadline_ns == host_deadline && state.lifetime_records == 1);
    REQUIRE(fresh());
    REQUIRE(memcmp(state.events[0], "PDAANV01", 8) == 0 && state.event_count == 1);
    for (before = 64; before < PDAA_NATIVE_EVENT_BYTES; before++) REQUIRE(state.events[0][before] == 0);
    REQUIRE(sizeof(state.events) == 4194304U); /* framing included */
    state.event_count = PDAA_NATIVE_EVENTS; /* modeled fixed-buffer exhaustion */
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_close, 0, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_OVERFLOW && state.event_count == PDAA_NATIVE_EVENTS);
    REQUIRE(state.records[0].pending == PDAA_PENDING_RETIREMENT); /* no erased uncertainty */
    return 1;
}

static int finite_boundaries_and_reuse(void)
{
    uint32_t index, number;
    REQUIRE(running_original());
    for (index = 1; index < PDAA_ACTIVE_TIDS; index++) {
        number = birth(1, 1, 200 + index, 2 + index, 2000 + index);
        REQUIRE(number == index + 1U);
    }
    REQUIRE(state.live_records == PDAA_ACTIVE_TIDS);
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_clone, THREAD_FLAGS, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_RESOURCE && state.live_records == PDAA_ACTIVE_TIDS);
    REQUIRE(running_original());
    for (index = 1; index < PDAA_LIFETIME_TIDS; index++) {
        /* Same numeric TID is allowed only after actual terminality; fresh
         * start_ticks produces a distinct retained lifetime identity.
         */
        number = birth(1, 1, 200, 2, 2000 + index);
        REQUIRE(number == index + 1U);
        REQUIRE(pdaa_lifecycle_terminal(&state, number, 0, now_ns++));
    }
    REQUIRE(state.lifetime_records == PDAA_LIFETIME_TIDS && state.live_records == 1);
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_clone, THREAD_FLAGS, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_RESOURCE && state.lifetime_records == PDAA_LIFETIME_TIDS);
    return 1;
}

static int retained_failures_and_boundaries(void)
{
    const struct pdaa_kernel_identity child = {200, 200, 2, 2000};
    struct pdaa_kernel_identity original;
    uint32_t number, cli;
    uint64_t high_water;
    REQUIRE(running_original());
    REQUIRE(!pdaa_lifecycle_fail(&state, PDAA_LIFECYCLE_CUSTODY, now_ns++));
    REQUIRE(pdaa_lifecycle_deadlines(&state, now_ns++, UINT64_C(60000000000), UINT64_C(10000000000)));
    REQUIRE(state.cleanup_deadline_ns == UINT64_C(10000000000) && state.failure == PDAA_LIFECYCLE_CUSTODY);
    REQUIRE(!pdaa_lifecycle_arm_cli(&state, now_ns++)); /* one-use arm remains denied */
    REQUIRE(state.records[0].pending == PDAA_PENDING_NONE);
    REQUIRE(!pdaa_lifecycle_enter(&state, 1, __NR_close, 0, now_ns++)); /* otherwise-valid operation denied by poison */
    REQUIRE(state.records[0].pending == PDAA_PENDING_NONE);
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    number = state.records[0].reserved_record;
    REQUIRE(pdaa_lifecycle_capture_birth(&state, 1, 200, PTRACE_EVENT_FORK));
    REQUIRE(state.records[number - 1U].actual_birth_return == 200); /* before any next clock sample */
    now_ns = state.phase_deadline_ns;
    REQUIRE(pdaa_lifecycle_birth_return(&state, 1, 200, PTRACE_EVENT_FORK, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_CLOCK && pdaa_lifecycle_find_live(&state, 200) == number);
    REQUIRE(pdaa_lifecycle_birth(&state, 1, &child, now_ns++)); /* actual identity retained after denial */
    REQUIRE(state.records[number - 1U].identity_authenticated);
    REQUIRE(!pdaa_lifecycle_newborn_stop(&state, number, now_ns++)); /* never healthy release */
    REQUIRE(pdaa_lifecycle_terminal(&state, number, 9, now_ns++));
    REQUIRE(pdaa_lifecycle_identity_absent(&state, number, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_CLOCK);
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_capture_birth(&state, 1, 200, PTRACE_EVENT_VFORK));
    REQUIRE(!pdaa_lifecycle_birth_return(&state, 1, 200, PTRACE_EVENT_VFORK, now_ns++));
    REQUIRE(state.records[1].actual_birth_return == 200 && pdaa_lifecycle_find_live(&state, 200) == 2);
    REQUIRE(fresh());
    original = state.records[0].identity;
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_execve, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_capture_exec(&state, 1, original.host_tid));
    now_ns = state.host_deadline_ns;
    REQUIRE(pdaa_lifecycle_exec(&state, 1, &original, now_ns++));
    REQUIRE(state.records[0].exec_event_seen && state.failure == PDAA_LIFECYCLE_CLOCK);
    REQUIRE(running_original());
    now_ns = state.phase_deadline_ns + 1U;
    REQUIRE(!pdaa_lifecycle_tick(&state, now_ns++));
    high_water = now_ns + UINT64_C(9999999999);
    REQUIRE(pdaa_lifecycle_deadlines(&state, now_ns++, state.phase_deadline_ns, high_water));
    high_water = now_ns + 100;
    REQUIRE(!pdaa_lifecycle_tick(&state, high_water));
    REQUIRE(state.last_monotonic_ns == high_water);
    REQUIRE(!pdaa_lifecycle_tick(&state, high_water - 1U));
    REQUIRE(state.last_monotonic_ns == high_water); /* no rollback after phase expiry */
    REQUIRE(running_original());
    cli = birth(1, 0, 200, 2, 2000);
    REQUIRE(cli != 0 && execute(cli));
    REQUIRE(pdaa_lifecycle_terminal(&state, cli, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_identity_absent(&state, cli, now_ns++));
    REQUIRE(pdaa_lifecycle_children_terminal(&state));
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_clone, THREAD_FLAGS, now_ns++));
    REQUIRE(pdaa_lifecycle_capture_birth(&state, 1, 201, PTRACE_EVENT_CLONE));
    REQUIRE(pdaa_lifecycle_birth_return(&state, 1, 201, PTRACE_EVENT_CLONE, now_ns++));
    REQUIRE(!pdaa_lifecycle_fail(&state, PDAA_LIFECYCLE_CUSTODY, now_ns++));
    REQUIRE(!pdaa_lifecycle_children_terminal(&state)); /* provisional original-thread group is not authenticated */
    REQUIRE(state.records[2].status == PDAA_RECORD_NEWBORN && !state.records[2].identity_authenticated);
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_fork, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_capture_birth(&state, 1, UINT64_MAX, PTRACE_EVENT_FORK));
    REQUIRE(state.records[1].actual_birth_return == UINT64_MAX);
    REQUIRE(!pdaa_lifecycle_birth_return(&state, 1, UINT64_MAX, PTRACE_EVENT_FORK, now_ns++));
    REQUIRE(state.records[1].actual_birth_return == UINT64_MAX && state.reserved_records == 1);
    REQUIRE(fresh());
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_execve, 0, now_ns++));
    REQUIRE(pdaa_lifecycle_capture_exec(&state, 1, 999));
    REQUIRE(state.records[0].exec_raw_seen && state.records[0].exec_raw_former_tid == 999 && !state.records[0].exec_event_seen);
    REQUIRE(fresh());
    REQUIRE(!pdaa_lifecycle_tick(&state, state.host_deadline_ns));
    REQUIRE(state.failure == PDAA_LIFECYCLE_CLOCK);
    REQUIRE(running_original());
    REQUIRE(pdaa_lifecycle_deadlines(&state, now_ns++, UINT64_C(50000000000), UINT64_C(9000000000)));
    REQUIRE(state.phase_deadline_ns == UINT64_C(50000000000));
    REQUIRE(!pdaa_lifecycle_tick(&state, state.cleanup_deadline_ns));
    REQUIRE(state.failure == PDAA_LIFECYCLE_CLOCK);
    REQUIRE(fresh());
    while (state.event_count < PDAA_NATIVE_EVENTS - 1U) {
        REQUIRE(pdaa_lifecycle_deadlines(&state, now_ns++, 0, 0));
    }
    REQUIRE(pdaa_lifecycle_enter(&state, 1, __NR_close, 0, now_ns++));
    REQUIRE(state.event_count == PDAA_NATIVE_EVENTS);
    REQUIRE(!pdaa_lifecycle_result(&state, 1, 0, 0, now_ns++));
    REQUIRE(state.failure == PDAA_LIFECYCLE_OVERFLOW && state.records[0].pending == PDAA_PENDING_RETIREMENT);
    return 1;
}

int main(void)
{
    if (!normal_tree() || !vfork_and_order() || !topology_denials() || !identity_and_terminal() ||
        !clocks_and_journal() || !finite_boundaries_and_reuse() || !retained_failures_and_boundaries()) return 1;
    printf("Native lifecycle modeled checks passed: %u; kernel observer calls: 0\n", checked);
    return 0;
}
