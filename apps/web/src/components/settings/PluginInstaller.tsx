import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginInstallRecord,
  PluginManifest,
  PluginCatalog,
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
} from "../ui/dialog";
import { SettingsSection } from "./settingsLayout";
import { pluginCapabilityCopy } from "./pluginCapabilityCopy";
import { pluginInstallError, pluginUpload, validGithubInput } from "./pluginInstall.logic";

type Catalog = Schema.Schema.Type<typeof PluginCatalog>;

function PluginCapabilities({ manifest }: { readonly manifest: PluginManifest }) {
  const m = useMessages();
  return (
    <ul className="space-y-2 text-muted-foreground">
      {manifest.capabilities.map((capability) => (
        <li key={capability}>
          <Badge variant="outline">{capability}</Badge>
          <p className="mt-1">{m(pluginCapabilityCopy[capability])}</p>
        </li>
      ))}
    </ul>
  );
}

export function PluginInstaller({
  environmentId,
  nativeTarget = null,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly nativeTarget?: string | null;
  readonly onChange?: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const allowed = useAtomValue(serverEnvironment.pluginsInstall.permissionAtom(environmentId));
  const installations = useEnvironmentQuery(
    serverEnvironment.pluginsInstalledList({ environmentId, input: {} }),
  );
  const installed = installations.data;
  const catalog = useAtomCommand(serverEnvironment.pluginsCatalog, { reportFailure: false });
  const install = useAtomCommand(serverEnvironment.pluginsInstall, { reportFailure: false });
  const setEnabled = useAtomCommand(serverEnvironment.pluginsSetEnabled, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.pluginsUpdate, { reportFailure: false });
  const consent = useAtomCommand(serverEnvironment.pluginsConsent, { reportFailure: false });
  const rollback = useAtomCommand(serverEnvironment.pluginsRollback, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.pluginsRemove, { reportFailure: false });
  const [shop, setShop] = useState<Catalog | null>(null);
  const [mode, setMode] = useState<"closed" | "github" | "local" | "shop">("closed");
  const [updateId, setUpdateId] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<PluginManifest | null>(null);
  const [removing, setRemoving] = useState<PluginInstallRecord | null>(null);
  const [purge, setPurge] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const fail = (cause: Cause.Cause<unknown>) =>
    setError(m(pluginInstallError(Cause.squash(cause))));
  const refresh = () => {
    installations.refresh();
    onChange?.();
  };
  const run = async (action: () => ReturnType<typeof install>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    if (result._tag === "Failure") fail(result.cause);
    else {
      if (result.value.record.stagedVersion && result.value.manifest)
        setReview(result.value.manifest);
      refresh();
    }
    setBusy(false);
    return result._tag === "Success";
  };
  const addGithub = async () => {
    if (!validGithubInput(source.trim())) {
      setError(m(pluginInstallError("Bad URL")));
      return;
    }
    if (
      await run(() =>
        updateId
          ? update({ environmentId, input: { id: updateId, source: source.trim() } })
          : install({ environmentId, input: { source: source.trim() } }),
      )
    )
      setMode("closed");
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const prepared = await pluginUpload(files).then(
      (input) => ({ input, error: null }),
      (cause: unknown) => ({ input: null, error: cause }),
    );
    if (!prepared.input) {
      setError(m(pluginInstallError(prepared.error)));
      setBusy(false);
      return;
    }
    const input = prepared.input;
    if (
      await run(() =>
        updateId
          ? update({ environmentId, input: { ...input, id: updateId } })
          : install({ environmentId, input }),
      )
    )
      setMode("closed");
  };
  const browse = async () => {
    setMode("shop");
    setError(null);
    setBusy(true);
    const result = await catalog({ environmentId, input: {} });
    if (result._tag === "Success") setShop(result.value);
    else fail(result.cause);
    setBusy(false);
  };
  const pickFolder = async () => {
    const api = readLocalApi();
    if (!window.desktopBridge || !api || !nativeTarget) {
      folder.current?.click();
      return;
    }
    const path = await api.dialogs
      .pickFolder({ targetEnvironmentId: nativeTarget })
      .catch(() => null);
    if (
      path &&
      (await run(() =>
        updateId
          ? update({ environmentId, input: { id: updateId, source: path } })
          : install({ environmentId, input: { source: path } }),
      ))
    )
      setMode("closed");
  };
  return (
    <>
      <SettingsSection
        title={gt("Installed plugins")}
        headerAction={
          <Button
            size="sm"
            disabled={!allowed || busy}
            onClick={() => {
              setError(null);
              setUpdateId(null);
              setMode("github");
            }}
          >
            <T>Add plugin</T>
          </Button>
        }
      >
        <div className="space-y-4 px-4 py-3 text-sm">
          {installations.error ? (
            <p role="alert">{m(pluginInstallError(installations.error))}</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !allowed}
            onClick={() => void refresh()}
          >
            <T>Refresh plugins</T>
          </Button>
          {installed?.installations
            .filter((record) => record.versions.length > 0)
            .map((record) => {
              const active = record.versions.find(
                (version) => version.version === record.activeVersion,
              );
              const staged = installed.stagedManifests.find(
                (manifest) => manifest.id === record.id,
              );
              const manifest =
                installed.snapshot.plugins.find((plugin) => plugin.manifest.id === record.id)
                  ?.manifest ?? staged;
              const origin = active?.source ?? record.versions.at(-1)?.source;
              return (
                <div key={record.id} className="space-y-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2 font-mono">
                    <span>{record.id}</span>
                    <Badge variant="outline">{record.activeVersion ?? gt("Inactive")}</Badge>
                    <Badge variant="secondary">
                      {origin?.kind === "github"
                        ? gt("GitHub")
                        : origin?.kind === "catalog"
                          ? gt("Catalog")
                          : gt("Local")}
                    </Badge>
                  </div>
                  {manifest ? (
                    <div className="flex flex-wrap gap-1">
                      {manifest.capabilities.map((capability) => (
                        <Badge key={capability} variant="outline">
                          {capability}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {record.stagedVersion ? (
                    <div role="status" className="space-y-2 border-l-2 border-warning pl-3">
                      <p>
                        <T>
                          Version <Var>{record.stagedVersion}</Var> is staged and waiting for
                          consent. The active version has not changed.
                        </T>
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!allowed || busy || !staged}
                        onClick={() => setReview(staged ?? null)}
                      >
                        <T>Review and activate</T>
                      </Button>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!allowed || busy}
                      onClick={() => {
                        if (origin?.kind === "github") {
                          setUpdateId(record.id);
                          setSource(origin.url);
                          setMode("github");
                        } else if (origin?.kind === "local" && !origin.path) {
                          setUpdateId(record.id);
                          setMode("local");
                        } else void run(() => update({ environmentId, input: { id: record.id } }));
                      }}
                    >
                      <T>Update</T>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!allowed || busy || !record.previousVersion}
                      onClick={() =>
                        void run(() => rollback({ environmentId, input: { id: record.id } }))
                      }
                    >
                      <T>Roll back</T>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !allowed ||
                        busy ||
                        !installed.snapshot.plugins.find(
                          (plugin) => plugin.manifest.id === record.id,
                        )?.enabled
                      }
                      onClick={async () => {
                        setBusy(true);
                        const result = await setEnabled({
                          environmentId,
                          input: { pluginId: record.id, enabled: false },
                        });
                        if (result._tag === "Failure") fail(result.cause);
                        refresh();
                        setBusy(false);
                      }}
                    >
                      <T>Disable</T>
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!allowed || busy}
                      onClick={() => {
                        setPurge(false);
                        setRemoving(record);
                      }}
                    >
                      <T>Remove</T>
                    </Button>
                  </div>
                </div>
              );
            })}
        </div>
      </SettingsSection>
      <Dialog
        open={mode !== "closed"}
        onOpenChange={(open) => {
          if (!open && !busy) setMode("closed");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{updateId ? <T>Update</T> : <T>Add plugin</T>}</DialogTitle>
            <DialogDescription>
              <T>Choose a prebuilt plugin. You will review its capabilities before activation.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={mode === "github" ? "default" : "outline"}
                disabled={busy}
                onClick={() => setMode("github")}
              >
                <T>GitHub URL</T>
              </Button>
              <Button
                size="sm"
                variant={mode === "local" ? "default" : "outline"}
                disabled={busy}
                onClick={() => setMode("local")}
              >
                <T>Local folder or file</T>
              </Button>
              <Button
                size="sm"
                variant={mode === "shop" ? "default" : "outline"}
                disabled={busy}
                onClick={() => void browse()}
              >
                <T>Browse the shop</T>
              </Button>
            </div>
            {mode === "github" ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addGithub();
                }}
              >
                <Input
                  aria-label={gt("GitHub URL")}
                  placeholder="owner/repo@tag"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  disabled={busy}
                />
                <Button type="submit" disabled={!allowed || busy || !source.trim()}>
                  {updateId ? <T>Update</T> : <T>Install</T>}
                </Button>
              </form>
            ) : null}
            {mode === "local" ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  <T>
                    Choose a folder with manifest.json and plugin.mjs, or upload a .zip or .tgz.
                    Files are sent to the selected server.
                  </T>
                </p>
                <div className="flex gap-2">
                  <Button disabled={!allowed || busy} onClick={() => void pickFolder()}>
                    <T>Choose folder</T>
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!allowed || busy}
                    onClick={() => file.current?.click()}
                  >
                    <T>Choose files</T>
                  </Button>
                </div>
                <input
                  hidden
                  ref={file}
                  type="file"
                  multiple
                  accept=".zip,.tgz,.gz,.json,.mjs"
                  aria-label={gt("Plugin files")}
                  onChange={(event) => {
                    void upload(event.target.files);
                    event.target.value = "";
                  }}
                />
                <input
                  hidden
                  ref={folder}
                  type="file"
                  multiple
                  {...{ webkitdirectory: "" }}
                  aria-label={gt("Plugin folder")}
                  onChange={(event) => {
                    void upload(event.target.files);
                    event.target.value = "";
                  }}
                />
              </div>
            ) : null}
            {mode === "shop" ? (
              <div className="space-y-3">
                {shop?.plugins.map((entry) => (
                  <div key={entry.id} className="space-y-2 rounded-lg border p-3">
                    <p className="font-mono">
                      {entry.id} · {entry.version}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">{entry.repository}</p>
                    <div className="flex flex-wrap gap-1">
                      {entry.capabilities.map((capability) => (
                        <Badge key={capability} variant="outline">
                          {capability}
                        </Badge>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      disabled={!allowed || busy}
                      onClick={() =>
                        void run(() =>
                          install({ environmentId, input: { source: entry.id } }),
                        ).then((ok) => {
                          if (ok) setMode("closed");
                        })
                      }
                    >
                      <T>Install</T>
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {busy ? (
              <p role="status">
                <T>Working…</T>
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Review plugin capabilities</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Plugins run inside the p0code server with your account's access to files, network
                and credentials. Capabilities are declarations, and only some are enforced. Activate
                only plugins you trust.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {review ? (
              <div className="space-y-3 text-sm">
                <p className="font-mono">
                  {review.id} · {review.version}
                </p>
                <p>{review.description}</p>

                <p>
                  <T>
                    External services:{" "}
                    <Var>{review.externalServices.join(", ") || gt("None declared")}</Var>
                  </T>
                </p>
                <PluginCapabilities manifest={review} />
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setReview(null)}>
              <T>Keep staged</T>
            </Button>
            <Button
              disabled={!allowed || busy || !review}
              onClick={() => {
                if (review)
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
            >
              <T>Confirm and activate</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Remove plugin?</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Plugin code will be removed. Keep its data and secrets unless you explicitly choose
                to delete them.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={purge}
                onChange={(event) => setPurge(event.target.checked)}
                disabled={busy}
              />
              <T>Also permanently delete plugin data and secrets</T>
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              <T>Cancel</T>
            </Button>
            <Button
              variant="destructive"
              disabled={!allowed || busy || !removing}
              onClick={() => {
                if (removing)
                  void run(() =>
                    remove({ environmentId, input: { id: removing.id, purgeData: purge } }),
                  ).then((ok) => {
                    if (ok) setRemoving(null);
                  });
              }}
            >
              <T>Remove</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
