import { CatalogRecovery } from "./CatalogRecovery";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionPhase,
} from "@t3tools/client-runtime/connection";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  ensureClientSettingsHydrated,
  useClientSettings,
  useClientSettingsHydrationStatus,
} from "../../hooks/useSettings";
import {
  advanceStartupProgress,
  createStartupProgress,
  getBootStartupProgress,
  resolveClientStartupStage,
  type StartupProgressSnapshot,
} from "../../lib/startupProgress";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  isFirstRunWorkspaceProvenanceAuthoritative,
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  resolveHostedFirstRunDecision,
  transitionFirstRunGateState,
  type FirstRunGateState,
} from "../../onboarding/firstRun.logic";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentProjects } from "../../state/projects";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { StartupLoadingScreen } from "../StartupLoadingScreen";
import { Button } from "../ui/button";

/** Pending blocks all rendering, including EventRouter welcome navigation. */

const FIRST_RUN_DECISION_TIMEOUT_MS = 4_000;
const STARTUP_LOADING_TIMEOUT_MS = 6_000;

interface StartupReadinessSnapshot {
  readonly enabledEnvironmentCount: number;
  readonly primaryEnvironmentDiscovered: boolean;
  readonly primaryConnectionPhase: SupervisorConnectionPhase | null;
  readonly primaryShellHasSnapshot: boolean;
}

const SETTLED_STARTUP_READINESS: StartupReadinessSnapshot = {
  enabledEnvironmentCount: 0,
  primaryEnvironmentDiscovered: true,
  primaryConnectionPhase: "connected",
  primaryShellHasSnapshot: true,
};

const SETTLED_STARTUP_READINESS_ATOM = Atom.make(SETTLED_STARTUP_READINESS).pipe(
  Atom.withLabel("web-onboarding-settled-startup-readiness"),
);

let previousStartupReadiness: StartupReadinessSnapshot | null = null;

const primaryStartupReadinessAtom = Atom.make((get): StartupReadinessSnapshot => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const enabledEnvironmentCount = [...enabledEnvironmentIds(catalog)].length;
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  let next: StartupReadinessSnapshot;
  if (primaryEnvironmentId === null) {
    next = {
      enabledEnvironmentCount,
      primaryEnvironmentDiscovered: false,
      primaryConnectionPhase: null,
      primaryShellHasSnapshot: false,
    };
  } else {
    const connection = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(primaryEnvironmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    const shell = get(environmentShell.stateValueAtom(primaryEnvironmentId));
    next = {
      enabledEnvironmentCount,
      primaryEnvironmentDiscovered: true,
      primaryConnectionPhase: connection.phase,
      primaryShellHasSnapshot: Option.isSome(shell.snapshot),
    };
  }
  if (
    previousStartupReadiness !== null &&
    previousStartupReadiness.enabledEnvironmentCount === next.enabledEnvironmentCount &&
    previousStartupReadiness.primaryEnvironmentDiscovered === next.primaryEnvironmentDiscovered &&
    previousStartupReadiness.primaryConnectionPhase === next.primaryConnectionPhase &&
    previousStartupReadiness.primaryShellHasSnapshot === next.primaryShellHasSnapshot
  ) {
    return previousStartupReadiness;
  }
  previousStartupReadiness = next;
  return next;
}).pipe(Atom.withLabel("web-onboarding-primary-startup-readiness"));

const primaryShellLiveAtom = Atom.make((get) => {
  const serverConfig = get(primaryServerConfigAtom);
  return (
    serverConfig !== null &&
    get(environmentShell.stateValueAtom(serverConfig.environment.environmentId)).status === "live"
  );
}).pipe(Atom.withLabel("web-onboarding-primary-shell-live"));

const workspaceEvidenceLiveAtom = Atom.make((get) => {
  const environmentIds = new Set([
    ...get(environmentProjects.projectsAtom).map((project) => project.environmentId),
    ...get(environmentThreadShells.threadShellsAtom).map((thread) => thread.environmentId),
  ]);

  for (const environmentId of environmentIds) {
    if (get(environmentShell.stateValueAtom(environmentId)).status !== "live") {
      return false;
    }
  }

  return true;
}).pipe(Atom.withLabel("web-onboarding-workspace-evidence-live"));

