import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Keeps apps/p0d/dist/<goos>-<goarch>/p0d current for the dev desktop, which runs p0d as its
// backend. Without Go the app explains how to get p0d when it starts.

// oxlint-disable-next-line t3code/no-global-process-runtime -- Builds for the actual dev host; this script has no Effect runtime.
const hostPlatform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Builds for the actual dev host; this script has no Effect runtime.
const hostArch = process.arch;

const p0dDir = NodeURL.fileURLToPath(new URL("../../p0d/", import.meta.url));
const goos = hostPlatform === "win32" ? "windows" : hostPlatform;
const goarch = hostArch === "x64" ? "amd64" : hostArch;
const output = NodePath.join(
  p0dDir,
  "dist",
  `${goos}-${goarch}`,
  hostPlatform === "win32" ? "p0d.exe" : "p0d",
);

function newestSourceMtime(directory) {
  let newest = 0;
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist") newest = Math.max(newest, newestSourceMtime(path));
    } else if (/\.go$|^go\.(mod|sum)$/.test(entry.name)) {
      newest = Math.max(newest, NodeFS.statSync(path).mtimeMs);
    }
  }
  return newest;
}

let builtAt = 0;
try {
  builtAt = NodeFS.statSync(output).mtimeMs;
} catch {}

if (builtAt < newestSourceMtime(p0dDir)) {
  const go = NodeChildProcess.spawnSync("go", ["version"], { stdio: "ignore" });
  if (go.error || go.status !== 0) {
    console.warn(
      builtAt > 0
        ? `[p0d] Go is not installed; using the older build at ${output}.`
        : "[p0d] Go is not installed, so p0d can't be built. Install Go or put a p0d binary in ~/.p0code/bin; the desktop app will say where it looked.",
    );
  } else {
    console.log(`[p0d] building ${output}`);
    NodeChildProcess.execFileSync("go", ["build", "-trimpath", "-o", output, "."], {
      cwd: p0dDir,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
  }
}
