import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { verifyIsolatedTlsRejection } from "../scripts/acceptance/isolated-tls-probe.mjs";

describe("isolated browser certificate-negative probe", () => {
  function fixture(fault: string) {
    const page = Object.assign(new EventEmitter(), { goto: vi.fn(async () => {
      if (fault === "response") page.emit("response", {});
      if (fault === "hostile") throw { get message() { throw new Error("private getter"); } };
      if (fault !== "accepted") throw new Error(fault.startsWith("wrong") ? "ERR_CERT_DATE_INVALID private" : "ERR_CERT_COMMON_NAME_INVALID private");
    }) });
    const context = { cookies: vi.fn(async () => fault === "cookies" ? [{ name: "private" }] : []),
      newPage: vi.fn(async () => page), close: vi.fn(async () => { if (fault.includes("cleanup")) throw new Error("private cleanup"); }) };
    const browser = { newContext: vi.fn(async () => context) };
    return { browser, context, page };
  }
  it("requires the expected rejection in a fresh context and always closes it", async () => {
    const f = fixture("none");
    await expect(verifyIsolatedTlsRejection(f.browser, "https://synthetic.invalid", "ERR_CERT_COMMON_NAME_INVALID")).resolves.toBeUndefined();
    expect(f.browser.newContext).toHaveBeenCalledExactlyOnceWith({ ignoreHTTPSErrors: false });
    expect(f.page.goto).toHaveBeenCalledExactlyOnceWith("https://synthetic.invalid");
    expect(f.context.close).toHaveBeenCalledOnce();
  });
  it.each(["accepted", "wrong", "cookies", "response", "hostile", "cleanup"])("fails closed for %s", async (fault) => {
    const f = fixture(fault);
    const error = await verifyIsolatedTlsRejection(f.browser, "https://synthetic.invalid", "ERR_CERT_COMMON_NAME_INVALID").then(() => null, (value: unknown) => value);
    expect(error).not.toBeNull();
    expect(String(error)).not.toContain("private");
    expect(f.context.close).toHaveBeenCalledOnce();
  });
  it("retains a sanitized primary failure if cleanup also fails", async () => {
    const f = fixture("wrong-cleanup"), report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(verifyIsolatedTlsRejection(f.browser, "https://synthetic.invalid", "ERR_CERT_COMMON_NAME_INVALID"))
        .rejects.toThrow(/^Certificate probe failed$/);
      expect(report).toHaveBeenCalledOnce();
      expect(report.mock.calls[0]![0]).not.toContain("private");
    } finally { report.mockRestore(); }
  });
  it("rejects unsupported categories before opening a context", async () => {
    const f = fixture("none");
    await expect(verifyIsolatedTlsRejection(f.browser, "https://synthetic.invalid", "private-category")).rejects.toThrow("Unsupported certificate rejection category");
    expect(f.browser.newContext).not.toHaveBeenCalled();
  });
});
