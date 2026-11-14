import { expect, it } from "vitest";
import { canonicalActorSchema, roleSchema, roles } from "../packages/domain/src/index.js";
import { ProtectedSessionModel, type ProtectedCapability, type Session } from "../apps/web/src/protected-session-model.js";

const actor = { customerId: "10000000-0000-4000-8000-000000000001", subject: "person", roles: ["leadership", "pmo_admin"] };
const A = "30000000-0000-4000-8000-000000000001", B = "30000000-0000-4000-8000-000000000002";
function ready(model: ProtectedSessionModel, token = "synthetic-token"): { session: Session; capability: ProtectedCapability } {
  const session = model.establish(model.beginLogin(), token)!;
  const identity = model.beginIdentity(session)!;
  expect(model.finishIdentity(identity, "success", actor)).toBe("applied");
  return { session, capability: model.capability(session)! };
}

it("admits only the latest login and does not let an old session borrow an identical new credential", () => {
  const model = new ProtectedSessionModel(), first = model.beginLogin(), second = model.beginLogin();
  expect(model.establish(first, "synthetic-token")).toBeNull();
  const session = model.establish(second, "synthetic-token")!;
  expect(model.establish(second, "synthetic-token")).toBeNull();
  expect(model.capability(session)).toBeNull();
  const check = model.beginIdentity(session)!;
  expect(model.identityCredential(check)).toBe("synthetic-token");
  model.finishIdentity(check, "success", actor);
  const old = model.capability(session)!;
  model.signOut(); const next = ready(model, "synthetic-token");
  expect(model.protectedCredential(old)).toBeUndefined();
  expect(model.expire(session)).toBe(false);
  expect(model.protectedCredential(next.capability)).toBe("synthetic-token");
});

it("closes ordinary admission while the latest identity check is pending or unavailable", () => {
  const model = new ProtectedSessionModel(), { session, capability } = ready(model);
  const older = model.beginIdentity(session)!, newer = model.beginIdentity(session)!;
  expect(model.protectedCredential(capability)).toBeUndefined();
  expect(model.identityCredential(older)).toBeUndefined();
  expect(model.finishIdentity(older, "denied")).toBe("stale");
  expect(model.finishIdentity(newer, "unavailable")).toBe("applied");
  expect(model.capability(session)).toBeNull();
  const retry = model.beginIdentity(session)!;
  expect(model.finishIdentity(retry, "success", actor)).toBe("applied");
  expect(model.capability(session)).not.toBeNull();
});

it("terminates only for a current identity denial, but expires a current session independently of issuance", () => {
  const model = new ProtectedSessionModel(), { session } = ready(model);
  const older = model.beginIdentity(session)!, latest = model.beginIdentity(session)!;
  expect(model.finishIdentity(older, "denied")).toBe("stale");
  expect(model.finishIdentity(latest, "denied")).toBe("terminated");
  expect(model.beginIdentity(session)).toBeNull();
  const current = ready(model), a = model.beginIdentity(current.session)!, b = model.beginIdentity(current.session)!;
  expect(model.expire(current.session)).toBe(true);
  expect(model.finishIdentity(a, "success", actor)).toBe("stale");
  expect(model.finishIdentity(b, "success", actor)).toBe("stale");
});

it("fences old A results and same-project superseded checks and latches current denial", () => {
  const model = new ProtectedSessionModel(), { capability } = ready(model);
  expect(model.select(capability, A)).toBe(true); const oldA = model.beginProject(capability)!;
  expect(model.select(capability, B)).toBe(true); expect(model.select(capability, A)).toBe(true);
  const first = model.beginProject(capability)!, latest = model.beginProject(capability)!;
  expect(model.finishProject(oldA, "denied")).toBe(false);
  expect(model.finishProject(first, "denied")).toBe(false);
  expect(model.finishProject(latest, "success")).toBe(true); expect(model.projectCapability(capability)).not.toBeNull();
  const denial = model.beginProject(capability)!; expect(model.finishProject(denial, "denied")).toBe(true);
  expect(model.beginProject(capability)).toBeNull(); expect(model.projectCapability(capability)).toBeNull();
  expect(model.retryProject(capability)).toBe(true);
  expect(model.finishProject(model.beginProject(capability)!, "success")).toBe(true);
});

