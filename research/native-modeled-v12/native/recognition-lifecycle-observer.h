/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Native kernel-event adapter. Source-only, not a production entrypoint.
 */
#ifndef PDAA_RECOGNITION_LIFECYCLE_OBSERVER_H
#define PDAA_RECOGNITION_LIFECYCLE_OBSERVER_H
#include "recognition-lifecycle-state.h"

enum pdaa_observer_step {
    PDAA_OBSERVER_FAILURE = 0, PDAA_OBSERVER_IDLE = 1,
    PDAA_OBSERVER_EVENT = 2, PDAA_OBSERVER_TARGET_TERMINAL = 3
};

struct pdaa_native_orphan_stop {
    uint32_t host_tid;
    int status;
};

struct pdaa_lifecycle_observer {
    struct pdaa_lifecycle_state state;
    int proc_root_fd;
    int original_pidfd;
    uint64_t pid_namespace_device;
    uint64_t pid_namespace_inode;
    char cgroup_path[1024];
    uint32_t original_host_tid;
    uint32_t bootstrap_stop_seen;
    uint32_t bootstrap_released;
    uint32_t seized;
    uint32_t attach_attempted;
    uint32_t drain_polls;
    uint32_t absence_polls;
    uint64_t clock_high_water_ns;
    uint64_t setup_deadline_ns;
    uint32_t orphan_count;
    struct pdaa_native_orphan_stop orphans[PDAA_ACTIVE_TIDS];
};

/* Sole caller must be the immutable native fixture owner, in a fresh observer
 * cgroup, outside the target PID namespace, one process/thread, nofile16.
 * Borrowed FDs are already owned/authenticated by that fixture and are never
 * closed/replaced here: proc-root, original creation pidfd, target pid-ns.
 * The cgroup path is the exact owned fresh v2 path, not target input.
 * No attach/identity result is filesystem/network/secret admission.
 */
int pdaa_observer_attach(struct pdaa_lifecycle_observer *observer,
                         int proc_root_fd, int original_creation_pidfd, int target_pid_namespace_fd,
                         uint32_t original_host_tid, const char *owned_cgroup_path,
                         uint64_t existing_host_deadline_ns);
/* Call only after the complete host capability/secret/immutable-image barrier.
 * The real PTRACE_INTERRUPT stop must already have been consumed by step().
 * This mechanical release never produces an application admission token.
 */
int pdaa_observer_release_bootstrap(struct pdaa_lifecycle_observer *observer);
/* Nonblocking: at most one kernel wait event plus already-held newborn stop.
 * The outer owner must service its authenticated command/deadline channel and
 * independent termination within the SAME deadlines between these calls.
 * Any failure requires host-owned subtree termination. No detach or retry.
 */
enum pdaa_observer_step pdaa_observer_step(struct pdaa_lifecycle_observer *observer);
/* After a fault, retain actual terminal waits and permit only early-exit
 * completion. Never resume a birth/exec/ordinary syscall. Independent host
 * termination remains required; this is bounded nonblocking drain only.
 */
enum pdaa_observer_step pdaa_observer_drain(struct pdaa_lifecycle_observer *observer);
/* Use only genuine absolute deadlines received over the private owner channel.
 * This cannot reconstruct the original owner's claim or cleanup authority.
 */
int pdaa_observer_transfer_deadlines(struct pdaa_lifecycle_observer *observer,
                                    uint64_t phase_deadline_ns, uint64_t cleanup_deadline_ns);
#endif
