import { projectPolicyOwner } from "./project-policy-write-registry.js";

// SEC-AUTH-001: the backend receipt permits an exact same-subject, same-key,
// same-payload replay. Other commands in this customer/portfolio remain
// blocked while the previous outcome is unresolved. This page-lifetime guard
// is not a durable receipt or a cross-tab lock.
export const canonicalCreationOwner = projectPolicyOwner;
export type CreationCommand = Readonly<{ key: string; fingerprint: string }>;
export async function canonicalCommandFingerprint(subject: string, payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([subject, payload]));
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("The creation request is too large to prepare.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
type Entry = { id: symbol; state: "pending" | "uncertain"; command: CreationCommand };
export class CanonicalCreationWriteRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private notifying = false;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = () => this.version;
  state(owner: string, command: CreationCommand | null): "available" | "retryable" | "pending" | "uncertain" | "capacity" | "invalid" {
    if (!owner) return "invalid";
    const entry = this.entries.get(owner);
    if (!entry) return this.entries.size >= 64 ? "capacity" : "available";
    if (entry.state === "pending") return "pending";
    return command && entry.command.key === command.key &&
      entry.command.fingerprint === command.fingerprint ? "retryable" : "uncertain";
  }
  begin(owner: string, command: CreationCommand): symbol | null {
    if (!command.key || command.key.length > 128 || !/^[0-9a-f]{64}$/.test(command.fingerprint)) return null;
    const state = this.state(owner, command);
    if (state !== "available" && state !== "retryable") return null;
    const id = Symbol("canonical-creation");
    this.entries.set(owner, { id, state: "pending", command: { ...command } }); this.notify(); return id;
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
export const projectCreationWrites = new CanonicalCreationWriteRegistry();
export const programmeCreationWrites = new CanonicalCreationWriteRegistry();
