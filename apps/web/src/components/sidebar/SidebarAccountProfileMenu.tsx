import { useGT } from "gt-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { setActiveAccountProfile } from "../../state/accountProfiles";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** One-click segmented toggle between account profiles (e.g. Work / Personal) above the sidebar utility bar. */
export function SidebarAccountProfileToggle() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const { accountProfiles, activeAccountProfileId } = usePrimarySettings((settings) => ({
    accountProfiles: settings.accountProfiles,
    activeAccountProfileId: settings.activeAccountProfileId,
  }));
  if (environmentId === null || accountProfiles.length < 2) return null;
  return (
    <div className="pb-1">
      <ToggleGroup
        aria-label={gt("Account profile")}
        variant="segmented"
        fill
        size="sm"
        className="w-full"
        value={activeAccountProfileId ? [activeAccountProfileId] : []}
        onValueChange={(next) => {
          const id = next[0];
          if (id === undefined) return;
          const profile = accountProfiles.find((candidate) => candidate.id === id);
          if (profile) void setActiveAccountProfile(environmentId, profile.id);
        }}
      >
        {accountProfiles.map((profile) => (
          <Toggle key={profile.id} value={profile.id} className="min-w-0 flex-1">
            <span className="truncate">{profile.name}</span>
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}
