import type { HealthScopeFence } from "./health-scope-fence.js";

export function sameHealthRoles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort(), right = [...b].sort();
  return left.every((role, index) => role === right[index]);
}

// Checks are separate authenticated reads. The project check starts only after
// identity has been verified for this context; neither check is authorization
// for a later health read or an assurance of continuous access.
export async function establishHealthScope(
  fence: HealthScopeFence,
  context: number,
  current: () => boolean,
  signal: AbortSignal,
  checkIdentity: (signal: AbortSignal, currentCheck: () => boolean) => Promise<boolean>,
  checkProject: (signal: AbortSignal, currentCheck: () => boolean) => Promise<boolean>,
): Promise<boolean> {
  const live = () => !signal.aborted && fence.contextSnapshot() === context && current();
  if (!live()) return false;
  const identity = fence.begin("identity");
  if (!identity) return false;
  try {
    const allowed = await checkIdentity(signal, () => live() && fence.currentCheck(identity));
    if (!live() || !allowed) { fence.finish(identity, false); return false; }
    if (!fence.finish(identity, true)) return false;
  } catch { fence.finish(identity, false); return false; }
  if (!live()) return false;
  const project = fence.begin("project");
  if (!project) return false;
  try {
    const allowed = await checkProject(signal, () => live() && fence.currentCheck(project));
    if (!live() || !allowed) { fence.finish(project, false); return false; }
    return fence.finish(project, true);
  } catch { fence.finish(project, false); return false; }
}
