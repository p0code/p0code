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
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { AlertTriangleIcon, ExternalLinkIcon, KeyRoundIcon, RocketIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { deployEnvironment } from "../../state/deploy";
import { useProfileProjects, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** A deploy the page should open on arrival, e.g. from a thread's menu. */
export interface DeployPreselection {
  readonly projectId?: ProjectId;
  readonly branch?: string;
  readonly threadId?: ThreadId;
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
  const query = useEnvironmentQuery(deployEnvironment.overview({ environmentId, input: {} }));
  const projects = useProfileProjects(useProjects()).filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const accountProfiles = useEnvironmentSettings(
    environmentId,
    (settings) => settings.accountProfiles,
  );
  const [dialog, setDialog] = useState<DeployPreselection | null>(
    preselect.projectId === undefined ? null : preselect,
  );
  const [envDialogProjectId, setEnvDialogProjectId] = useState<ProjectId | null>(null);
  const overview = query.data;

  if (overview === null) {
    return (
      <SettingsSection title={gt("Deploy")}>
        <p
          className="px-4 py-3 text-sm text-muted-foreground"
          role={query.error ? "alert" : "status"}
        >
          {query.error ?? gt("Loading…")}
        </p>
      </SettingsSection>
    );
  }

  if (overview.providers.length === 0) {
    return (
      <SettingsSection title={gt("Deploy")}>
        <div className="space-y-2 px-4 py-4 text-sm">
          <p className="font-medium">
            <T>No deploy providers installed</T>
          </p>
          <p className="text-muted-foreground">
            <T>
              Deploy targets such as Vercel, Cloudflare or your own Docker hosts come from plugins.
              Install one in <Link to="/settings/plugins">Plugins</Link>, turn it on, then link your
              account here.
            </T>
          </p>
        </div>
      </SettingsSection>
    );
  }

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
      <SettingsSection title={gt("Deploy providers")}>
        {activeProfileName ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            {gt("Showing accounts in profile {profile} and untagged accounts.", {
              profile: activeProfileName,
            })}
          </p>
        ) : null}
        {overview.providers.map((provider) => {
          const providerAccounts = overview.accounts.filter(
            (account) => account.pluginId === provider.pluginId,
          );
          return (
            <ProviderSection
              key={provider.pluginId}
              environmentId={environmentId}
              provider={provider}
              accounts={providerAccounts}
              profiles={accountProfiles}
            />
          );
        })}
      </SettingsSection>

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
  state,
}: {
  readonly running: boolean;
  readonly state: DeployAccountSummary["status"]["state"];
}) {
  const gt = useGT();
  if (!running) return <Badge variant="outline">{gt("Off in Plugins")}</Badge>;
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

function ProviderSection({
  environmentId,
  provider,
  accounts,
  profiles,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: DeployProviderSummary;
  readonly accounts: ReadonlyArray<DeployAccountSummary>;
  readonly profiles: ReadonlyArray<AccountProfile>;
}) {
  const gt = useGT();
  const canLink = useAtomValue(deployEnvironment.link.permissionAtom(environmentId));
  const link = useAtomCommand(deployEnvironment.link, { label: `link ${provider.label}` });
  const [label, setLabel] = useState("");
  const [teamId, setTeamId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [linkWarnings, setLinkWarnings] = useState<ReadonlyArray<DeployWarning>>([]);

  const addAccount = async () => {
    setBusy(true);
    setFailure(null);
    setLinkWarnings([]);
    const trimmedLabel = label.trim();
    const trimmedTeam = teamId.trim();
    const result = await link({
      environmentId,
      input: {
        pluginId: provider.pluginId,
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
    } else {
      setAuthorizeUrl(null);
      setLabel("");
      setTeamId("");
      setLinkWarnings(result.value.result.warnings ?? []);
    }
  };

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {provider.label}
            {!provider.running ? <Badge variant="outline">{gt("Off in Plugins")}</Badge> : null}
          </span>
        }
        description={
          <>
            {!provider.running ? (
              <T>Turn this plugin on in Plugins to link an account.</T>
            ) : accounts.length === 0 ? (
              <T>Link one or more accounts to deploy with this provider.</T>
            ) : (
              <T>Add another named account for a different team or profile.</T>
            )}
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
          provider.running ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <Input
                size="sm"
                className="w-32"
                value={label}
                disabled={!canLink || busy}
                placeholder={gt("Account name")}
                aria-label={gt("{provider} account name", { provider: provider.label })}
                onChange={(event) => setLabel(event.target.value)}
              />
              <Input
                size="sm"
                className="w-28"
                value={teamId}
                disabled={!canLink || busy}
                placeholder={gt("Team ID (optional)")}
                aria-label={gt("{provider} team ID", { provider: provider.label })}
                onChange={(event) => setTeamId(event.target.value)}
              />
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                size="sm"
                className="w-40"
                value={token}
                disabled={!canLink || busy}
                placeholder={gt("Access token (optional)")}
                aria-label={gt("{provider} access token", { provider: provider.label })}
                onChange={(event) => setToken(event.target.value)}
              />
              <Button size="xs" disabled={!canLink || busy} onClick={() => void addAccount()}>
                {accounts.length > 0 ? gt("Add account") : gt("Link")}
              </Button>
            </div>
          ) : null
        }
      >
        <AccountWarnings warnings={linkWarnings} />
      </SettingsRow>
      {accounts.map((account) => (
        <AccountCardRow
          key={account.id}
          environmentId={environmentId}
          provider={provider}
          account={account}
          profiles={profiles}
        />
      ))}
    </>
  );
}

function AccountCardRow({
  environmentId,
  provider,
  account,
  profiles,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: DeployProviderSummary;
  readonly account: DeployAccountSummary;
  readonly profiles: ReadonlyArray<AccountProfile>;
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
  const warnings = account.status.warnings ?? [];

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
          <span className="text-xs font-normal text-muted-foreground">{provider.label}</span>
          <AccountStatusBadge running={provider.running} state={account.status.state} />
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
      {profiles.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
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
    </SettingsRow>
  );
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
