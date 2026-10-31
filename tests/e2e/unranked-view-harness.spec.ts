import { expect, test } from "@playwright/test";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const result = (milestoneId: string, marker: number) => {
  const now = Date.now(), asOf = new Date(now).toISOString(), validUntil = new Date(now + 60000).toISOString();
  const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20), provenance: "HUMAN_CONFIRMED",
    effectiveAt: new Date(now - 1000).toISOString(), observedAt: new Date(now - 1000).toISOString(), versionValidUntil: validUntil });
  return { kind: "UNRANKED_NO_POLICY", projectId: id(1), milestoneId, bindingId: id(marker + 1), factId: id(marker + 2),
    factType: `canonical.state.${String(marker).padStart(32, "0")}`, asOf,
    positions: [{ state: "COMPLETE", supports: [support(marker + 10)] }, { state: "OPEN", supports: [support(marker + 11)] }] };
};

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }, testInfo) => {
  const base = new URL(testInfo.project.use.baseURL!);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname)) throw new Error("Synthetic harness requires loopback");
  const origin = base.origin;
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
});

test("unmounted view scopes an as-of observation and rejects invalid paths and oversized responses", async ({ page }) => {
  let requests = 0, oversized = false;
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/projects/**/leadership-unranked-state-reports", async (route) => {
    requests++;
    const milestone = new URL(route.request().url()).pathname.split("/").at(-2)!;
    if (oversized) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result(milestone, 100)) + " ".repeat(270000) });
    return route.fulfill({ json: result(milestone, milestone === id(2) ? 100 : 200), headers: { "Cache-Control": "no-store" } });
  });
  await page.goto("/test/unranked-harness.html");
  await page.getByRole("button", { name: "Check human milestone reports" }).click();
  await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
  await expect(page.getByText("Reports, access or policy may have changed", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Select B" }).click();
  await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Check human milestone reports" }).click();
  await expect(page.getByText(`Evidence ${id(220)}`, { exact: false })).toBeVisible();
  const before = requests; await page.getByRole("button", { name: "Select invalid" }).click();
  await expect(page.getByRole("button", { name: "Check human milestone reports" })).toHaveCount(0);
  await page.waitForTimeout(250); expect(requests).toBe(before);
  await page.getByRole("button", { name: "Select A" }).click(); oversized = true;
  await page.getByRole("button", { name: "Check human milestone reports" }).click();
  await expect(page.getByText("Milestone reports could not be established", { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.unrankedReadCanceled)).toBe(true);
  expect(await page.evaluate(() => window.unrankedReadBytes ?? 0)).toBeGreaterThan(262144);
  await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
});

test("a synthetic denial clears immediately while its full body drains", async ({ page }) => {
  const denial = "d".repeat(150000); let denied = false;
  await page.addInitScript(() => { window.unrankedHoldDenial = true; });
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/projects/**/leadership-unranked-state-reports", (route) => denied
    ? route.fulfill({ status: 403, contentType: "text/plain", body: denial })
    : route.fulfill({ json: result(id(2), 100), headers: { "Cache-Control": "no-store" } }));
  try {
    await page.goto("/test/unranked-harness.html"); await page.getByRole("button", { name: "Check human milestone reports" }).click();
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible(); denied = true;
    await page.getByRole("button", { name: "Check human milestone reports" }).click();
    await expect(page.getByText("Milestone reports could not be established", { exact: false })).toBeVisible();
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.unrankedDenialHeld)).toBe(true);
    expect(await page.evaluate(() => window.unrankedDenialComplete)).toBe(false);
    await page.evaluate(() => window.unrankedReleaseDenial?.());
    await expect.poll(() => page.evaluate(() => window.unrankedDenialComplete)).toBe(true);
    expect(await page.evaluate(() => window.unrankedDenialBytes)).toBe(denial.length);
    await expect.poll(() => page.evaluate(() => window.unrankedDenialSignalPresent)).toBe(true);
    expect(await page.evaluate(() => window.unrankedDenialAborted)).toBe(false);
  } finally { await page.evaluate(() => { window.unrankedHoldDenial = false; window.unrankedReleaseDenial?.(); }).catch(() => {}); }
});

