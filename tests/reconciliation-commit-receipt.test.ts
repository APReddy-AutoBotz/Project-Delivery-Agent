// Unit-only fabricated receipts test the READER. They are not SQL/acceptance proof.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  reconciliationCommitCases,
  reconciliationCommitTables,
  validateReconciliationCommitReceipt,
} from "../scripts/acceptance/reconciliation-commit-receipt.mjs";

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
function validReceipt() {
  let serial = 10;
  let birth: any;
  const fingerprint = (table: string, count: number) => ({
    count,
    sha256: sha(count ? [table, count] : []),
  });
  const blank = () =>
    Object.fromEntries(
      reconciliationCommitTables.map((table: string) => [
        table,
        fingerprint(
          table,
          table === "AuditEvent"
            ? 12
            : ["ProjectFact", "ProjectFactVersion", "FactEvidence"].includes(
                  table,
                )
              ? 4
              : 0,
        ),
      ]),
    );
  const states = { positive: blank(), negative: blank() };
  const cases = reconciliationCommitCases.map((mode: string) => {
    const fixture =
      mode === "positive-birth" ||
      mode === "wrong-reused-identity" ||
      mode.includes("refresh")
        ? "positive"
        : "negative";
    const before = clone(states[fixture]);
    const after = clone(before);
    const bump = (table: string, delta: number) => {
      after[table] = fingerprint(table, after[table].count + delta);
    };
    if (["positive-birth", "positive-no-request"].includes(mode)) {
      bump("MilestoneConsistencyAssessment", 1);
      bump("MilestoneConsistencyTarget", 4);
      bump("FactAssessment", 4);
      bump("FactAssessmentVersion", 4);
      bump("MilestoneReconciliationCheck", 1);
      bump("AuditEvent", mode === "positive-birth" ? 4 : 2);
      if (mode === "positive-birth") {
        bump("MilestoneConsistencyContributorVersion", 4);
        bump("MilestoneReconciliationRequest", 1);
        bump("MilestoneReconciliationAssignment", 1);
      }
    } else if (mode === "positive-refresh") {
      bump("MilestoneReconciliationAssignment", 1);
      bump("AuditEvent", 1);
    }
    states[fixture] = after;
    const negativeMessage = mode.includes("refresh")
      ? "Incomplete reconciliation assignment cannot commit"
      : "Unowned reconciliation assessment cannot commit";
    const generatedIds = Array.from(
      { length: mode.includes("refresh") ? 2 : 6 },
      () => id(serial++),
    );
    const scope = {
      customerId: id(5),
      projectId: fixture === "positive" ? id(1) : id(2),
    };
    const milestoneId = fixture === "positive" ? id(3) : id(4);
    let result: any = null,
      positiveRows: any = null;
    if (mode === "positive-birth") {
      result = {
        requestId: generatedIds[3],
        checkId: generatedIds[0],
        assessmentId: generatedIds[1],
      };
      positiveRows = {
        request: [
          {
            ...scope,
            id: result.requestId,
            milestoneId,
            originalAssessmentId: result.assessmentId,
            originCommandId: result.checkId,
            sealed: true,
            valid: true,
          },
        ],
        check: [
          {
            ...scope,
            id: result.checkId,
            assessmentId: result.assessmentId,
            requestId: result.requestId,
            outcome: "CREATED",
            valid: true,
          },
        ],
        assignment: [
          {
            ...scope,
            id: generatedIds[4],
            requestId: result.requestId,
            revision: 1,
            previousAssignmentId: null,
            valid: true,
          },
        ],
      };
      birth = { result, positiveRows };
    } else if (mode === "positive-no-request") {
      result = {
        requestId: null,
        checkId: generatedIds[0],
        assessmentId: generatedIds[1],
      };
      positiveRows = {
        request: [],
        assignment: [],
        check: [
          {
            ...scope,
            id: result.checkId,
            assessmentId: result.assessmentId,
            requestId: null,
            outcome: "NO_REQUEST",
            valid: true,
          },
        ],
      };
    } else if (mode === "positive-refresh") {
      result = { id: generatedIds[0], revision: 2 };
      positiveRows = {
        request: clone(birth.positiveRows.request),
        check: [],
        assignment: [
          {
            ...scope,
            id: result.id,
            requestId: birth.result.requestId,
            revision: 2,
            previousAssignmentId: birth.positiveRows.assignment[0].id,
            valid: true,
          },
        ],
      };
    }
    return {
      mode,
      ...scope,
      milestoneId,
      runtimeRole: "pdaa_api",
      transactionPid: 101,
      nativePid: 101,
      transactionSessionUser: "pdaa_api",
      nativeCommitAttempts: 1,
      callbackReturned: true,
      callbackReturnedAtCommit: true,
      nativeCommit: mode.startsWith("positive-")
        ? { command: "COMMIT" }
        : { code: "P0001", message: negativeMessage },
      commitObserver: {
        observerPid: 202,
        writerPid: 101,
        sessionUser: "pdaa_api",
        state: "idle",
        query: "COMMIT",
        phase: "native-commit-settled",
      },
      generatedIds,
      result,
      positiveRows,
      generatedAbsence: mode.startsWith("positive-")
        ? null
        : Object.fromEntries(
            reconciliationCommitTables.map((table: string) => [table, 0]),
          ),
      before,
      after,
    };
  });
  return {
    schemaVersion: 1,
    customerId: id(5),
    positiveProjectId: id(1),
    negativeProjectId: id(2),
    originalRequestId: cases[0].generatedIds[3],
    cases,
  };
}
function rejected(
  change: (receipt: any) => void,
  pins: Record<string, unknown> = { expectedSessionUser: "pdaa_api" },
) {
  const receipt = validReceipt();
  change(receipt);
  expect(() => validateReconciliationCommitReceipt(receipt, pins)).toThrow(
    /Reconciliation receipt/,
  );
}

