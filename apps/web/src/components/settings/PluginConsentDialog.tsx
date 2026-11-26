import type { PluginManifest } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";

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
import { pluginCapabilityCopy } from "./pluginCapabilityCopy";

/** The one consent dialog every install path shows before plugin code can run. */
export function PluginConsentDialog({
  manifest,
  open,
  busy,
  allowed,
  error,
  onKeepStaged,
  onConfirm,
}: {
  readonly manifest: PluginManifest | null;
  readonly open: boolean;
  readonly busy: boolean;
  readonly allowed: boolean;
  readonly error: string | null;
  readonly onKeepStaged: () => void;
  readonly onConfirm: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onKeepStaged();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Review plugin capabilities</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Plugins run inside the p0code server with your account's access to files, network and
              credentials. Capabilities are declarations, and only some are enforced. Activate only
              plugins you trust.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {manifest ? (
            <div className="space-y-3 text-sm">
              <p className="font-mono">
                {manifest.id} · {manifest.version}
              </p>
              <p>{manifest.description}</p>
              <p>
                <T>
                  External services:{" "}
                  <Var>{manifest.externalServices.join(", ") || gt("None declared")}</Var>
                </T>
              </p>
              <ul className="space-y-2 text-muted-foreground">
                {manifest.capabilities.map((capability) => (
                  <li key={capability}>
                    <Badge variant="outline">{capability}</Badge>
                    <p className="mt-1">{m(pluginCapabilityCopy[capability])}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onKeepStaged}>
            <T>Keep staged</T>
          </Button>
          <Button disabled={!allowed || busy || !manifest} onClick={onConfirm}>
            <T>Confirm and activate</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