it("keeps project denial through identical identity refresh but clears it on actual selection change", () => {
  const model = new ProtectedSessionModel(), { session, capability } = ready(model);
  model.select(capability, A); model.finishProject(model.beginProject(capability)!, "denied");
  const check = model.beginIdentity(session)!; model.finishIdentity(check, "success", { ...actor, roles: [...actor.roles].reverse() });
  const next = model.capability(session)!;
  expect(model.beginProject(next)).toBeNull();
  model.select(next, B); model.select(next, A);
  expect(model.beginProject(next)).not.toBeNull();
});

it("invalidates old project proof on identity refresh and role change", () => {
  const model = new ProtectedSessionModel(), { session, capability } = ready(model);
  model.select(capability, A); model.finishProject(model.beginProject(capability)!, "success");
  const oldProject = model.projectCapability(capability)!;
  const refresh = model.beginIdentity(session)!;
  expect(model.projectCredential(oldProject)).toBeUndefined();
  model.finishIdentity(refresh, "success", actor);
  const refreshed = model.capability(session)!;
  expect(model.projectCapability(refreshed)).toBeNull();
  model.finishProject(model.beginProject(refreshed)!, "denied");
  const rolesChanged = model.beginIdentity(session)!;
  model.finishIdentity(rolesChanged, "success", { ...actor, roles: ["leadership"] });
  const changed = model.capability(session)!;
  expect(model.current(refreshed)).toBe(false);
  expect(model.beginProject(changed)).not.toBeNull();
  expect(model.projectCredential(oldProject)).toBeUndefined();
});

it("does not accept forged handles, repeated completion or a malformed identity", () => {
  const model = new ProtectedSessionModel(), { session, capability } = ready(model);
  expect(model.current({ ...capability })).toBe(false);
  model.select(capability, A); const project = model.beginProject(capability)!;
  expect(model.finishProject({ ...project }, "success")).toBe(false);
  expect(model.finishProject(project, "success")).toBe(true);
  expect(model.finishProject(project, "denied")).toBe(false);
  const check = model.beginIdentity(session)!;
  expect(model.finishIdentity({ ...check }, "success", actor)).toBe("stale");
  expect(model.finishIdentity(check, "success", { ...actor, roles: ["not-a-role"] })).toBe("applied");
  expect(model.capability(session)).toBeNull();
});

