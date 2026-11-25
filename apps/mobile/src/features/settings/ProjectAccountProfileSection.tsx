import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { AccountProfileId } from "@t3tools/contracts";
import { projectAccountProfile } from "@t3tools/shared/accountProfiles";

import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import type { SettingsTarget } from "./settings-environment-filter";
import { useSettingsWriter } from "./useSettingsWriter";

/** Files a project under one of its environment's account profiles. */
export function ProjectAccountProfileSection(props: {
  readonly member: EnvironmentProject;
  readonly environment: SettingsTarget;
  readonly title: string;
}) {
  const writeSettings = useSettingsWriter();
  const { settings } = props.environment.serverConfig;
  if (props.member.isScratch || settings.accountProfiles.length < 2) return null;
  const assigned = projectAccountProfile(settings, props.member.id)?.id ?? null;
  const assign = (profileId: AccountProfileId) =>
    void writeSettings(
      [],
      [
        {
          environmentId: props.environment.environmentId,
          patch: { projectAccountProfileIds: { [props.member.id]: profileId } },
        },
      ],
    );

  return (
    <SettingsSection title={props.title}>
      {settings.accountProfiles.map((profile, index) => (
        <ListChoiceRow
          key={profile.id}
          label={profile.name}
          selected={profile.id === assigned}
          separated={index > 0}
          onPress={() => assign(profile.id)}
        />
      ))}
    </SettingsSection>
  );
}
