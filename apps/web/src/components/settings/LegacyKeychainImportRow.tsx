import type { EnvironmentId, LegacyKeychainImportResult } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { T, useGT } from "gt-react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const total = (result: LegacyKeychainImportResult) =>
  result.moved + result.alreadyPresent + result.leftBehind + result.failed;

export function LegacyKeychainImportRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const run = useAtomCommand(serverEnvironment.importLegacyKeychain);

  const report = (result: LegacyKeychainImportResult) => {
    if (total(result) === 0) {
      toastManager.add({
        type: "success",
        title: gt("Nothing to import"),
        description: gt("No old keychain items were found."),
      });
      return;
    }
    const counts = {
      moved: result.moved,
      alreadyPresent: result.alreadyPresent,
      leftBehind: result.leftBehind,
    };
    if (result.failed > 0) {
      toastManager.add({
        type: "error",
        title: gt("Some old keychain items could not be imported"),
        description: gt(
          "{moved} moved, {alreadyPresent} already present, {leftBehind} left behind, {failed} failed. Unlock the keychain and try again.",
          { ...counts, failed: result.failed },
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: gt("Old keychain items imported"),
      description: gt(
        "{moved} moved, {alreadyPresent} already present, {leftBehind} left behind.",
        counts,
      ),
    });
  };

  const importNow = async () => {
    if (importing) return;
    setImporting(true);
    const result = await run({ environmentId, input: {} }).finally(() => setImporting(false));
    if (result._tag === "Success") {
      report(result.value);
      setOpen(false);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not import old keychain items"),
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <SettingsSection id="keychain" title={gt("Keychain")}>
      <SettingsRow
        title={gt("Import old keychain items")}
        description={gt(
          "Move credentials saved under the old keychain service into p0code. Nothing happens until you choose to import.",
        )}
        control={
          <Button size="sm" variant="outline" disabled={importing} onClick={() => setOpen(true)}>
            {importing ? <T>Importing…</T> : <T>Import…</T>}
          </Button>
        }
      />
      <AlertDialog open={open} onOpenChange={(next) => !importing && setOpen(next)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Import old keychain items?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>macOS will ask for permission for each old keychain item.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={importing} />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button disabled={importing} onClick={() => void importNow()}>
              {importing ? <T>Importing…</T> : <T>Import</T>}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
