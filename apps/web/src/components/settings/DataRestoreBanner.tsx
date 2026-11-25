import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, Var } from "gt-react";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";

export function DataRestoreBanner() {
  const { environment } = useSettingsScope();
  return environment?.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.plugins === true ? (
    <EnvironmentRestoreBanner
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ) : null;
}

function EnvironmentRestoreBanner({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canManage = useAtomValue(
    serverEnvironment.dataRestoreApprove.permissionAtom(environmentId),
  );
  return canManage ? <PendingRestoreBanner environmentId={environmentId} /> : null;
}

function PendingRestoreBanner({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const pending = useEnvironmentQuery(
    serverEnvironment.dataRestorePending({ environmentId, input: {} }),
  );
  const approve = useAtomCommand(serverEnvironment.dataRestoreApprove);
  const cancel = useAtomCommand(serverEnvironment.dataRestoreCancel);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const restore = pending.data;
  if (!restore) return null;
  const confirming = confirmingId === restore.id;
  return (
    <div role="status" className="space-y-2 border-b p-4 text-sm">
      <p>
        <T>
          A backup from <Var>{restore.snapshotCreatedAt}</Var> on environment{" "}
          <Var>{restore.sourceEnvironmentId}</Var> is ready to restore (<Var>{restore.files}</Var>{" "}
          files, <Var>{restore.bytes}</Var> bytes).
        </T>
      </p>
      <p>
        <T>
          Restoring replaces this environment’s chats, attachments, settings and keybindings, then
          restarts the server. The current data is kept in a restore-replaced folder on this
          machine. Provider sign-in and device pairing may be needed again.
        </T>
      </p>
      {confirming ? (
        <p>
          <T>Confirm that you want to replace this environment’s data with this backup.</T>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          variant={confirming ? "destructive" : "outline"}
          onClick={async () => {
            if (!confirming) {
              setConfirmingId(restore.id);
              return;
            }
            setBusy(true);
            await approve({ environmentId, input: { id: restore.id } });
            setBusy(false);
          }}
        >
          {confirming ? <T>Replace data and restart</T> : <T>Review restore</T>}
        </Button>
        <Button
          disabled={busy}
          variant="ghost"
          onClick={async () => {
            setBusy(true);
            await cancel({ environmentId, input: {} });
            setBusy(false);
          }}
        >
          <T>Cancel restore</T>
        </Button>
      </div>
    </div>
  );
}
