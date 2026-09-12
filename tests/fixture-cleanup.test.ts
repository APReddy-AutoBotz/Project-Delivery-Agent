import { expect, it, vi } from "vitest";
import {
  runWithCleanup,
  drainAndClose,
} from "../scripts/acceptance/fixture-cleanup.mjs";

it("NFR-REL-001: closes only after all started operations settle", async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const close = vi.fn();
  const cleanup = drainAndClose([pending], [close]);
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  complete();
  await cleanup;
  expect(close).toHaveBeenCalledOnce();
});
it("NFR-REL-001: attempts every closer even when one throws synchronously", async () => {
  const error = new Error("close failed"),
    last = vi.fn();
  await expect(
    drainAndClose(
      [],
      [
        () => {
          throw error;
        },
        last,
      ],
    ),
  ).rejects.toMatchObject({ errors: [error] });
  expect(last).toHaveBeenCalledOnce();
});
it("NFR-REL-001: preserves both the primary and cleanup failures", async () => {
  const primary = new Error("operation failed"),
    cleanup = new Error("cleanup failed");
  await expect(
    runWithCleanup(
      () => {
        throw primary;
      },
      () => {
        throw cleanup;
      },
    ),
  ).rejects.toMatchObject({ errors: [primary, cleanup] });
});
it("NFR-REL-001: always cleans up and retains the original outcome", async () => {
  const cleanup = vi.fn();
  expect(await runWithCleanup(async () => 7, cleanup)).toBe(7);
  const error = new Error("primary");
  await expect(
    runWithCleanup(() => {
      throw error;
    }, cleanup),
  ).rejects.toBe(error);
  expect(cleanup).toHaveBeenCalledTimes(2);
});
