import { useGT } from "gt-react";
import {
  type ScopedThreadRef,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { newMessageId } from "../lib/utils";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { threadEnvironment } from "../state/threads";

export function useConveneJudges() {
  const gt = useGT();
  const start = useOrchestrationCommand(
    threadEnvironment.startTurn,
    gt("Could not convene judges"),
  );
  return (
    thread: ScopedThreadRef & {
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    },
  ) =>
    start({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          // oxlint-disable-next-line t3code/no-untranslated-copy -- Agent instructions remain English.
          text: "Convene the configured judges panel using convene_judges. After its report arrives, validate and fix actionable findings and run relevant tests.",
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        dispatchMode: "queue",
        createdAt: new Date().toISOString(),
      },
    });
}
