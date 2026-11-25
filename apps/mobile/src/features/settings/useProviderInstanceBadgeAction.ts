import type { MenuAction } from "@react-native-menu/menu";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  PROVIDER_INSTANCE_BADGE_MAX_LENGTH,
  resolveProviderInstanceDisplayName,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerProvider } from "@t3tools/contracts";
import { useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { planProviderInstanceBadgeSave } from "./provider-instance-badge";
import type { SettingsTarget } from "./settings-environment-filter";

export const PROVIDER_INSTANCE_BADGE_ACTION_ID = "badge";

/** A menu action that edits the short badge drawn on the instance's provider icon. */
export function useProviderInstanceBadgeAction(
  environment: SettingsTarget,
  provider: ServerProvider,
) {
  const gt = useGT();
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const { providerInstances } = environment.serverConfig.settings;
  const current =
    (Object.hasOwn(providerInstances, provider.instanceId)
      ? providerInstances[provider.instanceId]?.instanceBadge
      : undefined) ?? "";
  const name = resolveProviderInstanceDisplayName(provider);
  const failureTitle = gt("Could not save the badge");
  async function save(value: string) {
    const plan = planProviderInstanceBadgeSave({
      providerInstances,
      policy: environment.serverConfig.managedPolicy,
      instanceId: provider.instanceId,
      driver: provider.driver,
      badge: value,
    });
    if ("error" in plan) {
      Dialog.alert(failureTitle, plan.error);
      return;
    }
    const result = await mutate({
      environmentId: environment.environmentId,
      input: { patch: {}, providerInstanceMutation: plan.mutation },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    Dialog.alert(
      failureTitle,
      failure instanceof Error ? (errorDisplayMessage(failure, m) ?? failure.message) : undefined,
    );
  }
  const action: MenuAction = {
    id: PROVIDER_INSTANCE_BADGE_ACTION_ID,
    title: gt("Badge", { $context: "short label drawn on a provider icon" }),
    ...(current ? { subtitle: current } : {}),
    image: "tag",
  };
  function edit() {
    Dialog.prompt({
      title: gt("Badge for {account}", { account: name }),
      message: gt(
        "Up to {count} characters or emoji on the provider icon. Leave empty to use one made from the name.",
        { count: PROVIDER_INSTANCE_BADGE_MAX_LENGTH },
      ),
      initialValue: current,
      confirmText: gt("Save"),
      onConfirm: (value) => {
        void save(value);
      },
    });
  }
  return { action, edit };
}