it("accepts valid /me wire identities and UUIDs outside the narrower canonical actor subset", () => {
  const model = new ProtectedSessionModel(), session = model.establish(model.beginLogin(), "token")!;
  const check = model.beginIdentity(session)!;
  expect(model.finishIdentity(check, "success", { ...actor, subject: " " + "x".repeat(205), roles: ["leadership", "leadership"] })).toBe("applied");
  const capability = model.capability(session)!;
  expect(model.current(capability)).toBe(true);
  expect(model.select(capability, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe(true);
});

it("uses a fixed bounded role count and rejects identities beyond the planned body bound", () => {
  const model = new ProtectedSessionModel(), session = model.establish(model.beginLogin(), "token")!;
  let lengthReads = 0;
  const dynamic = new Proxy(["leadership"], { get(target, key, receiver) {
    if (key === "length") { lengthReads++; return lengthReads === 1 ? 1 : 1_000_000; }
    return Reflect.get(target, key, receiver);
  } });
  const check = model.beginIdentity(session)!;
  expect(model.finishIdentity(check, "success", { ...actor, roles: dynamic })).toBe("applied");
  expect(model.capability(session)).not.toBeNull(); expect(lengthReads).toBe(1);
  const longSubject = model.beginIdentity(session)!;
  expect(model.finishIdentity(longSubject, "success", { ...actor, subject: "x".repeat(65537) })).toBe("applied");
  expect(model.capability(session)).toBeNull();
  const largeRoles = model.beginIdentity(session)!;
  expect(model.finishIdentity(largeRoles, "success", { ...actor, roles: new Array(65537) })).toBe("applied");
  expect(model.capability(session)).toBeNull();
});

it("matches the pinned UUID and role contracts on representative wire values", () => {
  const model = new ProtectedSessionModel(), { session, capability } = ready(model);
  const ids: unknown[] = [A, A.toUpperCase(), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "30000000-0000-0000-8000-000000000001", "30000000-0000-9000-8000-000000000001",
    "30000000-0000-4000-7000-000000000001", " 30000000-0000-4000-8000-000000000001", 123, "invalid"];
  for (let version = 1; version <= 8; version++) ids.push(`30000000-0000-${version}000-8000-000000000001`);
  for (const id of ids) expect(model.select(capability, id as string)).toBe(canonicalActorSchema.shape.customerId.safeParse(id).success);
  for (const role of [...roles, "admin", "", 1]) {
    const check = model.beginIdentity(session)!;
    expect(model.finishIdentity(check, "success", { ...actor, roles: [role] } as never)).toBe("applied");
    expect(model.capability(session) !== null).toBe(roleSchema.safeParse(role).success);
  }
});

it("rejects missing handles and hostile identity data without opening admission", () => {
  const model = new ProtectedSessionModel();
  expect(model.establish(undefined as never, "token")).toBeNull();
  expect(model.beginIdentity(undefined as never)).toBeNull();
  expect(model.expire(undefined as never)).toBe(false);
  expect(model.current(undefined as never)).toBe(false);
  expect(model.currentProject(undefined as never)).toBe(false);
  expect(model.currentProjectCapability(undefined as never)).toBe(false);
  const session = model.establish(model.beginLogin(), "token")!;
  const check = model.beginIdentity(session)!;
  const hostile = Object.defineProperty({}, "customerId", { get() { throw new Error("synthetic getter"); } });
  expect(model.finishIdentity(check, "success", hostile as never)).toBe("applied");
  expect(model.capability(session)).toBeNull();
  const retry = model.beginIdentity(session)!;
  expect(model.finishIdentity(retry, "success", { ...actor, roles: new Array(1) })).toBe("applied");
  expect(model.capability(session)).toBeNull();
  model.signOut(); expect(model.establish(undefined as never, "token")).toBeNull();
});

it("binds project authority to its exact project, selection and successful issuance", () => {
  const model = new ProtectedSessionModel(), { capability } = ready(model);
  expect(model.select(capability, 123 as never)).toBe(false);
  expect(model.select(capability, "not-a-project-id")).toBe(false);
  model.select(capability, A); model.finishProject(model.beginProject(capability)!, "success");
  const originalA = model.projectCapability(capability)!;
  expect(model.projectCredential(originalA)).toBe("synthetic-token");
  expect(model.currentProjectCapability({ ...originalA })).toBe(false);
  model.select(capability, B); model.finishProject(model.beginProject(capability)!, "success");
  const projectB = model.projectCapability(capability)!;
  expect(model.projectCredential(originalA)).toBeUndefined();
  expect(model.denyProject(originalA)).toBe(false);
  model.select(capability, A); model.finishProject(model.beginProject(capability)!, "success");
  const freshA = model.projectCapability(capability)!;
  expect(model.projectCredential(originalA)).toBeUndefined();
  expect(model.projectCredential(projectB)).toBeUndefined();
  expect(model.projectCredential(freshA)).toBe("synthetic-token");
  const refresh = model.beginProject(capability)!;
  expect(model.projectCredential(freshA)).toBeUndefined();
  expect(model.finishProject(refresh, "success")).toBe(true);
  const latestA = model.projectCapability(capability)!;
  expect(model.denyProject(freshA)).toBe(false);
  expect(model.denyProject(latestA)).toBe(true);
  expect(model.beginProject(capability)).toBeNull();
});

it("cannot overwrite a newer identity or session created by an actor getter", () => {
  const model = new ProtectedSessionModel(), original = ready(model);
  const oldCheck = model.beginIdentity(original.session)!;
  let newerCapability: ProtectedCapability | null = null, called = false;
  const reentrant = { ...actor, get subject() {
    if (!called) {
      called = true; const newer = model.beginIdentity(original.session)!;
      expect(model.finishIdentity(newer, "success", { ...actor, subject: "newer" })).toBe("applied");
      newerCapability = model.capability(original.session);
    }
    return "older";
  } };
  expect(model.finishIdentity(oldCheck, "success", reentrant)).toBe("stale");
  expect(newerCapability).not.toBeNull(); expect(model.capability(original.session)).toBe(newerCapability);

  const nextOld = model.beginIdentity(original.session)!;
  let newSession: Session | null = null, newCapability: ProtectedCapability | null = null, switched = false;
  const switching = { ...actor, get subject() {
    if (!switched) {
      switched = true; model.signOut(); const next = ready(model, "next-token");
      newSession = next.session; newCapability = next.capability;
    }
    return "older";
  } };
  expect(model.finishIdentity(nextOld, "success", switching)).toBe("stale");
  expect(newSession).not.toBeNull(); expect(model.capability(newSession!)).toBe(newCapability);
  expect(model.protectedCredential(newCapability!)).toBe("next-token");
});


it("exposes only the immutable validated actor for the exact current identity capability", () => {
  const model = new ProtectedSessionModel(), original = ready(model);
  const snapshot = model.actorSnapshot(original.capability)!;
  expect(snapshot).toEqual({ customerId: actor.customerId, subject: actor.subject, roles: ["leadership", "pmo_admin"] });
  expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.roles)).toBe(true);
  expect(model.actorSnapshot({ ...original.capability })).toBeNull();
  const newer = model.beginIdentity(original.session)!;
  expect(model.actorSnapshot(original.capability)).toBeNull();
  const input = { ...actor, roles: ["project_manager", "leadership"] };
  model.finishIdentity(newer, "success", input); const capability = model.capability(original.session)!;
  input.roles.push("system_admin");
  expect(model.actorSnapshot(capability)?.roles).toEqual(["leadership", "project_manager"]);
  model.signOut(); const next = ready(model, "synthetic-token");
  expect(model.actorSnapshot(capability)).toBeNull(); expect(model.actorSnapshot(next.capability)).not.toBeNull();
});


