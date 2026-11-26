const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function macUpdateHelper(options: {
  app: string;
  dmg: string;
  directory: string;
  pid: number;
  checksum: string;
}) {
  return `#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
app=${quote(options.app)}
dmg=${quote(options.dmg)}
work=${quote(options.directory)}
expected=${quote(options.checksum)}
stage="$work/staged.app"
mount="$work/mount"
backup="$app.previous-update"
log="$work/install.log"
exec >>"$log" 2>&1
mounted=0
moved=0
cleanup() {
  result=$?
  if [ "$mounted" = 1 ]; then hdiutil detach "$mount" -quiet || true; fi
  if [ "$result" != 0 ]; then
    if [ "$moved" = 1 ] && [ ! -e "$app" ]; then mv "$backup" "$app"; fi
    printf '%s\\n' 'Update failed. The current app has been kept. See install.log.' > "$work/failure"
    if [ "\${1:-}" = install ]; then open "$app" || true; fi
  fi
}
trap 'cleanup "\${1:-}"' EXIT
fingerprint() {
  rm -f "$work/cert0"
  codesign --display --extract-certificates "$work/cert" "$1"
  test -s "$work/cert0"
  shasum -a 256 "$work/cert0" | cut -d ' ' -f 1
}
if [ "\${1:-}" = prepare ]; then
  [ -w "$app" ] && [ -w "$(dirname "$app")" ] || { echo 'Install location is not writable. Move the app to a writable Applications folder.'; exit 1; }
  [ ! -e "$backup" ] || { echo 'A previous update backup exists. Move it aside before retrying.'; exit 1; }
  actual=$(shasum -a 256 "$dmg" | cut -d ' ' -f 1)
  [ "$actual" = "$expected" ] || { echo 'SHA256 checksum mismatch.'; exit 1; }
  mkdir -p "$mount"
  hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mount" -quiet
  mounted=1
  candidates=("$mount"/*.app)
  [ "\${#candidates[@]}" = 1 ] || exit 1
  source="\${candidates[0]}"
  test -d "$source"
  codesign --verify --deep --strict "$source"
  current=$(fingerprint "$app")
  incoming=$(fingerprint "$source")
  [ "$current" = "$incoming" ] || { echo 'Update signing certificate does not match the current app.'; exit 1; }
  currentId=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist")
  incomingId=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$source/Contents/Info.plist")
  [ "$currentId" = "$incomingId" ] || exit 1
  rm -rf "$stage"
  ditto "$source" "$stage"
  codesign --verify --deep --strict "$stage"
  hdiutil detach "$mount" -quiet
  mounted=0
elif [ "\${1:-}" = install ]; then
  for ((i=0; i<120; i++)); do
    kill -0 ${options.pid} 2>/dev/null || break
    sleep 1
  done
  if kill -0 ${options.pid} 2>/dev/null; then echo 'App did not quit; update cancelled.'; exit 1; fi
  codesign --verify --deep --strict "$stage"
  [ "$(fingerprint "$app")" = "$(fingerprint "$stage")" ] || exit 1
  replacement="$(dirname "$app")/.p0code-update-$$.app"
  ditto "$stage" "$replacement"
  codesign --verify --deep --strict "$replacement"
  xattr -dr com.apple.quarantine "$replacement" || true
  attributes=$(xattr -lr "$replacement")
  if printf '%s' "$attributes" | grep -q 'com.apple.quarantine:'; then echo 'Could not clear quarantine.'; exit 1; fi
  mv "$app" "$backup"
  moved=1
  if ! mv "$replacement" "$app"; then mv "$backup" "$app"; moved=0; exit 1; fi
  if ! open "$app"; then mv "$app" "$replacement"; mv "$backup" "$app"; moved=0; exit 1; fi
  rm -rf "$backup" "$stage" "$dmg"
else
  exit 1
fi
`;
}
