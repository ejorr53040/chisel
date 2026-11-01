import { describe, expect, it } from "vitest";
import { cancelRun } from "../src/run";

describe("cancelRun", () => {
  it("aborts the current run only when the id names it", () => {
    const current = { id: "run-a", controller: new AbortController() };

    expect(cancelRun(current, "run-b")).toBe(false);
    expect(cancelRun(current, undefined)).toBe(false);
    expect(current.controller.signal.aborted).toBe(false);

    expect(cancelRun(current, "run-a")).toBe(true);
    expect(current.controller.signal.aborted).toBe(true);
  });

  it("aborts nothing when no run is going", () => {
    expect(cancelRun(null, "run-a")).toBe(false);
  });
});
