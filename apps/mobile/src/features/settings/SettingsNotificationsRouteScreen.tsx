import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Notifications from "expo-notifications";
import { useGT } from "gt-react-native";
import { Linking } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { runtime } from "../../lib/runtime";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const notificationStatusAtom = makePermissionStatusAtom({
  label: "mobile:notification-permission",
  initial: false,
  read: async () => (await Notifications.getPermissionsAsync()).granted,
});

export function SettingsNotificationsRouteScreen() {
  const gt = useGT();
  const enabled = useAtomValue(notificationStatusAtom);
  const setEnabled = useAtomSet(notificationStatusAtom);
  const changePermission = async (value: boolean) => {
    if (!value) {
      await Linking.openSettings();
      return;
    }
    const result = await runtime.runPromise(Effect.result(requestAgentNotificationPermission));
    if (result._tag === "Failure") {
      Dialog.alert(
        gt("Couldn't enable notifications"),
        gt("Open system Settings to enable notifications."),
      );
      return;
    }
    setEnabled(result.success.type === "granted");
    if (result.success.type === "denied" && !result.success.canAskAgain)
      await Linking.openSettings();
  };
  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
      >
        <SettingsSection title={gt("Agent activity")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={gt("Device Notifications")}
            value={enabled}
            onValueChange={(value) => void changePermission(value)}
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
