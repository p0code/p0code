import { describe, expect, it } from "vite-plus/test";
import { pluginInstallError, validGithubInput } from "./pluginInstall.logic";

describe("plugin install input", () => {
  it("accepts repositories, tagged shorthand and release artifacts, and refuses credentials and non-GitHub URLs", () => {
    for (const value of [
      "p0code/backup",
      "owner/repo@v1",
      "https://github.com/p0code/backup",
      "https://github.com/owner/repo/releases/download/v1/plugin.zip",
    ])
      expect(validGithubInput(value)).toBe(true);
    for (const value of [
      "bad url",
      "http://github.com/a/b",
      "https://user:secret@github.com/a/b",
      "https://evil.test/a/b",
      "https://github.com/a/b?token=secret",
    ])
      expect(validGithubInput(value)).toBe(false);
  });
  it("replaces internal failures with actionable host copy", () => {
    for (const value of [
      "Bad URL",
      "Checksum mismatch",
      "No manifest.json",
      "Incompatible plugin API",
      "This plugin is built into the server",
      "Network failure",
      "Error: private/path\n at stack",
    ]) {
      expect(pluginInstallError(new Error(value))).toBeDefined();
      expect(JSON.stringify(pluginInstallError(new Error(value)))).not.toContain("private/path");
    }
  });
});
