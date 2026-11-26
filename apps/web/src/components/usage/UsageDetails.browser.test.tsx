import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  UsageDay,
  type UsageDetailsInput,
  type UsageDetailsRow,
} from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { render } from "../../../test/render";

vi.mock("../../state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { ThreadId, ProjectId, UsageDay } = await import("@t3tools/contracts");
  const rows: UsageDetailsRow[] = [
    {
      day: UsageDay.make("2026-03-01"),
      threadId: ThreadId.make("thread-a"),
      title: "Fix the graph",
      projectId: ProjectId.make("project-a"),
      project: "Graph",
      provider: "claude",
      account: "work",
      model: "model-a",
      uncachedInputTokens: 1000,
      cachedInputTokens: 400,
      cacheCreationTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      records: 2,
      costUsd: 1.55,
      unpricedRecords: 0,
    },
    {
      day: UsageDay.make("2026-03-02"),
      threadId: ThreadId.make("thread-b"),
      title: "Update login",
      projectId: ProjectId.make("project-b"),
      project: "Website",
      provider: "codex",
      account: "personal",
      model: "model-b",
      uncachedInputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
      records: 1,
      costUsd: 0.12,
      unpricedRecords: 0,
    },
  ];
  return {
    serverEnvironment: {
      usageDetails: ({ input }: { input: UsageDetailsInput }) => {
        const filtered = rows.filter(
          (row) =>
            (!input.project || row.project.includes(input.project)) &&
            (!input.threadId || row.threadId === input.threadId),
        );
        return Atom.make(
          AsyncResult.success({
            rows: filtered,
            totalRows: filtered.length,
            totals: {
              uncachedInputTokens: filtered.reduce((n, r) => n + r.uncachedInputTokens, 0),
              cachedInputTokens: 400,
              cacheCreationTokens: 100,
              outputTokens: 70,
              reasoningTokens: 20,
              records: filtered.length,
              costUsd: filtered.reduce((n, r) => n + r.costUsd, 0),
              unpricedRecords: 0,
            },
          }),
        );
      },
    },
  };
});

import { UsageDetails } from "./UsageDetails";

describe("usage details", () => {
  it("filters recorded chats, resets, inspects a thread, and navigates to its environment", async () => {
    await using screen = await render(
      <Dialog open>
        <DialogPopup>
          <DialogTitle>Usage</DialogTitle>
          <UsageDetails
            environments={[
              {
                environmentId: EnvironmentId.make("workstation"),
                label: "Workstation",
                isPending: false,
                canReadDiagnostics: true,
                isConnected: true,
                error: null,
                summary: null,
              },
            ]}
            window={{
              sinceDay: UsageDay.make("2026-03-01"),
              untilDay: UsageDay.make("2026-03-31"),
              timeZone: "UTC",
            }}
          />
        </DialogPopup>
      </Dialog>,
    );
    await expect.element(page.getByRole("link", { name: "Fix the graph" })).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Update login" })).toBeVisible();
    await userEvent.type(page.getByLabelText("Project", { exact: true }), "Graph");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect.element(page.getByRole("link", { name: "Update login" })).not.toBeInTheDocument();
    await expect
      .element(
        page
          .getByRole("row")
          .filter({ hasText: "Filtered totals" })
          .getByRole("cell", { name: "$1.55", exact: true }),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect.element(page.getByRole("link", { name: "Update login" })).toBeVisible();
    await userEvent.type(page.getByLabelText("Project", { exact: true }), "Missing");
    await page.getByRole("button", { name: "Apply filters" }).click();
    const empty = page.getByText("No usage is recorded for this filter.", { exact: true });
    await expect.element(empty).toBeVisible();
    const emptyBounds = empty.element().getBoundingClientRect();
    const regionBounds = page
      .getByRole("region", { name: "Usage details" })
      .element()
      .getBoundingClientRect();
    expect(emptyBounds.left).toBeGreaterThanOrEqual(regionBounds.left);
    expect(emptyBounds.right).toBeLessThanOrEqual(regionBounds.right);
    await page.getByRole("button", { name: "Reset filters" }).click();
    await page.getByRole("button", { name: "Inspect thread usage" }).first().click();
    await expect
      .element(
        page
          .getByRole("dialog", { name: "Fix the graph", exact: true })
          .getByText("Thread usage for the selected dates, across all models and accounts."),
      )
      .toBeVisible();
    await expect
      .element(
        page
          .getByRole("dialog", { name: "Fix the graph", exact: true })
          .getByRole("link", { name: "Update login" }),
      )
      .not.toBeInTheDocument();
    await page
      .getByRole("dialog", { name: "Fix the graph", exact: true })
      .getByRole("link", { name: "Fix the graph" })
      .click();
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/workstation/thread-a"),
    );
  });
});
