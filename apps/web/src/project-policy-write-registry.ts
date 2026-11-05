// FR-HLT-008 / SEC-AUTH-001: an unconfirmed policy POST is not evidence that
// the server did nothing. This tab-lifetime registry is not a server receipt,
// cross-tab lock or durable idempotency mechanism. Keys identify the customer
// and project, so a different actor in this tab cannot borrow an open slot.
type Entry = { id: symbol; state: "pending" | "uncertain" };
export function projectPolicyOwner(customerId: unknown, projectId: unknown): string {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  return typeof customerId === "string" && typeof projectId === "string" && uuid.test(customerId) && uuid.test(projectId)
    ? JSON.stringify([customerId.toLowerCase(), projectId.toLowerCase()]) : "";
}
export class ProjectPolicyWriteRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private notifying = false;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = () => this.version;
  state(owner: string): "available" | "pending" | "uncertain" | "capacity" | "invalid" {
    return !owner ? "invalid" : this.entries.get(owner)?.state ?? (this.entries.size >= 64 ? "capacity" : "available");
  }
  begin(owner: string): symbol | null {
    if (!owner || this.state(owner) !== "available") return null;
    const id = Symbol("project-policy-write"); this.entries.set(owner, { id, state: "pending" }); this.notify(); return id;
  }
  confirm(owner: string, id: symbol): boolean {
    if (this.entries.get(owner)?.id !== id) return false;
    this.entries.delete(owner); this.notify(); return true;
  }
  uncertain(owner: string, id: symbol): boolean {
    const entry = this.entries.get(owner);
    if (!entry || entry.id !== id) return false;
    entry.state = "uncertain"; this.notify(); return true;
  }
  private notify(): void {
    this.version++;
    if (this.notifying) return;
    this.notifying = true;
    queueMicrotask(() => { this.notifying = false; for (const listener of this.listeners) listener(); });
  }
}
export const projectPolicyWrites = new ProjectPolicyWriteRegistry();
// Source access replacements have their own bounded slots. Their key uses the
// project/source UUID pair and therefore conservatively spans local actors.
export const sourceAccessWrites = new ProjectPolicyWriteRegistry();
