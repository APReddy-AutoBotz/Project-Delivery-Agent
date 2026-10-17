/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Acceptance-only finite lifecycle accounting. SOURCE ONLY, not qualification.
 * The real observer supplies kernel facts. Modeled calls confer no authority.
 */
#ifndef PDAA_RECOGNITION_LIFECYCLE_STATE_H
#define PDAA_RECOGNITION_LIFECYCLE_STATE_H

#include <stddef.h>
#include <stdint.h>
#include "recognition-lifecycle-policy.h"

#define PDAA_ACTIVE_TIDS 128U
#define PDAA_LIFETIME_TIDS 512U
#define PDAA_NATIVE_EVENTS 32768U
#define PDAA_NATIVE_EVENT_BYTES 128U
#define PDAA_NATIVE_EVENT_STORAGE (PDAA_NATIVE_EVENTS * PDAA_NATIVE_EVENT_BYTES)

enum pdaa_lifecycle_error {
    PDAA_LIFECYCLE_OK = 0,
    PDAA_LIFECYCLE_IDENTITY = 1,
    PDAA_LIFECYCLE_ORDER = 2,
    PDAA_LIFECYCLE_TOPOLOGY = 3,
    PDAA_LIFECYCLE_RESOURCE = 4,
    PDAA_LIFECYCLE_ABI = 5,
    PDAA_LIFECYCLE_CLOCK = 6,
    PDAA_LIFECYCLE_CUSTODY = 7,
    PDAA_LIFECYCLE_OVERFLOW = 8,
    PDAA_LIFECYCLE_SYSCALL = 9
};

enum pdaa_native_role {
    PDAA_ROLE_ORIGINAL = 0, PDAA_ROLE_CLI = 1,
    PDAA_ROLE_VERSION = 2, PDAA_ROLE_CAN_CONNECT = 3, PDAA_ROLE_RPC = 4
};

enum pdaa_pending_kind {
    PDAA_PENDING_NONE = 0, PDAA_PENDING_THREAD = 1,
    PDAA_PENDING_PROCESS = 2, PDAA_PENDING_EXEC = 3,
    PDAA_PENDING_RETIREMENT = 4
};

enum pdaa_native_record_status {
    PDAA_RECORD_UNUSED = 0, PDAA_RECORD_RESERVED = 1,
    PDAA_RECORD_NEWBORN = 2, PDAA_RECORD_LIVE = 3,
    PDAA_RECORD_TERMINAL = 4, PDAA_RECORD_FAILED_BIRTH = 5
};

struct pdaa_kernel_identity {
    uint32_t host_tid;
    uint32_t host_tgid;
    uint32_t namespace_tid;
    uint64_t start_ticks;
};

struct pdaa_native_record {
    struct pdaa_kernel_identity identity;
    uint32_t group;
    enum pdaa_native_record_status status;
    enum pdaa_pending_kind pending;
    uint32_t reserved_record; /* 1-based; zero means none */
    uint32_t reserved_group;
    uint32_t syscall_number;
    uint32_t birth_event_seen;
    uint32_t exec_event_seen;
    uint32_t early_exit_seen;
    uint32_t terminal_wait_status;
    uint64_t actual_birth_return;
    uint32_t identity_authenticated;
    uint32_t expected_birth_event;
    uint32_t original_identity_absent;
    uint32_t exit_stop_held;
    uint32_t exit_resume_attempted;
    uint32_t birth_raw_seen;
    uint32_t birth_raw_event;
    uint64_t birth_raw_return;
    uint32_t exec_raw_seen;
    uint64_t exec_raw_former_tid;
};

struct pdaa_native_group {
    uint32_t used; /* lifetime one-use process/table reservation */
    uint32_t live;
    uint32_t reserved;
    uint32_t host_tgid;
    uint32_t exec_observed;
};

/* No heap, callbacks, raw argv, environments, paths or syscall pointer data.
 * Journal framing is exactly 128 bytes, all unused bytes are zero. Journal
 * capacity is separate from the originating 4 MiB row-data allowance.
 */
