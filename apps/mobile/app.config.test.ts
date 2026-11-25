import { expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
const repoEnv = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));

vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => repoEnv.current,
}));

async function loadConfig(variant: string | undefined, overrides: Record<string, string> = {}) {
  vi.resetModules();
  repoEnv.current = { APP_VARIANT: variant, ...overrides };
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.p0code.p0code"],
  ["development", "com.p0code.p0code.dev"],
  ["preview", "com.p0code.p0code.preview"],
  ["production", "com.p0code.p0code"],
])("uses the p0code iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.slug).toBe("p0code");
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
});

it("omits upstream distribution identities by default", async () => {
  const config = await loadConfig(undefined);
  expect(config.owner).toBeUndefined();
  expect(config.updates).toBeUndefined();
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.android?.intentFilters).toBeUndefined();
  expect((config.extra?.eas as { projectId?: string } | undefined)?.projectId).toBeUndefined();
});

it("reads EAS and hosted app identities from repo env", async () => {
  const projectId = "11111111-2222-3333-4444-555555555555";
  const config = await loadConfig(undefined, {
    T3CODE_EAS_OWNER: "p0owner",
    T3CODE_EAS_PROJECT_ID: projectId,
    T3CODE_MOBILE_UPDATES_URL: `https://u.expo.dev/${projectId}`,
    T3CODE_IOS_TEAM_ID: "ABCDE12345",
    T3CODE_MOBILE_HOSTED_APP_HOST: "app.example.com",
  });
  expect(config.owner).toBe("p0owner");
  expect(config.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
  expect(config.ios?.appleTeamId).toBe("ABCDE12345");
  expect(config.ios?.associatedDomains).toEqual(["applinks:app.example.com"]);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host: "app.example.com", pathPrefix: "/threads/" },
  ]);
  expect((config.extra?.eas as { projectId?: string } | undefined)?.projectId).toBe(projectId);
});
