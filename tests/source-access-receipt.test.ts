import { describe, expect, it } from "vitest";
import { confirmsSourceAccess } from "../apps/web/src/source-access-receipt.js";

describe("source access replacement receipt", () => {
  const sourceId = "a0000000-0000-4000-8000-000000000001";
  it("accepts a newer matching revision, including reader-triggered jumps", () => {
    expect(confirmsSourceAccess(sourceId, 2, { sourceId, revision: 3 })).toBe(true);
    expect(confirmsSourceAccess(sourceId, 2, { sourceId: sourceId.toUpperCase(), revision: 7 })).toBe(true);
  });
  it("rejects nonadvancing, malformed, extra-field or wrong-source receipts", () => {
    for (const result of [null, [], { sourceId, revision: 2 }, { sourceId, revision: 1 },
      { sourceId, revision: 2.5 }, { sourceId, revision: 2147483648 }, { sourceId, revision: "7" },
      { sourceId, revision: 7, extra: true }, { sourceId: "b0000000-0000-4000-8000-000000000001", revision: 7 }])
      expect(confirmsSourceAccess(sourceId, 2, result)).toBe(false);
    expect(confirmsSourceAccess(sourceId, NaN, { sourceId, revision: 7 })).toBe(false);
  });
});
