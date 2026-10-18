/* EXEC-016 / TR-DEP-004 / NFR-REL-002 / NFR-SEC-001/004/005.
 * Synthetic evaluation of the REAL static BPF program. No install, process
 * creation, kernel probe or native qualification. NOT COMPILED OR EXECUTED.
 */
#include "recognition-lifecycle-policy.h"
#include <errno.h>
#include <linux/audit.h>
#include <linux/close_range.h>
#include <linux/seccomp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>

static unsigned int checked = 0;

/* Inspect every instruction, including branches missed by the modeled rows.
 * Forward-only conditional jumps must land inside this actual program.
 */
static int structure_valid(void)
{
    size_t count = 0, index;
    const struct sock_filter *program = pdaa_lifecycle_policy_instructions(&count);
    if (program == NULL || count == 0 || count > 4096U) return 0;
    for (index = 0; index < count; index++) {
        const struct sock_filter instruction = program[index];
        switch (instruction.code) {
            case BPF_LD | BPF_W | BPF_ABS:
                if (instruction.k > sizeof(struct seccomp_data) - sizeof(uint32_t) ||
                    instruction.k % 4 != 0 || instruction.jt != 0 || instruction.jf != 0) return 0;
                break;
            case BPF_JMP | BPF_JEQ | BPF_K:
            case BPF_JMP | BPF_JSET | BPF_K:
            case BPF_JMP | BPF_JGE | BPF_K:
            case BPF_JMP | BPF_JGT | BPF_K:
                if (index + 1U + instruction.jt >= count || index + 1U + instruction.jf >= count) return 0;
                break;
            case BPF_RET | BPF_K:
                if (instruction.jt != 0 || instruction.jf != 0) return 0;
                break;
            default: return 0;
        }
    }
    return program[count - 1U].code == (BPF_RET | BPF_K);
}

static uint32_t evaluate(const struct seccomp_data *input)
{
    size_t count = 0, index = 0, steps = 0;
    const struct sock_filter *program = pdaa_lifecycle_policy_instructions(&count);
    uint32_t accumulator = 0;
    while (index < count && ++steps <= count) {
        const struct sock_filter instruction = program[index++];
        switch (instruction.code) {
            case BPF_LD | BPF_W | BPF_ABS:
                if (instruction.k > sizeof(*input) - sizeof(accumulator) || instruction.k % 4 != 0) return 0xFFFFFFFFU;
                memcpy(&accumulator, (const unsigned char *)input + instruction.k, sizeof(accumulator));
                break;
            case BPF_JMP | BPF_JEQ | BPF_K:
                index += accumulator == instruction.k ? instruction.jt : instruction.jf;
                break;
            case BPF_JMP | BPF_JSET | BPF_K:
                index += (accumulator & instruction.k) != 0 ? instruction.jt : instruction.jf;
                break;
            case BPF_JMP | BPF_JGE | BPF_K:
                index += accumulator >= instruction.k ? instruction.jt : instruction.jf;
                break;
            case BPF_JMP | BPF_JGT | BPF_K:
                index += accumulator > instruction.k ? instruction.jt : instruction.jf;
                break;
            case BPF_RET | BPF_K:
                return instruction.k;
            default:
                return 0xFFFFFFFFU;
        }
    }
    return 0xFFFFFFFFU;
}

static int check(int number, uint64_t first, uint64_t third, uint32_t architecture, uint32_t expected)
{
    struct seccomp_data input;
    memset(&input, 0, sizeof(input));
    input.nr = number;
    input.arch = architecture;
    input.args[0] = first;
    input.args[2] = third;
    checked++;
    if (evaluate(&input) != expected) {
        /* Only a fixed synthetic case number; never native arguments/errors. */
        fprintf(stderr, "Native policy synthetic control failed: %u\n", checked);
        return 0;
    }
    return 1;
}

#define REQUIRE(n, a, c, expected) do { if (!check((n), (a), (c), AUDIT_ARCH_X86_64, (expected))) return 1; } while (0)
#define DENIED(error) (SECCOMP_RET_ERRNO | (error))
#define TRACED(tag) (SECCOMP_RET_TRACE | (tag))

