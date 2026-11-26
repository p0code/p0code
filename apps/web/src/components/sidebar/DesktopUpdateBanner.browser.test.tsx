import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { DesktopUpdateBanner } from "./DesktopUpdateBanner";

vi.mock("../../state/desktopUpdate", () => ({
  useDesktopUpdateState: () => ({ availableVersion: "0.2.4", status: "available" }),
}));

it("shows the update and lets the user dismiss its notice", async () => {
  await using screen = await render(<DesktopUpdateBanner />);
  await expect.element(screen.getByText("p0code 0.2.4 is available.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Review update" })).toBeVisible();
  await screen.getByRole("button", { name: "Dismiss" }).click();
  await expect.element(screen.getByText("p0code 0.2.4 is available.")).not.toBeInTheDocument();
});
