import {
  connectorReadScopeSchema,
  parseIngestion,
  validateConnectorDeepLink,
  validateConnectorPage,
  validateConnectorRecord,
  type ConnectorFailure,
  type ConnectorResult,
  type ReadOnlyConnector,
} from "../../packages/domain/src/connector.js";

// Shared synthetic fixture only. No Jira/live-source or full write-contract claim.
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const fixtureScope = {
  binding: {
    customerId: id(1),
    sourceId: id(2),
    sourceType: "synthetic",
    origin: "https://source.example",
  },
  projectIds: [id(3)],
};
export const fixtureRecord = {
  ref: {
    customerId: id(1),
    sourceId: id(2),
    projectId: id(3),
    recordType: "issue",
    recordId: "A-1",
  },
  revision: "1",
  observedAt: "2026-09-22T11:00:00.000Z",
  effectiveAt: "2026-09-22T11:00:00.000Z",
  deepLink: "https://source.example/browse/A-1",
  observations: [
    { factType: "status", value: { type: "text" as const, value: "Open" } },
  ],
};
export function createSyntheticReadConnector(
  failure?: ConnectorFailure,
): ReadOnlyConnector {
  const result = <T>(value: T): Promise<ConnectorResult<T>> =>
    Promise.resolve(
      failure
        ? { ok: false, failure: structuredClone(failure) }
        : { ok: true, value: structuredClone(value) },
    );
  const verifyScope = (input: unknown) => {
    const scope = parseIngestion(connectorReadScopeSchema, input);
    // The fixture is bound to one source and scope, never adopts caller scope.
    validateConnectorPage(
      { scope, cursor: null },
      {
        binding: fixtureScope.binding,
        inputCursor: null,
        nextCursor: null,
        terminal: true,
        records: [fixtureRecord],
      },
    );
    return scope;
  };
  return {
    testConnection(scope) {
      verifyScope(scope);
      return result({ checkedAt: fixtureRecord.observedAt });
    },
    discoverScopes(scope) {
      verifyScope(scope);
      return result({
        projectIds: fixtureScope.projectIds,
        checkedAt: fixtureRecord.observedAt,
      });
    },
    pullChanges(request) {
      verifyScope(request.scope);
      return result(
        validateConnectorPage(request, {
          binding: fixtureScope.binding,
          inputCursor: request.cursor,
          nextCursor: request.cursor === null ? "next" : null,
          terminal: request.cursor !== null,
          records: request.cursor === null ? [fixtureRecord] : [],
        }),
      );
    },
    getRecord(scope, ref) {
      verifyScope(scope);
      return result(validateConnectorRecord(scope, ref, fixtureRecord));
    },
    getDeepLink(scope, ref) {
      verifyScope(scope);
      validateConnectorRecord(scope, ref, fixtureRecord);
      return validateConnectorDeepLink(scope, fixtureRecord.deepLink);
    },
  } satisfies ReadOnlyConnector;
}
