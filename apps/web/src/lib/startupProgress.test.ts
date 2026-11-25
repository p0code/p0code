import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  __resetBootStartupProgressForTests,
  advanceStartupProgress,
  computeStartupStagePercent,
  createStartupProgress,
  formatStartupProgressLabel,
  getBootStartupProgress,
  normalizeDatabaseMigrationProgress,
  reportBootStage,
  reportServerStartupStatus,
  resolveClientStartupStage,
  resolveServerStartupProgress,
  syncBootShellDom,
  type ClientStartupReadinessInput,
} from "./startupProgress";

const baseReadiness: ClientStartupReadinessInput = {
  enabled: true,
  hostedStatic: false,
  hydrated: true,
  firstRunDecision: "app",
  catalogReady: true,
  enabledEnvironmentCount: 1,
  primaryEnvironmentDiscovered: true,
  primaryConnectionPhase: "connected",
  primaryServerConfigReady: true,
  primaryShellHasSnapshot: true,
  allShellsBootstrapped: true,
  startupTimedOut: false,
};

afterEach(() => {
  __resetBootStartupProgressForTests();
});

describe("computeStartupStagePercent", () => {
  it("maps each startup stage to its progress percentage", () => {
    expect(computeStartupStagePercent("starting-server")).toBe(15);
    expect(computeStartupStagePercent("updating-database")).toBe(35);
    expect(computeStartupStagePercent("connecting")).toBe(70);
    expect(computeStartupStagePercent("loading-threads")).toBe(90);
    expect(computeStartupStagePercent("ready")).toBe(100);
  });

  it("interpolates updating-database progress across reported migration counts", () => {
    expect(computeStartupStagePercent("updating-database", { current: 1, total: 3 })).toBe(35);
    expect(computeStartupStagePercent("updating-database", { current: 2, total: 3 })).toBe(45);
    expect(computeStartupStagePercent("updating-database", { current: 3, total: 3 })).toBe(55);
    expect(computeStartupStagePercent("updating-database", { current: 2, total: 7 })).toBe(34);
    expect(computeStartupStagePercent("updating-database", { current: 7, total: 7 })).toBe(55);
  });

  it("clamps overflowed migration counts and falls back when counts are invalid", () => {
    expect(normalizeDatabaseMigrationProgress({ current: 9, total: 5 })).toEqual({
      current: 5,
      total: 5,
    });
    expect(computeStartupStagePercent("updating-database", { current: 9, total: 5 })).toBe(55);
    expect(normalizeDatabaseMigrationProgress({ current: 0, total: 5 })).toBeNull();
    expect(normalizeDatabaseMigrationProgress({ current: 1, total: 0 })).toBeNull();
    expect(computeStartupStagePercent("updating-database", { current: 0, total: 5 })).toBe(35);
  });
});

describe("formatStartupProgressLabel", () => {
  it("formats short stage labels with and without migration counts", () => {
    expect(formatStartupProgressLabel(createStartupProgress("starting-server"))).toBe(
      "Starting server",
    );
    expect(formatStartupProgressLabel(createStartupProgress("updating-database"))).toBe(
      "Updating database",
    );
    expect(
      formatStartupProgressLabel(
        createStartupProgress("updating-database", { current: 2, total: 7 }),
      ),
    ).toBe("Updating database (2/7)");
    expect(formatStartupProgressLabel(createStartupProgress("connecting"))).toBe("Connecting");
    expect(formatStartupProgressLabel(createStartupProgress("loading-threads"))).toBe(
      "Loading threads",
    );
    expect(formatStartupProgressLabel(createStartupProgress("ready"))).toBe("Ready");
  });
});

describe("advanceStartupProgress", () => {
  it("advances monotonically across stages and migration steps without regressing", () => {
    const server = createStartupProgress("starting-server");
    const db1 = advanceStartupProgress(
      server,
      createStartupProgress("updating-database", { current: 1, total: 4 }),
    );
    expect(db1).toEqual({
      stage: "updating-database",
      percent: 33,
      migration: { current: 1, total: 4 },
    });

    const db3 = advanceStartupProgress(
      db1,
      createStartupProgress("updating-database", { current: 3, total: 4 }),
    );
    expect(db3).toEqual({
      stage: "updating-database",
      percent: 48,
      migration: { current: 3, total: 4 },
    });

    // Clearing migration status briefly before HTTP 200 does not jump backwards.
    expect(advanceStartupProgress(db3, createStartupProgress("starting-server"))).toBe(db3);
    // Out-of-order migration count does not regress.
    expect(
      advanceStartupProgress(
        db3,
        createStartupProgress("updating-database", { current: 2, total: 4 }),
      ),
    ).toBe(db3);
    // Identical state preserves reference identity.
    expect(
      advanceStartupProgress(
        db3,
        createStartupProgress("updating-database", { current: 3, total: 4 }),
      ),
    ).toBe(db3);

    const connecting = advanceStartupProgress(db3, createStartupProgress("connecting"));
    expect(connecting).toEqual({ stage: "connecting", percent: 70, migration: null });

    const loading = advanceStartupProgress(connecting, createStartupProgress("loading-threads"));
    expect(loading).toEqual({ stage: "loading-threads", percent: 90, migration: null });

    expect(advanceStartupProgress(loading, createStartupProgress("connecting"))).toBe(loading);

    const ready = advanceStartupProgress(loading, createStartupProgress("ready"));
    expect(ready).toEqual({ stage: "ready", percent: 100, migration: null });
  });
});