test("an old abort-ignoring response cannot publish after a selection change", async ({ page }) => {
  let release!: () => void, entered!: () => void, settled!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), arrived = new Promise<void>((resolve) => { entered = resolve; });
  const finished = new Promise<void>((resolve) => { settled = resolve; });
  let requests = 0, held = false;
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/projects/**/leadership-unranked-state-reports", async (route) => {
    requests++; const milestone = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const isHeld = requests === 1;
    if (isHeld) { held = true; entered(); await gate; }
    try { await route.fulfill({ json: result(milestone, milestone === id(2) ? 100 : 200), headers: { "Cache-Control": "no-store" } }); }
    catch { /* Aborted request. */ } finally { if (isHeld) settled(); }
  });
  try {
    await page.goto("/test/unranked-harness.html");
    await page.evaluate(async (oldEvidence) => {
      window.unrankedOldSeen = false;
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.oldValue?.includes(oldEvidence) || record.target.textContent?.includes(oldEvidence) ||
              [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(oldEvidence))) window.unrankedOldSeen = true;
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      const canary = document.createElement("span"); canary.textContent = oldEvidence;
      document.body.append(canary); canary.remove(); await Promise.resolve();
      if (!window.unrankedOldSeen) throw new Error("Transient mutation observer canary failed");
      window.unrankedOldSeen = false;
    }, `Evidence ${id(120)}`);
    await page.getByRole("button", { name: "Toggle ignored abort" }).click();
    await page.getByRole("button", { name: "Check human milestone reports" }).click(); await arrived;
    await page.getByRole("button", { name: "Select B" }).click();
    await page.getByRole("button", { name: "Check human milestone reports" }).click();
    await expect(page.getByText("Milestone reports could not be established", { exact: false })).toBeVisible();
    expect(requests).toBe(1); release();
    await expect.poll(() => page.evaluate(() => window.unrankedHarnessBodies ?? [])).toContain(id(2));
    await expect.poll(() => page.evaluate(() => window.unrankedHarnessSettled ?? 0)).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => window.unrankedOldSeen)).toBe(false);
    await page.getByRole("button", { name: "Check human milestone reports" }).click();
    await expect(page.getByText(`Evidence ${id(220)}`, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText(`Evidence ${id(220)}`, { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => window.unrankedOldSeen)).toBe(false);
  } finally {
    release();
    try {
      if (held) {
        let complete = false; await Promise.race([finished.then(() => { complete = true; }), new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (!complete) throw new Error("Synthetic held route did not settle within cleanup bound");
      }
    } finally {
      let closed = false;
      await Promise.race([page.close({ runBeforeUnload: false }).then(() => { closed = true; }), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (!closed) throw new Error("Synthetic page did not close within cleanup bound");
    }
  }
});

test("pagehide and freeze stay in force across selection until both are restored", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/projects/**/leadership-unranked-state-reports", async (route) => {
    requests++; const milestone = new URL(route.request().url()).pathname.split("/").at(-2)!;
    return route.fulfill({ json: result(milestone, milestone === id(2) ? 100 : 200), headers: { "Cache-Control": "no-store" } });
  });
  await page.goto("/test/unranked-harness.html"); await page.getByRole("button", { name: "Check human milestone reports" }).click();
  await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); document.dispatchEvent(new Event("freeze")); });
  await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Select B" }).click(); const before = requests;
  await page.evaluate(() => { document.dispatchEvent(new Event("resume")); window.dispatchEvent(new Event("focus")); });
  await page.getByRole("button", { name: "Check human milestone reports" }).click(); await page.waitForTimeout(250); expect(requests).toBe(before);
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.getByRole("button", { name: "Check human milestone reports" }).click();
  await expect(page.getByText(`Evidence ${id(220)}`, { exact: false })).toBeVisible();
  await page.evaluate(() => { document.dispatchEvent(new Event("freeze")); window.dispatchEvent(new Event("pagehide")); });
  await expect(page.getByText(`Evidence ${id(220)}`, { exact: false })).toHaveCount(0);
  const hiddenCount = requests;
  await page.evaluate(() => { window.dispatchEvent(new Event("pageshow")); window.dispatchEvent(new Event("focus")); });
  await page.getByRole("button", { name: "Check human milestone reports" }).click(); await page.waitForTimeout(250); expect(requests).toBe(hiddenCount);
  await page.evaluate(() => document.dispatchEvent(new Event("resume")));
  await expect(page.getByText(`Evidence ${id(220)}`, { exact: false })).toBeVisible();
});

