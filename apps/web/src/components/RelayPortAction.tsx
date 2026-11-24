import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "./ui/dialog";
import { QRCodeSvg } from "./ui/qr-code";

export function RelayPortAction({
  environmentId,
  port,
}: {
  environmentId: EnvironmentId;
  port: number;
}) {
  const gt = useGT();
  const allowed = useAtomValue(serverEnvironment.relayExposePort.permissionAtom(environmentId));
  const expose = useAtomCommand(serverEnvironment.relayExposePort);
  const portLink = useAtomCommand(serverEnvironment.relayPortLink);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const share = async (access: "private" | "link") => {
    const result = await expose({
      environmentId,
      input: { port, access, expiresInSeconds: 86400 },
    });
    if (result._tag === "Success") {
      if (access === "private") {
        const link = await portLink({ environmentId, input: { port } });
        if (link._tag === "Success") setUrl(link.value.url);
      } else setUrl(result.value.url);
    }
  };
  if (!allowed) return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={gt("Expose port through relay")}
        onClick={() => setOpen(true)}
      >
        <T>Relay</T>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Expose a local port</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Choose access for this port. Exposure expires after one day and can be revoked in
                Sharing & access.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              <div className="flex gap-2">
                <Button onClick={() => void share("private")}>
                  <T>Private</T>
                </Button>
                <Button onClick={() => void share("link")}>
                  <T>Anyone with link</T>
                </Button>
              </div>
              {url ? (
                <>
                  <Input readOnly value={url} aria-label={gt("Port link")} />
                  <QRCodeSvg value={url} size={180} />
                  <Button onClick={() => void navigator.clipboard.writeText(url)}>
                    <T>Copy link</T>
                  </Button>
                </>
              ) : null}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
