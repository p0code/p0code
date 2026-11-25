import type { EnvironmentCatalogError } from "@t3tools/client-runtime/connection";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { RefreshIcon } from "../ui/refresh-icon";
import { Button } from "../ui/button";

/**
 * Shown when the saved connection catalog could not be read, instead of an empty workspace that
 * looks like the user's environments were lost.
 */
export function SavedCatalogRecovery({ error }: { readonly error: EnvironmentCatalogError }) {
  const gt = useGT();
  const navigate = useNavigate();
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center text-center">
        <h1 className="text-lg font-semibold">{gt("Your saved environments could not be read")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {gt(
            "They are still saved on this computer, but p0code cannot read them. Nothing was replaced with an empty list.",
          )}
        </p>
        <p className="mt-3 max-w-full break-all text-xs text-muted-foreground/80">
          {error.preservedKey === null
            ? gt("The saved list was left where it was.")
            : gt("A copy was kept at {key}.", { key: error.preservedKey })}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            <RefreshIcon refreshing={false} />
            {gt("Retry")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void navigate({ to: "/settings/connections" });
            }}
          >
            {gt("Reconnect this machine")}
          </Button>
        </div>
      </div>
    </main>
  );
}
