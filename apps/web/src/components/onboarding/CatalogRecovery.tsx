import type { ConnectionCatalogError } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { Button } from "../ui/button";

export function CatalogRecovery({
  error,
  onContinue,
}: {
  readonly error: ConnectionCatalogError;
  readonly onContinue: () => void;
}) {
  const gt = useGT();
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-lg flex-col items-center gap-4 text-center" role="alert">
        <h1 className="text-lg font-semibold">
          {gt("Your saved environments could not be decrypted")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {gt(
            "Your projects and threads are still on disk. Reconnect this machine or add your remote environments again.",
          )}
        </p>
        {error.keptPath && (
          <p className="break-all text-sm">
            {gt("Preserved copy: {path}", { path: error.keptPath })}
          </p>
        )}
        {failure && <p className="text-sm text-destructive">{failure}</p>}
        <Button
          onClick={() => {
            const bridge = window.desktopBridge;
            if (!bridge) {
              onContinue();
              return;
            }
            void bridge.setLocalEnvironmentEnabled(true).then(
              () => window.location.reload(),
              (cause: unknown) => {
                setFailure(cause instanceof Error ? cause.message : String(cause));
              },
            );
          }}
        >
          {gt("Reconnect this machine")}
        </Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {gt("Retry")}
        </Button>
        <Button variant="ghost" onClick={onContinue}>
          {gt("Open workspace")}
        </Button>
      </div>
    </main>
  );
}
