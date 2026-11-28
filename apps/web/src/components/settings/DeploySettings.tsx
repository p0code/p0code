import { useAtomValue } from "@effect/atom-react";
import {
  deployAccountDisplayName,
  deployTargetFor,
  isDeployAccountReady,
} from "@t3tools/client-runtime/state/deploy";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AccountProfile,
  AccountProfileId,
  DeployAccountSummary,
  DeployEnvironment,
  DeployEnvTarget,
  DeployOverview,
  DeployPendingApproval,
  DeployProviderSummary,
  DeployRecord,
  DeployTargetKind,
  DeployWarning,
  EnvironmentId,
  PluginId,
  PluginInfo,
  PluginState,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  CloudIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  PlusIcon,
  RocketIcon,
  ServerIcon,
  TriangleIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { deployEnvironment } from "../../state/deploy";
import { useProfileProjects, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  ProviderInstancesLayout,
  type ProviderInstanceListRow,
  type ProviderInstanceRowStatusTone,
} from "./ProviderInstancesLayout";
import { getProviderVersionLabel } from "./providerStatus";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { CloudflareIcon, type Icon, VercelIcon } from "../Icons";

/** A deploy the page should open on arrival, e.g. from a thread's menu. */
export interface DeployPreselection {
  readonly projectId?: ProjectId;
  readonly branch?: string;
  readonly threadId?: ThreadId;
}

/** A deploy provider the page offers, whether or not this server has a backend for it. */
interface DeployProviderEntry {
  /** The provider id the server reports it under. */
  readonly id: string;
  readonly builtIn: boolean;
  readonly label: string;
  readonly icon: string | null;
  readonly description: string | null;
  /** Null for a built-in this server cannot run yet: shown, but not linkable. */
  readonly provider: DeployProviderSummary | null;
  /** Null for providers that are not plugins; only plugins can be turned on and off. */
  readonly plugin: PluginInfo | null;
  readonly accounts: ReadonlyArray<DeployAccountSummary>;
}

const builtInDeployProviders = (gt: ReturnType<typeof useGT>) => [
  {
    id: "vercel",
    // oxlint-disable-next-line t3code/no-untranslated-copy -- product brand name
    label: "Vercel",
    icon: "vercel",
    description: gt("Deploy web apps and preview branches to Vercel projects."),
  },
  {
    id: "cloudflare",
    // oxlint-disable-next-line t3code/no-untranslated-copy -- product brand name
    label: "Cloudflare",
    icon: "cloudflare",
    description: gt("Deploy Workers and Pages to Cloudflare."),
  },
  {
    id: "p0deploy",
    label: gt("Own server (Docker)"),
    icon: "server",
    description: gt("Deploy containers to your own SSH or Docker host."),
  },
];

/** The built-in catalog first, then every other provider the server reports. */
function listDeployProviders(
  gt: ReturnType<typeof useGT>,
  overview: DeployOverview,
  plugins: ReadonlyArray<PluginInfo>,
): ReadonlyArray<DeployProviderEntry> {
  const builtIns = builtInDeployProviders(gt);
  const entry = (id: string, builtIn: (typeof builtIns)[number] | null): DeployProviderEntry => {
    const provider = overview.providers.find((candidate) => candidate.pluginId === id) ?? null;
    const plugin = plugins.find((candidate) => candidate.manifest.id === id) ?? null;
    return {
      id,
      builtIn: builtIn !== null,
      label: provider?.label ?? builtIn?.label ?? id,
      icon: provider?.icon ?? builtIn?.icon ?? null,
      description: plugin?.manifest.description ?? builtIn?.description ?? null,
      provider,
      plugin,
      accounts: overview.accounts.filter((account) => account.pluginId === id),
    };
  };
  return [
    ...builtIns.map((builtIn) => entry(builtIn.id, builtIn)),
    ...overview.providers
      .filter((provider) => !builtIns.some((builtIn) => builtIn.id === provider.pluginId))
      .map((provider) => entry(provider.pluginId, null)),
  ];
}

const PROVIDER_ICONS: Partial<Record<string, typeof RocketIcon | Icon>> = {
  vercel: VercelIcon,
  cloudflare: CloudflareIcon,
  cloud: CloudIcon,
  server: ServerIcon,
  triangle: TriangleIcon,
};

/** Providers name a lucide icon or give an `https:`/`data:` image URL. */
function DeployProviderIcon({ entry }: { readonly entry: DeployProviderEntry }) {
  const icon = entry.icon ?? "";
  if (/^(https:|data:image\/)/.test(icon)) {
    return <img src={icon} alt="" className="size-4 object-contain" />;
  }
  const Icon = PROVIDER_ICONS[icon] ?? RocketIcon;
  return <Icon className="size-4 text-foreground/80" aria-hidden />;
}

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
};

const targetKindLabel = (gt: ReturnType<typeof useGT>, kind: DeployTargetKind): string => {
  switch (kind) {
    case "pages":
      return gt("Pages", { $context: "deploy target kind" });
    case "worker":
      return gt("Worker", { $context: "deploy target kind" });
    case "vercel-project":
      return gt("Project", { $context: "deploy target kind" });
  }
};

/** Why a provider cannot be used right now, or null while it runs. */
function providerUnavailableLabel(
  gt: ReturnType<typeof useGT>,
  entry: DeployProviderEntry,
): string | null {
  if (entry.provider === null) return gt("Not available yet");
  if (entry.plugin?.state === "failed") {
    return gt("Failed", { $context: "deploy provider status" });
  }
  if (entry.plugin?.state === "starting") return gt("Starting…");
  if (!entry.provider.running) return gt("Disabled", { $context: "provider status" });
  return null;
}

function summarizeAccountStatus(
  gt: ReturnType<typeof useGT>,
  account: DeployAccountSummary,
): { readonly text: string; readonly tone: ProviderInstanceRowStatusTone } {
  const hasWarnings = (account.status.warnings?.length ?? 0) > 0;
  switch (account.status.state) {
    case "linked":
      return {
        text: account.status.accountLabel
          ? `${gt("Linked")} · ${account.status.accountLabel}`
          : gt("Linked"),
        tone: hasWarnings ? "warning" : "ready",
      };
    case "expired":
      return { text: gt("Sign-in expired"), tone: "warning" };
    case "error":
      return { text: gt("Error", { $context: "deploy provider status" }), tone: "error" };
    case "unlinked":
      return { text: gt("Not linked"), tone: "neutral" };
  }
}

