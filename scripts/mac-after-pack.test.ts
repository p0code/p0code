// @effect-diagnostics nodeBuiltinImport:off - Tests real Info.plist merging in a temporary app bundle.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import plist from "plist";
import { describe, expect, it } from "vite-plus/test";

import { syncMacHelperUsageDescriptions } from "./mac-after-pack.ts";

describe("syncMacHelperUsageDescriptions", () => {
  it("copies NS*UsageDescription entries to the Helper Info.plist while preserving LSUIElement", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mac-after-pack-"));
    try {
      for (const productFilename of ["p0code", "p0code (Nightly)"]) {
        const appOutDir = NodePath.join(root, productFilename);
        const contentsDir = NodePath.join(appOutDir, `${productFilename}.app`, "Contents");
        const helperContentsDir = NodePath.join(
          contentsDir,
          "Frameworks",
          `${productFilename} Helper.app`,
          "Contents",
        );
        await NodeFSP.mkdir(helperContentsDir, { recursive: true });

        await NodeFSP.writeFile(
          NodePath.join(contentsDir, "Info.plist"),
          plist.build({
            CFBundleExecutable: productFilename,
            CFBundleIdentifier: "tw.yhw.p0code",
            NSCameraUsageDescription: "Camera usage",
            NSMicrophoneUsageDescription: "Microphone usage",
            NSAppleEventsUsageDescription: "AppleEvents usage",
            NSLocalNetworkUsageDescription: "Local network usage",
            NSCalendarsUsageDescription: "Calendars usage",
            CFBundleDocumentTypes: [{ CFBundleTypeName: "Web page" }],
          }),
          "utf8",
        );
        await NodeFSP.writeFile(
          NodePath.join(helperContentsDir, "Info.plist"),
          plist.build({
            CFBundleExecutable: `${productFilename} Helper`,
            CFBundleIdentifier: "tw.yhw.p0code.helper",
            LSUIElement: true,
          }),
          "utf8",
        );

        await syncMacHelperUsageDescriptions(appOutDir, productFilename);

        const updatedHelper = plist.parse(
          await NodeFSP.readFile(NodePath.join(helperContentsDir, "Info.plist"), "utf8"),
        ) as Record<string, unknown>;
        expect(updatedHelper).toMatchObject({
          CFBundleExecutable: `${productFilename} Helper`,
          CFBundleIdentifier: "tw.yhw.p0code.helper",
          LSUIElement: true,
          NSCameraUsageDescription: "Camera usage",
          NSMicrophoneUsageDescription: "Microphone usage",
          NSAppleEventsUsageDescription: "AppleEvents usage",
          NSLocalNetworkUsageDescription: "Local network usage",
          NSCalendarsUsageDescription: "Calendars usage",
        });
        expect(updatedHelper.CFBundleDocumentTypes).toBeUndefined();
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
