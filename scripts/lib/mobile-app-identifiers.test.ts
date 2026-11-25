import { expect, it } from "vite-plus/test";

import { resolveMobileAppIdentifiers } from "./mobile-app-identifiers.ts";

it("resolves the fork's app identifiers for each variant", () => {
  expect(resolveMobileAppIdentifiers("development", {})).toEqual({
    iosBundleIdentifier: "com.p0code.p0code.dev",
    androidPackage: "com.p0code.p0code.dev",
  });
  expect(resolveMobileAppIdentifiers("preview", {})).toEqual({
    iosBundleIdentifier: "com.p0code.p0code.preview",
    androidPackage: "com.p0code.p0code.preview",
  });
  expect(resolveMobileAppIdentifiers("production", {})).toEqual({
    iosBundleIdentifier: "com.p0code.p0code",
    androidPackage: "com.p0code.p0code",
  });
});

it("applies the Personal Team bundle ID only to the variant being built", () => {
  const env = {
    APP_VARIANT: "preview",
    T3CODE_IOS_PERSONAL_TEAM: "1",
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.custom",
  };
  expect(resolveMobileAppIdentifiers("preview", env)).toEqual({
    iosBundleIdentifier: "com.example.custom",
    androidPackage: "com.p0code.p0code.preview",
  });
  expect(resolveMobileAppIdentifiers("production", env).iosBundleIdentifier).toBe(
    "com.p0code.p0code",
  );
  expect(
    resolveMobileAppIdentifiers("preview", {
      APP_VARIANT: "preview",
      T3CODE_IOS_PERSONAL_TEAM: "0",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.custom",
    }).iosBundleIdentifier,
  ).toBe("com.p0code.p0code.preview");
});
