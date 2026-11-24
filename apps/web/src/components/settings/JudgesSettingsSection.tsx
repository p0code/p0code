import { newMessageId } from "../../lib/utils";
import { DEFAULT_JUDGES, ProviderInstanceId, type JudgeMember } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsSection, SettingsRow } from "./settingsLayout";

export function JudgesSettingsSection() {
  const gt = useGT();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const { environment, scope } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment ? providersByEnvironment.get(environment.environmentId) : undefined) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const modelOptions = new Map(
    entries.map((entry) => [entry.instanceId, getAppModelOptionsForInstance(settings, entry)]),
  );
  const disabled = !environment || scope.kind === "project" || scope.kind === "checkout";
  const save = (judges: ReadonlyArray<JudgeMember>) => update({ judges });
  const replace = (index: number, member: JudgeMember) =>
    save(settings.judges.map((value, i) => (i === index ? member : value)));
  const move = (index: number, delta: number) => {
    const judges = [...settings.judges];
    const next = index + delta;
    const member = judges[index];
    const other = judges[next];
    if (!member || !other) return;
    judges[index] = other;
    judges[next] = member;
    save(judges);
  };
  return (
    <SettingsSection id="judges" title={gt("Judges")}>
      <p className="text-sm text-muted-foreground">
        <T>
          Independent reviewers inspect your work and return one combined report. Start a panel from
          a thread or with /judges.
        </T>
      </p>
      {disabled ? (
        <p className="text-sm text-muted-foreground">
          <T>Select an environment to edit its judges.</T>
        </p>
      ) : null}
      <fieldset disabled={disabled} className="space-y-3">
        {settings.judges.map((member, index) => {
          const entry = entries.find((entry) =>
            member.providerInstanceId
              ? entry.instanceId === member.providerInstanceId
              : entry.driverKind === member.driverKind && entry.enabled,
          );
          return (
            <div
              key={member.id ?? `${member.providerInstanceId ?? member.driverKind}:${member.model}`}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
            >
              <Switch
                checked={member.enabled}
                onCheckedChange={(enabled) => replace(index, { ...member, enabled })}
                aria-label={gt("Enable judge")}
              />
              <ProviderModelPicker
                environmentId={environment?.environmentId ?? null}
                activeInstanceId={
                  entry?.instanceId ??
                  member.providerInstanceId ??
                  ProviderInstanceId.make("unavailable")
                }
                model={member.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptions}
                triggerAriaLabel={gt("Judge model")}
                onInstanceModelChange={(providerInstanceId, model) =>
                  replace(index, {
                    id: member.id ?? newMessageId(),
                    enabled: member.enabled,
                    providerInstanceId,
                    model,
                  })
                }
              />
              {entry ? (
                <TraitsPicker
                  provider={entry.driverKind}
                  models={entry.models}
                  model={member.model}
                  modelOptions={member.options ?? []}
                  allowPromptInjectedEffort={false}
                  onModelOptionsChange={(options) =>
                    replace(index, { ...member, options: options ?? [] })
                  }
                />
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <T>Move up</T>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={index === settings.judges.length - 1}
                onClick={() => move(index, 1)}
              >
                <T>Move down</T>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => save(settings.judges.filter((_, i) => i !== index))}
              >
                <T>Remove</T>
              </Button>
            </div>
          );
        })}
        <Button
          size="sm"
          variant="outline"
          onClick={() => save([...settings.judges, { ...DEFAULT_JUDGES[0]!, id: newMessageId() }])}
        >
          <T>Add judge</T>
        </Button>
        <SettingsRow
          title={gt("Reviewer instructions")}
          description={gt(
            "All judges use this rubric. They only inspect files; the main agent fixes validated findings.",
          )}
          control={
            <Textarea
              value={settings.judgeInstructions}
              onChange={(event) => update({ judgeInstructions: event.target.value })}
              aria-label={gt("Reviewer instructions")}
              className="min-h-36 w-full sm:w-96"
            />
          }
        />
        <SettingsRow
          title={gt("Default review scope")}
          control={
            <Textarea
              value={settings.judgeDefaultScope}
              onChange={(event) => update({ judgeDefaultScope: event.target.value })}
              aria-label={gt("Default review scope")}
              className="w-full sm:w-96"
            />
          }
        />
      </fieldset>
    </SettingsSection>
  );
}
