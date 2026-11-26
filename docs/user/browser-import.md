# Import browser sessions

Import cookies from another browser into the desktop app's [preview browser](./browser.md) so you can reuse existing signed-in sessions.

## Import a profile

1. Close the source browser.
2. Open **Settings → Browser → Browser profiles → Add profile** and choose a browser under **Import from**.
3. Allow any OS keyring unlock prompt.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag p0code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen p0code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

## Platform notes

- **macOS (Safari)**: Requires temporary **Full Disk Access** (grant in System Settings, quit/reopen T3 Code if macOS requires it, then reopen the import wizard). You can revoke Full Disk Access afterward.
- **Windows**: Supports Firefox, Zen, and Helium profiles using standard encryption. Other Chromium browsers use app-bound encryption and cannot be imported.
- Partitioned cookies are skipped on all platforms. Administrators can disable cookie import via [managed policy](./managed-policy.md#other-capabilities).