int main(void)
{
    int legacy_number;
    if (!structure_valid()) return 1;
    if (PDAA_TARGET_TABLE_ENTRIES != 960U || PDAA_TARGET_NOFILE != 192U) return 1;
    if (!check(__NR_read, 0, 0, AUDIT_ARCH_I386, SECCOMP_RET_KILL_PROCESS)) return 1;
    if (!check(__NR_read | 0x40000000, 0, 0, AUDIT_ARCH_X86_64, SECCOMP_RET_KILL_PROCESS)) return 1;
    REQUIRE(511, 0, 0, SECCOMP_RET_ALLOW);
    for (legacy_number = 512; legacy_number <= 547; legacy_number++) {
        REQUIRE(legacy_number, 0, 0, SECCOMP_RET_KILL_PROCESS);
    }
    REQUIRE(548, 0, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_clone3, 0, 0, DENIED(ENOSYS));
    REQUIRE(__NR_unshare, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_setns, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_setrlimit, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_prlimit64, 0, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_prlimit64, 0, 1, DENIED(EPERM));
    REQUIRE(__NR_prlimit64, 0, UINT64_C(0x100000000), DENIED(EPERM));
    REQUIRE(__NR_close_range, 0, CLOSE_RANGE_UNSHARE, DENIED(EPERM));
    REQUIRE(__NR_close_range, 0, CLOSE_RANGE_UNSHARE | CLOSE_RANGE_CLOEXEC, DENIED(EPERM));
    REQUIRE(__NR_close_range, 0, 0, TRACED(PDAA_TRACE_RETIREMENT));
    REQUIRE(__NR_close_range, 0, CLOSE_RANGE_CLOEXEC, TRACED(PDAA_TRACE_RETIREMENT));
    REQUIRE(__NR_prctl, PR_SET_NAME, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_prctl, PR_GET_NAME, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_prctl, PR_GET_SECCOMP, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_prctl, PR_GET_DUMPABLE, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_prctl, PR_GET_NO_NEW_PRIVS, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_prctl, PR_SET_DUMPABLE, 0, DENIED(EPERM));
    REQUIRE(__NR_prctl, PR_SET_SECCOMP, 0, DENIED(EPERM));
    REQUIRE(__NR_prctl, PR_SET_PTRACER, 0, DENIED(EPERM));
    REQUIRE(__NR_fork, 0, 0, TRACED(PDAA_TRACE_BIRTH));
    REQUIRE(__NR_vfork, 0, 0, TRACED(PDAA_TRACE_BIRTH));
    REQUIRE(__NR_clone, 0, 0, TRACED(PDAA_TRACE_BIRTH));
    REQUIRE(__NR_execve, 0, 0, TRACED(PDAA_TRACE_EXEC));
    REQUIRE(__NR_execveat, 0, 0, TRACED(PDAA_TRACE_EXEC));
    REQUIRE(__NR_close, 0, 0, TRACED(PDAA_TRACE_RETIREMENT));
    REQUIRE(__NR_shutdown, 0, 0, TRACED(PDAA_TRACE_RETIREMENT));
    REQUIRE(__NR_exit_group, 0, 0, TRACED(PDAA_TRACE_RETIREMENT));
    REQUIRE(__NR_exit, 0, 0, TRACED(PDAA_TRACE_RETIREMENT));
    REQUIRE(__NR_io_uring_setup, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_io_uring_register, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_io_uring_enter, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_pidfd_getfd, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_recvmsg, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_recvmmsg, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_process_vm_readv, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_process_vm_writev, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_bpf, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_seccomp, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_ptrace, 0, 0, DENIED(EPERM));
    REQUIRE(__NR_read, 0, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_write, 0, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_openat, 0, 0, SECCOMP_RET_ALLOW);
    REQUIRE(__NR_dup3, 0, 0, SECCOMP_RET_ALLOW);
    printf("Native policy modeled controls passed: %u; structural checks: 1; policy installs: 0\n", checked);
    return 0;
}
