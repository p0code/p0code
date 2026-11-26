import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginManifest,
  PluginShopEntryState,
  PluginShopListInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { ExternalLinkIcon, RefreshCwIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
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
import { pluginCapabilityCopy } from "./pluginCapabilityCopy";
import { pluginInstallError } from "./pluginInstall.logic";
import { PluginConsentDialog } from "./PluginConsentDialog";

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

function SourceBadge({ state }: { readonly state: PluginShopEntryState }) {
  const gt = useGT();
  return (
    <Badge variant={state.entry.verified ? "secondary" : "outline"}>
      {state.entry.verified ? <ShieldCheckIcon /> : null}
      {state.entry.verified
        ? gt("Verified publisher")
        : state.entry.source === "official"
          ? gt("Official")
          : gt("Community")}
    </Badge>
  );
}

function EntryCard({
  state,
  busy,
  onOpen,
  onInstall,
  onUpdate,
}: {
  readonly state: PluginShopEntryState;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onInstall: () => void;
  readonly onUpdate: () => void;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        {state.entry.iconUrl ? (
          <img
            src={state.entry.iconUrl}
            alt=""
            className="size-10 shrink-0 rounded-lg border object-cover"
          />
        ) : (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted font-mono text-xs">
            {state.entry.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{state.entry.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {gt("by")} {state.entry.author.name}
          </p>
        </div>
        <SourceBadge state={state} />
      </div>
      <p className="line-clamp-3 text-sm text-muted-foreground">{state.entry.description}</p>
      <div className="flex flex-wrap gap-1">
        {state.entry.versions
          .find((version) => version.version === state.selectedVersion?.version)
          ?.capabilities.map((capability) => (
            <Badge key={capability} variant="outline">
              {capability}
            </Badge>
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {state.installedVersion ? (
          <Badge variant="outline">
            {gt("Installed")} {state.installedVersion}
          </Badge>
        ) : null}
        {state.updateAvailable ? <Badge>{gt("Update available")}</Badge> : null}
        {!state.compatible ? <Badge variant="destructive">{gt("Incompatible")}</Badge> : null}
        <span className="text-muted-foreground">
          {state.selectedVersion ? `v${state.selectedVersion.version}` : null}
          {state.selectedVersion ? ` · ${formatBytes(state.selectedVersion.sizeBytes)}` : null}
        </span>
      </div>
      <div className="mt-auto flex flex-wrap gap-2">
        {state.installed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onUpdate}
            aria-label={gt("Update")}
          >
            <T>Update</T>
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || !state.compatible || state.selectedVersion === null}
            onClick={onInstall}
          >
            <T>Install</T>
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onOpen}>
          <T>Open</T>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          render={<a href={state.entry.repoUrl} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon />
          <T>Repo</T>
        </Button>
      </div>
    </div>
  );
}

export function PluginShopTab({
  environmentId,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly onChange?: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const allowed = useAtomValue(serverEnvironment.pluginsShopInstall.permissionAtom(environmentId));
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [installedOnly, setInstalledOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<PluginManifest | null>(null);
  const input: PluginShopListInput = {
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(category ? { category } : {}),
    ...(installedOnly ? { installedOnly: true } : {}),
  };
  const shop = useEnvironmentQuery(serverEnvironment.pluginsShopList({ environmentId, input }));
  const refresh = useAtomCommand(serverEnvironment.pluginsShopRefresh, { reportFailure: false });
  const install = useAtomCommand(serverEnvironment.pluginsShopInstall, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.pluginsShopUpdate, { reportFailure: false });
  const consent = useAtomCommand(serverEnvironment.pluginsConsent, { reportFailure: false });
  const fail = (cause: Cause.Cause<unknown>) =>
    setError(m(pluginInstallError(Cause.squash(cause))));
  const run = async (action: () => ReturnType<typeof install>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    if (result._tag === "Failure") fail(result.cause);
    else {
      if (result.value.record.stagedVersion && result.value.manifest)
        setReview(result.value.manifest);
      shop.refresh();
      onChange?.();
    }
    setBusy(false);
    return result._tag === "Success";
  };
  const refreshShop = async () => {
    setBusy(true);
    setError(null);
    const result = await refresh({ environmentId, input: {} });
    if (result._tag === "Failure") fail(result.cause);
    shop.refresh();
    setBusy(false);
  };
  const entries = shop.data?.entries ?? [];
  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-3 text-sm text-muted-foreground">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <ShieldAlertIcon className="size-4" />
          <T>What the shop checks, and what it does not</T>
        </p>
        <p className="mt-2">
          <T>
            Catalog entries are metadata only. p0code downloads the bundle, checks its checksum and
            manifest, refuses a different plugin API, and asks you to consent to every capability
            before any code runs. Verified means the repo is owned by p0code. It is not a security
            audit.
          </T>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <Input
            aria-label={gt("Search the shop")}
            placeholder={gt("Search plugins")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          items={[
            { value: "all", label: gt("All categories") },
            ...(shop.data?.categories ?? []).map((item) => ({ value: item, label: item })),
          ]}
          value={category ?? "all"}
          onValueChange={(value) => setCategory(value === null || value === "all" ? null : value)}
        >
          <SelectTrigger size="sm" className="w-44" aria-label={gt("Category")}>
            <SelectValue placeholder={gt("All categories")} />
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            <SelectItem value="all">{gt("All categories")}</SelectItem>
            {(shop.data?.categories ?? []).map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          variant={installedOnly ? "default" : "outline"}
          aria-pressed={installedOnly}
          onClick={() => setInstalledOnly((value) => !value)}
        >
          <T>Installed only</T>
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refreshShop()}>
          <RefreshCwIcon />
          <T>Refresh</T>
        </Button>
      </div>
      {shop.error ? <p role="alert">{m(pluginInstallError(shop.error))}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {shop.data?.error ? (
        <Alert variant="warning">
          <AlertDescription>
            <p>{m(pluginInstallError(shop.data.error))}</p>
            {shop.data.stale && shop.data.fetchedAt ? (
              <p>
                <T>
                  Showing the catalog from{" "}
                  <Var>{new Date(shop.data.fetchedAt).toLocaleString()}</Var>.
                </T>
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {shop.data?.skippedEntries ? (
        <p role="status" className="text-xs text-muted-foreground">
          <T>
            <Var>{shop.data.skippedEntries}</Var> shop entries were skipped because they failed
            p0code's catalog checks.
          </T>
        </p>
      ) : null}
      {shop.isPending && !shop.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          <T>Loading the shop…</T>
        </p>
      ) : null}
      {shop.data && entries.length === 0 && !shop.data.error ? (
        <p className="text-sm text-muted-foreground">
          <T>No plugins match these filters.</T>
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {entries.map((state) => (
          <EntryCard
            key={state.entry.id}
            state={state}
            busy={busy || !allowed}
            onOpen={() => setOpenId(state.entry.id)}
            onInstall={() =>
              void run(() => install({ environmentId, input: { id: state.entry.id } }))
            }
            onUpdate={() =>
              void run(() => update({ environmentId, input: { id: state.entry.id } }))
            }
          />
        ))}
      </div>
      {openId ? (
        <ShopEntryDialog
          environmentId={environmentId}
          id={openId}
          allowed={allowed}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            shop.refresh();
            onChange?.();
          }}
          onStaged={(manifest) => setReview(manifest)}
        />
      ) : null}
      <PluginConsentDialog
        manifest={review}
        open={review !== null}
        busy={busy}
        allowed={allowed}
        error={error}
        onKeepStaged={() => {
          if (!busy) setReview(null);
        }}
        onConfirm={() => {
          if (!review) return;
          void run(() =>
            consent({
              environmentId,
              input: {
                id: review.id,
                version: review.version,
                capabilities: review.capabilities,
              },
            }),
          ).then((ok) => {
            if (ok) setReview(null);
          });
        }}
      />
    </div>
  );
}

function ShopEntryDialog({
  environmentId,
  id,
  allowed,
  onClose,
  onChanged,
  onStaged,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly allowed: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  readonly onStaged: (manifest: PluginManifest) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const detail = useEnvironmentQuery(
    serverEnvironment.pluginsShopEntry({ environmentId, input: { id } }),
  );
  const install = useAtomCommand(serverEnvironment.pluginsShopInstall, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.pluginsShopUpdate, { reportFailure: false });
  const uninstall = useAtomCommand(serverEnvironment.pluginsShopUninstall, {
    reportFailure: false,
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const state = detail.data?.entry ?? null;
  const run = async (action: () => ReturnType<typeof install>) => {
    setWorking(true);
    setError(null);
    const result = await action();
    if (result._tag === "Failure") setError(m(pluginInstallError(Cause.squash(result.cause))));
    else {
      if (result.value.record.stagedVersion && result.value.manifest)
        onStaged(result.value.manifest);
      onChanged();
      detail.refresh();
    }
    setWorking(false);
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next && !working) onClose();
        }}
      >
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{state?.entry.name ?? gt("Plugin")}</DialogTitle>
            <DialogDescription>
              {state ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {gt("by")} {state.entry.author.name}
                  </span>
                  <SourceBadge state={state} />
                  {state.installedVersion ? (
                    <Badge variant="outline">
                      {gt("Installed")} {state.installedVersion}
                    </Badge>
                  ) : null}
                  {state.updateAvailable ? <Badge>{gt("Update available")}</Badge> : null}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {detail.error ? <p role="alert">{m(pluginInstallError(detail.error))}</p> : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {state ? (
                <>
                  <p className="text-sm">
                    {state.entry.longDescription ?? state.entry.description}
                  </p>
                  {state.entry.screenshotUrls.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {state.entry.screenshotUrls.map((url) => (
                        <img
                          key={url}
                          src={url}
                          alt={gt("Screenshot of {name}", { name: state.entry.name })}
                          className="aspect-video w-full rounded-lg border object-cover"
                        />
                      ))}
                    </div>
                  ) : null}
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <dt className="text-muted-foreground">
                      <T>Version</T>
                    </dt>
                    <dd>{state.selectedVersion?.version ?? gt("No compatible version")}</dd>
                    <dt className="text-muted-foreground">
                      <T>Size</T>
                    </dt>
                    <dd>
                      {state.selectedVersion ? formatBytes(state.selectedVersion.sizeBytes) : "-"}
                    </dd>
                    <dt className="text-muted-foreground">
                      <T>License</T>
                    </dt>
                    <dd>{state.entry.license}</dd>
                    <dt className="text-muted-foreground">
                      <T>Source</T>
                    </dt>
                    <dd>{state.entry.source === "official" ? gt("Official") : gt("Community")}</dd>
                  </dl>
                  <div>
                    <p className="mb-2 text-sm font-medium">
                      <T>Capabilities</T>
                    </p>
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {(state.selectedVersion?.capabilities ?? []).map((capability) => (
                        <li key={capability}>
                          <Badge variant="outline">{capability}</Badge>
                          <p className="mt-1">{m(pluginCapabilityCopy[capability])}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {state.entry.versions.length > 1 ? (
                    <div>
                      <p className="mb-2 text-sm font-medium">
                        <T>Versions</T>
                      </p>
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {state.entry.versions.map((version) => (
                          <li key={version.version}>
                            v{version.version} · {formatBytes(version.sizeBytes)} ·{" "}
                            {new Date(version.publishedAt).toLocaleDateString()}
                            {version.version === state.entry.latestVersion
                              ? ` · ${gt("latest")}`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {confirmRemove ? (
                    <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
                      <p className="text-sm">
                        <T>
                          Remove this plugin? Its code is deleted; data and secrets stay unless you
                          purge them.
                        </T>
                      </p>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={purging}
                          onChange={(event) => setPurging(event.target.checked)}
                        />
                        <T>Also permanently delete plugin data and secrets</T>
                      </label>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setConfirmRemove(false)}>
                          <T>Cancel</T>
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={working || !allowed}
                          onClick={() =>
                            void run(() =>
                              uninstall({
                                environmentId,
                                input: { id: state.entry.id, purgeData: purging },
                              }),
                            ).then(() => {
                              setConfirmRemove(false);
                              onClose();
                            })
                          }
                        >
                          <T>Remove</T>
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            {state?.installed ? (
              <Button
                variant="destructive"
                disabled={working || !allowed}
                onClick={() => setConfirmRemove(true)}
              >
                <T>Uninstall</T>
              </Button>
            ) : null}
            <Button variant="outline" disabled={working} onClick={onClose}>
              <T>Close</T>
            </Button>
            <Button
              disabled={
                working ||
                !allowed ||
                state === null ||
                state.selectedVersion === null ||
                (!state.updateAvailable && state.installed)
              }
              onClick={() => {
                if (!state) return;
                void run(() =>
                  state.installed
                    ? update({ environmentId, input: { id: state.entry.id } })
                    : install({ environmentId, input: { id: state.entry.id } }),
                );
              }}
            >
              {state?.installed ? <T>Update</T> : <T>Install</T>}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