it("accepts a coherent schemaVersion 1 reader fixture without mutating it", () => {
  const receipt = validReceipt(),
    before = clone(receipt);
  expect(
    validateReconciliationCommitReceipt(receipt, {
      expectedSessionUser: "pdaa_api",
    }),
  ).toMatchObject({ caseCount: 12, positiveControls: 3, negativeControls: 9 });
  expect(receipt).toEqual(before);
});
it("allows an owner login with an effective API role only when externally pinned", () => {
  const receipt = validReceipt();
  for (const row of receipt.cases) {
    row.commitObserver.sessionUser = "pdaa_migrate";
    row.transactionSessionUser = "pdaa_migrate";
  }
  expect(
    validateReconciliationCommitReceipt(receipt, {
      expectedSessionUser: "pdaa_migrate",
    }).sessionUser,
  ).toBe("pdaa_migrate");
});
it("accepts only the exact orphan FK alternative", () => {
  const receipt = validReceipt();
  receipt.cases[2].nativeCommit = {
    code: "23503",
    message:
      'insert or update on table "MilestoneConsistencyAssessment" violates foreign key constraint "ReconciliationAssessment_check_fk"',
    constraint: "ReconciliationAssessment_check_fk",
  } as any;
  expect(() => validateReconciliationCommitReceipt(receipt)).not.toThrow();
});
it.each(reconciliationCommitCases)("rejects missing case %s", (mode: string) =>
  rejected((r) => {
    r.cases = r.cases.filter((c: any) => c.mode !== mode);
  }),
);
it.each([
  [
    "missing version",
    (r: any) => {
      delete r.schemaVersion;
    },
  ],
  [
    "future version",
    (r: any) => {
      r.schemaVersion = 2;
    },
  ],
  [
    "missing root customer",
    (r: any) => {
      delete r.customerId;
    },
  ],
  [
    "wrong case customer",
    (r: any) => {
      r.cases[0].customerId = id(999);
    },
  ],
  [
    "wrong case project",
    (r: any) => {
      r.cases[1].projectId = r.positiveProjectId;
    },
  ],
  [
    "changed case milestone",
    (r: any) => {
      r.cases[6].milestoneId = id(999);
    },
  ],
  [
    "duplicate case",
    (r: any) => {
      r.cases[1] = clone(r.cases[0]);
    },
  ],
  [
    "unknown case",
    (r: any) => {
      r.cases[1].mode = "claimed-pass";
    },
  ],
  [
    "case reorder",
    (r: any) => {
      [r.cases[1], r.cases[2]] = [r.cases[2], r.cases[1]];
    },
  ],
  [
    "extra case",
    (r: any) => {
      r.cases.push(clone(r.cases[0]));
    },
  ],
  [
    "wrong role",
    (r: any) => {
      r.cases[0].runtimeRole = "pdaa_migrate";
    },
  ],
  [
    "wrong native PID",
    (r: any) => {
      r.cases[0].nativePid = 303;
    },
  ],
  [
    "missing native PID",
    (r: any) => {
      delete r.cases[0].nativePid;
    },
  ],
  [
    "wrong transaction session",
    (r: any) => {
      r.cases[0].transactionSessionUser = "postgres";
    },
  ],
  [
    "wrong observer writer",
    (r: any) => {
      r.cases[0].commitObserver.writerPid = 303;
    },
  ],
  [
    "same observer backend",
    (r: any) => {
      r.cases[0].commitObserver.observerPid = 101;
    },
  ],
  [
    "observer backend changed",
    (r: any) => {
      r.cases[1].commitObserver.observerPid = 303;
    },
  ],
  [
    "wrong phase",
    (r: any) => {
      r.cases[0].commitObserver.phase = "before-commit";
    },
  ],
  [
    "active observer",
    (r: any) => {
      r.cases[0].commitObserver.state = "active";
    },
  ],
  [
    "observer rollback",
    (r: any) => {
      r.cases[0].commitObserver.query = "ROLLBACK";
    },
  ],
  [
    "multiple observer statements",
    (r: any) => {
      r.cases[0].commitObserver.query = "COMMIT; SELECT 1";
    },
  ],
  [
    "wrong session user",
    (r: any) => {
      for (const c of r.cases) {
        c.commitObserver.sessionUser = "untrusted_login";
        c.transactionSessionUser = "untrusted_login";
      }
    },
  ],
  [
    "callback not returned",
    (r: any) => {
      r.cases[0].callbackReturnedAtCommit = false;
    },
  ],
  [
    "callback final state false",
    (r: any) => {
      r.cases[0].callbackReturned = false;
    },
  ],
  [
    "callback field missing",
    (r: any) => {
      delete r.cases[0].callbackReturnedAtCommit;
    },
  ],
  [
    "no native COMMIT",
    (r: any) => {
      r.cases[0].nativeCommitAttempts = 0;
    },
  ],
  [
    "two native COMMITs",
    (r: any) => {
      r.cases[0].nativeCommitAttempts = 2;
    },
  ],
  [
    "positive rollback",
    (r: any) => {
      r.cases[0].nativeCommit.command = "ROLLBACK";
    },
  ],
  [
    "negative commit success",
    (r: any) => {
      r.cases[1].nativeCommit = { command: "COMMIT" };
    },
  ],
  [
    "permission failure",
    (r: any) => {
      r.cases[1].nativeCommit.code = "42501";
    },
  ],
  [
    "generic guard error",
    (r: any) => {
      r.cases[1].nativeCommit.message = "Some error";
    },
  ],
  [
    "wrong guard for refresh",
    (r: any) => {
      r.cases[6].nativeCommit.message =
        "Incomplete reconciliation check cannot commit";
    },
  ],
  [
    "unexpected guard constraint",
    (r: any) => {
      r.cases[1].nativeCommit.constraint = "unrelated";
    },
  ],
  [
    "error mixed with success",
    (r: any) => {
      r.cases[0].nativeCommit.code = "P0001";
    },
  ],
  [
    "missing conflict coverage",
    (r: any) => {
      delete r.cases[1].before.FactAuthorityConflict;
    },
  ],
  [
    "missing conflict absence",
    (r: any) => {
      delete r.cases[1].generatedAbsence.FactAuthorityConflict;
    },
  ],
  [
    "missing negative absence",
    (r: any) => {
      r.cases[1].generatedAbsence = null;
    },
  ],
  [
    "negative row remains",
    (r: any) => {
      r.cases[1].generatedAbsence.AuditEvent = 1;
    },
  ],
  [
    "boolean absence",
    (r: any) => {
      r.cases[1].generatedAbsence.AuditEvent = true;
    },
  ],
  [
    "positive absence residue",
    (r: any) => {
      r.cases[0].generatedAbsence = {};
    },
  ],
  [
    "negative result residue",
    (r: any) => {
      r.cases[1].result = {};
    },
  ],
  [
    "negative SQL residue",
    (r: any) => {
      r.cases[1].positiveRows = {};
    },
  ],
  [
    "missing positive result",
    (r: any) => {
      r.cases[0].result = null;
    },
  ],
  [
    "missing positive rows",
    (r: any) => {
      r.cases[0].positiveRows = null;
    },
  ],
  [
    "missing initial assignment",
    (r: any) => {
      r.cases[0].positiveRows.assignment = [];
    },
  ],
  [
    "duplicate positive row",
    (r: any) => {
      r.cases[0].positiveRows.request.push(
        clone(r.cases[0].positiveRows.request[0]),
      );
    },
  ],
  [
    "SQL row wrong customer",
    (r: any) => {
      r.cases[0].positiveRows.request[0].customerId = id(999);
    },
  ],
  [
    "SQL row wrong project",
    (r: any) => {
      r.cases[0].positiveRows.check[0].projectId = r.negativeProjectId;
    },
  ],
  [
    "SQL row wrong milestone",
    (r: any) => {
      r.cases[0].positiveRows.request[0].milestoneId = id(999);
    },
  ],
  [
    "SQL row unsealed",
    (r: any) => {
      r.cases[0].positiveRows.request[0].sealed = false;
    },
  ],
  [
    "SQL predicate false",
    (r: any) => {
      r.cases[0].positiveRows.check[0].valid = false;
    },
  ],
  [
    "original proof substituted",
    (r: any) => {
      r.cases[0].positiveRows.request[0].originalAssessmentId = id(999);
    },
  ],
  [
    "origin command substituted",
    (r: any) => {
      r.cases[0].positiveRows.request[0].originCommandId = id(999);
    },
  ],
  [
    "check proof mismatch",
    (r: any) => {
      r.cases[0].positiveRows.check[0].assessmentId = id(999);
    },
  ],
  [
    "request result mismatch",
    (r: any) => {
      r.cases[0].result.requestId = r.cases[0].generatedIds[2];
    },
  ],
  [
    "check result not generated",
    (r: any) => {
      r.cases[0].result.checkId = id(999);
    },
  ],
  [
    "INITIAL revision wrong",
    (r: any) => {
      r.cases[0].positiveRows.assignment[0].revision = 2;
    },
  ],
  [
    "INITIAL predecessor present",
    (r: any) => {
      r.cases[0].positiveRows.assignment[0].previousAssignmentId = id(999);
    },
  ],
  [
    "refresh predecessor wrong",
    (r: any) => {
      r.cases[8].positiveRows.assignment[0].previousAssignmentId = id(999);
    },
  ],
  [
    "refresh result wrong ID",
    (r: any) => {
      r.cases[8].result.id = r.cases[8].generatedIds[1];
    },
  ],
  [
    "refresh result wrong revision",
    (r: any) => {
      r.cases[8].result.revision = 3;
    },
  ],
  [
    "refresh changed original proof",
    (r: any) => {
      r.cases[8].positiveRows.request[0].originalAssessmentId = id(999);
    },
  ],
  [
    "refresh check residue",
    (r: any) => {
      r.cases[8].positiveRows.check = clone(r.cases[0].positiveRows.check);
    },
  ],
  [
    "NO_REQUEST request residue",
    (r: any) => {
      r.cases[9].result.requestId = r.originalRequestId;
    },
  ],
  [
    "NO_REQUEST wrong outcome",
    (r: any) => {
      r.cases[9].positiveRows.check[0].outcome = "CREATED";
    },
  ],
  [
    "source content in narrow row",
    (r: any) => {
      r.cases[0].positiveRows.request[0].contributorIdentity =
        "hidden source data";
    },
  ],
  [
    "negative fingerprint changed",
    (r: any) => {
      r.cases[1].after.AuditEvent.sha256 = "a".repeat(64);
    },
  ],
  [
    "negative count changed",
    (r: any) => {
      r.cases[1].after.AuditEvent.count++;
    },
  ],
  [
    "unknown fingerprint family",
    (r: any) => {
      r.cases[0].before.NotARealTable = { count: 0, sha256: sha([]) };
    },
  ],
  [
    "invalid digest",
    (r: any) => {
      r.cases[0].before.AuditEvent.sha256 = "pass";
    },
  ],
  [
    "invalid empty digest",
    (r: any) => {
      r.cases[0].before.FactAuthorityConflict.sha256 = "a".repeat(64);
    },
  ],
  [
    "duplicate generated ID",
    (r: any) => {
      r.cases[0].generatedIds[1] = r.cases[0].generatedIds[0];
    },
  ],
  [
    "cross-case generated ID",
    (r: any) => {
      r.cases[1].generatedIds[0] = r.cases[0].generatedIds[0];
    },
  ],
  [
    "missing generated IDs",
    (r: any) => {
      r.cases[1].generatedIds = [];
    },
  ],
  [
    "original ID not generated",
    (r: any) => {
      r.originalRequestId = id(900);
    },
  ],
  [
    "original from wrong case",
    (r: any) => {
      r.originalRequestId = r.cases[1].generatedIds[0];
    },
  ],
  [
    "same probe project",
    (r: any) => {
      r.negativeProjectId = r.positiveProjectId;
    },
  ],
  [
    "broken fingerprint chain",
    (r: any) => {
      r.cases[6].before.AuditEvent.sha256 = "b".repeat(64);
    },
  ],
  [
    "boolean-only pass",
    (r: any) => {
      r.cases[0] = { mode: "positive-birth", passed: true };
    },
  ],
  [
    "unrecognized assertion field",
    (r: any) => {
      r.cases[0].passed = true;
    },
  ],
] as const)("rejects %s", (_label, change) => rejected(change));
it.each([0, -1, 1.5, "101", 2147483648, null])(
  "rejects invalid PID %s",
  (bad) =>
    rejected((r) => {
      r.cases[0].transactionPid = bad;
    }),
);
it.each([-1, 1.5, "12", 5001, null])(
  "rejects invalid fingerprint count %s",
  (bad) =>
    rejected((r) => {
      r.cases[0].before.AuditEvent.count = bad;
    }),
);
it("rejects an external original-ID pin mismatch", () =>
  rejected(() => {}, { expectedOriginalRequestId: id(999) }));
