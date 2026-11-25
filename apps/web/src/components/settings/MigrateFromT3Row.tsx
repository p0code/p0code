import type { DesktopT3ImportState } from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useState } from "react";

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
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

export function MigrateFromT3Row() {
  const gt = useGT();
  const resolve = useMessages();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.t3Import;
  const [state, setState] = useState<DesktopT3ImportState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [keepEnvironmentId, setKeepEnvironmentId] = useState(false);
  const [migrating, setMigrating] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads desktop IPC import availability once on mount
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.getState().then(
      (next) => {
        if (active) setState(next);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  if (!bridge || state === null || !state.supported) return null;

  const runMigration = async () => {
    if (migrating) return;
    setMigrating(true);
    try {
      const result = await bridge.run({ keepEnvironmentId });
      if (!result.ok) {
        setMigrating(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: resolve(msg("Could not migrate from T3 Code")),
            description: result.error ?? resolve(msg("Something went wrong.")),
          }),
        );
      }
    } catch (error) {
      setMigrating(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: resolve(msg("Could not migrate from T3 Code")),
          description:
            error instanceof Error ? error.message : resolve(msg("Something went wrong.")),
        }),
      );
    }
  };

  const description = !state.hasStockData
    ? gt("No stock T3 Code data found in {stock}.", { stock: state.stockHome })
    : state.alreadyMigrated
      ? gt("Already imported from {stock}. You can re-import anytime; current data is backed up.", {
          stock: state.stockHome,
        })
      : gt("Import threads, settings, providers, and keychain credentials from {stock}.", {
          stock: state.stockHome,
        });

  return (
    <>
      <SettingsRow
        title={gt("Migrate from T3 Code")}
        description={description}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!state.hasStockData || migrating}
            onClick={() => setDialogOpen(true)}
          >
            {migrating ? <T>Migrating…</T> : <T>Migrate…</T>}
          </Button>
        }
      />
      <AlertDialog open={dialogOpen} onOpenChange={(open) => !migrating && setDialogOpen(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Migrate from T3 Code?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                p0code will stop its local server, copy your threads, settings, and providers from{" "}
                <Var>{state.stockHome}</Var> into <Var>{state.appHome}</Var>, import credentials
                into the OS keychain, and restart. Your T3 Code folder is never modified, and your
                current p0code folder is moved aside as a backup.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3">
            <div className="space-y-0.5">
              <div className="text-sm font-medium text-foreground">
                <T>Keep environment ID</T>
              </div>
              <p className="text-xs text-muted-foreground">
                <T>
                  Keep paired devices working without re-pairing. Do not run T3 Code and p0code at
                  the same time if enabled.
                </T>
              </p>
            </div>
            <Switch
              checked={keepEnvironmentId}
              disabled={migrating}
              onCheckedChange={setKeepEnvironmentId}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={migrating} />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button disabled={migrating} onClick={() => void runMigration()}>
              {migrating ? <T>Migrating…</T> : <T>Migrate and restart</T>}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
