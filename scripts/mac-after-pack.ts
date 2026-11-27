// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import plist from "plist";

const prepareServerCompileCache: (context: MacAfterPackContext) => Promise<void> =
  NodeModule.createRequire(import.meta.url)("./prepare-server-compile-cache.cjs");

interface MacAfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly arch: number;
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string;
    };
  };
}

const USAGE_DESCRIPTION_KEY = /^NS.*UsageDescription$/;

function asPlistRecord(value: unknown, filePath: string): Record<string, plist.PlistValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected dictionary plist at ${filePath}`);
  }
  return value as Record<string, plist.PlistValue>;
}

/**
 * Copies macOS TCC usage descriptions from the main app's Info.plist into the generic Helper's
 * Info.plist before code signing so detached/CLI launches running as `p0code Helper` carry the
 * same usage strings while preserving `LSUIElement`.
 */
export async function syncMacHelperUsageDescriptions(
  appOutDir: string,
  productFilename: string,
): Promise<void> {
  const contentsDir = NodePath.join(appOutDir, `${productFilename}.app`, "Contents");
  const appPlistPath = NodePath.join(contentsDir, "Info.plist");
  const appPlist = asPlistRecord(
    plist.parse(await NodeFSP.readFile(appPlistPath, "utf8")),
    appPlistPath,
  );
  const executableName =
    typeof appPlist.CFBundleExecutable === "string" && appPlist.CFBundleExecutable.length > 0
      ? appPlist.CFBundleExecutable
      : productFilename;
  const helperName = `${executableName} Helper`;
  const helperPlistPath = NodePath.join(
    contentsDir,
    "Frameworks",
    `${helperName}.app`,
    "Contents",
    "Info.plist",
  );
  const helperPlist = asPlistRecord(
    plist.parse(await NodeFSP.readFile(helperPlistPath, "utf8")),
    helperPlistPath,
  );

  for (const [key, value] of Object.entries(appPlist)) {
    if (USAGE_DESCRIPTION_KEY.test(key) && typeof value === "string") {
      helperPlist[key] = value;
    }
  }

  await NodeFSP.writeFile(helperPlistPath, plist.build(helperPlist), "utf8");
}

export default async function afterPack(context: MacAfterPackContext): Promise<void> {
  await prepareServerCompileCache(context);
  if (context.electronPlatformName !== "darwin") return;
  await syncMacHelperUsageDescriptions(context.appOutDir, context.packager.appInfo.productFilename);
}