it("rejects an external customer pin mismatch", () =>
  rejected(() => {}, { expectedCustomerId: id(999) }));
it("rejects a wrong native FK constraint even with the expected message", () =>
  rejected((r) => {
    r.cases[2].nativeCommit = {
      code: "23503",
      message:
        'insert or update on table "MilestoneConsistencyAssessment" violates foreign key constraint "ReconciliationAssessment_check_fk"',
      constraint: "Wrong_constraint",
    };
  }));

const rowFor = (receipt: any, mode: string) =>
  receipt.cases.find((row: any) => row.mode === mode);

it.each(["wrong-reused-identity", "wrong-refresh-time"])(
  "requires native COMMIT and rollback evidence for %s",
  (mode) => {
    rejected((r) => {
      rowFor(r, mode).nativeCommitAttempts = 0;
    });
    rejected((r) => {
      rowFor(r, mode).callbackReturnedAtCommit = false;
    });
    rejected((r) => {
      rowFor(r, mode).nativePid = 303;
    });
    rejected((r) => {
      rowFor(r, mode).runtimeRole = "pdaa_migrate";
    });
    rejected((r) => {
      rowFor(r, mode).nativeCommit.code = "42501";
    });
    rejected((r) => {
      rowFor(r, mode).nativeCommit.code = "57014";
    });
    rejected((r) => {
      rowFor(r, mode).nativeCommit = { command: "COMMIT" };
    });
    rejected((r) => {
      rowFor(r, mode).generatedAbsence.AuditEvent = 1;
    });
  },
);
it("rejects a check guard as proof of the refresh predecessor-time guard", () =>
  rejected((r) => {
    rowFor(r, "wrong-refresh-time").nativeCommit.message =
      "Incomplete reconciliation check cannot commit";
  }));
