import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { DeploySettingsPanel } from "../components/settings/DeploySettings";

const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

function SettingsDeployRoute() {
  const search = Route.useSearch();
  return (
    <DeploySettingsPanel
      preselect={{
        ...(search.projectId === undefined ? {} : { projectId: search.projectId }),
        ...(search.branch === undefined ? {} : { branch: search.branch }),
        ...(search.threadId === undefined ? {} : { threadId: search.threadId }),
      }}
    />
  );
}

/** `projectId`, `branch` and `threadId` open the deploy dialog, as a thread's menu does. */
export const Route = createFileRoute("/_chat/settings/deploy")({
  validateSearch: (raw: Record<string, unknown>) => {
    const environmentId = text(raw.environmentId);
    const projectId = text(raw.projectId);
    const branch = text(raw.branch);
    const threadId = text(raw.threadId);
    return {
      ...(environmentId === undefined ? {} : { environmentId: EnvironmentId.make(environmentId) }),
      ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }),
      ...(branch === undefined ? {} : { branch }),
      ...(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) }),
    };
  },
  component: SettingsDeployRoute,
});