function managerReady(model: ProtectedSessionModel) {
  const session = model.establish(model.beginLogin(), "synthetic-token")!;
  model.finishIdentity(model.beginIdentity(session)!, "success", { ...actor, roles: ["project_manager"] });
  return { session, capability: model.capability(session)! };
}
const queueId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("binds nonselected preview rows to an exact current queue and preview turn", () => {
  const model = new ProtectedSessionModel(), { capability } = managerReady(model), view = model.enterQueueView(capability)!;
  const projects = Array.from({ length: 25 }, (_, index) => queueId(index + 1));
  const check = model.beginQueue(view, model.queueIdleFor(view)!)!;
  const queue = model.finishQueue(check, projects)!;
  const first = model.beginPreview(queue, model.previewIdleFor(queue)!, projects.slice(0, 5))!;
  expect(first.rows).toHaveLength(5); expect(Object.isFrozen(first.rows)).toBe(true);
  const row = first.rows[0]!;
  expect(Object.isFrozen(row)).toBe(true); expect(model.currentPreviewRow(queue, first, row)).toBe(true);
  expect(model.currentPreviewRow(queue, first, { ...row })).toBe(false);
  expect(model.currentPreviewRow({ ...queue }, first, row)).toBe(false);
  const second = model.beginPreview(queue, first, projects.slice(5, 10))!;
  expect(model.currentPreviewRow(queue, first, row)).toBe(false);
  expect(model.currentPreviewRow(queue, second, second.rows[0]!)).toBe(true);
  expect(model.cancelPreview(queue, first)).toBe(false);
  expect(model.beginPreview(queue, first, [])).toBeNull(); // stale action cannot clear second
  expect(model.currentPreviewRow(queue, second, second.rows[0]!)).toBe(true);
  expect(model.beginPreview(queue, second, projects.slice(0, 6))).toBeNull();
  expect(model.currentPreviewRow(queue, second, second.rows[0]!)).toBe(false);
  expect(model.beginPreview(queue, model.previewIdleFor(queue)!, [projects[0], projects[0]])).toBeNull();
  expect(model.beginPreview(queue, model.previewIdleFor(queue)!, [queueId(99)])).toBeNull();
  expect(model.beginPreview(queue, model.previewIdleFor(queue)!, new Array(1))).toBeNull();
  expect(model.beginPreview(queue, model.previewIdleFor(queue)!, ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])).toBeNull();
});

