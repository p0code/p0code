import { describe, expect, it } from "vite-plus/test";

import { colorMix, oklch, parseColor, toHex } from "./native-theme.ts";

describe("native-theme color conversion", () => {
  it("converts oklch to the sRGB the browser paints", () => {
    expect(toHex(oklch(1, 0, 0))).toBe("#ffffffff");
    expect(toHex(oklch(0, 0, 0))).toBe("#000000ff");
    // CSS Color 4 reference: oklch(62.8% 0.2577 29.23) is #ff0000.
    expect(toHex(parseColor("oklch(62.8% 0.2577 29.23)"))).toBe("#ff0000ff");
    // Tailwind v4 publishes these sRGB fallbacks.
    expect(toHex(parseColor("oklch(21% 0.006 285.885)"))).toBe("#18181bff");
    expect(toHex(parseColor("oklch(69.6% 0.17 162.48)"))).toBe("#00bc7dff");
    expect(toHex(parseColor("oklch(62.3% 0.214 259.815)"))).toBe("#2b7fffff");
  });

  it("mixes like CSS color-mix()", () => {
    const white = parseColor("#fff");
    const black = parseColor("#000");
    expect(toHex(colorMix("srgb", white, 0.5, black, null))).toBe("#808080ff");
    // A total under 100% scales alpha.
    expect(toHex(parseColor("color-mix(in srgb, #fff 10%, transparent)"))).toBe("#ffffff1a");
    expect(toHex(parseColor("--alpha(#fff / 8%)"))).toBe("#ffffff14");
    expect(toHex(parseColor("color-mix(in oklab, #ff0000 100%, #000)"))).toBe("#ff0000ff");
    expect(toHex(parseColor("light-dark(#111, #eee)", true))).toBe("#eeeeeeff");
  });
});
