import { useGT, useMessages } from "gt-react";

import { APP_DISPLAY_NAME } from "../branding";
import { formatStartupProgressLabel, type StartupProgressSnapshot } from "../lib/startupProgress";

export function StartupLoadingScreen({ progress }: { readonly progress: StartupProgressSnapshot }) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const label = formatStartupProgressLabel(progress, resolveMessage);

  return (
    <main
      className="flex h-dvh min-h-0 w-full items-center justify-center bg-background px-6 text-foreground"
      aria-label={gt("{appName} startup screen", { appName: APP_DISPLAY_NAME })}
    >
      <div className="flex flex-col items-center gap-4">
        <img
          src="/apple-touch-icon.png"
          alt={APP_DISPLAY_NAME}
          className="size-16 rounded-2xl object-contain"
        />
        <div className="flex w-[min(220px,72vw)] flex-col items-center gap-2">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-valuetext={label}
            className="h-[3px] w-full overflow-hidden rounded-full bg-foreground/15"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <p
            role="status"
            aria-live="polite"
            className="text-center text-xs leading-4 text-muted-foreground tabular-nums"
          >
            {label}
          </p>
        </div>
      </div>
    </main>
  );
}
