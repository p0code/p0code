import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Combobox, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxTrigger } from "./combobox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

it.each(["menu", "popover", "combobox"])(
  "closes a persistent %s on route navigation",
  async (kind) => {
    await using screen = await render(
      kind === "menu" ? (
        <Menu>
          <MenuTrigger>Choose</MenuTrigger>
          <MenuPopup>
            <MenuItem>Environment</MenuItem>
          </MenuPopup>
        </Menu>
      ) : kind === "popover" ? (
        <Popover>
          <PopoverTrigger>Choose</PopoverTrigger>
          <PopoverPopup>Environment</PopoverPopup>
        </Popover>
      ) : (
        <Combobox>
          <ComboboxTrigger>Choose</ComboboxTrigger>
          <ComboboxPopup>
            <ComboboxList>
              <ComboboxItem value="local">Environment</ComboboxItem>
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      ),
    );
    await userEvent.click(screen.getByText("Choose", { exact: true }));
    await expect.element(page.getByText("Environment", { exact: true })).toBeVisible();
    await screen.router!.navigate({ to: "/settings/general" });
    if (kind === "combobox") {
      await expect.element(page.getByText("Environment", { exact: true })).not.toBeVisible();
    } else {
      await expect.element(page.getByText("Environment", { exact: true })).not.toBeInTheDocument();
    }
    await expect
      .element(screen.getByText("Choose", { exact: true }))
      .toHaveAttribute("aria-expanded", "false");
  },
);
