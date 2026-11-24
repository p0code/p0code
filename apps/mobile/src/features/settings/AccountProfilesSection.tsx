import {
  type AccountProfile,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { moveProfileInstance, orderInstancesForDriver } from "@t3tools/shared/accountProfiles";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SettingsTarget } from "./settings-environment-filter";
import { useSettingsWriter } from "./useSettingsWriter";

/** Picks the environment's active account profile and orders each provider's accounts in it. */
export function AccountProfilesSection(props: {
  readonly environment: SettingsTarget;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const gt = useGT();
  const writeSettings = useSettingsWriter();
  const { accountProfiles, activeAccountProfileId } = props.environment.serverConfig.settings;
  const active = accountProfiles.find((profile) => profile.id === activeAccountProfileId);
  const drivers = [...new Set(props.providers.map((provider) => provider.driver))].filter(
    (driver) => props.providers.filter((provider) => provider.driver === driver).length > 1,
  );
  if (accountProfiles.length === 0) return null;
  const write = (patch: ServerSettingsPatch) =>
    writeSettings([], [{ environmentId: props.environment.environmentId, patch }]);
  const saveProfile = (next: AccountProfile) =>
    write({
      accountProfiles: accountProfiles.map((profile) => (profile.id === next.id ? next : profile)),
    });

  return (
    <SettingsSection title={gt("Account profiles")}>
      {accountProfiles.map((profile, index) => (
        <ListChoiceRow
          key={profile.id}
          label={profile.name}
          selected={profile.id === activeAccountProfileId}
          separated={index > 0}
          onPress={() => void write({ activeAccountProfileId: profile.id })}
        />
      ))}
      {active ? (
        <>
          <SettingsSwitchRow
            icon="arrow.left.arrow.right"
            label={gt("Switch accounts at usage limits")}
            subtitle={gt(
              "When a thread hits a usage limit, continue it on the next account in this profile instead of waiting for the reset.",
            )}
            value={active.autoSwitchOnLimit}
            onValueChange={(autoSwitchOnLimit) =>
              void saveProfile({ ...active, autoSwitchOnLimit })
            }
          />
          {drivers.map((driver) => {
            const ordered = orderInstancesForDriver(active, props.providers, driver);
            const ids = ordered.map((provider) => provider.instanceId);
            return (
              <View
                key={driver}
                className="border-t border-border-subtle bg-grouped-card px-4 py-2"
              >
                <Text className="text-sm text-foreground-muted">
                  {gt("{provider}, first choice first", {
                    provider: PROVIDER_DISPLAY_NAMES[driver] ?? driver,
                  })}
                </Text>
                {ordered.map((provider, index) => {
                  const name = provider.displayName ?? provider.instanceId;
                  return (
                    <ListRowLayout
                      key={provider.instanceId}
                      label={`${index + 1}. ${name}`}
                      accessory={
                        <View className="flex-row items-center gap-1">
                          <IconButton
                            icon="arrow.up"
                            accessibilityLabel={gt("Move {name} up", { name })}
                            disabled={index === 0}
                            onPress={() =>
                              void saveProfile(
                                moveProfileInstance(active, ids, provider.instanceId, -1),
                              )
                            }
                          />
                          <IconButton
                            icon="arrow.down"
                            accessibilityLabel={gt("Move {name} down", { name })}
                            disabled={index === ordered.length - 1}
                            onPress={() =>
                              void saveProfile(
                                moveProfileInstance(active, ids, provider.instanceId, 1),
                              )
                            }
                          />
                        </View>
                      }
                    />
                  );
                })}
              </View>
            );
          })}
        </>
      ) : null}
    </SettingsSection>
  );
}
