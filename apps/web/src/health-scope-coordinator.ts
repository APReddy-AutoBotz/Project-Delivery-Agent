import type { HealthScopeFence } from "./health-scope-fence.js";

// Checks are separate authenticated reads. The project check starts only after
// identity has been verified for this context; neither check is authorization
// for a later health read or an assurance of continuous access.
export async function establishHealthScope(
  fence: HealthScopeFence,
  context: number,
  current: () => boolean,
  signal: AbortSignal,
  checkIdentity: (signal: AbortSignal) => Promise<boolean>,
  checkProject: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  const live = () => !signal.aborted && fence.contextSnapshot() === context && current();
  if (!live()) return false;
  const identity = fence.begin("identity");
  if (!identity) return false;
  try {
    const allowed = await checkIdentity(signal);
    if (!live() || !allowed) { fence.finish(identity, false); return false; }
    if (!fence.finish(identity, true)) return false;
  } catch { fence.finish(identity, false); return false; }
  if (!live()) return false;
  const project = fence.begin("project");
  if (!project) return false;
  try {
    const allowed = await checkProject(signal);
    if (!live() || !allowed) { fence.finish(project, false); return false; }
    return fence.finish(project, true);
  } catch { fence.finish(project, false); return false; }
}