it("rejects stale queue cleanup and old view callbacks across navigation and refresh", () => {
  const model = new ProtectedSessionModel(), { session, capability } = managerReady(model);
  const view = model.enterQueueView(capability)!;
  const firstCheck = model.beginQueue(view, model.queueIdleFor(view)!)!;
  const first = model.finishQueue(firstCheck, [A, B])!, firstTurn = model.beginPreview(first, model.previewIdleFor(first)!, [A])!;
  const secondCheck = model.beginQueue(view, first)!;
  expect(model.invalidateQueue(first)).toBe(false); expect(model.currentQueueCheck(secondCheck)).toBe(true);
  expect(model.beginQueue(view, first)).toBeNull();
  const second = model.finishQueue(secondCheck, [A, B])!, secondTurn = model.beginPreview(second, model.previewIdleFor(second)!, [B])!;
  expect(model.invalidateQueue(firstCheck)).toBe(false);
  expect(model.currentPreviewRow(second, secondTurn, secondTurn.rows[0]!)).toBe(true);
  expect(model.currentPreviewRow(first, firstTurn, firstTurn.rows[0]!)).toBe(false);
  model.select(capability, A); expect(model.enterQueueView(capability)).toBeNull();
  expect(model.beginQueue(view, second)).toBeNull();
  model.select(capability, B); model.select(capability, A); model.select(capability, null);
  const returnedView = model.enterQueueView(capability)!;
  expect(model.beginQueue(view, model.queueIdleFor(view)!)).toBeNull(); expect(model.leaveQueueView(view)).toBe(false);
  const currentCheck = model.beginQueue(returnedView, model.queueIdleFor(returnedView)!)!;
  expect(model.invalidateQueue(currentCheck)).toBe(true);
  const latest = model.beginQueue(returnedView, model.queueIdleFor(returnedView)!)!; expect(model.currentQueueCheck(latest)).toBe(true);
  expect(model.leaveQueueView(returnedView)).toBe(true); expect(model.currentQueueCheck(latest)).toBe(false);
  const currentView = model.enterQueueView(capability)!, current = model.beginQueue(currentView, model.queueIdleFor(currentView)!)!;
  expect(model.beginQueue(returnedView, latest)).toBeNull(); expect(model.leaveQueueView(returnedView)).toBe(false);
  const identity = model.beginIdentity(session)!; expect(model.currentQueueCheck(current)).toBe(false);
  model.finishIdentity(identity, "success", { ...actor, roles: ["project_manager"] });
  const refreshed = model.capability(session)!, nextView = model.enterQueueView(refreshed)!;
  const nextQueue = model.finishQueue(model.beginQueue(nextView, model.queueIdleFor(nextView)!)!, [A])!;
  const nextTurn = model.beginPreview(nextQueue, model.previewIdleFor(nextQueue)!, [A])!;
  model.signOut(); managerReady(model);
  expect(model.currentPreviewRow(nextQueue, nextTurn, nextTurn.rows[0]!)).toBe(false);
  expect(model.invalidateQueue(nextQueue)).toBe(false);
});

