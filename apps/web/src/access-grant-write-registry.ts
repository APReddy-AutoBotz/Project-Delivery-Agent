// Page-lifetime guard only: these endpoints have no safe replay or receipt.
// It does not serialize other tabs, operators, or future page loads.
type Entry = { id: symbol; state: "pending" | "uncertain" };
export class AccessGrantWriteRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = () => this.version;
  state(owner: string): "available" | "pending" | "uncertain" | "capacity" {
    return this.entries.get(owner)?.state ?? (this.entries.size >= 64 ? "capacity" : "available");
  }
  begin(owner: string): symbol | null {
    if (this.state(owner) !== "available") return null;
    const id = Symbol("access-grant"); this.entries.set(owner, { id, state: "pending" }); this.notify(); return id;
  }
  confirm(owner: string, id: symbol) {
    if (this.entries.get(owner)?.id !== id) return;
    this.entries.delete(owner); this.notify();
  }
  uncertain(owner: string, id: symbol) {
    const entry = this.entries.get(owner); if (!entry || entry.id !== id) return;
    entry.state = "uncertain"; this.notify();
  }
  private notify() { this.version++; queueMicrotask(() => { for (const listener of this.listeners) listener(); }); }
}
export const accessGrantWrites = new AccessGrantWriteRegistry();
export function accessGrantOwner(customer: string, subject: string, scope: string, id: string) {
  return JSON.stringify([customer.toLowerCase(), subject.trim(), scope, id.toLowerCase()]);
}
