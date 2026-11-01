import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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
    canonical,
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
type PositiveCapture = { done: boolean; failed: boolean; bytes: number[]; status: number; readers: number; afterClick: boolean };
type PositiveState = { __positiveCapture: Record<string, PositiveCapture>; __restorePositiveFetch: () => void; __originalPositiveFetch: typeof fetch };

async function installPositiveCapture(page: Page, targetPath: string) {
  await page.evaluate((pathname) => {
    type Capture = { done: boolean; failed: boolean; bytes: number[]; status: number; readers: number; afterClick: boolean };
    const state = window as unknown as { __positiveCapture: Record<string, Capture>; __restorePositiveFetch: () => void };
    const records: Record<string, Capture> = Object.create(null);
    state.__positiveCapture = records;
    const original = window.fetch;
    let active = true, clicked = false;
    const markClick = (event: Event) => {
      if (event.composedPath().some((element) => element instanceof HTMLButtonElement && element.textContent?.trim() === "Check question")) clicked = true;
    };
    document.addEventListener("click", markClick, true);
    window.fetch = async (...args) => {
      const method = (args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET")).toUpperCase();
      const afterClick = clicked;
      const response = await original(...args);
      let url: URL;
      try { url = new URL(response.url); } catch { return response; }
      if (active && method === "GET" && url.origin === location.origin && url.pathname === pathname && response.status === 200 && response.body) {
        const requestId = response.headers.get("x-request-id") ?? "";
        const existing = records[requestId];
        if (!existing && Object.keys(records).length >= 16) return response;
        const capture = existing ?? { done: false, failed: !requestId, bytes: [], status: response.status, readers: 0, afterClick };
        if (existing) capture.failed = true;
        records[requestId] = capture;
        const stream = response.body, getReader = stream.getReader.bind(stream);
        stream.getReader = (() => {
          if (++capture.readers !== 1) capture.failed = true;
          const reader = getReader(), read = reader.read.bind(reader);
          reader.read = async () => {
            try {
              const part = await read();
              if (part.done) capture.done = true;
              else if (capture.bytes.length + part.value.length > 262144) capture.failed = true;
              else for (const byte of part.value) capture.bytes.push(byte);
              return part;
            } catch (error) { capture.failed = true; throw error; }
          };
          return reader;
        }) as typeof stream.getReader;
      }
      return response;
    };
    state.__restorePositiveFetch = () => { active = false; document.removeEventListener("click", markClick, true); window.fetch = original; };
  }, targetPath);
}

test("synthetic positive stream observer follows the page reader and fails closed on overflow", async ({ page }) => {
  const requestId = "10000000-0000-4000-8000-000000000097";
  const overflowId = "10000000-0000-4000-8000-000000000096";
  const value = JSON.stringify({ value: "synthetic-stream-canary" });
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<button>Check question</button><output></output><script>
        document.querySelector('button').onclick = async () => {
          const response = await fetch('/observation'), reader = response.body.getReader(), chunks = [];
          try { for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(...part.value); } }
          finally { reader.releaseLock(); }
          document.querySelector('output').textContent = new TextDecoder().decode(Uint8Array.from(chunks));
        };
      </script>`);
    } else if (request.url === "/observation" || request.url === "/observation?overflow=1") {
      const overflow = request.url.includes("overflow=1");
      response.writeHead(200, { "content-type": "application/json", "x-request-id": overflow ? overflowId : requestId });
      if (overflow) response.end("x".repeat(262145));
      else { response.write(value.slice(0, 8)); response.end(value.slice(8)); }
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.evaluate(() => { (window as unknown as PositiveState).__originalPositiveFetch = window.fetch; });
    await installPositiveCapture(page, "/observation");
    try {
      const observed = page.waitForResponse((response) => response.url() === `http://127.0.0.1:${address.port}/observation`);
      void observed.catch(() => {});
      await page.getByRole("button", { name: "Check question" }).click();
      const response = await observed;
      expect(response.status()).toBe(200);
      expect(await response.headerValue("x-request-id")).toBe(requestId);
      await expect.poll(() => page.evaluate((id) => (window as unknown as PositiveState).__positiveCapture[id]?.done === true, requestId)).toBe(true);
      const capture = await page.evaluate((id) => (window as unknown as PositiveState).__positiveCapture[id], requestId) as
        { done: boolean; failed: boolean; bytes: number[]; status: number; readers: number; afterClick: boolean };
      expect(capture).toMatchObject({ done: true, failed: false, status: 200, readers: 1, afterClick: true });
      expect(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(capture.bytes))).toBe(value);
      await expect(page.locator("output")).toHaveText(value);
      await page.evaluate(async () => {
        const response = await fetch("/observation?overflow=1"), reader = response.body!.getReader();
        try { while (!(await reader.read()).done) { /* Exercise the bounded observer. */ } }
        finally { reader.releaseLock(); }
      });
      const overflow = await page.evaluate((id) => (window as unknown as PositiveState).__positiveCapture[id], overflowId) as
        { done: boolean; failed: boolean; bytes: number[]; readers: number };
      expect(overflow).toMatchObject({ done: true, failed: true, readers: 1 });
      expect(overflow.bytes.length).toBeLessThanOrEqual(262144);
    } finally {
      await page.evaluate(() => { const state = window as unknown as Partial<PositiveState>; state.__restorePositiveFetch!(); delete state.__restorePositiveFetch; delete state.__positiveCapture; });
    }
    expect(await page.evaluate(() => window.fetch === (window as unknown as PositiveState).__originalPositiveFetch)).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("FR-QA-007 / FR-HLT-009: leadership sees the PM's synthetic positions until its source-reader access is removed", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  for (const binding of f.bindings)
    await f.share(binding.entry.sourceId, ["pmo-portfolio", "pm-atlas", "leader-atlas"]);
  const checked = await f.check();
  expect(checked.request.assignment.recipientSubject).toBe("pm-atlas");
  await signIn(page, "Project manager", `/?project=${f.projectId}&reconciliation=${checked.request.id}`);
  const proof = page.getByRole("region", { name: "PM reconciliation request", exact: true });
  await expect(proof.getByRole("article")).toHaveCount(4);
  await expect(proof.getByText("Value at capture: COMPLETE (text)", { exact: true })).toHaveCount(1);
  await expect(proof.getByText("Value at capture: OPEN (text)", { exact: true })).toHaveCount(3);
  for (const binding of f.bindings) {
    const article = proof.getByRole("article", { name: `${binding.targetKind} evidence ${binding.targetId}`, exact: true });
    await expect(article).toBeVisible();
    await expect(article.getByText(`Value at capture: ${binding.targetKind === "MILESTONE" ? "COMPLETE" : "OPEN"} (text)`, { exact: true })).toBeVisible();
    await article.getByText("Retained evidence references", { exact: true }).click();
    await expect(article.getByText(`Version: ${binding.entry.id}`, { exact: true })).toBeVisible();
    await expect(article.getByText(`Evidence: ${binding.entry.evidenceId}`, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();

  await signIn(page, "Leadership");
  await page.getByRole("button", { name: new RegExp(f.name) }).click();
  const answer = page.getByRole("region", { name: "Ask about milestone completion" });
  await answer.getByLabel("Milestone", { exact: true }).selectOption(f.milestoneId);
  await answer.getByLabel("Question", { exact: true }).fill("Does the selected milestone's recorded completion conflict with required work?");
  // Observe the bounded stream actually consumed by the page, rather than relying
  // on Chromium retaining a second copy in its DevTools network buffer.
  await installPositiveCapture(page, `/api${f.prefix}/milestones/${f.milestoneId}/leadership-conflict-observation`);
  let body!: { outcome: string; positions: Array<{ bindingId: string; state: string; supports: unknown }> };
  try {
    const canaryId = "10000000-0000-4000-8000-000000000098", canary = "synthetic-positive-stream-canary";
    const canaryPath = `/api${f.prefix}/milestones/${f.milestoneId}/leadership-conflict-observation?positive-capture-canary=1`;
    const canaryUrl = `**${canaryPath}`;
    await page.route(canaryUrl, (route) => route.fulfill({ status: 200,
      headers: { "content-type": "text/plain", "x-request-id": canaryId }, body: canary }));
    try {
      await page.evaluate(async (path) => {
        const response = await fetch(path), reader = response.body!.getReader();
        try { while (!(await reader.read()).done) { /* Exercise the same observer. */ } }
        finally { reader.releaseLock(); }
      }, canaryPath);
      const probe = await page.evaluate((id) => (window as unknown as PositiveState).__positiveCapture[id], canaryId) as
        { done: boolean; failed: boolean; bytes: number[]; status: number; readers: number; afterClick: boolean };
      expect(probe).toMatchObject({ done: true, failed: false, status: 200, readers: 1, afterClick: false });
      expect(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(probe.bytes))).toBe(canary);
    } finally { await page.unroute(canaryUrl); }
    const expectedUrl = new URL(`/api${f.prefix}/milestones/${f.milestoneId}/leadership-conflict-observation`, page.url());
    const observed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === expectedUrl.origin && url.pathname === expectedUrl.pathname && !url.search && response.request().method() === "GET";
    });
    void observed.catch(() => {});
    await answer.getByRole("button", { name: "Check question", exact: true }).click();
    const response = await observed;
    expect(response.status()).toBe(200);
    const requestId = await response.headerValue("x-request-id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(requestId).not.toBe(canaryId);
    await expect.poll(() => page.evaluate((id) => (window as unknown as PositiveState).__positiveCapture[id!]?.done === true, requestId)).toBe(true);
    const captured = await page.evaluate((id) => (window as unknown as PositiveState).__positiveCapture[id!], requestId) as
      { done: boolean; failed: boolean; bytes: number[]; status: number; readers: number; afterClick: boolean };
    expect(captured).toMatchObject({ done: true, failed: false, status: 200, readers: 1, afterClick: true });
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(captured.bytes)));
  } finally {
    await page.evaluate(() => { const state = window as unknown as Partial<PositiveState>; state.__restorePositiveFetch!(); delete state.__restorePositiveFetch; delete state.__positiveCapture; });
  }
  expect(body.outcome).toBe("CONFLICTING"); expect(body.positions).toHaveLength(4);
  expect(body.positions.filter((position: { state: string }) => position.state === "COMPLETE")).toHaveLength(1);
  expect(body.positions.filter((position: { state: string }) => position.state === "OPEN")).toHaveLength(3);
  for (const binding of f.bindings) {
    const position = body.positions.find((item: { bindingId: string }) => item.bindingId === binding.id);
    if (!position) throw new Error("Expected milestone observation position is missing");
    expect(position).toMatchObject({ targetKind: binding.targetKind, targetId: binding.targetId,
      factId: binding.factId, factType: binding.factType,
      state: binding.targetKind === "MILESTONE" ? "COMPLETE" : "OPEN" });
    expect(position.supports).toMatchObject([{ versionId: binding.entry.id, evidenceId: binding.entry.evidenceId,
      sourceId: binding.entry.sourceId, provenance: "HUMAN_CONFIRMED" }]);
    const row = answer.locator(".canonical-review-row").filter({ hasText: binding.entry.evidenceId });
    const entity = binding.targetKind === "MILESTONE"
      ? f.canonical.milestones.find((item: { id: string }) => item.id === binding.targetId)
      : f.canonical.workItems.find((item: { id: string }) => item.id === binding.targetId);
    expect(entity).toBeDefined();
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`${entity.key} · ${binding.targetKind === "MILESTONE" ? "Milestone · COMPLETE" : "Required work item · OPEN"}`);
    await expect(row).toContainText(`Evidence ${binding.entry.evidenceId} · version ${binding.entry.id} · source ${binding.entry.sourceId}`);
    await expect(row).toContainText("stored provenance: HUMAN CONFIRMED");
  }
  await expect(answer.getByText(/Completion is not established/)).toBeVisible();
  await expect(answer.getByText(/This result does not create a reconciliation request/)).toBeVisible();
  await expect(answer.locator(".canonical-review-row")).toHaveCount(4);

  await f.share(f.bindings[3].entry.sourceId, ["pmo-portfolio", "pm-atlas"]);
  // Observe the same stream consumed by the page, rather than depending on
  // Chromium retaining its response in the DevTools network buffer.
  await page.evaluate((pathname) => {
    type Capture = { done: boolean; failed: boolean; bytes: number[]; status: number; readers: number; afterClick: boolean };
    const state = window as unknown as { __denialCapture: Record<string, Capture>; __restoreFetch: () => void };
    const records: Record<string, Capture> = Object.create(null);
    state.__denialCapture = records;
    const original = window.fetch;
    let active = true, clicked = false;
    const markClick = (event: Event) => {
      if (event.composedPath().some((element) => element instanceof HTMLButtonElement && element.textContent?.trim() === "Refresh completion check")) clicked = true;
    };
    document.addEventListener("click", markClick, true);
    window.fetch = async (...args) => {
      const method = (args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET")).toUpperCase();
      const afterClick = clicked;
      const response = await original(...args);
      let url: URL;
      try { url = new URL(response.url); } catch { return response; }
      if (active && method === "GET" && url.origin === location.origin && url.pathname === pathname && response.status === 503 && response.body) {
        const requestId = response.headers.get("x-request-id") ?? "";
        const existing = records[requestId];
        const capture = existing ?? { done: false, failed: !requestId, bytes: [], status: response.status, readers: 0, afterClick };
        if (existing) capture.failed = true;
        records[requestId] = capture;
        const stream = response.body, getReader = stream.getReader.bind(stream);
        stream.getReader = (() => {
          if (++capture.readers !== 1) capture.failed = true;
          const reader = getReader(), read = reader.read.bind(reader);
          reader.read = async () => {
            try {
              const part = await read();
              if (part.done) capture.done = true;
              else if (capture.bytes.length + part.value.length > 65536) capture.failed = true;
              else for (const byte of part.value) capture.bytes.push(byte);
              return part;
            } catch (error) { capture.failed = true; throw error; }
          };
          return reader;
        }) as typeof stream.getReader;
      }
      return response;
    };
    state.__restoreFetch = () => { active = false; document.removeEventListener("click", markClick, true); window.fetch = original; };
  }, `/api${f.prefix}/milestones/${f.milestoneId}/leadership-conflict-observation`);
  try {
    const canaryId = "10000000-0000-4000-8000-000000000099", canary = "synthetic-hidden-evidence-canary";
    const canaryPath = `/api${f.prefix}/milestones/${f.milestoneId}/leadership-conflict-observation?capture-canary=1`;
    const canaryUrl = `**${canaryPath}`;
    await page.route(canaryUrl, (route) => route.fulfill({ status: 503,
      headers: { "content-type": "text/plain", "x-request-id": canaryId }, body: canary }));
    try {
      await page.evaluate(async (path) => {
        const response = await fetch(path), reader = response.body!.getReader();
        try { while (!(await reader.read()).done) { /* Exercise the same observer. */ } }
        finally { reader.releaseLock(); }
      }, canaryPath);
      const probe = await page.evaluate((id) => (window as any).__denialCapture[id], canaryId) as
        { done: boolean; failed: boolean; bytes: number[]; status: number; readers: number };
      expect(probe).toMatchObject({ done: true, failed: false, status: 503, readers: 1 });
      const probeText = new TextDecoder().decode(Uint8Array.from(probe.bytes));
      expect(probeText).toBe(canary);
      expect(() => expect(probeText).not.toContain(canary)).toThrow();
    } finally { await page.unroute(canaryUrl); }
    const denied = page.waitForResponse((item) =>
      item.url().endsWith(`/milestones/${f.milestoneId}/leadership-conflict-observation`) && item.request().method() === "GET");
    await answer.getByRole("button", { name: "Refresh completion check", exact: true }).click();
    const deniedResponse = await denied;
    expect(deniedResponse.status()).toBe(503);
    const requestId = await deniedResponse.headerValue("x-request-id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    await expect.poll(() => page.evaluate((id) => (window as any).__denialCapture[id!]?.done === true, requestId)).toBe(true);
    const captured = await page.evaluate((id) => (window as any).__denialCapture[id!], requestId) as
      { done: boolean; failed: boolean; bytes: number[]; status: number; readers: number; afterClick: boolean };
    expect(captured).toMatchObject({ done: true, failed: false, status: 503, readers: 1, afterClick: true });
    const deniedBody = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(captured.bytes));
    expect(JSON.parse(deniedBody)).toEqual({ statusCode: 503, message: "Service unavailable" });
    for (const binding of f.bindings) {
      expect(deniedBody).not.toContain(binding.entry.evidenceId);
      expect(deniedBody).not.toContain(binding.entry.sourceId);
    }
  } finally {
    await page.evaluate(() => { const state = window as any; state.__restoreFetch(); delete state.__restoreFetch; delete state.__denialCapture; });
  }
  await expect(answer.getByText(/Completion check is unavailable/)).toBeVisible();
  await expect(answer.locator(".canonical-review-row")).toHaveCount(0);
  const retained = await f.api("pm-atlas", `${f.prefix}/reconciliation-requests/${checked.request.id}`);
  expect(retained.status()).toBe(200);
  const delivered = await retained.json();
  expect(delivered).toMatchObject({ request: { id: checked.request.id, state: "OPEN",
    assignment: { recipientSubject: "pm-atlas" } }, assessment: { visibility: "available",
    revalidationRequired: false, result: { status: "CONFLICTING" } } });
  expect(delivered.assessment.result.contributors).toHaveLength(4);
  for (const binding of f.bindings) {
    const contributor = delivered.assessment.result.contributors.find((item: { bindingId: string }) => item.bindingId === binding.id);
    expect(contributor).toMatchObject({ targetKind: binding.targetKind, targetId: binding.targetId,
      factId: binding.factId, supportingVersionIds: [binding.entry.id], supportingEvidenceIds: [binding.entry.evidenceId] });
  }
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
