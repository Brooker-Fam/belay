#!/usr/bin/env bash
# Phase 0, step 4: the QR code for trying QR (managed) provisioning once, to record
# whether Google blocks it. Belay is normally provisioned with provision.sh instead.
#
# Usage: android/scripts/qr-payload.sh <release APK> <https URL of that same APK> [output dir]
#
# The phone downloads the APK from the URL during setup, so it must be reachable from
# the phone's Wi-Fi, over HTTPS. The script checks that the URL serves the same file.
# It writes <output dir>/belay-provisioning.json (default: the current directory) and,
# if `qrencode` is installed, belay-provisioning.png plus a QR code in the terminal.
# The payload holds no secrets: a URL and the signing certificate's checksum.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

APK="${1:-}"
URL="${2:-}"
OUT="${3:-.}"
[ -n "$APK" ] && [ -n "$URL" ] || die "Usage: $0 <release APK> <https URL of that APK> [output dir]"
[ -f "$APK" ] || die "No APK at $APK"
case "$URL" in https://*) ;; *) die "The URL must start with https://" ;; esac

signer="$(apk_signer "$APK" || true)"
hex="${signer%%|*}"
[ -n "$hex" ] || die "Couldn't read the APK's signing certificate (is it signed? is apksigner installed?)."

# EXTRA_PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM: the URL-safe base64 SHA-256 of
# the signing certificate, without padding.
checksum="$(python3 -c 'import base64,sys; print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).decode().rstrip("="))' "$hex")"

say "Checking that $URL serves this APK..."
local_sha="$(sha256_of "$APK")"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL -o "$tmp" "$URL" || die "Couldn't download $URL"
remote_sha="$(sha256_of "$tmp")"
[ "$local_sha" = "$remote_sha" ] || die "The URL serves a different file than $APK." \
  "local  $local_sha" "remote $remote_sha"
info "same file: $local_sha"

mkdir -p "$OUT"
JSON="$OUT/belay-provisioning.json"
python3 - "$JSON" "$URL" "$checksum" <<'EOF'
import json, sys
path, url, checksum = sys.argv[1:4]
payload = {
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "family.brooker.belay/family.brooker.belay.AdminReceiver",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": url,
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": checksum,
    # Without this, fully managed provisioning disables preinstalled apps it considers optional.
    "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": True,
}
with open(path, "w") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
EOF
say "Wrote $JSON"

if command -v qrencode >/dev/null; then
  qrencode -o "$OUT/belay-provisioning.png" -s 8 <"$JSON"
  qrencode -t ANSIUTF8 <"$JSON"
  say "Wrote $OUT/belay-provisioning.png"
else
  cat "$JSON"
  say "Install qrencode (apt install qrencode, or brew install qrencode) to draw the QR code,"
  say "or make one from the JSON above with any offline QR generator."
fi
say "On the freshly reset phone, tap the welcome screen 6 times, then scan this code."
