export type MobileAppVariant = "development" | "preview" | "production";

export interface MobileAppIdentifiers {
  readonly iosBundleIdentifier: string;
  readonly androidPackage: string;
}

/**
 * Native identities per variant. The fork's own apps, shared by `apps/mobile/app.config.ts` and the
 * host scripts that install, drive, and measure the app.
 */
export const MOBILE_APP_IDENTIFIERS: Record<MobileAppVariant, MobileAppIdentifiers> = {
  development: {
    iosBundleIdentifier: "com.p0code.p0code.dev",
    androidPackage: "com.p0code.p0code.dev",
  },
  preview: {
    iosBundleIdentifier: "com.p0code.p0code.preview",
    androidPackage: "com.p0code.p0code.preview",
  },
  production: {
    iosBundleIdentifier: "com.p0code.p0code",
    androidPackage: "com.p0code.p0code",
  },
};

/**
 * The identifiers a variant's native project installs under, including the Personal Team override,
 * which applies only to the variant this checkout is configured to build. Scripts and the Expo
 * config resolve through here, so an install cannot look for a different app than the config builds.
 */
export function resolveMobileAppIdentifiers(
  variant: MobileAppVariant,
  env: Readonly<Record<string, string | undefined>>,
): MobileAppIdentifiers {
  const identifiers = MOBILE_APP_IDENTIFIERS[variant];
  const personalTeamBundleIdentifier =
    env.T3CODE_IOS_PERSONAL_TEAM === "1" && variant === (env.APP_VARIANT ?? "production")
      ? env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim()
      : undefined;
  return {
    iosBundleIdentifier: personalTeamBundleIdentifier || identifiers.iosBundleIdentifier,
    androidPackage: identifiers.androidPackage,
  };
}
