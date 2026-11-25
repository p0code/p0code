# Unofficial T3 Connect bridge

The T3 Connect bridge links this environment to the official T3 Connect service. Once linked,
T3 Code apps signed in to your T3 account (app.t3.codes and the App Store / Google Play builds)
list the environment and connect to it, and the store mobile app gets push notifications and
Live Activities when agents finish or need you.

It is unofficial: T3 did not build it and may change its service at any time.

## Before you turn it on

- **It is not end-to-end encrypted.** Traffic runs through a Cloudflare tunnel, and Cloudflare
  sees it unencrypted. T3's relay sees your devices, connection details, and the thread and
  project titles in notifications.
- **Your T3 account decides who gets in.** Any device signed in to that account can connect to
  this environment while the bridge is on, with the same access as a device paired by link.
- It works alongside a [self-hosted relay](./remote-access.md#self-hosted-relay). Pairing links,
  guest links, and forwarded ports keep using the self-hosted relay.

## Turn it on

1. Open **Settings → Plugins** on this environment and turn on **Unofficial T3 Connect bridge**.
2. Choose **Sign in to T3 Connect**, then **Approve in browser** and confirm the code shown. The
   browser can be on any device.
3. The bridge links the environment when sign-in finishes. The first start downloads
   `cloudflared` once.

Turning the bridge off stops the tunnel and push notifications and signs out every device that
connected through it. **Unlink** removes the environment from your T3 account; **Sign out** also
forgets the sign-in on this environment.

Mobile shows the switch under **Connections**; sign in from web or desktop.
