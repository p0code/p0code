import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceAccountDetail,
  providerInstanceBadgeLength,
  providerInstanceInitials,
  providerInstanceShortLabel,
  resolveProviderInstanceBadges,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("providerInstanceInitials", () => {
  it("treats punctuation and camel-case humps as word breaks but keeps apostrophes between letters", () => {
    expect(providerInstanceInitials("Codex (hub)")).toBe("CH");
    expect(providerInstanceInitials("work_codex")).toBe("WC");
    expect(providerInstanceInitials("Theo's Codex")).toBe("TC");
    expect(providerInstanceInitials("Codex 'hub'")).toBe("CH");
    expect(providerInstanceInitials("‘hub’")).toBe("HU");
    expect(providerInstanceInitials("(hub)")).toBe("HU");
    expect(providerInstanceInitials("ClaudeProx")).toBe("CP");
    expect(providerInstanceInitials("ClaudeAPI")).toBe("CA");
    expect(providerInstanceInitials("API")).toBe("AP");
    expect(providerInstanceInitials("ClaudeProx Work")).toBe("CW");
    expect(providerInstanceInitials("(ClaudeProx)")).toBe("CP");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });
});

describe("providerInstanceShortLabel", () => {
  it("returns only the account in a trailing parenthetical", () => {
    expect(providerInstanceShortLabel("Claude (Denny NCSE)")).toBe("Denny NCSE");
    expect(providerInstanceShortLabel("  Claude ( Denny NCSE )  ")).toBe("Denny NCSE");
    expect(providerInstanceShortLabel("(Denny)")).toBe("Denny");
    expect(providerInstanceShortLabel("Claude (Work (Night))")).toBe("Work (Night)");
  });

  it("leaves names without a trailing parenthetical alone", () => {
    expect(providerInstanceShortLabel("Claude")).toBe("Claude");
    expect(providerInstanceShortLabel("  Claude  ")).toBe("Claude");
    expect(providerInstanceShortLabel("Claude (Denny) NCSE")).toBe("Claude (Denny) NCSE");
    expect(providerInstanceShortLabel("Claude )Denny(")).toBe("Claude )Denny(");
  });

  it("falls back to the full name when the parenthetical is empty", () => {
    expect(providerInstanceShortLabel("Claude ()")).toBe("Claude ()");
    expect(providerInstanceShortLabel("Claude (   )")).toBe("Claude (   )");
  });
});

describe("normalizeProviderAccentColor", () => {
  // regression: #9899 a non-hex accent must not render as the account badge color
  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });
});

describe("providerAccentForegroundColor", () => {
  it.each([
    ["#b5f23d", "#000000"],
    ["#2563eb", "#ffffff"],
    ["#777777", "#000000"],
  ])("chooses the higher WCAG contrast foreground for %s", (accent, foreground) => {
    expect(providerAccentForegroundColor(accent)).toBe(foreground);
  });
});

