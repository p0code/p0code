import type {
  CustomModelProvider,
  EnvironmentId,
  ProviderInstanceId,
  TextGeneratorModel,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { MoreVertical, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { T, useGT, Var } from "gt-react";

import { listCustomProviderModels, useUserModelProviders } from "../../customModelProviders";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import {
  type ModelDraft,
  modelDraftOf,
  type ProviderDraft,
  providerFromDraft,
  readCustomModelProviders,
  suggestCustomProviderId,
  withCustomModelProvider,
  withoutCustomModelProvider,
} from "@t3tools/client-runtime/custom-model-providers";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const hostOf = (baseUrl: string) => baseUrl.replace(/^https?:\/\//, "");
const fileNameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/** Model APIs added to an agent through p0code, beside the ones set up in its own files. */
export function CustomModelProvidersSection({
  environmentId,
  instanceId,
  config,
  readOnly,
  onConfigChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly config: unknown;
  readonly readOnly: boolean;
  readonly onConfigChange: (config: Readonly<Record<string, unknown>>) => Promise<boolean>;
}) {
  const gt = useGT();
  const { providers, keys } = readCustomModelProviders(config);
  const userProviders = AsyncResult.getOrElse(
    useUserModelProviders(environmentId, instanceId),
    () => [],
  );
  const [editing, setEditing] = useState<CustomModelProvider | "new" | null>(null);
  const [removing, setRemoving] = useState<CustomModelProvider | null>(null);

  return (
    <>
      <SettingsSection
        title={gt("Custom providers")}
        headerAction={
          readOnly ? null : (
            <Button size="xs" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add provider</T>
            </Button>
          )
        }
      >
        {providers.length === 0 && userProviders.length === 0 ? (
          <SettingsRow
            title={gt("No custom providers yet")}
            description={gt(
              "Connect an OpenAI- or Anthropic-compatible API and its models join the model picker.",
            )}
          />
        ) : null}
        {providers.map((provider) => (
          <SettingsRow
            key={provider.id}
            title={provider.name}
            description={gt(
              "{count, plural, one {{host} · {count} model} other {{host} · {count} models}}",
              { host: hostOf(provider.baseUrl), count: provider.models.length },
            )}
            control={
              readOnly ? null : (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={gt("More actions for {name}", { name: provider.name })}
                      />
                    }
                  >
                    <MoreVertical />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => setEditing(provider)}>
                      <T>Edit</T>
                    </MenuItem>
                    <MenuItem variant="destructive" onClick={() => setRemoving(provider)}>
                      <T>Remove</T>
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              )
            }
          />
        ))}
        {userProviders.map((provider) => (
          <SettingsRow
            key={`${provider.source}:${provider.id}`}
            title={provider.name ?? provider.id}
            description={gt(
              "{count, plural, one {In {file} · {count} model} other {In {file} · {count} models}}",
              { file: fileNameOf(provider.source), count: provider.models.length },
            )}
          />
        ))}
      </SettingsSection>
      {editing !== null ? (
        <CustomProviderDialog
          environmentId={environmentId}
          instanceId={instanceId}
          existing={editing === "new" ? null : editing}
          hasSavedKey={editing !== "new" && keys[editing.id] !== undefined}
          takenIds={new Set(providers.map((provider) => provider.id))}
          onClose={() => setEditing(null)}
          onSave={async (provider, apiKey) => {
            const saved = await onConfigChange(withCustomModelProvider(config, provider, apiKey));
            if (saved) setEditing(null);
          }}
        />
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{removing?.name ?? ""}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>Its models leave the model picker and its stored API key is deleted.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) {
                  void onConfigChange(withoutCustomModelProvider(config, removing.id));
                }
                setRemoving(null);
              }}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

type CheckState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly action: "load" | "test" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "tested"; readonly model: string };

function CustomProviderDialog({
  environmentId,
  instanceId,
  existing,
  hasSavedKey,
  takenIds,
  onClose,
  onSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly existing: CustomModelProvider | null;
  readonly hasSavedKey: boolean;
  readonly takenIds: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onSave: (provider: CustomModelProvider, apiKey: string) => Promise<void>;
}) {
  const gt = useGT();
  const formId = useId();
  const [name, setName] = useState(existing?.name ?? "");
  // Follows the name until edited; fixed once saved, since the key and model ids hang off it.
  const [customId, setCustomId] = useState<string | null>(existing?.id ?? null);
  const id = customId ?? suggestCustomProviderId(name, takenIds);
  const [kind, setKind] = useState<CustomModelProvider["kind"]>(
    existing?.kind ?? "openaiCompatible",
  );
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ReadonlyArray<ModelDraft>>(
    existing?.models.map(modelDraftOf) ?? [],
  );
  const [available, setAvailable] = useState<ReadonlyArray<TextGeneratorModel>>([]);
  const [manualModel, setManualModel] = useState("");
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [saving, setSaving] = useState(false);

  const draft: ProviderDraft = { id, name, kind, baseUrl, models };
  const provider = providerFromDraft(draft);
  const connection = providerFromDraft({ ...draft, models: [] });
  const idTaken = existing === null && takenIds.has(id);
  const busy = check.status === "running" || saving;

  const run = async (action: "load" | "test") => {
    if (connection === undefined) return;
    setCheck({ status: "running", action });
    const firstModel = models[0]?.id;
    const result = await listCustomProviderModels(environmentId, {
      instanceId,
      provider: { id: connection.id, kind: connection.kind, baseUrl: connection.baseUrl },
      apiKey,
      ...(action === "test" ? { test: true } : {}),
      ...(action === "test" && firstModel !== undefined ? { model: firstModel } : {}),
    });
    if ("error" in result) {
      setCheck({ status: "error", message: result.error });
      return;
    }
    if (action === "load") {
      setAvailable(result.models);
      setCheck({ status: "idle" });
      return;
    }
    setCheck({ status: "tested", model: result.testedModel ?? firstModel ?? "" });
  };

  const toggleModel = (model: TextGeneratorModel, selected: boolean) =>
    setModels((current) =>
      selected
        ? [
            ...current,
            {
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow?.toString() ?? "",
              inputCost: "",
              outputCost: "",
            },
          ]
        : current.filter((entry) => entry.id !== model.id),
    );

  const addManualModel = () => {
    const modelId = manualModel.trim();
    if (modelId === "" || models.some((model) => model.id === modelId)) return;
    setModels((current) => [
      ...current,
      { id: modelId, contextWindow: "", inputCost: "", outputCost: "" },
    ]);
    setManualModel("");
  };

  const updateModel = (modelId: string, patch: Partial<ModelDraft>) =>
    setModels((current) =>
      current.map((model) => (model.id === modelId ? { ...model, ...patch } : model)),
    );

  const save = async () => {
    if (provider === undefined || provider.models.length === 0 || idTaken || busy) return;
    setSaving(true);
    await onSave(provider, apiKey);
    setSaving(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {existing ? gt("Edit {name}", { name: existing.name }) : gt("Add a custom provider")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-name`}>
                  <T>Name</T>
                </Label>
                <Input
                  id={`${formId}-name`}
                  value={name}
                  autoFocus={existing === null}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-id`}>
                  <T>Provider ID</T>
                </Label>
                <Input
                  id={`${formId}-id`}
                  value={id}
                  disabled={existing !== null}
                  spellCheck={false}
                  aria-invalid={idTaken || undefined}
                  onChange={(event) => setCustomId(event.target.value.toLowerCase())}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-kind`}>
                  <T>API style</T>
                </Label>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    if (value === "openaiCompatible" || value === "anthropic") setKind(value);
                  }}
                >
                  <SelectTrigger id={`${formId}-kind`}>
                    <SelectValue>
                      {(value: string) =>
                        value === "anthropic" ? gt("Anthropic-compatible") : gt("OpenAI-compatible")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="openaiCompatible">
                      <T>OpenAI-compatible</T>
                    </SelectItem>
                    <SelectItem value="anthropic">
                      <T>Anthropic-compatible</T>
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-url`}>
                  <T>Base URL</T>
                </Label>
                <Input
                  id={`${formId}-url`}
                  value={baseUrl}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-key`}>
                <T>API key</T>
              </Label>
              <Input
                id={`${formId}-key`}
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={hasSavedKey ? gt("Saved. Type to replace it.") : gt("Optional")}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  <T>Models</T>
                </span>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={connection === undefined || busy}
                    onClick={() => void run("load")}
                  >
                    {check.status === "running" && check.action === "load" ? <Spinner /> : null}
                    <T>Load models</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={connection === undefined || busy}
                    onClick={() => void run("test")}
                  >
                    {check.status === "running" && check.action === "test" ? <Spinner /> : null}
                    <T>Test</T>
                  </Button>
                </div>
              </div>
              {check.status === "error" ? (
                <p role="alert" className="text-sm text-destructive">
                  {check.message}
                </p>
              ) : check.status === "tested" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  <T>
                    <Var>{check.model}</Var> answered. It works.
                  </T>
                </p>
              ) : null}
              {available.length > 0 ? (
                <div className="grid max-h-44 gap-1 overflow-y-auto rounded-lg border p-2">
                  {available.map((model) => (
                    <label key={model.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={models.some((entry) => entry.id === model.id)}
                        onCheckedChange={(checked) => toggleModel(model, checked === true)}
                      />
                      <span className="truncate">{model.id}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              {models.length > 0 ? (
                <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_4.5rem_4.5rem_auto] items-center gap-x-2 gap-y-1.5 text-xs">
                  <span className="text-muted-foreground">
                    <T>Model</T>
                  </span>
                  <span className="text-muted-foreground">
                    <T context="column header: a model's context window size in tokens">Context</T>
                  </span>
                  <span className="text-muted-foreground">
                    <T context="column header: input price in USD per million tokens">In $/1M</T>
                  </span>
                  <span className="text-muted-foreground">
                    <T context="column header: output price in USD per million tokens">Out $/1M</T>
                  </span>
                  <span />
                  {models.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      onChange={(patch) => updateModel(model.id, patch)}
                      onRemove={() =>
                        setModels((current) => current.filter((entry) => entry.id !== model.id))
                      }
                    />
                  ))}
                </div>
              ) : null}
              <div className="flex gap-2">
                <Input
                  size="sm"
                  value={manualModel}
                  placeholder={gt("Model ID")}
                  aria-label={gt("Model ID")}
                  spellCheck={false}
                  onChange={(event) => setManualModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addManualModel();
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={manualModel.trim() === ""}
                  onClick={addManualModel}
                >
                  <T>Add model</T>
                </Button>
              </div>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={provider === undefined || models.length === 0 || idTaken || busy}
          >
            {saving ? <Spinner /> : null}
            <T>Save</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ModelRow({
  model,
  onChange,
  onRemove,
}: {
  readonly model: ModelDraft;
  readonly onChange: (patch: Partial<ModelDraft>) => void;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  return (
    <>
      <span className="truncate font-mono">{model.id}</span>
      <Input
        size="compact"
        inputMode="numeric"
        value={model.contextWindow}
        placeholder="128000"
        aria-label={gt("Context window for {model}", { model: model.id })}
        onChange={(event) => onChange({ contextWindow: event.target.value })}
      />
      <Input
        size="compact"
        inputMode="decimal"
        value={model.inputCost}
        placeholder="0"
        aria-label={gt("Input price for {model}", { model: model.id })}
        onChange={(event) => onChange({ inputCost: event.target.value })}
      />
      <Input
        size="compact"
        inputMode="decimal"
        value={model.outputCost}
        placeholder="0"
        aria-label={gt("Output price for {model}", { model: model.id })}
        onChange={(event) => onChange({ outputCost: event.target.value })}
      />
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={gt("Remove {model}", { model: model.id })}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </>
  );
}
