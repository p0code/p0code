import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PullRequestStartAgentButton } from "./PullRequestDetailActions";

it("starts the agent from the header button", async () => {
  const onStartAgent = vi.fn();
  await using screen = await render(
    <PullRequestStartAgentButton
      handoff={null}
      disabledReason={null}
      onStartAgent={onStartAgent}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Start agent on this branch" }));

  expect(onStartAgent).toHaveBeenCalledTimes(1);
});

it("stays disabled and explains why when the checkout cannot run", async () => {
  const onStartAgent = vi.fn();
  await using screen = await render(
    <PullRequestStartAgentButton
      handoff={null}
      disabledReason="Environment is disconnected"
      onStartAgent={onStartAgent}
    />,
  );

  const button = screen.getByRole("button", { name: "Start agent on this branch" });
  await expect.element(button).toBeDisabled();
  await expect.element(button).toHaveAttribute("aria-description", "Environment is disconnected");
  expect(onStartAgent).not.toHaveBeenCalled();
});
