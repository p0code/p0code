import { useAtomValue } from "@effect/atom-react";
import { deployTargetFor, isDeployProviderReady } from "@t3tools/client-runtime/state/deploy";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DeployEnvironment,
  DeployOverview,
  DeployPendingApproval,
  DeployProviderSummary,
  DeployRecord,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { ExternalLinkIcon, RocketIcon } from "lucide-react";
import { useState } from "react";

import { deployEnvironment } from "../../state/deploy";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const [dialog, setDialog] = useState<DeployPreselection | null>(
    preselect.projectId === undefined ? null : preselect,
  );
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

  return (
    <>
      <SettingsSection title={gt("Deploy providers")}>
        {overview.providers.map((provider) => (
          <ProviderRow key={provider.pluginId} environmentId={environmentId} provider={provider} />
        ))}
      </SettingsSection>

      {overview.approvals.length > 0 ? (
        <SettingsSection title={gt("Waiting for approval")}>
          {overview.approvals.map((approval) => (
            <ApprovalRow
              key={approval.id}
              environmentId={environmentId}
              approval={approval}
              projectTitle={titleOf(approval.projectId)}
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
              key={`${deployment.pluginId}:${deployment.deploymentId}`}
              environmentId={environmentId}
              deployment={deployment}
              projectTitle={titleOf(deployment.projectId)}
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
    </>
  );
}

function ProviderStatusBadge({ provider }: { readonly provider: DeployProviderSummary }) {
  const gt = useGT();
  if (!provider.running) return <Badge variant="outline">{gt("Off in Plugins")}</Badge>;
  switch (provider.status.state) {
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

function ProviderRow({
  environmentId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: DeployProviderSummary;
}) {
  const gt = useGT();
  const canLink = useAtomValue(deployEnvironment.link.permissionAtom(environmentId));
  const link = useAtomCommand(deployEnvironment.link, { label: `link ${provider.label}` });
  const unlink = useAtomCommand(deployEnvironment.unlink, { label: `unlink ${provider.label}` });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const linked = provider.status.state === "linked";

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    const result = await link({
      environmentId,
      input:
        token.length > 0 ? { pluginId: provider.pluginId, token } : { pluginId: provider.pluginId },
    });
    setBusy(false);
    // The token is the provider's now; drop the copy in this page.
    setToken("");
    if (result._tag === "Failure") {
      setFailure(failureText(result, gt("The request failed.")));
      return;
    }
    setAuthorizeUrl(result.value._tag === "pending" ? result.value.authorizeUrl : null);
  };

  const remove = async () => {
    setBusy(true);
    setFailure(null);
    const result = await unlink({ environmentId, input: { pluginId: provider.pluginId } });
    setBusy(false);
    if (result._tag === "Failure") setFailure(failureText(result, gt("The request failed.")));
  };

  const account = provider.status.accountLabel;
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {provider.label}
          <ProviderStatusBadge provider={provider} />
        </span>
      }
      description={
        <>
          {!provider.running ? (
            <T>Turn this plugin on in Plugins to link an account.</T>
          ) : account ? (
            <T>
              Account: <Var>{account}</Var>
            </T>
          ) : null}
          {provider.status.message ? (
            <span className="block">{provider.status.message}</span>
          ) : null}
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
          <div className="flex items-center gap-2">
            {linked ? null : (
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                size="sm"
                className="w-44"
                value={token}
                disabled={!canLink || busy}
                placeholder={gt("Access token (optional)")}
                aria-label={gt("{provider} access token", { provider: provider.label })}
                onChange={(event) => setToken(event.target.value)}
              />
            )}
            <Button
              size="xs"
              variant={linked ? "outline" : "default"}
              disabled={!canLink || busy}
              onClick={() => void (linked ? remove() : submit())}
            >
              {linked
                ? gt("Unlink")
                : provider.status.state === "expired"
                  ? gt("Relink")
                  : gt("Link")}
            </Button>
          </div>
        ) : null
      }
    />
  );
}

function ProjectRow({
  environmentId,
  projectId,
  title,
  overview,
  onDeploy,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly overview: DeployOverview;
  readonly onDeploy: () => void;
}) {
  const gt = useGT();
  const canMap = useAtomValue(deployEnvironment.mapProject.permissionAtom(environmentId));
  const canDeploy = useAtomValue(deployEnvironment.start.permissionAtom(environmentId));
  const mapProject = useAtomCommand(deployEnvironment.mapProject);
  const target = deployTargetFor(overview, projectId);
  const ready = overview.providers.filter(isDeployProviderReady);
  const value = target
    ? JSON.stringify([
        target.mapping.pluginId,
        target.mapping.providerProjectId,
        target.mapping.providerProjectName,
      ])
    : "";

  return (
    <SettingsRow
      title={title}
      description={
        target ? (
          <>
            <T>
              Deploys to <Var>{target.mapping.providerProjectName}</Var> on{" "}
              <Var>{target.provider?.label ?? target.mapping.pluginId}</Var>
            </T>
            {isDeployProviderReady(target.provider) ? (
              <ProjectDomains environmentId={environmentId} projectId={projectId} />
            ) : null}
          </>
        ) : (
          <T>Not mapped to a deploy target.</T>
        )
      }
      control={
        <div className="flex items-center gap-2">
          <Select
            value={value}
            disabled={!canMap || ready.length === 0}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              const mapping =
                next === ""
                  ? null
                  : (() => {
                      const [pluginId, providerProjectId, providerProjectName] = JSON.parse(
                        next,
                      ) as [string, string, string];
                      return { pluginId, providerProjectId, providerProjectName };
                    })();
              void mapProject({ environmentId, input: { projectId, mapping } });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-48"
              aria-label={gt("Deploy target for {project}", { project: title })}
            >
              <SelectValue>
                {target ? target.mapping.providerProjectName : gt("Choose target")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">{gt("No target")}</SelectItem>
              {ready.map((provider) => (
                <ProviderProjectItems
                  key={provider.pluginId}
                  environmentId={environmentId}
                  provider={provider}
                />
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="xs"
            disabled={!canDeploy || target === null || !isDeployProviderReady(target.provider)}
            onClick={onDeploy}
          >
            <RocketIcon />
            <T>Deploy</T>
          </Button>
        </div>
      }
    />
  );
}

function ProviderProjectItems({
  environmentId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: DeployProviderSummary;
}) {
  const query = useEnvironmentQuery(
    deployEnvironment.providerProjects({ environmentId, input: { pluginId: provider.pluginId } }),
  );
  return (query.data ?? []).map((project) => (
    <SelectItem
      key={`${provider.pluginId}:${project.id}`}
      value={JSON.stringify([provider.pluginId, project.id, project.name])}
    >
      {project.name}
      <span className="text-muted-foreground"> · {provider.label}</span>
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
}: {
  readonly environmentId: EnvironmentId;
  readonly approval: DeployPendingApproval;
  readonly projectTitle: string;
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
        <T>
          A thread without Full access asked to deploy to <Var>{approval.providerProjectName}</Var>{" "}
          (<Var>{approval.environment}</Var>).
        </T>
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
}: {
  readonly environmentId: EnvironmentId;
  readonly deployment: DeployRecord;
  readonly projectTitle: string;
}) {
  const gt = useGT();
  const status = useEnvironmentQuery(
    deployEnvironment.deploymentStatus({
      environmentId,
      input: { pluginId: deployment.pluginId, deploymentId: deployment.deploymentId },
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
            {deployment.environment}
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
      input: { pluginId: deployment.pluginId, deploymentId: deployment.deploymentId, follow: true },
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
  const [environment, setEnvironment] = useState<DeployEnvironment>("preview");
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [sourceKind, setSourceKind] = useState<"git" | "local-build">("git");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [approval, setApproval] = useState<DeployPendingApproval | null>(null);
  const target = deployTargetFor(overview, projectId);

  const deploy = async () => {
    setBusy(true);
    setFailure(null);
    const trimmed = branch.trim();
    const result = await start({
      environmentId,
      input: {
        projectId,
        environment,
        sourceKind,
        ...(trimmed.length > 0 ? { branch: trimmed } : {}),
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
                To <Var>{target.mapping.providerProjectName}</Var> on{" "}
                <Var>{target.provider?.label ?? target.mapping.pluginId}</Var>.
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
              <Button
                disabled={
                  busy || !canDeploy || target === null || !isDeployProviderReady(target.provider)
                }
                onClick={() => void deploy()}
              >
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
