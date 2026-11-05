import { describe, expect, it } from "vitest";
import { ProjectPolicyWriteRegistry, projectPolicyOwner } from "../apps/web/src/project-policy-write-registry.js";

describe("FR-HLT-008 project policy write admission", () => {
  it("retains an uncertain outcome for the same customer and project", () => {
    const registry = new ProjectPolicyWriteRegistry();
    const first = registry.begin("owner-project")!;
    expect(registry.state("owner-project")).toBe("pending");
    expect(registry.begin("owner-project")).toBeNull();
    expect(registry.uncertain("owner-project", first)).toBe(true);
    expect(registry.state("owner-project")).toBe("uncertain");
    expect(registry.begin("owner-project")).toBeNull();
    expect(registry.begin("other-project")).not.toBeNull();
  });

  it("only lets the exact confirmed write release its admission", () => {
    const registry = new ProjectPolicyWriteRegistry();
    const first = registry.begin("owner-project")!;
    expect(registry.confirm("owner-project", Symbol("other"))).toBe(false);
    expect(registry.confirm("owner-project", first)).toBe(true);
    const next = registry.begin("owner-project")!;
    expect(registry.confirm("owner-project", first)).toBe(false);
    expect(registry.state("owner-project")).toBe("pending");
    expect(registry.confirm("owner-project", next)).toBe(true);
  });

  it("fails closed at its bounded capacity without evicting an unknown outcome", () => {
    const registry = new ProjectPolicyWriteRegistry();
    const first = registry.begin("owner-0")!; registry.uncertain("owner-0", first);
    for (let index = 1; index < 64; index++) expect(registry.begin(`owner-${index}`)).not.toBeNull();
    expect(registry.state("extra")).toBe("capacity");
    expect(registry.begin("extra")).toBeNull();
    expect(registry.state("owner-0")).toBe("uncertain");
  });

  it("normalizes UUID casing and rejects malformed owner keys", () => {
    const customer = "a0000000-0000-4000-8000-000000000001", project = "b0000000-0000-4000-8000-000000000002";
    expect(projectPolicyOwner(customer.toUpperCase(), project.toUpperCase())).toBe(projectPolicyOwner(customer, project));
    expect(projectPolicyOwner("bad", project)).toBe("");
    expect(new ProjectPolicyWriteRegistry().state("")).toBe("invalid");
  });
});
