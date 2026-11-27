import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Switch } from "../ui/switch";
import { ProviderInstancesLayout, type ProviderInstanceListGroup } from "./ProviderInstancesLayout";

function Harness({ groups }: { readonly groups: ReadonlyArray<ProviderInstanceListGroup> }) {
  const firstId = groups.flatMap((group) => group.rows)[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(firstId);
  return (
    <ProviderInstancesLayout
      title="Providers"
      listLabel="Providers list"
      detailLabel="Provider detail"
      groups={groups}
      selectedId={selectedId}
      onSelect={setSelectedId}
      detail={<div data-testid="detail-selected">{selectedId ?? "none"}</div>}
    />
  );
}

describe("ProviderInstancesLayout", () => {
  it("supports accessible listbox selection, keyboard navigation, and sibling trailing toggles", async () => {
    let toggled = 0;
    const groups: ReadonlyArray<ProviderInstanceListGroup> = [
      {
        id: "primary",
        label: "Built-in",
        rows: [
          {
            id: "alpha",
            icon: <span aria-hidden>A</span>,
            name: "Alpha",
            version: "v1.0.0",
            status: "Ready",
            statusTone: "ready",
            trailing: (
              <Switch
                checked
                aria-label="Toggle Alpha"
                onCheckedChange={() => {
                  toggled += 1;
                }}
              />
            ),
          },
          {
            id: "beta",
            icon: <span aria-hidden>B</span>,
            name: "Beta",
            status: "Disabled",
            statusTone: "disabled",
            dimmed: true,
          },
        ],
      },
      {
        id: "extras",
        label: "Plugins",
        rows: [
          {
            id: "gamma",
            icon: <span aria-hidden>G</span>,
            name: "Gamma",
            status: "Error",
            statusTone: "error",
          },
        ],
      },
    ];

    await using _screen = await render(<Harness groups={groups} />, { router: false });

    const listbox = page.getByRole("listbox", { name: "Providers list" });
    const alpha = listbox.getByRole("option", { name: "Alpha" });
    const beta = listbox.getByRole("option", { name: "Beta" });
    const gamma = listbox.getByRole("option", { name: "Gamma" });

    await expect.element(alpha).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByTestId("detail-selected")).toHaveTextContent("alpha");

    // Clicking the trailing switch triggers it without interfering with selection.
    await userEvent.click(page.getByRole("switch", { name: "Toggle Alpha" }));
    expect(toggled).toBe(1);

    // Keyboard navigation moves selection & focus across groups.
    await userEvent.click(alpha);
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(beta).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByTestId("detail-selected")).toHaveTextContent("beta");

    await userEvent.keyboard("{End}");
    await expect.element(gamma).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByTestId("detail-selected")).toHaveTextContent("gamma");

    await userEvent.keyboard("{Home}");
    await expect.element(alpha).toHaveAttribute("aria-selected", "true");
  });
});
