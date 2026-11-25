import { T, useGT } from "gt-react";
import { UserRoundIcon } from "lucide-react";

import { usePrimarySettings } from "../hooks/useSettings";
import { setActiveAccountProfile } from "../state/accountProfiles";
import { usePrimaryEnvironmentId } from "../state/environments";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";

/** Switches the primary environment's account profile; null until it has two profiles. */
export function useCommandPaletteAccountProfileItem(): CommandPaletteSubmenuItem | null {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const { accountProfiles, activeAccountProfileId } = usePrimarySettings((settings) => ({
    accountProfiles: settings.accountProfiles,
    activeAccountProfileId: settings.activeAccountProfileId,
  }));
  if (environmentId === null || accountProfiles.length < 2) return null;
  return {
    kind: "submenu",
    value: "action:switch-account-profile",
    searchTerms: ["switch profile", "account profile", "personal", "work", "accounts"],
    title: gt("Switch account profile"),
    icon: <UserRoundIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <UserRoundIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "accountProfile.cycle",
    groups: [
      {
        value: "account-profiles",
        label: gt("Switch account profile"),
        items: accountProfiles.map((profile) => ({
          kind: "action",
          value: `account-profile:${profile.id}`,
          title: profile.name,
          searchTerms: [profile.name, "profile", "account"],
          icon: <UserRoundIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            profile.id === activeAccountProfileId ? (
              <span className="text-xs text-muted-foreground/70">
                <T context="the account profile in use now">Current</T>
              </span>
            ) : undefined,
          run: () => setActiveAccountProfile(environmentId, profile.id),
        })),
      },
    ],
  };
}
