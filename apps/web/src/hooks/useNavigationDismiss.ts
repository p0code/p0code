import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

/** Navigation can leave a sidebar trigger mounted without delivering pointerleave. */
export function useNavigationDismiss(close: () => void) {
  const router = useRouter({ warn: false });
  const dismiss = useEffectEvent(close);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes transient layers before navigation renders a different route
  useEffect(() => router?.subscribe("onBeforeLoad", () => dismiss()), [router]);
}