describe("resolveServerStartupProgress", () => {
  it("maps ServerStartupStatus payloads with and without migrations", () => {
    expect(resolveServerStartupProgress({ status: "starting", migration: null })).toEqual({
      stage: "starting-server",
      percent: 15,
      migration: null,
    });
    expect(
      resolveServerStartupProgress({ status: "starting", migration: { current: 2, total: 5 } }),
    ).toEqual({
      stage: "updating-database",
      percent: 37,
      migration: { current: 2, total: 5 },
    });
  });
});

describe("resolveClientStartupStage", () => {
  it("progresses from connecting to loading-threads to ready as readiness signals arrive", () => {
    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        primaryEnvironmentDiscovered: false,
        primaryConnectionPhase: null,
        primaryServerConfigReady: false,
        primaryShellHasSnapshot: false,
        allShellsBootstrapped: false,
      }),
    ).toBe("connecting");

    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        primaryConnectionPhase: "connecting",
        primaryServerConfigReady: false,
        primaryShellHasSnapshot: false,
        allShellsBootstrapped: false,
      }),
    ).toBe("connecting");

    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        primaryConnectionPhase: "connected",
        primaryServerConfigReady: true,
        primaryShellHasSnapshot: false,
        allShellsBootstrapped: false,
      }),
    ).toBe("loading-threads");

    expect(resolveClientStartupStage(baseReadiness)).toBe("ready");
  });

  it("stays in loading-threads while first-run gate is pending after connecting", () => {
    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        firstRunDecision: "pending",
      }),
    ).toBe("loading-threads");
  });

  it("releases when the connection settles offline or the startup safety timer expires", () => {
    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        primaryConnectionPhase: "offline",
        primaryServerConfigReady: false,
        primaryShellHasSnapshot: false,
        allShellsBootstrapped: true,
      }),
    ).toBe("ready");

    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        primaryEnvironmentDiscovered: false,
        primaryConnectionPhase: null,
        primaryServerConfigReady: false,
        primaryShellHasSnapshot: false,
        allShellsBootstrapped: false,
        startupTimedOut: true,
      }),
    ).toBe("ready");
  });

  it("handles hosted-static startup with and without environments", () => {
    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        enabled: false,
        hostedStatic: true,
        catalogReady: false,
        enabledEnvironmentCount: 0,
        allShellsBootstrapped: false,
      }),
    ).toBe("connecting");

    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        enabled: false,
        hostedStatic: true,
        catalogReady: true,
        enabledEnvironmentCount: 0,
        allShellsBootstrapped: false,
      }),
    ).toBe("ready");

    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        enabled: false,
        hostedStatic: true,
        catalogReady: true,
        enabledEnvironmentCount: 2,
        allShellsBootstrapped: false,
      }),
    ).toBe("loading-threads");

    expect(
      resolveClientStartupStage({
        ...baseReadiness,
        enabled: false,
        hostedStatic: true,
        catalogReady: true,
        enabledEnvironmentCount: 2,
        allShellsBootstrapped: true,
      }),
    ).toBe("ready");
  });
});

describe("boot startup progress store and DOM sync", () => {
  it("syncs aria-valuenow, aria-valuetext, bar fill width, and label into #boot-shell", () => {
    const attrs = new Map<string, string>();
    const bar = {
      setAttribute: (name: string, value: string) => {
        attrs.set(name, value);
      },
    };
    const fill = { style: { width: "" } };
    const status = { textContent: "" };
    const nodes: Record<string, unknown> = {
      "boot-shell-card": {},
      "boot-shell-bar": bar,
      "boot-shell-bar-fill": fill,
      "boot-shell-progress": status,
    };
    const fakeDoc = {
      getElementById: (id: string) => (nodes[id] ?? null) as HTMLElement | null,
    };

    const progress = createStartupProgress("updating-database", { current: 2, total: 4 });
    syncBootShellDom(progress, fakeDoc);

    expect(attrs.get("aria-valuenow")).toBe("40");
    expect(attrs.get("aria-valuetext")).toBe("Updating database (2/4)");
    expect(fill.style.width).toBe("40%");
    expect(status.textContent).toBe("Updating database (2/4)");

    // When #boot-error has replaced #boot-shell-card, DOM sync is a no-op.
    delete nodes["boot-shell-card"];
    syncBootShellDom(createStartupProgress("connecting"), fakeDoc);
    expect(attrs.get("aria-valuenow")).toBe("40");
    expect(status.textContent).toBe("Updating database (2/4)");
  });

  it("advances module boot state monotonically through reportServerStartupStatus and reportBootStage", () => {
    expect(getBootStartupProgress().stage).toBe("starting-server");
    reportServerStartupStatus({ status: "starting", migration: { current: 1, total: 2 } });
    expect(getBootStartupProgress()).toEqual({
      stage: "updating-database",
      percent: 40,
      migration: { current: 1, total: 2 },
    });
    reportServerStartupStatus({ status: "starting", migration: null });
    expect(getBootStartupProgress().stage).toBe("updating-database");
    reportBootStage("connecting");
    expect(getBootStartupProgress()).toEqual({
      stage: "connecting",
      percent: 70,
      migration: null,
    });
  });
});