test("an old abort-ignoring response cannot publish after same-subject session renewal", async ({ page }) => {
  let release!: () => void, entered!: () => void, settled!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), arrived = new Promise<void>((resolve) => { entered = resolve; });
  const finished = new Promise<void>((resolve) => { settled = resolve; });
  let requests = 0, held = false;
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/projects/**/leadership-unranked-state-reports", async (route) => {
    requests++; const isHeld = requests === 1;
    if (isHeld) { held = true; entered(); await gate; }
    try { await route.fulfill({ json: result(id(2), isHeld ? 100 : 300), headers: { "Cache-Control": "no-store" } }); }
    catch { /* Aborted request. */ } finally { if (isHeld) settled(); }
  });
  try {
    await page.goto("/test/unranked-harness.html");
    await page.evaluate(async (oldEvidence) => {
      window.unrankedOldSeen = false;
      new MutationObserver((records) => {
        for (const record of records) if (record.oldValue?.includes(oldEvidence) || record.target.textContent?.includes(oldEvidence) ||
          [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(oldEvidence))) window.unrankedOldSeen = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      const canary = document.createElement("span"); canary.textContent = oldEvidence;
      document.body.append(canary); canary.remove(); await Promise.resolve();
      if (!window.unrankedOldSeen) throw new Error("Transient mutation observer canary failed"); window.unrankedOldSeen = false;
    }, `Evidence ${id(120)}`);
    await page.getByRole("button", { name: "Toggle ignored abort" }).click();
    await page.getByRole("button", { name: "Check human milestone reports" }).click(); await arrived;
    await page.getByRole("button", { name: "Renew session" }).click();
    await page.getByRole("button", { name: "Check human milestone reports" }).click();
    await expect(page.getByText("Milestone reports could not be established", { exact: false })).toBeVisible(); expect(requests).toBe(1);
    release(); await expect.poll(() => page.evaluate(() => window.unrankedHarnessBodies ?? [])).toContain(id(2));
    await expect.poll(() => page.evaluate(() => window.unrankedHarnessSettled ?? 0)).toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => window.unrankedOldSeen)).toBe(false);
    await page.getByRole("button", { name: "Check human milestone reports" }).click();
    await expect(page.getByText(`Evidence ${id(320)}`, { exact: false })).toBeVisible();
    expect(await page.evaluate(() => window.unrankedOldSeen)).toBe(false);
  } finally {
    release();
    try {
      if (held) {
        let complete = false; await Promise.race([finished.then(() => { complete = true; }), new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (!complete) throw new Error("Synthetic held route did not settle within cleanup bound");
      }
    } finally {
      let closed = false;
      await Promise.race([page.close({ runBeforeUnload: false }).then(() => { closed = true; }), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (!closed) throw new Error("Synthetic page did not close within cleanup bound");
    }
  }
});

for (const transition of ["selection round trip", "sign-out"] as const) {
  test(`an old response cannot publish after ${transition}`, async ({ page }) => {
    let release!: () => void, entered!: () => void, settled!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), arrived = new Promise<void>((resolve) => { entered = resolve; });
    const finished = new Promise<void>((resolve) => { settled = resolve; });
    let requests = 0, held = false;
    await page.route("**/api/**", (route) => route.abort());
    await page.route("**/api/projects/**/leadership-unranked-state-reports", async (route) => {
      requests++; const isHeld = requests === 1;
      if (isHeld) { held = true; entered(); await gate; }
      try { await route.fulfill({ json: result(id(2), isHeld ? 100 : 300), headers: { "Cache-Control": "no-store" } }); }
      catch { /* Aborted request. */ } finally { if (isHeld) settled(); }
    });
    try {
      await page.goto("/test/unranked-harness.html");
      await page.evaluate(async (oldEvidence) => {
        window.unrankedOldSeen = false;
        new MutationObserver((records) => {
          for (const record of records) if (record.oldValue?.includes(oldEvidence) || record.target.textContent?.includes(oldEvidence) ||
            [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(oldEvidence))) window.unrankedOldSeen = true;
        }).observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
        const canary = document.createElement("span"); canary.textContent = oldEvidence;
        document.body.append(canary); canary.remove(); await Promise.resolve();
        if (!window.unrankedOldSeen) throw new Error("Transient mutation observer canary failed"); window.unrankedOldSeen = false;
      }, `Evidence ${id(120)}`);
      await page.getByRole("button", { name: "Toggle ignored abort" }).click();
      await page.getByRole("button", { name: "Check human milestone reports" }).click(); await arrived;
      if (transition === "selection round trip") {
        await page.getByRole("button", { name: "Select B" }).click(); await page.getByRole("button", { name: "Select A" }).click();
        await page.getByRole("button", { name: "Check human milestone reports" }).click();
        await expect(page.getByText("Milestone reports could not be established", { exact: false })).toBeVisible();
      } else {
        await page.getByRole("button", { name: "Sign out" }).click();
        await expect(page.getByRole("button", { name: "Check human milestone reports" })).toHaveCount(0);
      }
      expect(requests).toBe(1); release(); await expect.poll(() => page.evaluate(() => window.unrankedHarnessBodies ?? [])).toContain(id(2));
      await expect.poll(() => page.evaluate(() => window.unrankedHarnessSettled ?? 0)).toBeGreaterThanOrEqual(1);
      expect(await page.evaluate(() => window.unrankedOldSeen)).toBe(false);
      if (transition === "sign-out") await page.getByRole("button", { name: "Renew session" }).click();
      await page.getByRole("button", { name: "Check human milestone reports" }).click();
      await expect(page.getByText(`Evidence ${id(320)}`, { exact: false })).toBeVisible();
      expect(await page.evaluate(() => window.unrankedOldSeen)).toBe(false);
    } finally {
      release();
      try {
        if (held) {
          let complete = false; await Promise.race([finished.then(() => { complete = true; }), new Promise((resolve) => setTimeout(resolve, 3000))]);
          if (!complete) throw new Error("Synthetic held route did not settle within cleanup bound");
        }
      } finally {
        let closed = false;
        await Promise.race([page.close({ runBeforeUnload: false }).then(() => { closed = true; }), new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (!closed) throw new Error("Synthetic page did not close within cleanup bound");
      }
    }
  });
}

test("initially hidden and disposed lifecycle cannot start or retain observations", async ({ page }) => {
  let requests = 0;
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (window as unknown as { testVisible?: boolean }).testVisible ? "visible" : "hidden" });
  });
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/projects/**/leadership-unranked-state-reports", async (route) => {
    requests++; return route.fulfill({ json: result(id(2), 100), headers: { "Cache-Control": "no-store" } });
  });
  await page.goto("/test/unranked-harness.html"); await page.getByRole("button", { name: "Check human milestone reports" }).click();
  await page.waitForTimeout(250); expect(requests).toBe(0);
  await page.evaluate(() => { (window as unknown as { testVisible?: boolean }).testVisible = true; document.dispatchEvent(new Event("visibilitychange")); });
  await page.getByRole("button", { name: "Check human milestone reports" }).click();
  await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Dispose lifecycle" }).click();
  await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
  const before = requests; await page.getByRole("button", { name: "Check human milestone reports" }).click();
  await page.waitForTimeout(250); expect(requests).toBe(before);
});
