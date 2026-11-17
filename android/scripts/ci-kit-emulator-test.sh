#!/usr/bin/env bash
# The setup kit's runner, end to end, on an emulator (CI's informational job in
# .github/workflows/setup-kit.yml). It REFUSES to run on anything but an emulator: it makes
# Belay the device owner.
#
# Usage: android/scripts/ci-kit-emulator-test.sh <debug APK>
#
# 1. provisions with the setup kit's command-line runner, `node setup-kit/dist/run.js` (the
#    same plan as provision.sh, run by the kit's interpreter over Tango and the adb server),
#    restart included
# 2. checks the end state ci-emulator-test.sh checks after provision.sh: device owner, Belay's
#    foreground service, the battery exemption, usage access and the exempt standby bucket
# 3. with BELAY_E2E_SERVER and BELAY_E2E_CODE (as for ci-emulator-test.sh), that the runner
#    connected the phone to that server
# 4. unprovision.sh releases device owner and uninstalls
#
# Build the kit first: (cd setup-kit && npm ci --ignore-scripts && npm run build).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

APK="${1:?debug APK}"
RUNNER="$(dirname "$ANDROID_DIR")/setup-kit/dist/run.js"
[ -f "$APK" ] || die "No APK at $APK"
[ -f "$RUNNER" ] || die "No $RUNNER." "Build the kit first: (cd setup-kit && npm ci --ignore-scripts && npm run build)"
command -v node >/dev/null || die "The setup kit's runner needs Node.js (24)."
E2E_SERVER="${BELAY_E2E_SERVER:-}"
E2E_CODE="${BELAY_E2E_CODE:-}"
if [ -n "$E2E_SERVER" ] && [ -z "$E2E_CODE" ]; then die "BELAY_E2E_SERVER needs BELAY_E2E_CODE too."; fi

find_adb
pick_device
if [ "$(ash getprop ro.boot.qemu)" != 1 ] && [ "$(ash getprop ro.kernel.qemu)" != 1 ]; then
  die "$SERIAL is not an emulator. This test sets a device owner: emulators only."
fi
phone_summary

step() { printf '\n=== %s\n' "$*"; }
service_running() { ash dumpsys activity services "$PKG/.service.BelayService" | contains 'isForeground=true'; }

step "Let the freshly booted system settle, then list its accounts (types only)"
sleep "${SETTLE_SECONDS:-45}"
types="$(account_types)"
echo "accounts: ${types:-none}"

step "Provision the debug build with the setup kit's runner (Tango, through the adb server)"
args=(--yes --serial "$SERIAL" --apk "$APK")
[ -z "$E2E_SERVER" ] || args+=(--server "$E2E_SERVER" --code "$E2E_CODE")
log="$(mktemp)"
# The runner talks to the adb server, as adb itself does.
"$ADB_BIN" start-server
node "$RUNNER" "${args[@]}" 2>&1 | tee "$log"

step "The end state provision.sh leaves"
is_belay_owner || die "Belay isn't the device owner" "$(owners_text)"
owners_text
for _ in $(seq 1 60); do
  if service_running; then break; fi
  sleep 1
done
service_running || die "BelayService isn't running in the foreground"
echo "Belay's foreground service is running"
ash dumpsys deviceidle whitelist | contains ",$PKG," || die "not on the battery-optimization allowlist"
echo "battery exemption: granted"
ash appops get "$PKG" GET_USAGE_STATS | contains allow || die "usage access not granted"
echo "usage access: granted"
bucket="$(ash am get-standby-bucket "$PKG")"
[ "$bucket" = 5 ] || die "standby bucket is $bucket, expected 5 (exempted)"
echo "standby bucket: $bucket (exempted)"
grep -qF "Restarting the phone once" "$log" || die "the runner didn't restart the phone"
if [ -n "$E2E_SERVER" ]; then
  grep -qF 'enrolled: ' "$log" || die "the runner didn't connect the phone to $E2E_SERVER"
  echo "connected to $E2E_SERVER"
fi

step "Unprovision (debug builds only)"
"$SCRIPTS_DIR/unprovision.sh" --yes --serial "$SERIAL"
if has_owner; then die "still has an owner" "$(owners_text)"; fi
if ash pm path "$PKG" | contains 'package:'; then die "Belay is still installed"; fi

step "All setup-kit emulator checks passed"
