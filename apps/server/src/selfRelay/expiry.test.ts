import { expect, it, vi } from "vite-plus/test";
import { atExpiry } from "./expiry.ts";

it("re-arms long exposures until their true expiry and cancels on socket close", () => {
  vi.useFakeTimers();
  try {
    const start = Date.parse("2026-11-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const expired = vi.fn();
    const cancel = atExpiry(start + 30 * 86400_000, Date.now, expired);
    vi.advanceTimersByTime(2_147_483_647);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30 * 86400_000 - 2_147_483_647);
    expect(expired).toHaveBeenCalledOnce();
    cancel();
    const cancelEarly = atExpiry(start + 31 * 86400_000, Date.now, expired);
    cancelEarly();
    vi.advanceTimersByTime(86400_000);
    expect(expired).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