// Subscribe only to thread count and the sole thread so populated-workspace shell updates cannot rerender the
// app root.
const threadCountAtom = Atom.make(
  (get) => get(environmentThreadShells.threadShellsAtom).length,
).pipe(Atom.withLabel("web-onboarding-thread-count"));

const soleThreadAtom = Atom.make((get) => {
  const threads = get(environmentThreadShells.threadShellsAtom);
  return threads.length === 1 ? threads[0]! : null;
}).pipe(Atom.withLabel("web-onboarding-sole-thread"));

export function FirstRunGate({
  enabled,
  hostedStatic,
  children,
}: {
  readonly enabled: boolean;
  readonly hostedStatic: boolean;
  readonly children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hydrationStatus = useClientSettingsHydrationStatus();
  const hydrated = hydrationStatus === "ready";
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { isReady: environmentCatalogReady } = useEnvironments();
  const catalogError = useAtomValue(environmentCatalog.catalogValueAtom).catalogError;
  const [catalogRecoveryDismissed, setCatalogRecoveryDismissed] = useState(false);
  const projects = useProjects();
  const threadCount = useAtomValue(threadCountAtom);
  const soleThread = useAtomValue(soleThreadAtom);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const primaryShellLive = useAtomValue(primaryShellLiveAtom);
  const workspaceEvidenceLive = useAtomValue(workspaceEvidenceLiveAtom);
  const [gateState, setGateState] = useState<FirstRunGateState>(() => ({
    decision:
      (!enabled && !hostedStatic) || (hydrated && onboardingCompletedAt !== null)
        ? "app"
        : "pending",
    stalled: false,
  }));
  const [startupSettled, setStartupSettled] = useState(() => !enabled && !hostedStatic);
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  const [startupProgress, setStartupProgress] = useState<StartupProgressSnapshot>(() =>
    getBootStartupProgress(),
  );
  const startupReadiness = useAtomValue(
    startupSettled ? SETTLED_STARTUP_READINESS_ATOM : primaryStartupReadinessAtom,
  );
  const { decision, stalled } = gateState;
  const settingsReadFailed = hydrationStatus === "failed" || hydrationStatus === "retrying";
  // The server's sole cwd-bootstrap project/thread still counts as fresh so npx p0 users see onboarding.
  const serverCwd = serverConfig?.cwd ?? null;
  const primaryEnvironmentId = serverConfig?.environment.environmentId ?? null;
  const workspaceFresh =
    threadCount <= 1 &&
    isFreshFirstRunWorkspace({
      primaryEnvironmentId,
      serverCwd,
      bootstrapProjectId: serverWelcome?.bootstrapProjectId,
      bootstrapThreadId: serverWelcome?.bootstrapThreadId,
      bootstrapProjectCreated: serverWelcome?.bootstrapProjectCreated,
      bootstrapThreadCreated: serverWelcome?.bootstrapThreadCreated,
      projects,
      threads: soleThread === null ? [] : [soleThread],
    });

  const { decision: nextDecision, persistCompletion } = hostedStatic
    ? resolveHostedFirstRunDecision(hydrated)
    : resolveFirstRunDecision({
        enabled,
        hydrated,
        completed: onboardingCompletedAt !== null,
        bootstrapped,
        authoritative: primaryShellLive,
        workspaceAuthoritative: workspaceEvidenceLive,
        workspaceProvenanceAuthoritative: isFirstRunWorkspaceProvenanceAuthoritative({
          welcomeReceived: serverWelcome !== null,
          bootstrapStatus: serverWelcome?.bootstrapStatus ?? null,
        }),
        catalogReady: environmentCatalogReady,
        serverConfigAvailable: serverConfig !== null,
        workspaceFresh,
        projectCount: projects.length,
        threadCount,
      });

  if (hydrated) {
    const transitioned = transitionFirstRunGateState(gateState, {
      type: "evidence",
      decision: nextDecision,
    });
    if (transitioned !== gateState) setGateState(transitioned);
  }

  const liveStartupStage = startupSettled
    ? "ready"
    : resolveClientStartupStage({
        enabled,
        hostedStatic,
        hydrated,
        firstRunDecision: decision,
        catalogReady: environmentCatalogReady,
        enabledEnvironmentCount: startupReadiness.enabledEnvironmentCount,
        primaryEnvironmentDiscovered: startupReadiness.primaryEnvironmentDiscovered,
        primaryConnectionPhase: startupReadiness.primaryConnectionPhase,
        primaryServerConfigReady: serverConfig !== null,
        primaryShellHasSnapshot: startupReadiness.primaryShellHasSnapshot,
        allShellsBootstrapped: bootstrapped,
        startupTimedOut,
      });

  const displayProgress =
    liveStartupStage === "ready"
      ? startupProgress
      : advanceStartupProgress(startupProgress, createStartupProgress(liveStartupStage));

  if (!startupSettled && liveStartupStage === "ready") {
    setStartupSettled(true);
  } else if (!startupSettled && displayProgress !== startupProgress) {
    setStartupProgress(displayProgress);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists onboarding completion to settings once the gate settles on skipping the wizard
  useEffect(() => {
    if (decision === "wizard" || !hydrated) return;
    if (persistCompletion && onboardingCompletedAt === null) {
      void completeOnboarding().catch(() => undefined);
    }
  }, [decision, hydrated, onboardingCompletedAt, persistCompletion]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer gives up on a pending first-run decision after the timeout
  useEffect(() => {
    if (!enabled || decision !== "pending" || !hydrated) return;
    const timer = window.setTimeout(
      () => setGateState((state) => transitionFirstRunGateState(state, { type: "timeout" })),
      FIRST_RUN_DECISION_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [decision, enabled, hydrated]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer releases the startup loading screen if primary discovery stalls after auth
  useEffect(() => {
    if (startupSettled || startupTimedOut || decision !== "app") return;
    const timer = window.setTimeout(() => setStartupTimedOut(true), STARTUP_LOADING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [decision, startupSettled, startupTimedOut]);

  // Setup opens by itself only from the home route. A direct link, such as
  // Settings, opens as asked so setup can never lock a user out of the app.
  const wizardOwnsRoute = pathname === "/";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates from the home route to /welcome when the gate decides on the wizard
  useEffect(() => {
    if (decision === "wizard" && wizardOwnsRoute) {
      void navigate({ to: "/welcome", replace: true });
    }
  }, [decision, navigate, wizardOwnsRoute]);

  if (catalogError && !catalogRecoveryDismissed) {
    return (
      <CatalogRecovery error={catalogError} onContinue={() => setCatalogRecoveryDismissed(true)} />
    );
  }
  if (settingsReadFailed) {
    return <FirstRunRecovery reason="settings" retrying={hydrationStatus === "retrying"} />;
  }
  if (decision === "wizard" && !wizardOwnsRoute) {
    return children;
  }
  if (decision !== "app") {
    return stalled ? (
      <FirstRunRecovery reason="connection" />
    ) : (
      <StartupLoadingScreen progress={displayProgress} />
    );
  }
  if (!startupSettled && liveStartupStage !== "ready") {
    return <StartupLoadingScreen progress={displayProgress} />;
  }
  return children;
}

function FirstRunRecovery({
  reason,
  retrying = false,
}: {
  readonly reason: "settings" | "connection";
  readonly retrying?: boolean;
}) {
  const settingsReadFailed = reason === "settings";
  const gt = useGT();
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center text-center">
        <h1 className="text-lg font-semibold">
          {settingsReadFailed ? gt("Could not read settings") : gt("Still connecting")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {settingsReadFailed
            ? gt("Your saved settings could not be loaded.")
            : gt("p0code could not confirm this workspace.")}
        </p>
        <Button
          className="mt-5"
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={() => {
            if (settingsReadFailed) {
              void ensureClientSettingsHydrated().catch(() => undefined);
            } else {
              window.location.reload();
            }
          }}
        >
          <RefreshIcon refreshing={retrying} />
          {settingsReadFailed ? gt("Retry") : gt("Reload")}
        </Button>
      </div>
    </main>
  );
}
