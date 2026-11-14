// Unwired capability-capturing callbacks for a future trusted queue owner.
// They provide logical fencing only: callers must retain physical request
// leases, drain original responses, and rely on server authorization.
import { ProtectedSessionModel, type PreviewIdle, type PreviewRowCapability, type PreviewTurn,
  type QueueCapability, type QueueCheck, type QueueIdle, type QueueView } from "./protected-session-model.js";

// Only the trusted coordinator receives finish. Children receive callbacks;
// they cannot supply claimed queue membership or obtain a live model handle.
export function createQueueLoadAction(model: ProtectedSessionModel, view: QueueView,
  expected: QueueIdle | QueueCheck | QueueCapability) {
  let live = true, attempted = false, finished = false, check: QueueCheck | null = null, queue: QueueCapability | null = null;
  const callbacks = Object.freeze({
    start(): boolean {
      if (!live || attempted) return false;
      attempted = true; check = model.beginQueue(view, expected); return check !== null;
    },
    current(): boolean {
      return live && (queue ? model.currentQueue(queue) : check ? model.currentQueueCheck(check) : false);
    },
    dispose(): void {
      if (!live) return;
      live = false; const owner = queue ?? check;
      if (owner) model.invalidateQueue(owner);
    },
  });
  return Object.freeze({
    callbacks,
    // Supply IDs only from the bounded, decoded response for this check.
    finish(projectIds: unknown): QueueCapability | null {
      if (!live || !check || finished) return null;
      finished = true;
      const result = model.finishQueue(check, projectIds);
      if (!live) { if (result) model.invalidateQueue(result); return null; }
      queue = result; return result;
    },
  });
}

function snapshotPreviewIds(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const count = value.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > 5) return null;
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      if (!Object.hasOwn(value, index)) return null;
      const id: unknown = value[index]; if (typeof id !== "string") return null;
      ids.push(id);
    }
    return Object.freeze(ids);
  } catch { return null; }
}

// Capture the intended displayed batch once, before sharing child callbacks.
export function createPreviewStartAction(model: ProtectedSessionModel, queue: QueueCapability,
  expected: PreviewIdle | PreviewTurn, projectIds: unknown) {
  const ids = snapshotPreviewIds(projectIds);
  let live = true, attempted = false, turn: PreviewTurn | null = null;
  const callbacks = Object.freeze({
    start(): boolean {
      if (!live || attempted || !ids) return false;
      attempted = true;
      const result = model.beginPreview(queue, expected, ids);
      if (!live) { if (result) model.cancelPreview(queue, result); return false; }
      turn = result; return result !== null;
    },
    dispose(): void {
      if (!live) return;
      live = false; if (turn) model.cancelPreview(queue, turn);
    },
  });
  return Object.freeze({
    callbacks,
    snapshot(): PreviewTurn | null { return live && turn && model.currentPreviewTurn(queue, turn) ? turn : null; },
    current(row: PreviewRowCapability): boolean {
      return Boolean(live && turn && model.currentPreviewRow(queue, turn, row));
    },
  });
}