struct pdaa_lifecycle_state {
    enum pdaa_lifecycle_error failure;
    uint32_t initialized;
    uint32_t lifetime_records;
    uint32_t live_records;
    uint32_t reserved_records;
    uint32_t event_count;
    uint32_t cli_armed;
    uint64_t last_monotonic_ns;
    uint64_t host_deadline_ns;
    uint64_t phase_deadline_ns;
    uint64_t cleanup_deadline_ns;
    struct pdaa_native_group groups[PDAA_TARGET_TABLES];
    struct pdaa_native_record records[PDAA_LIFETIME_TIDS];
    unsigned char events[PDAA_NATIVE_EVENTS][PDAA_NATIVE_EVENT_BYTES];
};

/* These are mechanical accounting APIs used only by the native observer.
 * Initialization is not attach, containment, source or capability admission.
 * Absolute deadlines must be transferred from genuine existing owners; this
 * module cannot start/reset a phase or cleanup clock from a syscall tag.
 */
int pdaa_lifecycle_initialize(struct pdaa_lifecycle_state *state,
                             const struct pdaa_kernel_identity *original,
                             uint64_t now_ns, uint64_t host_deadline_ns);
int pdaa_lifecycle_deadlines(struct pdaa_lifecycle_state *state, uint64_t now_ns,
                            uint64_t phase_deadline_ns, uint64_t cleanup_deadline_ns);
int pdaa_lifecycle_tick(struct pdaa_lifecycle_state *state, uint64_t now_ns);
/* Private original owner arms its one CLI birth only after genuine invocation
 * binding and the existing phase deadline transfer. Not a public API token.
 */
int pdaa_lifecycle_arm_cli(struct pdaa_lifecycle_state *state, uint64_t now_ns);
uint32_t pdaa_lifecycle_find_live(const struct pdaa_lifecycle_state *state, uint32_t host_tid);
int pdaa_lifecycle_enter(struct pdaa_lifecycle_state *state, uint32_t record,
                        uint32_t syscall_number, uint64_t clone_flags, uint64_t now_ns);
/* Pure first registration immediately after kernel GETEVENTMSG returns.
 * These perform no clocks, syscalls, authentication or healthy progression.
 */
int pdaa_lifecycle_capture_birth(struct pdaa_lifecycle_state *state, uint32_t parent, uint64_t actual_tid, uint32_t event);
int pdaa_lifecycle_capture_exec(struct pdaa_lifecycle_state *state, uint32_t record, uint64_t former_tid);
/* Retain the actual kernel GETEVENTMSG return BEFORE identity/clock guards.
 * Success here means observation retained, even when failure is sticky.
 */
int pdaa_lifecycle_birth_return(struct pdaa_lifecycle_state *state, uint32_t parent,
                               uint64_t actual_tid, uint32_t actual_event, uint64_t now_ns);
int pdaa_lifecycle_birth(struct pdaa_lifecycle_state *state, uint32_t parent,
                        const struct pdaa_kernel_identity *child, uint64_t now_ns);
int pdaa_lifecycle_newborn_stop(struct pdaa_lifecycle_state *state, uint32_t record, uint64_t now_ns);
int pdaa_lifecycle_exec(struct pdaa_lifecycle_state *state, uint32_t record,
                       const struct pdaa_kernel_identity *same_identity, uint64_t now_ns);
int pdaa_lifecycle_result(struct pdaa_lifecycle_state *state, uint32_t record,
                         int64_t return_value, int is_error, uint64_t now_ns);
int pdaa_lifecycle_early_exit(struct pdaa_lifecycle_state *state, uint32_t record, uint64_t now_ns);
int pdaa_lifecycle_terminal(struct pdaa_lifecycle_state *state, uint32_t record,
                           uint32_t actual_wait_status, uint64_t now_ns);
int pdaa_lifecycle_identity_absent(struct pdaa_lifecycle_state *state, uint32_t record, uint64_t now_ns);
int pdaa_lifecycle_fail(struct pdaa_lifecycle_state *state, enum pdaa_lifecycle_error reason, uint64_t now_ns);
/* Wait-based physical exits and later original-identity absence are separate.
 * Neither establishes successful recognition or available original authority.
 */
int pdaa_lifecycle_tree_exits_observed(const struct pdaa_lifecycle_state *state);
int pdaa_lifecycle_tree_terminal(const struct pdaa_lifecycle_state *state);
/* CLI/engine subtree terminality while original PID1 remains available for
 * same-client postflight/publication. Separate from whole-fixture retirement.
 */
int pdaa_lifecycle_children_terminal(const struct pdaa_lifecycle_state *state);

#endif
