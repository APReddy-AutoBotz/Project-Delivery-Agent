/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Acceptance-only native policy. No operational authority or caller policy.
 * Isolated DRAFT SOURCE: not compiled, exercised, integrated or qualified.
 */
#ifndef PDAA_RECOGNITION_LIFECYCLE_POLICY_H
#define PDAA_RECOGNITION_LIFECYCLE_POLICY_H

#include <stddef.h>
#include <linux/filter.h>

enum pdaa_policy_result {
    PDAA_POLICY_OK = 0,
    PDAA_POLICY_PLATFORM = 1,
    PDAA_POLICY_IDENTITY = 2,
    PDAA_POLICY_INVENTORY = 3,
    PDAA_POLICY_LIMIT = 4,
    PDAA_POLICY_NO_NEW_PRIVILEGES = 5,
    PDAA_POLICY_FILTER = 6
};

enum pdaa_lifecycle_trace {
    PDAA_TRACE_BIRTH = 1,
    PDAA_TRACE_EXEC = 2,
    PDAA_TRACE_RETIREMENT = 3
};

#define PDAA_TARGET_NOFILE 192U
#define PDAA_TARGET_TABLES 5U
#define PDAA_TARGET_TABLE_ENTRIES (PDAA_TARGET_NOFILE * PDAA_TARGET_TABLES)

/* Inspection for the real observer's fixed ABI and synthetic filter controls.
 * This returns fixed source instructions, never qualification or a mutable
 * caller-selected filter. The kernel installs only this exact static program.
 */
const struct sock_filter *pdaa_lifecycle_policy_instructions(size_t *count);

/* Only the single-threaded UID1000 namespace PID1 bootstrap may enter this.
 * The eventual bootstrap must first establish its reviewed control/containment
 * barrier. Success means limits/filter installed, NOT tracer attachment,
 * effective filesystem/network/secret containment or native admission.
 * Failure is terminal for the bootstrap; no caller may repair or exec Node.
 */
enum pdaa_policy_result pdaa_install_lifecycle_policy(void);

#endif
