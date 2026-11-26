import { useGT } from "gt-react";
import { useState } from "react";

import {
  desktopLocalBackendId,
  isDesktopLocalConnectionTarget,
} from "../../connection/desktopLocal";
import { ensureLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Windows drive paths, POSIX paths, and `~/` all count; a bare folder name does not. */
const isAbsoluteFolder = (value: string) => /^(~([/\\]|$)|[A-Za-z]:[\\/]|[\\/])/.test(value.trim());

export function NewProjectLocationSetting() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["projectsRoot"]);
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const { environments: allEnvironments } = useEnvironments();
  const [error, setError] = useState<string | null>(null);

  const resolvedRoot = environment?.serverConfig?.newProjectsRoot ?? null;
  const machine =
    environment === null ? null : settingsScopeEnvironmentLabel(environment, allEnvironments);
  const desktopLocal =
    environment !== null &&
    isDesktopLocalConnectionTarget(environment.entry.target) &&
    !desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;

  const save = (next: string | null) => {
    setError(null);
    updateSettings({ projectsRoot: next });
  };

  const commit = (draft: string) => {
    const value = draft.trim();
    if (value === "") {
      save(null);
      return;
    }
    if (!isAbsoluteFolder(value)) {
      setError(gt("Enter an absolute folder path, like ~/projects."));
      return;
    }
    save(value);
  };

  const pickFolder = async () => {
    setError(null);
    const picked = await ensureLocalApi().dialogs.pickFolder();
    if (picked != null) save(picked);
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["projectsRoot"]}
      {...setting("new-project-location")}
      description={
        mixed || machine === null
          ? gt(
              "New projects go in each selected environment's own folder. Existing projects stay where they are.",
            )
          : resolvedRoot === null
            ? gt("New projects go on {machine}. Existing projects stay where they are.", {
                machine,
              })
            : gt("New projects go in {path} on {machine}. Existing projects stay where they are.", {
                path: resolvedRoot,
                machine,
              })
      }
      resetAction={
        mixed || settings.projectsRoot !== null ? (
          <SettingResetButton
            ariaLabel={gt("Reset new project location to default")}
            onClick={() => save(null)}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-col items-start gap-1.5 sm:w-auto">
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixed ? "" : (settings.projectsRoot ?? "")}
              onCommit={commit}
              placeholder={mixed ? gt("Mixed") : (resolvedRoot ?? "~/projects")}
              spellCheck={false}
              aria-label={gt("New project location")}
              aria-invalid={error !== null}
            />
            {desktopLocal ? (
              <Button size="sm" variant="outline" onClick={() => void pickFolder()}>
                {gt("Choose folder…")}
              </Button>
            ) : null}
          </div>
          {error !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
