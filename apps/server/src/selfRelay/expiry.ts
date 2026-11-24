// @effect-diagnostics globalTimers:off -- Node sockets can outlive the maximum single timer delay.
export function atExpiry(expiresAt: number, now: () => number, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const remaining = expiresAt - now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(2_147_483_647, remaining));
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}