describe("shouldShowInstanceBadge", () => {
  it("hides badges for distinct ACP agents sharing the registry driver", () => {
    const mistral = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe", enabled: true };
    const devin = { driverKind: acpRegistry, acpRegistryAgentId: "devin", enabled: true };
    expect(shouldShowInstanceBadge(mistral, [mistral, devin])).toBe(false);
    expect(shouldShowInstanceBadge(devin, [mistral, devin])).toBe(false);
  });

  it("distinguishes registry instances whose agent identity is unavailable", () => {
    const entry = { driverKind: acpRegistry, enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(true);
  });

  it("shows the badge when the entry has its own badge", () => {
    const entry = { driverKind: codex, instanceBadge: "W", enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800", enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("ignores a non-hex accent color", () => {
    const entry = { driverKind: codex, accentColor: "blue", enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(false);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined, enabled: true };
    const second = { driverKind: codex, accentColor: undefined, enabled: true };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("ignores disabled siblings for enabled instances while distinguishing historical owners", () => {
    const enabled = { driverKind: codex, enabled: true };
    const disabled = { driverKind: codex, enabled: false };

    expect(shouldShowInstanceBadge(enabled, [enabled, disabled])).toBe(false);
    expect(shouldShowInstanceBadge(disabled, [enabled, disabled])).toBe(true);
    expect(shouldShowInstanceBadge(disabled, [disabled, { ...disabled }])).toBe(true);
    expect(shouldShowInstanceBadge(disabled, [disabled])).toBe(false);
  });
});

describe("resolveProviderInstanceBadges", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const instance = (instanceId: string, displayName: string, instanceBadge?: string) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: claude,
    displayName,
    ...(instanceBadge ? { instanceBadge } : {}),
  });
  const badgesOf = (...providers: ReadonlyArray<ReturnType<typeof instance>>) =>
    providers.map((provider) => resolveProviderInstanceBadges(providers).get(provider.instanceId));

  it("adds the first differing word or number when initials collide", () => {
    expect(
      badgesOf(
        instance("work-business", "Claude Work Business"),
        instance("work-2", "Claude Work 2"),
      ),
    ).toEqual(["CWB", "CW2"]);
    expect(badgesOf(instance("a", "Claude 12"), instance("b", "Claude 13"))).toEqual([
      "C12",
      "C13",
    ]);
    expect(badgesOf(instance("a", "Work"), instance("b", "Work2"))).toEqual(["WO", "W2"]);
  });

  it("keeps the plain initials for the name that is a prefix of another", () => {
    expect(
      badgesOf(instance("ncse", "Claude (Denny NCSE)"), instance("denny", "Claude Denny")),
    ).toEqual(["CDN", "CD"]);
  });

  it("keeps plain initials when they already differ or the instance is alone", () => {
    expect(badgesOf(instance("a", "Claude Work"), instance("b", "Personal"))).toEqual(["CW", "PE"]);
    expect(badgesOf(instance("a", "C"))).toEqual(["C"]);
  });

  it("numbers identical names, the default instance first", () => {
    expect(
      badgesOf(instance("z", "Work"), instance("claudeAgent", "Work"), instance("y", "Work")),
    ).toEqual(["W3", "WO", "W2"]);
  });

  it("prefers a set badge, capped at three graphemes, and avoids it in defaults", () => {
    expect(badgesOf(instance("a", "Claude Work", "🏢"), instance("b", "Claude Work"))).toEqual([
      "🏢",
      "CW",
    ]);
    expect(badgesOf(instance("a", "Claude Work", "CW"), instance("b", "Claude Work"))).toEqual([
      "CW",
      "C2",
    ]);
    expect(badgesOf(instance("a", "Claude", "👩‍💻🇹🇼ABC"))).toEqual(["👩‍💻🇹🇼A"]);
  });

  it("does not compare instances of different drivers", () => {
    const providers = [
      instance("a", "Work"),
      { ...instance("b", "Work"), driver: ProviderDriverKind.make("codex") },
    ];
    const badges = resolveProviderInstanceBadges(providers);
    expect([badges.get("a"), badges.get("b")]).toEqual(["WO", "WO"]);
  });
});

describe("providerInstanceBadgeLength", () => {
  it("counts emoji sequences as one character", () => {
    expect(providerInstanceBadgeLength("👩‍💻")).toBe(1);
    expect(providerInstanceBadgeLength("🇹🇼")).toBe(1);
    expect(providerInstanceBadgeLength("👍🏽A")).toBe(2);
    expect(providerInstanceBadgeLength(" é ")).toBe(1);
  });
});

describe("providerInstanceAccountDetail", () => {
  it("joins the account email and plan when known", () => {
    expect(providerInstanceAccountDetail({ email: "a@b.c", label: "Max" })).toBe("a@b.c · Max");
    expect(providerInstanceAccountDetail({})).toBeUndefined();
  });
});
