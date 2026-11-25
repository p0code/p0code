interface DesktopInstanceApp {
  requestSingleInstanceLock(): boolean;
  exit(code: number): void;
  on(event: "second-instance", listener: () => void): unknown;
  emit(event: "activate"): boolean;
}

/** Acquire before migration, settings, or any backend/keychain work. */
export function claimDesktopInstance(app: DesktopInstanceApp): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return false;
  }
  // Reuse the lifecycle's activation handler (restore/focus or recreate the main window).
  // During early startup there is no window yet; normal startup will show it.
  app.on("second-instance", () => app.emit("activate"));
  return true;
}
