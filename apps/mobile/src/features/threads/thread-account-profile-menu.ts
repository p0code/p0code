import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { projectAccountProfile, threadAccountProfile } from "@t3tools/shared/accountProfiles";
import { useGT } from "gt-react-native";

import { serverEnvironment } from "../../state/server";
import { useSettingsWriter } from "../settings/useSettingsWriter";

const SHOW_EVERYWHERE = "account-profile-all";
const PROFILE_PREFIX = "account-profile:";

/**
 * "Move to profile" for a thread row. Offered only while the thread's project is unassigned,
 * since a project's profile decides where its threads show.
 */
export function useThreadAccountProfileMenu(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId | null;
}) {
  const gt = useGT();
  const writeSettings = useSettingsWriter();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(thread.environmentId));
  const offered =
    settings !== null &&
    settings.accountProfiles.length > 1 &&
    (thread.projectId === null || projectAccountProfile(settings, thread.projectId) === undefined);
  if (!offered) return { items: [], handle: (_event: string) => false };

  const assigned = threadAccountProfile(settings, thread)?.id ?? null;
  const items: MenuAction[] = [
    {
      id: "account-profile",
      title: gt("Move to profile"),
      image: "person.crop.circle",
      subactions: [
        {
          id: SHOW_EVERYWHERE,
          title: gt("Show in all profiles"),
          state: assigned === null ? "on" : "off",
        },
        ...settings.accountProfiles.map((profile) => ({
          id: `${PROFILE_PREFIX}${profile.id}`,
          title: profile.name,
          state: profile.id === assigned ? ("on" as const) : ("off" as const),
        })),
      ],
    },
  ];
  const handle = (event: string) => {
    const profileId =
      event === SHOW_EVERYWHERE
        ? null
        : settings.accountProfiles.find((profile) => `${PROFILE_PREFIX}${profile.id}` === event)
            ?.id;
    if (profileId === undefined) return false;
    void writeSettings(
      [],
      [
        {
          environmentId: thread.environmentId,
          patch: { threadAccountProfileIds: { [thread.id]: profileId } },
        },
      ],
    );
    return true;
  };
  return { items, handle };
}
