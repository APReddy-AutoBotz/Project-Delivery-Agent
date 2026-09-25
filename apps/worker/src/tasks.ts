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
) {
  return {
    foundation_heartbeat: async () => heartbeat.recordHeartbeat(new Date()),
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