it("never reuses a vacant queue or preview owner after cancellation or failed parsing", () => {
  const model = new ProtectedSessionModel(), { capability } = managerReady(model), view = model.enterQueueView(capability)!;
  const oldIdle = model.queueIdleFor(view)!, check = model.beginQueue(view, oldIdle)!;
  expect(model.invalidateQueue(check)).toBe(true);
  expect(model.beginQueue(view, oldIdle)).toBeNull();
  const nextIdle = model.queueIdleFor(view)!; expect(nextIdle).not.toBe(oldIdle);
  const bad = model.beginQueue(view, nextIdle)!; expect(model.finishQueue(bad, ["invalid"])).toBeNull();
  expect(model.beginQueue(view, nextIdle)).toBeNull();
  const queue = model.finishQueue(model.beginQueue(view, model.queueIdleFor(view)!)!, [A, B])!;
  const oldPreviewIdle = model.previewIdleFor(queue)!;
  expect(model.cancelPreview(queue, oldPreviewIdle)).toBe(true);
  expect(model.cancelPreview(queue, oldPreviewIdle)).toBe(false);
  expect(model.beginPreview(queue, oldPreviewIdle, [A])).toBeNull();
  const turn = model.beginPreview(queue, model.previewIdleFor(queue)!, [A])!;
  expect(model.beginPreview(queue, turn, ["invalid"])).toBeNull();
  expect(model.beginPreview(queue, oldPreviewIdle, [B])).toBeNull();
  const freshIdle = model.previewIdleFor(queue)!; expect(freshIdle).not.toBe(oldPreviewIdle);
  const current = model.beginPreview(queue, freshIdle, [B])!;
  expect(model.currentPreviewRow(queue, current, current.rows[0]!)).toBe(true);
  expect(model.cancelPreview(queue, current)).toBe(true);
  expect(model.currentPreviewRow(queue, current, current.rows[0]!)).toBe(false);
  expect(model.beginPreview(queue, freshIdle, [A])).toBeNull();
  const afterHide = model.beginPreview(queue, model.previewIdleFor(queue)!, [A])!;
  expect(model.cancelPreview(queue, current)).toBe(false); // old cleanup after re-entry
  expect(model.currentQueue(queue)).toBe(true);
  expect(model.currentPreviewRow(queue, afterHide, afterHide.rows[0]!)).toBe(true);
});

it("a reentrant queue parse failure cannot clear a newer issued queue check", () => {
  const model = new ProtectedSessionModel(), { capability } = managerReady(model), view = model.enterQueueView(capability)!;
  const old = model.beginQueue(view, model.queueIdleFor(view)!)!;
  let newer: ReturnType<ProtectedSessionModel["beginQueue"]> = null;
  const input = [A]; Object.defineProperty(input, 0, { get() { newer = model.beginQueue(view, old); throw new Error("synthetic getter"); } });
  expect(model.finishQueue(old, input)).toBeNull(); expect(newer).not.toBeNull();
  expect(model.currentQueueCheck(newer!)).toBe(true);
  const queue = model.finishQueue(newer!, [B])!;
  expect(model.currentQueue(queue)).toBe(true);
});

it("fails closed on malformed queues and cannot let stale or reentrant input mint rows", () => {
  const model = new ProtectedSessionModel(), { capability } = managerReady(model), view = model.enterQueueView(capability)!;
  const nonManager = new ProtectedSessionModel(), nonManagerReady = ready(nonManager);
  expect(nonManager.enterQueueView(nonManagerReady.capability)).toBeNull();
  const alpha = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const invalid of [new Array(1), [alpha, alpha.toUpperCase()], ["invalid"], Array.from({ length: 26 }, (_, i) => queueId(i + 1))]) {
    const check = model.beginQueue(view, model.queueIdleFor(view)!)!;
    expect(model.finishQueue(check, invalid)).toBeNull(); expect(model.currentQueueCheck(check)).toBe(false);
  }
  const first = model.beginQueue(view, model.queueIdleFor(view)!)!, newer = model.beginQueue(view, first)!;
  expect(model.finishQueue(first, [A])).toBeNull();
  const queue = model.finishQueue(newer, [A, B])!;
  let replacement: ReturnType<ProtectedSessionModel["beginQueue"]> = null;
  const reentrant = [A]; Object.defineProperty(reentrant, 0, { get() { replacement = model.beginQueue(view, queue); return A; } });
  expect(model.beginPreview(queue, model.previewIdleFor(queue)!, reentrant)).toBeNull(); expect(replacement).not.toBeNull();
  const fresh = model.finishQueue(replacement!, [B])!;
  let inner: ReturnType<ProtectedSessionModel["beginPreview"]> = null;
  const nested = [B]; Object.defineProperty(nested, 0, { get() { inner = model.beginPreview(fresh, model.previewIdleFor(fresh)!, [B]); return B; } });
  expect(model.beginPreview(fresh, model.previewIdleFor(fresh)!, nested)).toBeNull(); expect(inner).not.toBeNull();
  expect(model.currentPreviewRow(fresh, inner!, inner!.rows[0]!)).toBe(true);
  expect(model.finishQueue(newer, [A])).toBeNull();
  expect(model.currentPreviewRow(fresh, inner!, inner!.rows[0]!)).toBe(true);
});
