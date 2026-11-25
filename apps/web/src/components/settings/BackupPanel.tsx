import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  BACKUP_PLUGIN_ID,
  type BackupAction,
  type BackupSettingsPatch,
  BackupStatus,
  type Frequency,
  type RemoteBackup,
  RemoteBackup as RemoteBackupSchema,
  type TargetKind,
} from "@t3tools/plugin-backup/actions";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { T, useGT, Var } from "gt-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const decodeStatus = Schema.decodeUnknownOption(BackupStatus);
const decodeList = Schema.decodeUnknownOption(
  Schema.Struct({ backups: Schema.Array(RemoteBackupSchema) }),
);
const POLL_MS = 1_500;

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    Date.parse(iso),
  );

export function BackupDisclosure() {
  return (
    <p className="text-muted-foreground">
      <T>
        Can read a copy of all your chats, attachments and settings, and can propose replacing them
        with a backup.
      </T>{" "}
      <T>
        Encrypted on this machine with your passphrase before upload. Without the passphrase,
        backups cannot be opened by anyone, including you.
      </T>
    </p>
  );
}

export function BackupPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canManage = useAtomValue(serverEnvironment.pluginsInvoke.permissionAtom(environmentId));
  return canManage ? <ManageBackupPanel environmentId={environmentId} /> : null;
}

function ManageBackupPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const invoke = useAtomCommand(serverEnvironment.pluginsInvoke);
  const plugins = useEnvironmentQuery(serverEnvironment.plugins({ environmentId, input: {} }));
  const message =
    plugins.data?.plugins.find((plugin) => plugin.manifest.id === BACKUP_PLUGIN_ID)?.message ??
    null;
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<ReadonlyArray<RemoteBackup> | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<BackupSettingsPatch>({});

  const call = async (action: BackupAction, input: unknown = {}) => {
    const result = await invoke({
      environmentId,
      input: { pluginId: BACKUP_PLUGIN_ID, action, input },
    });
    // Failures are already shown as toasts by useAtomCommand.
    return result._tag === "Success" ? result.value : null;
  };
  const refresh = async () => {
    const decoded = decodeStatus(await call("status"));
    if (Option.isSome(decoded)) setStatus(decoded.value);
  };
  const run = async (action: BackupAction, input: unknown = {}) => {
    setBusy(true);
    const decoded = decodeStatus(await call(action, input));
    if (Option.isSome(decoded)) setStatus(decoded.value);
    setBusy(false);
  };
  const loadBackups = async () => {
    setBusy(true);
    const decoded = decodeList(await call("list"));
    setBackups(Option.isSome(decoded) ? decoded.value.backups : null);
    setBusy(false);
  };
  const save = async (patch: BackupSettingsPatch) => {
    await run("setSettings", patch);
    setDraft({});
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server pushes only a one-line status; details come from the plugin's status action.
  useEffect(() => {
    if (message === null) return;
    void call("status").then((value) => {
      const decoded = decodeStatus(value);
      if (Option.isSome(decoded)) setStatus(decoded.value);
    });
  }, [message, call]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a running job reports progress only through status, so poll until it ends.
  useEffect(() => {
    if (status?.activity == null) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [status?.activity, refresh]);

  if (status === null) return null;
  const { settings, stored } = status;
  const s3 = { ...settings.s3, ...draft.s3 };
  const drive = { ...settings.drive, ...draft.drive };
  const ready =
    stored.passphrase &&
    (settings.target === "s3"
      ? stored.s3SecretAccessKey
      : settings.target === "google-drive" && stored.driveSignedIn);
  const working = busy || status.activity !== null;

  return (
    <div className="space-y-4">
      {status.signInError ? (
        <p role="alert" className="text-destructive">
          {status.signInError}
        </p>
      ) : status.lastResult && !status.lastResult.ok ? (
        <p role="alert" className="text-destructive">
          {status.lastResult.message}
        </p>
      ) : message ? (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      ) : null}

      <ToggleGroup
        aria-label={gt("Backup target")}
        className="w-full *:flex-1"
        value={[settings.target]}
        onValueChange={(next) => {
          const target = next[0] as TargetKind | undefined;
          if (target) void save({ target });
        }}
      >
        <Toggle value="none">
          <T>Off</T>
        </Toggle>
        <Toggle value="google-drive">
          <T>Google Drive</T>
        </Toggle>
        <Toggle value="s3">
          <T>S3</T>
        </Toggle>
      </ToggleGroup>

      {settings.target !== "none" ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={gt("Passphrase")}
            placeholder={stored.passphrase ? gt("Passphrase saved") : gt("Passphrase")}
            value={draft.passphrase ?? ""}
            onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })}
          />
          {!stored.passphrase || draft.passphrase ? (
            <p className="text-muted-foreground text-sm">
              <T>
                Keep a copy somewhere other than this machine. A lost passphrase means lost backups.
              </T>
            </p>
          ) : null}

          {settings.target === "s3" ? (
            <>
              <Input
                aria-label={gt("Endpoint")}
                placeholder="https://s3.us-east-1.amazonaws.com"
                value={s3.endpoint}
                onChange={(event) =>
                  setDraft({ ...draft, s3: { ...draft.s3, endpoint: event.target.value } })
                }
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label={gt("Bucket")}
                  placeholder={gt("Bucket")}
                  value={s3.bucket}
                  onChange={(event) =>
                    setDraft({ ...draft, s3: { ...draft.s3, bucket: event.target.value } })
                  }
                />
                <Input
                  aria-label={gt("Region")}
                  placeholder="us-east-1"
                  value={s3.region}
                  onChange={(event) =>
                    setDraft({ ...draft, s3: { ...draft.s3, region: event.target.value } })
                  }
                />
              </div>
              <Input
                aria-label={gt("Prefix")}
                placeholder="p0code/"
                value={s3.prefix}
                onChange={(event) =>
                  setDraft({ ...draft, s3: { ...draft.s3, prefix: event.target.value } })
                }
              />
              <Input
                aria-label={gt("Access key ID")}
                placeholder={gt("Access key ID")}
                value={s3.accessKeyId}
                onChange={(event) =>
                  setDraft({ ...draft, s3: { ...draft.s3, accessKeyId: event.target.value } })
                }
              />
              <Input
                type="password"
                autoComplete="off"
                aria-label={gt("Secret access key")}
                placeholder={
                  stored.s3SecretAccessKey ? gt("Secret saved") : gt("Secret access key")
                }
                value={draft.s3?.secretAccessKey ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, s3: { ...draft.s3, secretAccessKey: event.target.value } })
                }
              />
              <label className="flex items-center justify-between gap-3">
                <T>Path-style URLs</T>
                <Switch
                  checked={s3.forcePathStyle}
                  onCheckedChange={(forcePathStyle) =>
                    setDraft({ ...draft, s3: { ...draft.s3, forcePathStyle } })
                  }
                />
              </label>
            </>
          ) : (
            <>
              <Input
                aria-label={gt("Google client ID")}
                placeholder={gt("Google client ID")}
                value={drive.clientId}
                onChange={(event) =>
                  setDraft({ ...draft, drive: { ...draft.drive, clientId: event.target.value } })
                }
              />
              <Input
                type="password"
                autoComplete="off"
                aria-label={gt("Google client secret")}
                placeholder={
                  stored.driveClientSecret ? gt("Secret saved") : gt("Google client secret")
                }
                value={draft.drive?.clientSecret ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    drive: { ...draft.drive, clientSecret: event.target.value },
                  })
                }
              />
            </>
          )}
          <Button
            type="submit"
            variant="outline"
            disabled={busy || Object.keys(draft).length === 0}
          >
            <T>Save</T>
          </Button>
        </form>
      ) : null}

      {settings.target === "google-drive" ? (
        status.pendingSignIn ? (
          <div className="flex flex-wrap items-center gap-3">
            <code className="text-lg tracking-widest">{status.pendingSignIn.userCode}</code>
            <Button
              render={
                <a href={status.pendingSignIn.verificationUrl} target="_blank" rel="noreferrer" />
              }
            >
              <T>Approve in browser</T>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void run("driveSignOut")}>
              <T>Cancel</T>
            </Button>
          </div>
        ) : stored.driveSignedIn ? (
          <Button variant="ghost" disabled={busy} onClick={() => void run("driveSignOut")}>
            <T>Sign out of Google Drive</T>
          </Button>
        ) : (
          <Button
            disabled={busy || !stored.driveClientSecret || drive.clientId === ""}
            onClick={() => void run("driveSignIn")}
          >
            <T>Sign in to Google Drive</T>
          </Button>
        )
      ) : null}

      {settings.target !== "none" ? (
        <>
          <ToggleGroup
            aria-label={gt("Schedule")}
            className="w-full *:flex-1"
            value={[settings.frequency]}
            onValueChange={(next) => {
              const frequency = next[0] as Frequency | undefined;
              if (frequency) void save({ frequency });
            }}
          >
            <Toggle value="off">
              <T>Manual</T>
            </Toggle>
            <Toggle value="hourly">
              <T>Hourly</T>
            </Toggle>
            <Toggle value="daily">
              <T>Daily</T>
            </Toggle>
            <Toggle value="weekly">
              <T>Weekly</T>
            </Toggle>
          </ToggleGroup>
          <label className="flex items-center justify-between gap-3">
            <T>Backups to keep</T>
            <Input
              type="number"
              min={1}
              max={1000}
              className="w-24"
              defaultValue={settings.keep}
              onBlur={(event) => {
                const keep = Number(event.target.value);
                if (Number.isInteger(keep) && keep >= 1 && keep !== settings.keep) {
                  void save({ keep });
                }
              }}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-muted-foreground text-sm">
              {status.lastBackup ? (
                <T>
                  Last <Var>{formatTime(status.lastBackup.at)}</Var> ·{" "}
                  <Var>{formatBytes(status.lastBackup.bytes)}</Var>
                </T>
              ) : null}
              {status.nextRunAt ? (
                <>
                  {" · "}
                  <T>
                    Next <Var>{formatTime(status.nextRunAt)}</Var>
                  </T>
                </>
              ) : null}
            </span>
            <Button
              variant="outline"
              disabled={working || !ready}
              onClick={() => void loadBackups()}
            >
              <T>Show backups</T>
            </Button>
            <Button disabled={working || !ready} onClick={() => void run("backupNow")}>
              {status.activity?.kind === "backup" ? <T>Backing up…</T> : <T>Back up now</T>}
            </Button>
          </div>
        </>
      ) : null}

      {status.pendingRestore ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
          <span className="mr-auto">
            <T>
              Restore from <Var>{formatTime(status.pendingRestore.snapshotCreatedAt)}</Var> is
              waiting for confirmation
            </T>
          </span>
          <Button variant="ghost" disabled={busy} onClick={() => void run("cancelRestore")}>
            <T>Cancel restore</T>
          </Button>
        </div>
      ) : null}

      {backups ? (
        <ul className="divide-y rounded-md border">
          {backups.length === 0 ? (
            <li className="p-3 text-muted-foreground">
              <T>No backups yet</T>
            </li>
          ) : (
            backups.map((backup) => (
              <li key={backup.name} className="flex flex-wrap items-center gap-2 p-3">
                <span className="mr-auto">
                  {formatTime(backup.createdAt)}
                  <span className="ml-2 text-muted-foreground text-sm">
                    {formatBytes(backup.bytes)}
                    {backup.mine ? null : ` · ${backup.environmentId}`}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working}
                  onClick={() => void run("verify", { name: backup.name })}
                >
                  {status.activity?.name === backup.name && status.activity.kind === "verify" ? (
                    <T>Checking…</T>
                  ) : (
                    <T>Verify</T>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working}
                  onClick={() => void run("restore", { name: backup.name })}
                >
                  {status.activity?.name === backup.name && status.activity.kind === "restore" ? (
                    <T>Preparing…</T>
                  ) : (
                    <T>Restore</T>
                  )}
                </Button>
              </li>
            ))
          )}
        </ul>
      ) : null}
      {status.lastResult?.ok && status.lastResult.kind !== "backup" ? (
        <p role="status" className="text-muted-foreground text-sm">
          {status.lastResult.message}
        </p>
      ) : null}
    </div>
  );
}
