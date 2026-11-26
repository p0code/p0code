import { msg } from "gt-react";

export function pluginInstallError(error: unknown) {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/checksum/i.test(text))
    return msg(
      "Checksum mismatch. Retry the download or contact the plugin author. Nothing was activated.",
    );
  if (/api|compatible/i.test(text))
    return msg(
      "This plugin needs a different API version. Update p0code or choose a compatible plugin release.",
    );
  if (/built into|bundled/i.test(text))
    return msg("This plugin is bundled with p0code. Update the app to update it.");
  if (/manifest|bundle|archive/i.test(text))
    return msg(
      "No valid plugin bundle. Choose a .zip or .tgz containing manifest.json and plugin.mjs.",
    );
  if (/URL|catalog plugin/i.test(text))
    return msg(
      "Invalid plugin URL. Use a GitHub repository, release asset URL, or owner/repo@tag.",
    );
  if (/already installed/i.test(text))
    return msg(
      "This version is already installed. Choose a newer release or review the staged version below.",
    );
  if (/catalog.*date/i.test(text))
    return msg(
      "The catalog does not match this release. Ask the plugin author to update the shop entry.",
    );
  if (/Network|Download|fetch/i.test(text))
    return msg(
      "Download failed. Check the server's internet connection and the release URL, then retry.",
    );
  return msg("The plugin action failed. Check the bundle and server connection, then try again.");
}

export function validGithubInput(value: string): boolean {
  if (/^[\w.-]+\/[\w.-]+(?:@[^\s]+)?$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      /^\/[\w.-]+\/[\w.-]+\/?(?:releases\/(?:tag\/[^/]+|download\/[^/]+\/[^/]+))?$/.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}

export async function pluginUpload(files: FileList | readonly File[]) {
  const selected = Array.from(files);
  if (selected.length === 1 && /\.(zip|tgz|tar\.gz)$/i.test(selected[0]!.name)) {
    const file = selected[0]!;
    if (file.size > 32 * 1024 * 1024) throw new Error("Plugin archive exceeds 32 MiB.");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]!);
      reader.onerror = () => reject(new Error("Cannot read plugin archive."));
      reader.readAsDataURL(file);
    });
    return { source: file.name, upload: { name: file.name, data } };
  }
  const manifest = selected.find((file) => file.name === "manifest.json");
  const code = selected.find((file) => file.name === "plugin.mjs");
  if (!manifest || !code || manifest.size + code.size > 32 * 1024 * 1024)
    throw new Error("No valid manifest.json + plugin.mjs bundle.");
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("manifest.json", await manifest.arrayBuffer());
  zip.file("plugin.mjs", await code.arrayBuffer());
  return {
    source: "plugin.zip",
    upload: { name: "plugin.zip", data: await zip.generateAsync({ type: "base64" }) },
  };
}
