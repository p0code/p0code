import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { UserRoundIcon } from "lucide-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { setActiveAccountProfile } from "../../state/accountProfiles";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

/** Quick switch between the primary environment's account profiles. */
export function SidebarAccountProfileMenu() {
  const gt = useGT();
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const { accountProfiles, activeAccountProfileId } = usePrimarySettings((settings) => ({
    accountProfiles: settings.accountProfiles,
    activeAccountProfileId: settings.activeAccountProfileId,
  }));
  if (environmentId === null || accountProfiles.length < 2) return null;
  const active = accountProfiles.find((profile) => profile.id === activeAccountProfileId);
  const label = active
    ? gt("Account profile: {name}", { name: active.name })
    : gt("Account profile");
  return (
    <SidebarMenuItem className="shrink-0">
      <Menu>
        <MenuTrigger render={<SidebarMenuButton aria-label={label} title={label} size="icon" />}>
          <UserRoundIcon />
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          <MenuRadioGroup
            value={activeAccountProfileId ?? ""}
            onValueChange={(value: string) => {
              const profile = accountProfiles.find((candidate) => candidate.id === value);
              if (profile) void setActiveAccountProfile(environmentId, profile.id, profile.name);
            }}
          >
            {accountProfiles.map((profile) => (
              <MenuRadioItem key={profile.id} value={profile.id} closeOnClick>
                {profile.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem onClick={() => void navigate({ to: "/settings/providers" })}>
            <T>Edit profiles</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
