import { z } from "zod";
import type { Config } from "./config.js";

const policySchema = z.strictObject({
  shadow: z.literal(false),
  permitted: z.literal(true),
  humanApproved: z.literal(true),
});

// FR-APP-010, FR-ADM-009, NFR-SEC-001: bind one operation to server-owned
// configuration, policy and adapter. Never expose this factory or its readers as
// model tools. Invocation arguments cannot grant permission or supply approval.
export function createOutboundDispatcher<T>(boundary: {
  readConfiguration: () => Pick<Config, "SHADOW_MODE">;
  readPolicy: () => unknown | Promise<unknown>;
  dispatch: () => Promise<T>;
}): () => Promise<T> {
  const { readConfiguration, readPolicy, dispatch } = boundary;
  const requireActive = () => {
    if (readConfiguration()?.SHADOW_MODE !== "false")
      throw new Error("Outbound action blocked");
  };
  return async () => {
    try {
      requireActive();
      const policy = await readPolicy();
      if (!policySchema.safeParse(policy).success) throw new Error();
      // Configuration can change while the authoritative policy lookup awaits.
      requireActive();
    } catch {
      // Neither policy errors nor rejected values are safe diagnostic output.
      throw new Error("Outbound action blocked");
    }
    return dispatch();
  };
}