function summarizeProviderStatus(
  gt: ReturnType<typeof useGT>,
  entry: DeployProviderEntry,
): { readonly text: string; readonly tone: ProviderInstanceRowStatusTone } {
  const unavailable = providerUnavailableLabel(gt, entry);
  if (unavailable !== null) {
    if (entry.plugin?.state !== "failed") return { text: unavailable, tone: "disabled" };
    const detail = entry.plugin.message;
    return { text: detail ? `${unavailable} · ${detail}` : unavailable, tone: "error" };
  }
  if (entry.accounts.length === 0) return { text: gt("Not set up"), tone: "neutral" };
  const tones = entry.accounts.map((account) => summarizeAccountStatus(gt, account).tone);
  return {
    text: gt("Accounts linked: {linked} of {total}", {
      linked: entry.accounts.filter((account) => account.status.state === "linked").length,
      total: entry.accounts.length,
    }),
    tone: tones.includes("error") ? "error" : tones.includes("warning") ? "warning" : "ready",
  };
}

/** Account rows share the list with provider rows; plugin ids cannot contain a colon. */
const accountRowId = (accountId: string) => `account:${accountId}`;

export function DeploySettingsPanel({ preselect }: { readonly preselect: DeployPreselection }) {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.plugins === true;
  return (
    <SettingsPageContainer>
      {connected ? (
        <EnvironmentDeploy
          key={environment.environmentId}
          environmentId={environment.environmentId}
          preselect={preselect}
        />
      ) : (
        <SettingsSection title={gt("Deploy")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Connect an environment running this version to deploy from it.</T>
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentDeploy({
  environmentId,
  preselect,
}: {
  readonly environmentId: EnvironmentId;
  readonly preselect: DeployPreselection;
}) {
  const gt = useGT();
  const overviewQuery = useEnvironmentQuery(
    deployEnvironment.overview({ environmentId, input: {} }),
  );
  const pluginsQuery = useEnvironmentQuery(serverEnvironment.plugins({ environmentId, input: {} }));
  const canTogglePlugin = useAtomValue(
    serverEnvironment.pluginsSetEnabled.permissionAtom(environmentId),
  );
  const setPluginEnabled = useAtomCommand(serverEnvironment.pluginsSetEnabled, {
    reportFailure: false,
  });
  const projects = useProfileProjects(useProjects()).filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const accountProfiles = useEnvironmentSettings(
    environmentId,
    (settings) => settings.accountProfiles,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `pluginId` opens the dialog straight on that provider's link form.
  const [addDialog, setAddDialog] = useState<{ readonly pluginId: string | null } | null>(null);
  const [togglingPluginId, setTogglingPluginId] = useState<PluginId | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [linkWarnings, setLinkWarnings] = useState<
    Readonly<Record<string, ReadonlyArray<DeployWarning>>>
  >({});
  const [dialog, setDialog] = useState<DeployPreselection | null>(
    preselect.projectId === undefined ? null : preselect,
  );
  const [envDialogProjectId, setEnvDialogProjectId] = useState<ProjectId | null>(null);
  const overview = overviewQuery.data;

  if (overview === null) {
    return (
      <SettingsSection title={gt("Deploy")}>
        <p
          className="px-4 py-3 text-sm text-muted-foreground"
          role={overviewQuery.error ? "alert" : "status"}
        >
          {overviewQuery.error ?? gt("Loading…")}
        </p>
      </SettingsSection>
    );
  }

  const entries = listDeployProviders(gt, overview, pluginsQuery.data?.plugins ?? []);
  const hasBackend = entries.some((entry) => entry.provider !== null);
  const selectedAccount =
    overview.accounts.find((account) => accountRowId(account.id) === selectedId) ?? null;
  const selectedEntry =
    entries.find((entry) => entry.id === (selectedAccount?.pluginId ?? selectedId)) ??
    entries.find((entry) => entry.accounts.length > 0) ??
    entries.find((entry) => entry.provider !== null) ??
    entries[0]!;

  const togglePlugin = async (pluginId: PluginId, enabled: boolean) => {
    setToggleError(null);
    setTogglingPluginId(pluginId);
    const result = await setPluginEnabled({ environmentId, input: { pluginId, enabled } });
    setTogglingPluginId(null);
    if (result._tag === "Failure") {
      setToggleError(failureText(result, gt("The request failed.")));
      return;
    }
    overviewQuery.refresh();
    pluginsQuery.refresh();
  };

  const pluginSwitch = (entry: DeployProviderEntry) => {
    // A built-in without a backend keeps a dead switch; other non-plugins have nothing to toggle.
    if (entry.provider !== null && entry.plugin === null) return null;
    const plugin = entry.plugin;
    return (
      <Switch
        checked={entry.provider !== null && plugin?.enabled === true}
        disabled={
          entry.provider === null ||
          !canTogglePlugin ||
          plugin?.state === "starting" ||
          togglingPluginId !== null
        }
        onCheckedChange={(checked) => {
          if (plugin) void togglePlugin(plugin.manifest.id, Boolean(checked));
        }}
        aria-label={
          entry.provider === null
            ? gt("{provider} is not available yet", { provider: entry.label })
            : gt("Enable {provider} (affects all its accounts)", { provider: entry.label })
        }
      />
    );
  };

  const buildRows = (entry: DeployProviderEntry): ReadonlyArray<ProviderInstanceListRow> => {
    const unavailable = providerUnavailableLabel(gt, entry);
    const summary = summarizeProviderStatus(gt, entry);
    return [
      {
        id: entry.id,
        testId: `deploy-provider-row-${entry.id}`,
        icon: <DeployProviderIcon entry={entry} />,
        name: entry.label,
        version: getProviderVersionLabel(entry.plugin?.manifest.version),
        status: summary.text,
        statusTone: summary.tone,
        dimmed: unavailable !== null,
        trailing: pluginSwitch(entry),
      },
      ...entry.accounts.map((account): ProviderInstanceListRow => {
        const name = deployAccountDisplayName(account);
        const accountSummary = summarizeAccountStatus(gt, account);
        return {
          id: accountRowId(account.id),
          nested: true,
          icon: <KeyRoundIcon className="size-3.5 text-muted-foreground" aria-hidden />,
          name,
          ariaLabel: gt("{provider} account {account}", {
            provider: entry.label,
            account: name,
          }),
          status: unavailable ?? accountSummary.text,
          statusTone: unavailable === null ? accountSummary.tone : "disabled",
          dimmed: unavailable !== null,
        };
      }),
    ];
  };

  const builtInRows = entries.filter((entry) => entry.builtIn).flatMap(buildRows);
  const pluginRows = entries.filter((entry) => !entry.builtIn).flatMap(buildRows);

  const handleAccountLinked = (
    pluginId: string,
    accountId: string,
    warnings: ReadonlyArray<DeployWarning>,
  ) => {
    setSelectedId(pluginId);
    setLinkWarnings((previous) => ({ ...previous, [accountId]: warnings }));
    setAddDialog(null);
  };

  const titleOf = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? projectId;
  const accountNameOf = (accountId: string) => {
    const account = overview.accounts.find((candidate) => candidate.id === accountId);
    return account ? deployAccountDisplayName(account) : accountId;
  };
  const activeProfileName =
    overview.activeProfileId === null
      ? null
      : (accountProfiles.find((profile) => profile.id === overview.activeProfileId)?.name ??
        overview.activeProfileId);

  return (
    <>
      <ProviderInstancesLayout
        title={gt("Deploy")}
        titleAction={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Add deploy provider")}
            title={gt("Add deploy provider")}
            onClick={() => setAddDialog({ pluginId: null })}
          >
            <PlusIcon />
          </Button>
        }
        toolbar={
          activeProfileName ? (
            <p className="px-3 text-xs text-muted-foreground sm:px-4">
              {gt("Showing accounts in profile {profile} and untagged accounts.", {
                profile: activeProfileName,
              })}
            </p>
          ) : null
        }
        banner={
          toggleError ? (
            <p role="alert" className="px-3 text-xs text-destructive sm:px-4">
              {toggleError}
            </p>
          ) : null
        }
        groups={[
          {
            id: "built-in",
            ...(pluginRows.length > 0 ? { label: gt("Built-in") } : {}),
            rows: builtInRows,
          },
          { id: "plugins", label: gt("Plugin-provided"), rows: pluginRows },
        ]}
        selectedId={selectedAccount ? accountRowId(selectedAccount.id) : selectedEntry.id}
        onSelect={setSelectedId}
        listLabel={gt("Deploy providers")}
        detailLabel={gt("{provider} settings", { provider: selectedEntry.label })}
        detail={
          <DeployProviderDetail
            key={selectedAccount?.id ?? selectedEntry.id}
            environmentId={environmentId}
            entry={selectedEntry}
            account={selectedAccount}
            profiles={accountProfiles}
            activeProfileName={activeProfileName}
            enableSwitch={pluginSwitch(selectedEntry)}
            linkWarnings={linkWarnings}
            onAddAccount={() => setAddDialog({ pluginId: selectedEntry.id })}
          />
        }
      />

      {overview.approvals.length > 0 ? (
        <SettingsSection title={gt("Waiting for approval")}>
          {overview.approvals.map((approval) => (
            <ApprovalRow
              key={approval.id}
              environmentId={environmentId}
              approval={approval}
              projectTitle={titleOf(approval.projectId)}
              accountName={accountNameOf(approval.accountId)}
            />
          ))}
        </SettingsSection>
      ) : null}

      {hasBackend ? (
        <SettingsSection title={gt("Projects")}>
          {projects.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              <T>Add a project to this environment to deploy it.</T>
            </p>
          ) : (
            projects.map((project) => (
              <ProjectRow
                key={project.id}
                environmentId={environmentId}
                projectId={project.id}
                title={project.title}
                overview={overview}
                onDeploy={() => setDialog({ projectId: project.id })}
                onEditEnv={() => setEnvDialogProjectId(project.id)}
              />
            ))
          )}
        </SettingsSection>
      ) : null}

      {hasBackend || overview.deployments.length > 0 ? (
        <SettingsSection title={gt("Deployments")}>
          {overview.deployments.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              <T>Deploys started from this environment appear here.</T>
            </p>
          ) : (
            overview.deployments.map((deployment) => (
              <DeploymentRow
                key={`${deployment.accountId}:${deployment.deploymentId}`}
                environmentId={environmentId}
                deployment={deployment}
                projectTitle={titleOf(deployment.projectId)}
                accountName={accountNameOf(deployment.accountId)}
              />
            ))
          )}
        </SettingsSection>
      ) : null}

      {addDialog !== null ? (
        <AddDeployProviderDialog
          environmentId={environmentId}
          entries={entries}
          initialPluginId={addDialog.pluginId}
          onView={(entryId) => {
            setSelectedId(entryId);
            setAddDialog(null);
          }}
          onLinked={handleAccountLinked}
          onClose={() => setAddDialog(null)}
        />
      ) : null}

      {dialog?.projectId !== undefined ? (
        <DeployDialog
          environmentId={environmentId}
          projectId={dialog.projectId}
          projectTitle={titleOf(dialog.projectId)}
          overview={overview}
          {...(dialog.branch === undefined ? {} : { branch: dialog.branch })}
          {...(dialog.threadId === undefined ? {} : { threadId: dialog.threadId })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {envDialogProjectId !== null ? (
        <SetEnvDialog
          environmentId={environmentId}
          projectId={envDialogProjectId}
          projectTitle={titleOf(envDialogProjectId)}
          overview={overview}
          onClose={() => setEnvDialogProjectId(null)}
        />
      ) : null}
    </>
  );
}

function AccountStatusBadge({
  running,
  pluginState,
  state,
}: {
  readonly running: boolean;
  readonly pluginState: PluginState | null;
  readonly state: DeployAccountSummary["status"]["state"];
}) {
  const gt = useGT();
  if (pluginState === "failed") {
    return <Badge variant="error">{gt("Failed", { $context: "deploy provider status" })}</Badge>;
  }
  if (pluginState === "starting") {
    return <Badge variant="outline">{gt("Starting…")}</Badge>;
  }
  if (!running) {
    return <Badge variant="outline">{gt("Disabled", { $context: "provider status" })}</Badge>;
  }
  switch (state) {
    case "linked":
      return <Badge variant="success">{gt("Linked")}</Badge>;
    case "expired":
      return <Badge variant="warning">{gt("Sign-in expired")}</Badge>;
    case "error":
      return <Badge variant="error">{gt("Error", { $context: "deploy provider status" })}</Badge>;
    case "unlinked":
      return <Badge variant="outline">{gt("Not linked")}</Badge>;
  }
}

function AccountWarnings({ warnings }: { readonly warnings: ReadonlyArray<DeployWarning> }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1" data-testid="deploy-account-warnings">
      {warnings.map((warning) => (
        <li
          key={`${warning.code}:${warning.message}`}
          className="flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-xs text-warning-foreground"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{warning.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** The detail pane: one account when its row is selected, otherwise the provider and its accounts. */
function DeployProviderDetail({
  environmentId,
  entry,
  account,
  profiles,
  activeProfileName,
  enableSwitch,
  linkWarnings,
  onAddAccount,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: DeployProviderEntry;
  readonly account: DeployAccountSummary | null;
  readonly profiles: ReadonlyArray<AccountProfile>;
  readonly activeProfileName: string | null;
  readonly enableSwitch: ReactNode;
  readonly linkWarnings: Readonly<Record<string, ReadonlyArray<DeployWarning>>>;
  readonly onAddAccount: () => void;
}) {
  const gt = useGT();
  const canLink = useAtomValue(deployEnvironment.link.permissionAtom(environmentId));
  const provider = entry.provider;
  const version = getProviderVersionLabel(entry.plugin?.manifest.version);
  const unavailable = providerUnavailableLabel(gt, entry);
  const accountCard = (shown: DeployAccountSummary) =>
    provider ? (
      <AccountCardRow
        key={shown.id}
        environmentId={environmentId}
        provider={provider}
        pluginState={entry.plugin?.state ?? null}
        account={shown}
        profiles={profiles}
        extraWarnings={linkWarnings[shown.id]}
      />
    ) : null;

  if (account !== null) {
    return (
      <SettingsSection
        title={gt("{provider} account", { provider: entry.label })}
        icon={<DeployProviderIcon entry={entry} />}
      >
        {accountCard(account)}
      </SettingsSection>
    );
  }

  const description =
    provider === null
      ? gt("{provider} is not available in this version yet and cannot be linked.", {
          provider: entry.label,
        })
      : entry.plugin?.state === "failed"
        ? (entry.plugin.message ?? gt("This deploy provider failed to start."))
        : !provider.running
          ? gt("Turn on {provider} to link accounts or deploy with it.", { provider: entry.label })
          : entry.description;

  return (
    <>
      <SettingsSection
        title={entry.label}
        icon={<DeployProviderIcon entry={entry} />}
        headerAction={
          version ? <code className="text-xs text-muted-foreground">{version}</code> : undefined
        }
      >
        <SettingsRow
          title={gt("Status")}
          status={unavailable ?? summarizeProviderStatus(gt, entry).text}
          description={description}
          control={
            entry.plugin !== null && unavailable !== null ? (
              <Button size="xs" variant="outline" render={<Link to="/settings/plugins" />}>
                <T>Open Plugins</T>
              </Button>
            ) : undefined
          }
        />
        {entry.plugin !== null && provider !== null ? (
          <SettingsRow
            title={gt("Provider enabled")}
            description={gt("Turning {provider} on or off affects all of its accounts.", {
              provider: entry.label,
            })}
            control={enableSwitch}
          />
        ) : null}
      </SettingsSection>

      {provider !== null ? (
        <SettingsSection
          title={gt("Accounts")}
          headerAction={
            provider.running ? (
              <Button size="xs" variant="outline" disabled={!canLink} onClick={onAddAccount}>
                <PlusIcon />
                <T>Add account</T>
              </Button>
            ) : undefined
          }
        >
          {entry.accounts.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
              {activeProfileName
                ? gt("No accounts linked in profile {profile}.", { profile: activeProfileName })
                : gt("No accounts linked yet.")}
            </p>
          ) : (
            entry.accounts.map(accountCard)
          )}
        </SettingsSection>
      ) : null}
    </>
  );
}

function AddDeployProviderDialog({
  environmentId,
  entries,
  initialPluginId,
  onView,
  onLinked,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<DeployProviderEntry>;
  readonly initialPluginId: string | null;
  readonly onView: (entryId: string) => void;
  readonly onLinked: (
    pluginId: string,
    accountId: string,
    warnings: ReadonlyArray<DeployWarning>,
  ) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const canLink = useAtomValue(deployEnvironment.link.permissionAtom(environmentId));
  const link = useAtomCommand(deployEnvironment.link, { label: "link deploy account" });
  const [pluginId, setPluginId] = useState(initialPluginId);
  const [label, setLabel] = useState("");
  const [teamId, setTeamId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);

  const selected = entries.find((entry) => entry.id === pluginId) ?? null;
  const target = selected?.provider?.running ? selected.provider : null;

  const choose = (nextPluginId: string | null) => {
    setPluginId(nextPluginId);
    setLabel("");
    setTeamId("");
    setToken("");
    setFailure(null);
    setAuthorizeUrl(null);
  };

  const submit = async () => {
    if (target === null) return;
    setBusy(true);
    setFailure(null);
    const trimmedLabel = label.trim();
    const trimmedTeam = teamId.trim();
    const result = await link({
      environmentId,
      input: {
        pluginId: target.pluginId,
        ...(trimmedLabel.length > 0 ? { label: trimmedLabel } : {}),
        ...(trimmedTeam.length > 0 ? { teamId: trimmedTeam } : {}),
        ...(token.length > 0 ? { token } : {}),
      },
    });
    setBusy(false);
    // The token is the provider's now; drop the copy in this page.
    setToken("");
    if (result._tag === "Failure") {
      setFailure(failureText(result, gt("The request failed.")));
      return;
    }
    if (result.value.result._tag === "pending") {
      setAuthorizeUrl(result.value.result.authorizeUrl);
      return;
    }
    onLinked(target.pluginId, result.value.accountId, result.value.result.warnings ?? []);
  };

  const catalogItem = (entry: DeployProviderEntry) => {
    const unavailable = providerUnavailableLabel(gt, entry);
    const version = getProviderVersionLabel(entry.plugin?.manifest.version);
    return (
      <div
        key={entry.id}
        data-testid={`add-deploy-provider-item-${entry.id}`}
        className="flex items-start gap-2.5 rounded-lg border border-border/60 px-3 py-2.5"
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <DeployProviderIcon entry={entry} />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{entry.label}</span>
            {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
            {unavailable ? <Badge variant="outline">{unavailable}</Badge> : null}
          </div>
          {entry.description ? (
            <p className="text-xs text-muted-foreground">{entry.description}</p>
          ) : null}
        </div>
        {entry.provider === null ? null : entry.provider.running ? (
          <Button size="xs" variant="outline" disabled={!canLink} onClick={() => choose(entry.id)}>
            {entry.accounts.length > 0 ? gt("Add account") : gt("Link")}
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => onView(entry.id)}>
            <T>View</T>
          </Button>
        )}
      </div>
    );
  };

  const pluginEntries = entries.filter((entry) => !entry.builtIn);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target ? (
              <T>
                Link <Var>{target.label}</Var> account
              </T>
            ) : (
              gt("Add deploy provider")
            )}
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <T>Add a named account to deploy projects with this provider.</T>
            ) : (
              <T>Choose a deploy provider to link an account.</T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {target ? (
            <div className="space-y-3">
              <Input
                size="sm"
                value={label}
                disabled={!canLink || busy}
                placeholder={gt("Account name")}
                aria-label={gt("{provider} account name", { provider: target.label })}
                onChange={(event) => setLabel(event.target.value)}
              />
              <Input
                size="sm"
                value={teamId}
                disabled={!canLink || busy}
                placeholder={gt("Team ID (optional)")}
                aria-label={gt("{provider} team ID", { provider: target.label })}
                onChange={(event) => setTeamId(event.target.value)}
              />
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                size="sm"
                value={token}
                disabled={!canLink || busy}
                placeholder={gt("Access token (optional)")}
                aria-label={gt("{provider} access token", { provider: target.label })}
                onChange={(event) => setToken(event.target.value)}
              />
              {authorizeUrl ? (
                <a
                  className="inline-flex items-center gap-1 text-sm underline"
                  href={authorizeUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <T>Finish signing in</T>
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              ) : null}
              {failure ? (
                <p role="alert" className="text-sm text-destructive">
                  {failure}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2" data-testid="add-deploy-provider-builtins">
                <h3 className="text-xs font-medium text-muted-foreground">{gt("Built-in")}</h3>
                {entries.filter((entry) => entry.builtIn).map(catalogItem)}
              </div>
              <div className="space-y-2" data-testid="add-deploy-provider-plugins">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {gt("Plugin-provided")}
                </h3>
                {pluginEntries.length > 0 ? (
                  pluginEntries.map(catalogItem)
                ) : (
                  <p className="text-xs text-muted-foreground">
                    <T>
                      Third-party deploy providers can be added from{" "}
                      <Link to="/settings/plugins" className="underline" onClick={onClose}>
                        Plugins
                      </Link>
                      .
                    </T>
                  </p>
                )}
              </div>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {target ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => choose(null)}>
                <T>Back</T>
              </Button>
              <Button disabled={!canLink || busy} onClick={() => void submit()}>
                {gt("Link account")}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>
              <T>Close</T>
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AccountCardRow({
  environmentId,
  provider,
  pluginState,
  account,
  profiles,
  extraWarnings,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: DeployProviderSummary;
  readonly pluginState: PluginState | null;
  readonly account: DeployAccountSummary;
  readonly profiles: ReadonlyArray<AccountProfile>;
  readonly extraWarnings?: ReadonlyArray<DeployWarning> | undefined;
}) {
  const gt = useGT();
  const canManage = useAtomValue(deployEnvironment.link.permissionAtom(environmentId));
  const link = useAtomCommand(deployEnvironment.link, { label: `relink ${provider.label}` });
  const unlink = useAtomCommand(deployEnvironment.unlink, { label: `unlink ${provider.label}` });
  const updateAccount = useAtomCommand(deployEnvironment.updateAccount, {
    label: `update ${provider.label} account`,
  });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const displayName = deployAccountDisplayName(account);
  const linked = account.status.state === "linked";
  const warnings = mergeWarnings(account.status.warnings, extraWarnings);

  const relink = async () => {
    setBusy(true);
    setFailure(null);
    const result = await link({
      environmentId,
      input: {
        pluginId: account.pluginId,
        accountId: account.id,
        ...(token.length > 0 ? { token } : {}),
      },
    });
    setBusy(false);
    setToken("");
    if (result._tag === "Failure") {
      setFailure(failureText(result, gt("The request failed.")));
      return;
    }
    setAuthorizeUrl(
      result.value.result._tag === "pending" ? result.value.result.authorizeUrl : null,
    );
  };

  const remove = async () => {
    setBusy(true);
    setFailure(null);
    const result = await unlink({ environmentId, input: { accountId: account.id } });
    setBusy(false);
    if (result._tag === "Failure") setFailure(failureText(result, gt("The request failed.")));
  };

  const renameAccount = async (rawValue: string) => {
    const trimmed = rawValue.trim();
    const nextLabel = trimmed.length > 0 ? trimmed : null;
    if (nextLabel === account.label) return;
    setBusy(true);
    setFailure(null);
    const result = await updateAccount({
      environmentId,
      input: { accountId: account.id, label: nextLabel },
    });
    setBusy(false);
    if (result._tag === "Failure") setFailure(failureText(result, gt("The request failed.")));
  };

  const toggleProfile = async (profileId: AccountProfileId) => {
    setBusy(true);
    setFailure(null);
    const next = account.profileIds.includes(profileId)
      ? account.profileIds.filter((id) => id !== profileId)
      : [...account.profileIds, profileId];
    const result = await updateAccount({
      environmentId,
      input: { accountId: account.id, profileIds: next },
    });
    setBusy(false);
    if (result._tag === "Failure") setFailure(failureText(result, gt("The request failed.")));
  };

  const setAllProfiles = async () => {
    if (account.profileIds.length === 0) return;
    setBusy(true);
    setFailure(null);
    const result = await updateAccount({
      environmentId,
      input: { accountId: account.id, profileIds: [] },
    });
    setBusy(false);
    if (result._tag === "Failure") setFailure(failureText(result, gt("The request failed.")));
  };

  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-2" data-testid="deploy-account-card">
          <span>{displayName}</span>
          <AccountStatusBadge
            running={provider.running}
            pluginState={pluginState}
            state={account.status.state}
          />
        </span>
      }
      description={
        <>
          {account.status.accountLabel && account.status.accountLabel !== displayName ? (
            <span className="block">
              <T>
                Account: <Var>{account.status.accountLabel}</Var>
              </T>
            </span>
          ) : null}
          {account.teamId ? (
            <span className="block font-mono text-xs">
              <T>
                Team: <Var>{account.teamId}</Var>
              </T>
            </span>
          ) : null}
          {account.status.message ? <span className="block">{account.status.message}</span> : null}
          {authorizeUrl ? (
            <a
              className="mt-1 inline-flex items-center gap-1 text-foreground underline"
              href={authorizeUrl}
              target="_blank"
              rel="noreferrer"
            >
              <T>Finish signing in</T>
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
          {failure ? (
            <span role="alert" className="block text-destructive">
              {failure}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {provider.running && !linked ? (
            <>
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                size="sm"
                className="w-36"
                value={token}
                disabled={!canManage || busy}
                placeholder={gt("Access token (optional)")}
                aria-label={gt("{account} access token", { account: displayName })}
                onChange={(event) => setToken(event.target.value)}
              />
              <Button size="xs" disabled={!canManage || busy} onClick={() => void relink()}>
                {account.status.state === "expired" ? gt("Relink") : gt("Link")}
              </Button>
            </>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={!canManage || busy}
            onClick={() => void remove()}
          >
            {gt("Unlink")}
          </Button>
        </div>
      }
    >
      <AccountWarnings warnings={warnings} />
      <div className="mt-2 flex flex-wrap items-center gap-2 pb-1">
        <DraftInput
          size="sm"
          className="w-48"
          value={account.label ?? ""}
          disabled={!canManage || busy}
          placeholder={account.status.accountLabel ?? gt("Account name")}
          aria-label={gt("Display name for {account}", { account: displayName })}
          spellCheck={false}
          onCommit={(next) => void renameAccount(next)}
        />
        {profiles.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="xs"
              variant={account.profileIds.length === 0 ? "secondary" : "outline"}
              disabled={!canManage || busy}
              onClick={() => void setAllProfiles()}
            >
              <T>All profiles</T>
            </Button>
            {profiles.map((profile) => {
              const tagged = account.profileIds.includes(profile.id);
              return (
                <Button
                  key={profile.id}
                  size="xs"
                  variant={tagged ? "secondary" : "outline"}
                  aria-pressed={tagged}
                  disabled={!canManage || busy}
                  onClick={() => void toggleProfile(profile.id)}
                >
                  {profile.name}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function mergeWarnings(
  primary: ReadonlyArray<DeployWarning> | undefined,
  extra: ReadonlyArray<DeployWarning> | undefined,
): ReadonlyArray<DeployWarning> {
  if (!extra || extra.length === 0) return primary ?? [];
  if (!primary || primary.length === 0) return extra;
  const seen = new Set(primary.map((warning) => `${warning.code}:${warning.message}`));
  return [
    ...primary,
    ...extra.filter((warning) => !seen.has(`${warning.code}:${warning.message}`)),
  ];
}

function ProjectRow({
  environmentId,
  projectId,
  title,
  overview,
  onDeploy,
  onEditEnv,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly overview: DeployOverview;
  readonly onDeploy: () => void;
  readonly onEditEnv: () => void;
}) {
  const gt = useGT();
  const canMap = useAtomValue(deployEnvironment.mapProject.permissionAtom(environmentId));
  const canDeploy = useAtomValue(deployEnvironment.start.permissionAtom(environmentId));
  const mapProject = useAtomCommand(deployEnvironment.mapProject);
  const target = deployTargetFor(overview, projectId);
  const readyAccounts = overview.accounts.filter((account) => {
    const provider =
      overview.providers.find((candidate) => candidate.pluginId === account.pluginId) ?? null;
    return isDeployAccountReady(account, provider);
  });
  const targetReady = target !== null && isDeployAccountReady(target.account, target.provider);
  const value = target
    ? JSON.stringify([
        target.mapping.accountId,
        target.mapping.targetKind,
        target.mapping.targetId,
        target.mapping.targetName,
      ])
    : "";

  return (
    <SettingsRow
      title={title}
      description={
        target ? (
          <>
            <T>
              Deploys to <Var>{target.mapping.targetName}</Var> (
              <Var>{targetKindLabel(gt, target.mapping.targetKind)}</Var>) via{" "}
              <Var>{target.accountName}</Var> on <Var>{target.providerLabel}</Var>
            </T>
            {targetReady ? (
              <ProjectDomains environmentId={environmentId} projectId={projectId} />
            ) : null}
          </>
        ) : (
          <T>Not mapped to a deploy target.</T>
        )
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Select
            value={value}
            disabled={!canMap || readyAccounts.length === 0}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              const mapping =
                next === ""
                  ? null
                  : (() => {
                      const [accountId, targetKind, targetId, targetName] = JSON.parse(next) as [
                        string,
                        DeployTargetKind,
                        string,
                        string,
                      ];
                      return {
                        accountId,
                        targetKind,
                        targetId,
                        targetName,
                        defaultEnvironment: target?.mapping.defaultEnvironment ?? "preview",
                        ...(target?.mapping.directory === undefined
                          ? {}
                          : { directory: target.mapping.directory }),
                      };
                    })();
              void mapProject({ environmentId, input: { projectId, mapping } });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-52"
              aria-label={gt("Deploy target for {project}", { project: title })}
            >
              <SelectValue>{target ? target.mapping.targetName : gt("Choose target")}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">{gt("No target")}</SelectItem>
              {readyAccounts.map((account) => {
                const provider =
                  overview.providers.find((candidate) => candidate.pluginId === account.pluginId) ??
                  null;
                return (
                  <AccountProjectItems
                    key={account.id}
                    environmentId={environmentId}
                    account={account}
                    providerLabel={provider?.label ?? account.pluginId}
                  />
                );
              })}
            </SelectPopup>
          </Select>
          {target ? (
            <>
              <Select
                value={target.mapping.defaultEnvironment}
                disabled={!canMap}
                onValueChange={(next) => {
                  if (next !== "preview" && next !== "production") return;
                  void mapProject({
                    environmentId,
                    input: {
                      projectId,
                      mapping: {
                        accountId: target.mapping.accountId,
                        targetKind: target.mapping.targetKind,
                        targetId: target.mapping.targetId,
                        targetName: target.mapping.targetName,
                        defaultEnvironment: next,
                        ...(target.mapping.directory === undefined
                          ? {}
                          : { directory: target.mapping.directory }),
                      },
                    },
                  });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-28"
                  aria-label={gt("Default environment for {project}", { project: title })}
                >
                  <SelectValue>
                    {target.mapping.defaultEnvironment === "production"
                      ? gt("Production")
                      : gt("Preview")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="preview">{gt("Preview")}</SelectItem>
                  <SelectItem value="production">{gt("Production")}</SelectItem>
                </SelectPopup>
              </Select>
              <Button
                size="xs"
                variant="outline"
                disabled={!canDeploy || !targetReady}
                onClick={onEditEnv}
              >
                <KeyRoundIcon />
                <T>Env vars</T>
              </Button>
            </>
          ) : null}
          <Button size="xs" disabled={!canDeploy || !targetReady} onClick={onDeploy}>
            <RocketIcon />
            <T>Deploy</T>
          </Button>
        </div>
      }
    />
  );
}

function AccountProjectItems({
  environmentId,
  account,
  providerLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly account: DeployAccountSummary;
  readonly providerLabel: string;
}) {
  const query = useEnvironmentQuery(
    deployEnvironment.providerProjects({ environmentId, input: { accountId: account.id } }),
  );
  const accountName = deployAccountDisplayName(account);
  return (query.data ?? []).map((project) => (
    <SelectItem
      key={`${account.id}:${project.kind}:${project.id}`}
      value={JSON.stringify([account.id, project.kind, project.id, project.name])}
    >
      {project.name}
      <span className="text-muted-foreground">
        {" "}
        · {providerLabel} ({accountName})
      </span>
    </SelectItem>
  ));
}

function ProjectDomains({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const query = useEnvironmentQuery(
    deployEnvironment.domains({ environmentId, input: { projectId } }),
  );
  const domains = query.data ?? [];
  if (domains.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {domains.map((domain) => (
        <a
          key={domain.name}
          href={`https://${domain.name}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs underline"
        >
          {domain.name}
          {domain.verified === false ? " ⚠" : ""}
        </a>
      ))}
    </span>
  );
}

function ApprovalRow({
  environmentId,
  approval,
  projectTitle,
  accountName,
}: {
  readonly environmentId: EnvironmentId;
  readonly approval: DeployPendingApproval;
  readonly projectTitle: string;
  readonly accountName: string;
}) {
  const canDecide = useAtomValue(deployEnvironment.decideApproval.permissionAtom(environmentId));
  const decide = useAtomCommand(deployEnvironment.decideApproval);
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean) => {
    setBusy(true);
    await decide({ environmentId, input: { approvalId: approval.id, approve } });
    setBusy(false);
  };
  return (
    <SettingsRow
      title={projectTitle}
      description={
        <>
          <T>
            A thread without Full access asked to deploy to <Var>{approval.targetName}</Var> via{" "}
            <Var>{accountName}</Var> (<Var>{approval.environment}</Var>).
          </T>
          {approval.directory ? (
            <span className="block font-mono text-xs">{approval.directory}</span>
          ) : null}
        </>
      }
      control={
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={!canDecide || busy}
            onClick={() => void answer(false)}
          >
            <T>Decline</T>
          </Button>
          <Button size="xs" disabled={!canDecide || busy} onClick={() => void answer(true)}>
            <T>Approve and deploy</T>
          </Button>
        </div>
      }
    />
  );
}

function DeploymentRow({
  environmentId,
  deployment,
  projectTitle,
  accountName,
}: {
  readonly environmentId: EnvironmentId;
  readonly deployment: DeployRecord;
  readonly projectTitle: string;
  readonly accountName: string;
}) {
  const gt = useGT();
  const status = useEnvironmentQuery(
    deployEnvironment.deploymentStatus({
      environmentId,
      input: { accountId: deployment.accountId, deploymentId: deployment.deploymentId },
    }),
  );
  const canRollback = useAtomValue(deployEnvironment.rollback.permissionAtom(environmentId));
  const rollback = useAtomCommand(deployEnvironment.rollback);
  const [logsOpen, setLogsOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const state = status.data?.state ?? deployment.state;
  const url = status.data?.url ?? deployment.url;

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {projectTitle}
          <DeploymentStateBadge state={state} />
        </span>
      }
      description={
        <>
          <span className="font-mono text-xs">
            {accountName} · {deployment.environment}
            {deployment.branch ? ` · ${deployment.branch}` : ""} · {deployment.deploymentId}
          </span>
          {url ? (
            <a
              className="ms-2 inline-flex items-center gap-1 underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {url}
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
          {note ? <span className="block">{note}</span> : null}
          <DeployLogsSheet
            open={logsOpen}
            onClose={() => setLogsOpen(false)}
            environmentId={environmentId}
            deployment={deployment}
          />
        </>
      }
      control={
        <div className="flex gap-2">
          <Button size="xs" variant="outline" onClick={() => setLogsOpen(true)}>
            <T>Logs</T>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!canRollback || state !== "ready"}
            onClick={async () => {
              const result = await rollback({
                environmentId,
                input: { projectId: deployment.projectId, deploymentId: deployment.deploymentId },
              });
              setNote(
                result._tag === "Success"
                  ? gt("Rolled back to {deployment}.", { deployment: result.value.deploymentId })
                  : failureText(result, gt("The request failed.")),
              );
            }}
          >
            <T>Roll back to this</T>
          </Button>
        </div>
      }
    />
  );
}

function DeploymentStateBadge({ state }: { readonly state: DeployRecord["state"] }) {
  const gt = useGT();
  switch (state) {
    case "queued":
      return <Badge variant="outline">{gt("Queued")}</Badge>;
    case "building":
      return <Badge variant="info">{gt("Building")}</Badge>;
    case "ready":
      return <Badge variant="success">{gt("Ready", { $context: "deployment state" })}</Badge>;
    case "error":
      return <Badge variant="error">{gt("Failed", { $context: "deployment state" })}</Badge>;
    case "canceled":
      return <Badge variant="outline">{gt("Canceled")}</Badge>;
  }
}

function DeployLogsSheet({
  open,
  onClose,
  environmentId,
  deployment,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly deployment: DeployRecord;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetPopup side="right" className="w-[min(90vw,40rem)]">
        <SheetHeader>
          <SheetTitle>
            <T>
              Logs for <Var>{deployment.deploymentId}</Var>
            </T>
          </SheetTitle>
        </SheetHeader>
        {open ? <DeployLogLines environmentId={environmentId} deployment={deployment} /> : null}
      </SheetPopup>
    </Sheet>
  );
}

function DeployLogLines({
  environmentId,
  deployment,
}: {
  readonly environmentId: EnvironmentId;
  readonly deployment: DeployRecord;
}) {
  const gt = useGT();
  const logs = useEnvironmentQuery(
    deployEnvironment.logs({
      environmentId,
      input: {
        accountId: deployment.accountId,
        deploymentId: deployment.deploymentId,
        follow: true,
      },
    }),
  );
  const lines = logs.data ?? [];
  return (
    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 pb-4 font-mono text-xs">
      {lines.length > 0 ? lines.join("\n") : (logs.error ?? gt("Waiting for log lines…"))}
    </pre>
  );
}

function DeployDialog({
  environmentId,
  projectId,
  projectTitle,
  overview,
  branch: initialBranch,
  threadId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly overview: DeployOverview;
  readonly branch?: string;
  readonly threadId?: ThreadId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const start = useAtomCommand(deployEnvironment.start);
  const decide = useAtomCommand(deployEnvironment.decideApproval);
  const canDeploy = useAtomValue(deployEnvironment.start.permissionAtom(environmentId));
  const target = deployTargetFor(overview, projectId);
  const targetReady = target !== null && isDeployAccountReady(target.account, target.provider);
  const [environment, setEnvironment] = useState<DeployEnvironment>(
    target?.mapping.defaultEnvironment ?? "preview",
  );
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [sourceKind, setSourceKind] = useState<"git" | "local-build">("git");
  const [directory, setDirectory] = useState(target?.mapping.directory ?? "");
  const [allowOutsideProject, setAllowOutsideProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [approval, setApproval] = useState<DeployPendingApproval | null>(null);

  const deploy = async () => {
    if (target === null) return;
    setBusy(true);
    setFailure(null);
    const trimmedBranch = branch.trim();
    const trimmedDirectory = directory.trim();
    const result = await start({
      environmentId,
      input: {
        projectId,
        accountId: target.mapping.accountId,
        environment,
        sourceKind,
        ...(trimmedBranch.length > 0 ? { branch: trimmedBranch } : {}),
        ...(trimmedDirectory.length > 0 ? { directory: trimmedDirectory } : {}),
        ...(allowOutsideProject ? { allowOutsideProject: true } : {}),
        ...(threadId === undefined ? {} : { threadId }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setFailure(failureText(result, gt("The request failed.")));
      return;
    }
    if (result.value._tag === "approval-required") {
      setApproval(result.value.approval);
      return;
    }
    onClose();
  };

  const answer = async (approve: boolean) => {
    if (approval === null) return;
    setBusy(true);
    const result = await decide({ environmentId, input: { approvalId: approval.id, approve } });
    setBusy(false);
    if (result._tag === "Failure") {
      setFailure(failureText(result, gt("The request failed.")));
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>
              Deploy <Var>{projectTitle}</Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <T>
                To <Var>{target.mapping.targetName}</Var> via <Var>{target.accountName}</Var> on{" "}
                <Var>{target.providerLabel}</Var>.
              </T>
            ) : (
              <T>Choose a deploy target for this project in Settings → Deploy first.</T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {approval ? (
              <p className="text-sm">
                <T>
                  This thread does not have Full access, so the deploy waits for your approval. It
                  will deploy <Var>{approval.branch ?? ""}</Var> to{" "}
                  <Var>{approval.environment}</Var>.
                </T>
              </p>
            ) : (
              <>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <T>Environment</T>
                  <Select
                    value={environment}
                    onValueChange={(next) => {
                      if (next === "preview" || next === "production") setEnvironment(next);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-40">
                      <SelectValue>
                        {environment === "production" ? gt("Production") : gt("Preview")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="preview">{gt("Preview")}</SelectItem>
                      <SelectItem value="production">{gt("Production")}</SelectItem>
                    </SelectPopup>
                  </Select>
                </label>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <T>Source</T>
                  <Select
                    value={sourceKind}
                    onValueChange={(next) => {
                      if (next === "git" || next === "local-build") setSourceKind(next);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-40">
                      <SelectValue>
                        {sourceKind === "git" ? gt("Git branch") : gt("Local build")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="git">{gt("Git branch")}</SelectItem>
                      <SelectItem value="local-build">{gt("Local build")}</SelectItem>
                    </SelectPopup>
                  </Select>
                </label>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <T>Branch</T>
                  <Input
                    size="sm"
                    className="w-40"
                    value={branch}
                    placeholder={gt("Default branch")}
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </label>
                {sourceKind === "local-build" ? (
                  <>
                    <label className="flex items-center justify-between gap-3 text-sm">
                      <T>Folder</T>
                      <Input
                        size="sm"
                        className="w-40"
                        value={directory}
                        placeholder={gt("Project root")}
                        onChange={(event) => setDirectory(event.target.value)}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={allowOutsideProject}
                        onCheckedChange={(checked) => setAllowOutsideProject(checked === true)}
                      />
                      <T>Allow folder outside this project</T>
                    </label>
                  </>
                ) : null}
              </>
            )}
            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {approval ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
                <T>Decline</T>
              </Button>
              <Button disabled={busy || !canDeploy} onClick={() => void answer(true)}>
                <T>Approve and deploy</T>
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                <T>Cancel</T>
              </Button>
              <Button disabled={busy || !canDeploy || !targetReady} onClick={() => void deploy()}>
                <RocketIcon />
                <T>Deploy</T>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Parses `KEY=VALUE` lines into a variable map; ignores blank lines and `#` comments. */
export function parseEnvLines(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.length > 0) vars[key] = line.slice(eq + 1);
  }
  return vars;
}

function SetEnvDialog({
  environmentId,
  projectId,
  projectTitle,
  overview,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly overview: DeployOverview;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const setEnv = useAtomCommand(deployEnvironment.setEnv);
  const canSet = useAtomValue(deployEnvironment.setEnv.permissionAtom(environmentId));
  const target = deployTargetFor(overview, projectId);
  const [environment, setEnvironment] = useState<DeployEnvTarget>(
    target?.mapping.defaultEnvironment ?? "preview",
  );
  const [varsText, setVarsText] = useState("");
  const [removeText, setRemoveText] = useState("");
  const [secret, setSecret] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setFailure(null);
    const vars = parseEnvLines(varsText);
    const remove = removeText
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const result = await setEnv({
      environmentId,
      input: {
        projectId,
        environment,
        vars,
        secret,
        ...(remove.length > 0 ? { remove } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setFailure(failureText(result, gt("The request failed.")));
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>
              Environment variables for <Var>{projectTitle}</Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <T>
                Sets or removes variables on <Var>{target.mapping.targetName}</Var> via{" "}
                <Var>{target.accountName}</Var>.
              </T>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <T>Environment</T>
              <Select
                value={environment}
                onValueChange={(next) => {
                  if (next === "production" || next === "preview" || next === "development") {
                    setEnvironment(next);
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue>
                    {environment === "production"
                      ? gt("Production")
                      : environment === "development"
                        ? gt("Development")
                        : gt("Preview")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="production">{gt("Production")}</SelectItem>
                  <SelectItem value="preview">{gt("Preview")}</SelectItem>
                  <SelectItem value="development">{gt("Development")}</SelectItem>
                </SelectPopup>
              </Select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>
                <T>Set variables (KEY=value, one per line)</T>
              </span>
              <Textarea
                rows={4}
                value={varsText}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- KEY=value syntax example
                placeholder="API_URL=https://api.example.com"
                onChange={(event) => setVarsText(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={secret}
                onCheckedChange={(checked) => setSecret(checked === true)}
              />
              <T>Store as secrets</T>
            </label>
            <label className="block space-y-1 text-sm">
              <span>
                <T>Remove variable names (optional)</T>
              </span>
              <Input
                size="sm"
                value={removeText}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- env var key example
                placeholder="OLD_KEY, LEGACY_TOKEN"
                onChange={(event) => setRemoveText(event.target.value)}
              />
            </label>
            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button disabled={busy || !canSet || target === null} onClick={() => void save()}>
            <T>Save variables</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
