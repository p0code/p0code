import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { routeSelectionToAccountProfile } from "@t3tools/shared/accountProfiles";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { readEnvironment, readEnvironmentProviders } from "../state/environments";
import { hasExplicitComposerModelSelection } from "./chatThreadActions";

/**
 * Moves a new draft's model onto the active profile's preferred account of the same provider.
 * Covers the remembered last pick and the project default; a pick made in this draft stays.
 */
export function routeDraftToAccountProfile(
  draftId: DraftId,
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  defaultSelection: ModelSelection | null,
): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(draftId);
  if (hasExplicitComposerModelSelection(draft)) return;
  const settings = readEnvironment(environmentId)?.serverConfig?.settings;
  const providers = readEnvironmentProviders(environmentId);
  const selection =
    (draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : undefined) ??
    defaultSelection;
  if (!settings || !providers || !selection) return;
  const routed = routeSelectionToAccountProfile({
    selection,
    providers,
    settings,
    projectId,
    now: Date.now(),
  });
  if (routed.instanceId !== selection.instanceId) {
    store.setModelSelection(draftId, routed, { replaceOptions: true });
  }
}
