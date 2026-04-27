import { describe, it, expect, vi } from "vitest";
import { registerSkillsChangeListener, bumpSnapshotVersion } from "../src/refresh.js";

describe("registerSkillsChangeListener", () => {
  it("returns an unsubscribe function", () => {
    const listener = vi.fn();
    const unsubscribe = registerSkillsChangeListener(listener);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  it("calls listener when bumpSnapshotVersion is called", () => {
    const listener = vi.fn();
    const unsubscribe = registerSkillsChangeListener(listener);
    bumpSnapshotVersion();
    expect(listener).toHaveBeenCalledTimes(1);
    bumpSnapshotVersion();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    bumpSnapshotVersion();
    expect(listener).toHaveBeenCalledTimes(2); // unsubscribed, no more calls
  });
});
