import type { WorkerHeartbeatRepository } from "@pdaa/domain";

const connectorRunPath = "/internal/connectors/run";

type ConnectorTaskKeyRing = {
  currentKeyId: string;
  keys: Record<string, string>;
};
type WorkerConnectorConfig = {
  INTERNAL_API_URL?: string;
  connectorTaskKeys?: ConnectorTaskKeyRing | null;
};
type TaskSigner = (input: {
  method: string;
  path: string;
  body: Uint8Array;
  keyRing: ConnectorTaskKeyRing;
}) => Record<string, string>;

export function createTasks(
  heartbeat: WorkerHeartbeatRepository,
  config?: WorkerConnectorConfig,
  fetchImpl: typeof fetch = fetch,
  signTaskRequest?: TaskSigner,
  purgeHealthAssessments?: () => Promise<void>,
) {
  return {
    foundation_heartbeat: async () => heartbeat.recordHeartbeat(new Date()),
    health_assessment_retention: async () => {
      if (!purgeHealthAssessments) throw new Error("health_assessment_retention_unavailable");
      await purgeHealthAssessments();
    },
    connector_sync_dispatch: async () => {
      if (!config?.INTERNAL_API_URL || !config.connectorTaskKeys) return;
      if (!signTaskRequest) throw new Error("connector_dispatch_unavailable");
      const body = Buffer.from("{}", "utf8");
      const headers = signTaskRequest({
        method: "POST",
        path: connectorRunPath,
        body,
        keyRing: config.connectorTaskKeys,
      });
      let response: Response;
      try {
        response = await fetchImpl(new URL(connectorRunPath, config.INTERNAL_API_URL), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
        });
      } catch {
        throw new Error("connector_dispatch_unavailable");
      }
      if (!response.ok) throw new Error("connector_dispatch_unavailable");
      await response.body?.cancel();
    },
  };
}