it("rejects an assignment guard as proof of malformed REUSED identity", () =>
  rejected((r) => {
    rowFor(r, "wrong-reused-identity").nativeCommit.message =
      "Incomplete reconciliation assignment cannot commit";
  }));
it("requires REUSED corruption to use the original positive fixture", () =>
  rejected((r) => {
    rowFor(r, "wrong-reused-identity").projectId = r.negativeProjectId;
  }));
it("rejects obsolete ten-case evidence", () =>
  rejected((r) => {
    r.cases = r.cases.slice(0, 10);
  }));
it("keeps exactly two generated identities for the new refresh control", () =>
  rejected((r) => {
    rowFor(r, "wrong-refresh-time").generatedIds.push(id(999));
  }));
it.each(["ProjectFact", "ProjectFactVersion", "FactEvidence"])(
  "requires complete input rollback evidence for %s",
  (table) => {
    rejected((r) => {
      delete rowFor(r, "wrong-reused-identity").before[table];
    });
    rejected((r) => {
      delete rowFor(r, "wrong-reused-identity").generatedAbsence[table];
    });
    rejected((r) => {
      rowFor(r, "wrong-reused-identity").generatedAbsence[table] = 1;
    });
    rejected((r) => {
      rowFor(r, "wrong-reused-identity").after[table].sha256 = "a".repeat(64);
    });
  },
);
it.each(["ProjectFact", "ProjectFactVersion", "FactEvidence"])(
  "forbids positive captures from changing %s",
  (table) => {
    rejected((r) => {
      const row = rowFor(r, "positive-birth");
      row.after[table] = {
        count: row.before[table].count + 1,
        sha256: "a".repeat(64),
      };
    });
  },
);
