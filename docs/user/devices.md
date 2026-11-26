# Devices

The Device panel shows a live iOS Simulator or Android Emulator next to a
thread, so you can watch an agent verify mobile work and tap the device
yourself. Agents get the same device through `device_*` tools and the
`agent-device` command line, which p0code sets up for them.

## Open a device

Open the right panel in a project thread and choose **Device** (first-time setup starts the device hub, checks iOS/Android tools, and asks whether agents may control devices).

- Start a stopped device or attach to a running one; open additional devices via **+ → Device**.
- Click, drag, and type directly on the live screen; use the toolbar for Home, Back, Recents, rotate, power off, **3D view** (and fold/unfold on foldables), **Tools**, or **Float device over chat**.
- **Tools drawer**: Inspect the foreground app, toggle dark mode, text size, accessibility overlays, mock location, app permissions, iOS VoiceOver / test push notifications, and Android orientation / network toggles.
- Closing a tab stops streaming without powering off the device. Turn off **Settings → Devices → Use devices** to stop helper processes.

Simulators run on the machine that hosts the environment server. iOS needs
macOS with Xcode. Android needs the SDK Platform-Tools, Android Emulator,
and Command-line Tools (latest), plus a virtual device created in Android
Studio's Device Manager. p0code detects standard SDK locations; set
`ANDROID_HOME` for a custom location. The panel explains missing dependencies.
After installing SDK tools, restart the environment server and refresh devices.

Devices run on the environment's server machine (or an SSH/Simlock device host):

- **iOS Simulators**: macOS with Xcode.
- **Android Emulators**: Android SDK Platform-Tools, Android Emulator, Command-line Tools (latest), an AVD created in Android Studio, and `ffmpeg` with `libx264` on `PATH` (or `SERVE_EMU_FFMPEG`). Set `ANDROID_HOME` for custom SDK paths.
- **Physical Android devices**: SDK Platform-Tools only (no `ffmpeg`). Enable **USB debugging** (and **USB debugging (Security settings)** on Xiaomi devices), or pair wirelessly via `adb pair <addr>:<pairing-port>` then `adb connect <addr>:<port>`.

Restart the environment server after installing SDK tools or changing `PATH` / `SERVE_EMU_FFMPEG`.

## Agents and devices

Enable **Settings → Devices → Agents can use devices** so agents can drive devices through `agent-device` (restart existing agent sessions after enabling). First iOS tap builds a small test runner once per server (~2 minutes).

When an agent opens a device, it floats over chat by default (disable **Settings → Browser → Auto-show floating preview** to open in the right panel instead). On mobile, tap the device button above the composer to watch and interact.

## Remote connections

The device stream goes through the environment server, so it works over the
local network, Tailscale, and the relay. Live video needs a secure page
(HTTPS or localhost); on a plain-HTTP remote origin iOS falls back to a slower
still-image stream and Android cannot show video, except on Expo Simulators.

## SSH device hosts

Use simulators/emulators on another macOS or Linux machine (e.g., a Mac build host from Linux/Windows):

**Test connection**, in the host's menu, checks SSH, Node, npm, and platform tools without installing
anything, with a result for each selected environment. Targets that resolve to
the environment’s own machine are skipped, since its devices are already local.
The first device listing installs pinned device tools on the host.
SSH device hosts currently need macOS or Linux. To use devices on a Windows
machine, run p0code on that machine and connect to its environment.
Node 22.12 or newer and npm must be available to non-interactive SSH commands.
T3 checks common Homebrew and Android SDK locations; custom installations need
the appropriate PATH and `ANDROID_HOME` or `ANDROID_SDK_ROOT` on the host.
Android on an SSH host needs the same SDK tools as a local environment; adb on
the PATH alone does not enable it. Android emulator video needs
`ffmpeg` with libx264 on that host; physical Android devices use scrcpy and do
not need ffmpeg.

> Note: Remote simulators cannot reach `localhost` dev servers (like Metro) on your main host without port forwarding or a reachable network address.

## Simlock hosts (alpha)

Connect to a [Simlock](https://incubator.callstack.com/simlock/) device pool (requires Simlock `main` at commit `6316e10`+ with `capabilities.stream.enabled` and `capabilities.input.enabled`):

1. Enable **Settings → Labs → Simlock device hosts (alpha)** and **Settings → Devices → Use devices**.
2. Choose **Add source → Simlock pool** with an agent token (`simlock --gateway token create --role agent`) over HTTPS or Tailscale (give each T3 server its own token; treat it like worker shell access).
3. Closing a device with **Return device to the pool** wipes and releases the lease. Toolbar tools/rotation/screenshots are unavailable in the UI (agents can still invoke them via `device_open`).

## Device tool updates

The T3 server manages device hub and `agent-device` versions automatically on itself and SSH hosts. Check versions in **Settings → Devices → Check versions**; update the remote T3 server to receive newer device tools.
