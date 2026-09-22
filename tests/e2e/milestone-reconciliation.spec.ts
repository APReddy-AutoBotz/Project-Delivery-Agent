import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

test.setTimeout(90000); // Real multi-actor review/retry/source-revalidation journeys.
const portfolioId = "20000000-0000-4000-8000-000000000001";
async function fixture(request: APIRequestContext, omitMilestone = false) {
  const tokens: Record<string, string> = {};
  for (const persona of [
    "pmo-portfolio",
    "pm-atlas",
    "leader-atlas",
    "operator",
  ]) {
    const response = await request.post("/api/auth/development", {
      data: { persona },
    });
    expect(response.status()).toBe(200);
    tokens[persona] = (await response.json()).token;
  }
  const api = (persona: string, path: string, method = "GET", data?: unknown) =>
    request.fetch("/api" + path, {
      method,
      headers: { Authorization: "Bearer " + tokens[persona] },
      ...(data === undefined ? {} : { data }),
    });
  const input = canonicalFixture(portfolioId);
  input.code = "REC-" + randomUUID().slice(0, 12);
  input.name = "Synthetic reconciliation " + randomUUID().slice(0, 8);
  input.responsibilities = [
    {
      role: "PROJECT_MANAGER",
      subject: "pm-atlas",
      displayName: "Configured PM",
    },
  ];
  input.workItems = [1, 2, 3].map((n) => ({
    ...input.workItems[0],
    key: "WI-" + n,
  }));
  input.requiredWorkItems = [1, 2, 3].map((n) => ({
    milestoneKey: "MS-1",
    workItemKey: "WI-" + n,
  }));
  input.raidItems = [];
  input.sourceMappings = [];
  expect(
    (
      await api("operator", "/access-grants", "POST", {
        subject: "pmo-portfolio",
        role: "pmo_admin",
        scopeType: "portfolio",
        scopeId: portfolioId,
      })
    ).status(),
  ).toBe(204);
  const created = await api("pmo-portfolio", "/projects", "POST", input);
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).id,
    prefix = `/projects/${projectId}`;
  for (const [subject, role] of [
    ["pm-atlas", "project_manager"],
    ["leader-atlas", "leadership"],
  ])
    expect(
      (
        await api("operator", "/access-grants", "POST", {
          subject,
          role,
          scopeType: "project",
          scopeId: projectId,
        })
      ).status(),
    ).toBe(204);
  const canonical = await (
    await api("pmo-portfolio", prefix + "/canonical")
  ).json();
  const milestoneId = canonical.milestones.find(
    (m: { key: string }) => m.key === "MS-1",
  ).id;
  const targets = [
    {
      targetKind: "MILESTONE",
      targetId: milestoneId,
      initialState: "COMPLETE",
    },
    ...canonical.requiredWorkItems
      .filter((l: { milestoneKey: string }) => l.milestoneKey === "MS-1")
      .map((l: { workItemKey: string }) => ({
        targetKind: "WORK_ITEM",
        targetId: canonical.workItems.find(
          (w: { key: string }) => w.key === l.workItemKey,
        ).id,
        initialState: "OPEN",
      })),
  ];
  expect(targets).toHaveLength(4);
  const effectiveAt = new Date(Date.now() - 3600000).toISOString(),
    validUntil = new Date(Date.now() + 86400000).toISOString(),
    bindings: any[] = [];
  async function share(
    sourceId: string,
    readers = ["pmo-portfolio", "pm-atlas"],
  ) {
    const path = prefix + `/fact-sources/${sourceId}/access`;
    const current = await api("pmo-portfolio", path);
    expect(current.status()).toBe(200);
    expect(
      (
        await api("pmo-portfolio", path, "POST", {
          projectId,
          sourceId,
          expectedRevision: (await current.json()).revision,
          state: "AVAILABLE",
          readers,
        })
      ).status(),
    ).toBe(200);
  }
  async function configure(bound: any) {
    expect(
      (
        await api("pmo-portfolio", prefix + "/authority-policies", "POST", {
          projectId,
          factType: bound.factType,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          effectiveAt,
          definition: {
            tiers: [
              {
                selectors: [
                  {
                    sourceType: "human_statement",
                    instanceId: null,
                    requiredApproval: "NOT_REQUIRED",
                    validity: null,
                  },
                ],
              },
            ],
            conflictBehavior: "REQUEST_RECONCILIATION",
          },
        })
      ).status(),
    ).toBe(201);
    await share(bound.entry.sourceId);
    bindings.push(bound);
  }
  for (const target of targets.filter(
    (t) => !omitMilestone || t.targetKind !== "MILESTONE",
  )) {
    const response = await api(
      "pmo-portfolio",
      prefix + "/state-bindings",
      "POST",
      {
        projectId,
        ...target,
        effectiveAt,
        validUntil,
        originalStatement: "Synthetic confirmed " + target.initialState,
        idempotencyKey: randomUUID(),
      },
    );
    expect(response.status()).toBe(201);
    await configure(await response.json());
  }
  async function check() {
    const response = await api(
      "pmo-portfolio",
      prefix + "/milestone-reconciliation-checks",
      "POST",
      {
        projectId,
        milestoneId,
        enabled: true,
        ruleRevision: "milestone-required-state/v1",
        idempotencyKey: randomUUID(),
      },
    );
    expect(response.status()).toBe(201);
    return response.json();
  }
  return {
    api,
    projectId,
    prefix,
    milestoneId,
    name: input.name,
    effectiveAt,
    validUntil,
    bindings,
    configure,
    share,
    check,
  };
}
async function signIn(page: Page, persona: string, path = "/") {
  await page.goto(path);
  await page.getByRole("button", { name: new RegExp(`^${persona} `) }).click();
}
async function open(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await signIn(page, "PMO administrator");
  await page.getByRole("button", { name: new RegExp(f.name) }).click();
  await page
    .getByLabel("Milestone to check", { exact: true })
    .selectOption(f.milestoneId);
}
test("INT-EVD-004: review binding, retry a committed check and show management metadata only", async ({
  page,
  request,
}) => {
  const f = await fixture(request, true);
  await open(page, f);
  await page
    .getByRole("button", { name: "MILESTONE " + f.milestoneId, exact: true })
    .click();
  await page
    .getByLabel("Initial evidence state", { exact: true })
    .selectOption("COMPLETE");
  await page
    .getByLabel("Original state statement", { exact: true })
    .fill("Synthetic milestone complete for reconciliation");
  await page
    .getByLabel("State effective at (UTC)", { exact: true })
    .fill(f.effectiveAt);
  await page
    .getByLabel("State valid until (UTC, optional)", { exact: true })
    .fill(f.validUntil);
  await page
    .getByRole("button", { name: "Review state binding", exact: true })
    .click();
  await expect(
    page.getByText(
      "HUMAN_CONFIRMED · COMPLETE · Synthetic milestone complete for reconciliation",
      { exact: true },
    ),
  ).toBeVisible();
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/state-bindings") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Confirm state binding", exact: true })
    .click();
  const bound = await saved;
  expect(bound.status()).toBe(201);
  await f.configure(await bound.json());
  let committed: any,
    firstKey: string | undefined,
    calls = 0;
  let checkLost!: () => void, checkFailed!: (error: unknown) => void;
  const lostCheck = new Promise<void>((resolve, reject) => {
    checkLost = resolve;
    checkFailed = reject;
  });
  void lostCheck.catch(() => {});
  await page.route("**/milestone-reconciliation-checks", async (route) => {
    calls++;
    const body = route.request().postDataJSON();
    if (calls === 1) {
      firstKey = body.idempotencyKey;
      try {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        committed = await response.json();
        await route.abort("failed");
        checkLost();
      } catch (error) {
        checkFailed(error);
        throw error;
      }
    } else {
      expect(body.idempotencyKey).toBe(firstKey);
      await route.continue();
    }
  });
  await page
    .getByRole("button", {
      name: "Check milestone and request reconciliation",
      exact: true,
    })
    .click();
  // The UI's five-second retry assertion starts after the original command has
  // actually committed and the lost response has been injected, not during it.
  await lostCheck;
  await expect(
    page.getByRole("button", {
      name: "Retry same milestone check",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry same milestone check", exact: true })
    .click();
  await expect(
    page.getByText(/Check outcome: CONFLICTING · CREATED/),
  ).toBeVisible();
  expect(calls).toBe(2);
  await page.unroute("**/milestone-reconciliation-checks");
  expect(committed.request.assignment.recipientSubject).toBe("pm-atlas");
  await page
    .getByRole("combobox", { name: "Reconciliation queue", exact: true })
    .selectOption("manage");
  const queue = page.getByRole("region", {
    name: "Reconciliation queue",
    exact: true,
  });
  await expect(queue.getByText(/Assignment revision 1:/)).toBeVisible();
  await expect(
    queue.getByRole("button", { name: "Open request", exact: true }),
  ).toHaveCount(0);
  // FR-EVD-012: another successful check must not remount away an uncertain
  // assignment refresh. Its identical original command remains retryable.
  let assignmentCommand: unknown,
    assignmentCalls = 0;
  let assignmentLost!: () => void, assignmentFailed!: (error: unknown) => void;
  const lostAssignment = new Promise<void>((resolve, reject) => {
    assignmentLost = resolve;
    assignmentFailed = reject;
  });
  void lostAssignment.catch(() => {});
  await page.route("**/reconciliation-requests/*/assignment", async (route) => {
    assignmentCalls++;
    const body = route.request().postDataJSON();
    if (assignmentCalls === 1) {
      assignmentCommand = body;
      try {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort("failed");
        assignmentLost();
      } catch (error) {
        assignmentFailed(error);
        throw error;
      }
    } else {
      expect(body).toEqual(assignmentCommand);
      await route.continue();
    }
  });
  await queue
    .getByRole("button", {
      name: "Refresh configured PM assignment",
      exact: true,
    })
    .click();
  await lostAssignment;
  await expect(
    queue.getByRole("button", {
      name: "Retry same assignment refresh",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Check milestone and request reconciliation",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(/Check outcome: CONFLICTING · REUSED/),
  ).toBeVisible();
  await queue
    .getByRole("button", { name: "Retry same assignment refresh", exact: true })
    .click();
  await expect.poll(() => assignmentCalls).toBe(2);
  await expect(queue.getByText(/Assignment revision 2:/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /acknowledge|approve|resolve|send/i }),
  ).toHaveCount(0);
});
test("GOLDEN-003 / AC-HLT-005: assigned PM opens retained Complete/Open proof, then source revocation withholds all of it", async ({
  page,
  request,
}) => {
  const f = await fixture(request),
    checked = await f.check();
  const link = `/?project=${f.projectId}&reconciliation=${checked.request.id}`;
  await signIn(page, "Project manager", link);
  const proof = page.getByRole("region", {
    name: "PM reconciliation request",
    exact: true,
  });
  await expect(proof.getByText(/CONFLICTING: a milestone/)).toBeVisible();
  await expect(proof.getByRole("article")).toHaveCount(4);
  await expect(
    proof.getByText("Value at capture: COMPLETE (text)", { exact: true }),
  ).toBeVisible();
  await expect(
    proof.getByText("Value at capture: OPEN (text)", { exact: true }),
  ).toHaveCount(3);
  await expect(proof.getByText(/Provenance: HUMAN_CONFIRMED/)).toHaveCount(4);
  await expect(proof.getByText(/Historical proof as of/)).toBeVisible();
  await page.screenshot({
    path: "artifacts/reconciliation-native-pm-proof.png",
    fullPage: true,
  });
  await f.share(f.bindings[3].entry.sourceId, ["pmo-portfolio"]);
  await proof
    .getByRole("button", { name: "Refresh request access", exact: true })
    .click();
  await expect(proof.getByText(/Proof withheld/)).toBeVisible();
  await expect(proof.getByRole("article")).toHaveCount(0);
  await f.share(f.bindings[3].entry.sourceId);
  await proof
    .getByRole("button", { name: "Refresh request access", exact: true })
    .click();
  await expect(proof.getByRole("article")).toHaveCount(4);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: /^Leadership / }).click();
  await expect(proof.getByRole("alert")).toBeVisible();
  await expect(proof.getByRole("article")).toHaveCount(0);
  expect((await f.api("pmo-portfolio", f.prefix + "/canonical")).status()).toBe(
    200,
  );
});
test("FR-EVD-009: project navigation discards saved request scope before another workspace mounts", async ({
  page,
  request,
}) => {
  const a = await fixture(request),
    b = await fixture(request),
    checked = await a.check();
  await signIn(
    page,
    "Project manager",
    `/?project=${a.projectId}&reconciliation=${checked.request.id}`,
  );
  await expect(
    page
      .getByRole("region", { name: "PM reconciliation request", exact: true })
      .getByRole("article"),
  ).toHaveCount(4);
  const unexpected: string[] = [];
  page.on("request", (r) => {
    if (
      r
        .url()
        .includes(
          `/projects/${b.projectId}/reconciliation-requests/${checked.request.id}`,
        )
    )
      unexpected.push(r.url());
  });
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Projects", exact: false })
    .click();
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: new RegExp(b.name) }).click();
  await expect(
    page.getByRole("heading", { name: b.name, exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Milestone to check", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: "PM reconciliation request",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
