import { ProjectFactError, type Actor } from "@pdaa/domain";
import { Prisma } from "./generated/prisma/client.js";

type Grant = {
  id: string;
  customerId: string;
  subject: string;
  scopeType: string;
  scopeId: string;
  role: string;
};
export type ReconciliationRouting = {
  reason:
    | "ASSIGNED"
    | "NO_CONFIGURED_PM"
    | "AMBIGUOUS_CONFIGURED_PM"
    | "PM_SCOPE_UNAVAILABLE";
  recipientSubject: string | null;
  responsibilityId: string | null;
  grantId: string | null;
  grantCustomerId: string | null;
  grantSubject: string | null;
  grantScopeType: string | null;
  grantScopeId: string | null;
  grantRole: string | null;
};
// NFR-SEC-001: the complete actor/candidate grant union is locked before facts.
// Routing configuration never attests another person's current identity claims.
export async function authorizeReconciliation(
  tx: Prisma.TransactionClient,
  actor: Actor,
  projectId: string,
  mode: "read" | "manage" | "recipient",
) {
  const projects = await tx.$queryRaw<{ portfolioId: string }[]>`
    SELECT "portfolioId" FROM public."Project" WHERE "customerId"=${actor.customerId}::uuid AND id=${projectId}::uuid FOR UPDATE`;
  if (!projects[0]) throw new ProjectFactError("DENIED");
  const configured = await tx.projectResponsibility.findMany({
    where: { customerId: actor.customerId, projectId, role: "PROJECT_MANAGER" },
    select: { id: true, subject: true },
    orderBy: { id: "asc" },
    take: 51,
  });
  if (configured.length > 50)
    throw new Error("Reconciliation configuration exceeds bounds");
  const candidate = configured.length === 1 ? configured[0]! : null;
  const subjects = [
    ...new Set([actor.subject, ...(candidate ? [candidate.subject] : [])]),
  ];
  const grants = await tx.$queryRaw<Grant[]>`
    SELECT id,"customerId",subject,"scopeType","scopeId",role FROM public."AccessGrant"
    WHERE "customerId"=${actor.customerId}::uuid AND subject IN (${Prisma.join(subjects)})
      AND (("scopeType"='project' AND "scopeId"=${projectId}::uuid) OR ("scopeType"='portfolio' AND "scopeId"=${projects[0].portfolioId}::uuid)) ORDER BY id FOR SHARE`;
  const matching = grants.filter(
    (grant) =>
      grant.subject === actor.subject &&
      actor.roles.some((role) => role === grant.role),
  );
  const canAppend = matching.some((grant) =>
    ["project_manager", "portfolio_manager", "pmo_admin"].includes(grant.role),
  );
  const canConfigure = matching.some((grant) => grant.role === "pmo_admin");
  if (mode === "recipient") {
    if (
      !candidate ||
      candidate.subject !== actor.subject ||
      !actor.roles.includes("project_manager") ||
      !matching.some((grant) => grant.role === "project_manager")
    )
      throw new ProjectFactError("DENIED");
  } else if (
    !(
      canAppend ||
      (mode === "read" && matching.some((grant) => grant.role === "leadership"))
    )
  )
    throw new ProjectFactError("DENIED");
  const selected = grants
    .filter(
      (grant) =>
        candidate &&
        grant.subject === candidate.subject &&
        grant.role === "project_manager",
    )
    .sort(
      (a, b) =>
        Number(a.scopeType !== "project") - Number(b.scopeType !== "project") ||
        a.id.localeCompare(b.id),
    )[0];
  const routing: ReconciliationRouting = {
    reason:
      configured.length === 0
        ? "NO_CONFIGURED_PM"
        : configured.length > 1
          ? "AMBIGUOUS_CONFIGURED_PM"
          : selected
            ? "ASSIGNED"
            : "PM_SCOPE_UNAVAILABLE",
    recipientSubject: selected ? candidate!.subject : null,
    responsibilityId: selected ? candidate!.id : null,
    grantId: selected?.id ?? null,
    grantCustomerId: selected?.customerId ?? null,
    grantSubject: selected?.subject ?? null,
    grantScopeType: selected?.scopeType ?? null,
    grantScopeId: selected?.scopeId ?? null,
    grantRole: selected?.role ?? null,
  };
  return { canAppend, canConfigure, routing };
}
