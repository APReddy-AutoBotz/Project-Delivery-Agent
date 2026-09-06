import type { WorkerHeartbeatRepository } from "@pdaa/domain";

export function createTasks(heartbeat: WorkerHeartbeatRepository) {
  return {
    foundation_heartbeat: async () => heartbeat.recordHeartbeat(new Date()),
  };
}
