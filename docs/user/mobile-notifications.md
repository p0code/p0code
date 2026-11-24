# Mobile notifications

Your phone can alert you when an agent finishes, fails, needs approval, or asks
for input. Enable **Device Notifications** in **Settings → Notifications**, grant
notification permission when the app asks, and tap a notification to open its
thread.

Alerts arrive while the app is connected to the environment or open in the
foreground; they are delivered over that connection, and your environment must
be running and reachable. Notification permission and notification channels are
controlled in system Settings: disabling permission there, or force-stopping the
app, stops alerts until you re-enable them.

Push notifications and Live Activities in the App Store and Google Play builds
are not available through a [self-hosted relay](./remote-access.md#self-hosted-relay):
delivering them when the app is not connected needs the upstream APNs/FCM keys,
so a relay-linked environment cannot reach the store app in the background.
