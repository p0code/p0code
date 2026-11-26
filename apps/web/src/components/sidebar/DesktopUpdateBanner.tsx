import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Button } from "../ui/button";

export function DesktopUpdateBanner() {
  const state = useDesktopUpdateState();
  const gt = useGT();
  const navigate = useNavigate();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  if (
    !state?.availableVersion ||
    dismissedVersion === state.availableVersion ||
    (state.status !== "available" && state.status !== "downloaded")
  )
    return null;
  return (
    <div className="space-y-1 rounded-md border border-border p-2 text-xs text-muted-foreground">
      <p>{gt("p0code {version} is available.", { version: state.availableVersion })}</p>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="link"
          onClick={() => void navigate({ to: "/settings/maintenance" })}
        >
          <T>Review update</T>
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setDismissedVersion(state.availableVersion)}
        >
          <T>Dismiss</T>
        </Button>
      </div>
    </div>
  );
}
