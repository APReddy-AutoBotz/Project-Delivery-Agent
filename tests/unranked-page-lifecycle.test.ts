import { expect, it, vi } from "vitest";
import { createUnrankedPageLifecycle } from "../apps/web/src/unranked-page-lifecycle.js";

function fixture(initial: DocumentVisibilityState = "visible") {
  let visibility = initial;
  const doc = new EventTarget(), win = new EventTarget();
  Object.defineProperty(doc, "visibilityState", { get: () => visibility });
  return { doc, win, lifecycle: createUnrankedPageLifecycle(doc as Document, win as Window),
    setVisibility: (value: DocumentVisibilityState) => { visibility = value; doc.dispatchEvent(new Event("visibilitychange")); } };
}

it("requires both page and freeze conditions to clear in either order", () => {
  for (const events of [["pagehide", "freeze", "resume", "pageshow"], ["freeze", "pagehide", "pageshow", "resume"]]) {
    const { doc, win, lifecycle } = fixture();
    const dispatch = (event: string) => (event === "freeze" || event === "resume" ? doc : win).dispatchEvent(new Event(event));
    expect(lifecycle.visible()).toBe(true);
    dispatch(events[0]!); dispatch(events[1]!); expect(lifecycle.visible()).toBe(false);
    dispatch(events[2]!); expect(lifecycle.visible()).toBe(false);
    dispatch(events[3]!); expect(lifecycle.visible()).toBe(true); lifecycle.dispose();
  }
});

it("retains suspension across subscriber replacement and honors document visibility", () => {
  const { doc, win, lifecycle, setVisibility } = fixture("hidden"), old = vi.fn(), next = vi.fn();
  expect(lifecycle.visible()).toBe(false); const unsubscribe = lifecycle.subscribe(old);
  win.dispatchEvent(new Event("pagehide")); doc.dispatchEvent(new Event("freeze")); unsubscribe();
  lifecycle.subscribe(next); setVisibility("visible"); doc.dispatchEvent(new Event("resume"));
  expect(lifecycle.visible()).toBe(false); expect(old).toHaveBeenCalledTimes(2);
  win.dispatchEvent(new Event("pageshow")); expect(lifecycle.visible()).toBe(true); expect(next).toHaveBeenLastCalledWith(true);
  lifecycle.dispose(); expect(next).toHaveBeenLastCalledWith(false);
  const calls = next.mock.calls.length; win.dispatchEvent(new Event("focus")); expect(next).toHaveBeenCalledTimes(calls); expect(lifecycle.visible()).toBe(false);
});
