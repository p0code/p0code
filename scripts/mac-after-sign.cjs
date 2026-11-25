// Unsigned macOS builds are re-signed with a stable self-signed identity when one is available, so
// macOS treats every update as the same app and keeps keychain "Always Allow" answers.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const DEFAULT_IDENTITY = "p0code Self-Signed";

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const requested = process.env.P0CODE_MAC_SIGN_IDENTITY?.trim();
  const identity = requested || DEFAULT_IDENTITY;
  const identities = execFileSync("security", ["find-identity", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (!identities.includes(`"${identity}"`)) {
    if (requested)
      throw new Error(`P0CODE_MAC_SIGN_IDENTITY "${identity}" is not in the keychain.`);
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync(
    "codesign",
    ["--force", "--deep", "--preserve-metadata=entitlements", "--sign", identity, app],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
