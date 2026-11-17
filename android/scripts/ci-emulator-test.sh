#!/usr/bin/env bash
# Provisioning and change detection, end to end, on an emulator (CI runs it on Android 17).
# It REFUSES to run on anything but an emulator: it makes Belay the device owner.
#
# Usage: android/scripts/ci-emulator-test.sh <debug APK> <androidTest APK> [<fixture v1 APK> <fixture v2 APK>]
#
# 1. provision.sh (debug build), including its restart
# 2. device owner, foreground service, the managed notice (and that it can't be dismissed),
#    the standby bucket, uninstall blocked
# 3. installing, updating and removing a package are detected (by any layer)
# 4. the instrumented tests; with the two fixture APKs (./gradlew :fixture:assembleV1Debug
#    :fixture:assembleV2Debug), they also install, update and remove the fixture app and
#    check the outbox got the three events
# 5. a restart: Belay comes back by itself and its change log survives
# 6. unprovision.sh releases device owner and uninstalls
#
# End to end with a Belay server running on this computer (CI starts one):
#   BELAY_E2E_SERVER   the server as the emulator sees it, like http://10.0.2.2:8080
#   BELAY_E2E_CODE     an enrollment code from it (server: node dist/cli.js create-code)
#   BELAY_E2E_STATUS   a command printing the server's status as JSON (cli.js status --json)
#   BELAY_E2E_CLI      optional (Phase 2): a command prefix that runs the server's CLI, like
#                      "BELAY_PUBLIC_URL=… BELAY_DATA_DIR=… node server/dist/cli.js"
# Then provision.sh also connects the phone, and the test checks that the server got the
# phone's app list and, with the fixture APKs, the fixture app's install, update and removal.
# With BELAY_E2E_CLI too, it checks Phase 2 enforcement: with new apps on "ask", the fixture
# app is suspended on install and the server has a pending request for it; a parent's
# "allow" lets it run within seconds (the long-poll), and "block" hides it.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

APK="${1:?debug APK}"
TEST_APK="${2:?androidTest APK}"
FIXTURE_V1="${3:-}"
FIXTURE_V2="${4:-}"
TEST_PKG="$PKG.test"
if [ -n "$FIXTURE_V1$FIXTURE_V2" ]; then
  [ -f "$FIXTURE_V1" ] && [ -f "$FIXTURE_V2" ] || die "fixture APKs not found: '$FIXTURE_V1' '$FIXTURE_V2'"
fi
E2E_SERVER="${BELAY_E2E_SERVER:-}"
E2E_CODE="${BELAY_E2E_CODE:-}"
E2E_STATUS="${BELAY_E2E_STATUS:-}"
E2E_CLI="${BELAY_E2E_CLI:-}"
FIXTURE_PKG="$PKG.fixture"
if [ -n "$E2E_SERVER" ]; then
  [ -n "$E2E_CODE" ] && [ -n "$E2E_STATUS" ] || die "BELAY_E2E_SERVER needs BELAY_E2E_CODE and BELAY_E2E_STATUS too."
  command -v jq >/dev/null || die "The end-to-end checks need jq."
fi
if [ -n "$E2E_CLI" ] && [ -z "$E2E_SERVER" ]; then
  die "BELAY_E2E_CLI needs BELAY_E2E_SERVER (and its code and status) too."
fi

find_adb
pick_device
if [ "$(ash getprop ro.boot.qemu)" != 1 ] && [ "$(ash getprop ro.kernel.qemu)" != 1 ]; then
  die "$SERIAL is not an emulator. This test sets a device owner: emulators only."
fi
phone_summary

step() { printf '\n=== %s\n' "$*"; }
# The server's status as JSON (end to end only).
server_status() { bash -c "$E2E_STATUS"; }
# Runs the server's CLI with these arguments, each quoted for bash (Phase 2 end to end).
server_cli() {
  printf '  server: %s\n' "$*"
  bash -c "$E2E_CLI $(printf '%q ' "$@")"
}
# The fixture app's state for user 0, from `dumpsys package` (AOSP 17 Settings.dumpPackageLPr
# prints "User 0: … installed=… hidden=… suspended=…"), like "hidden=false suspended=true".
fixture_state() {
  local text
  text="$(ash dumpsys package "$FIXTURE_PKG" 2>/dev/null || true)"
  sed -n 's/^ *User 0: .*\(hidden=[a-z]*\) \(suspended=[a-z]*\).*/\1 \2/p' <<<"$text" | head -n 1
}
# A hidden app is left out of `pm list packages` unless -u asks for uninstalled ones too.
fixture_listed() { ash pm list packages "$FIXTURE_PKG" | contains "package:$FIXTURE_PKG"; }
# Waits up to $2 seconds (default 15) until the fixture's state is exactly $1.
wait_fixture() {
  local _
  for _ in $(seq 1 "${2:-15}"); do
    [ "$(fixture_state)" = "$1" ] && return 0
    sleep 1
  done
  echo "--- the fixture app's state: $(fixture_state)"
  return 1
}
# Waits until the jq filter $1 holds for the server's view of the phone; $2 says what for.
wait_server() {
  local _
  for _ in $(seq 1 "${3:-60}"); do
    if server_status 2>/dev/null | jq -e ".phones[0] | $1" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "--- the server's view:"
  server_status || true
  diagnose
  die "the server never got $2"
}
# Waits until Belay logs a line containing $1 (the log is cleared before each action).
# grep reads from a process substitution, so its own status is the result.
wait_log() {
  grep -m1 -F -- "$1" < <(timeout "${2:-60}" "$ADB_BIN" -s "$SERIAL" logcat -v brief -s Belay:I)
}
# What Belay was doing, for a failed check.
diagnose() {
  echo "--- Belay's log (last 80 lines):"
  "$ADB_BIN" -s "$SERIAL" logcat -d -v brief -s Belay:V AndroidRuntime:E | tail -n 80 || true
  echo "--- Belay's processes:"
  ash "ps -A | grep -F $PKG" || true
  echo "--- last heartbeats:"
  state | grep -o '"heartbeats":.*' | cut -c 1-1500 || true
  echo "--- what Belay enforces:"
  state | grep -o '"enforcement":{[^}]*}' || true
}
# A summary of Belay's stored state: heartbeats, changes and outbox counts, which debug
# builds write after every agent step (DebugTools.afterStep). Read with run-as (debug builds
# only). Retries briefly, and shows run-as's own error if it never succeeds.
state() {
  local out _
  for _ in 1 2 3 4 5 6; do
    out="$(adb shell run-as "$PKG" cat no_backup/debug-state.json 2>&1 | tr -d '\r' || true)"
    case "$out" in "{"*) printf '%s\n' "$out"; return 0 ;; esac
    sleep 2
  done
  printf 'run-as failed: %s\n' "$out" >&2
  return 1
}
service_running() { ash dumpsys activity services "$PKG/.service.BelayService" | contains 'isForeground=true'; }
wait_boot() {
  adb wait-for-device
  for _ in $(seq 1 150); do
    [ "$(ash getprop sys.boot_completed 2>/dev/null)" = 1 ] && return 0
    sleep 2
  done
  die "the emulator didn't finish booting"
}

step "Let the freshly booted system settle, then list its accounts (types only)"
# Something on a Google APIs image can add an account seconds after boot, which then
# blocks set-device-owner. Wait, and show what is there.
sleep "${SETTLE_SECONDS:-45}"
types="$(account_types)"
echo "accounts: ${types:-none}"

step "Provision the debug build with provision.sh"
provision=(--yes --serial "$SERIAL")
[ -z "$E2E_SERVER" ] || provision+=(--server "$E2E_SERVER" --code "$E2E_CODE")
provision_log="$(mktemp)"
"$SCRIPTS_DIR/provision.sh" "${provision[@]}" "$APK" 2>&1 | tee "$provision_log"

step "Device owner, service and managed notice"
is_belay_owner || die "Belay isn't the device owner" "$(owners_text)"
owners_text
# What woke Belay, from its heartbeat log. After `dpm set-device-owner`, Android binds
# the DeviceAdminService, which starts Belay even though nothing opened it yet.
triggers="$(state | grep -o '"trigger":"[^"]*"' | sort | uniq -c || true)"
[ -n "$triggers" ] || die "couldn't read Belay's state with run-as"
printf 'heartbeats by trigger:\n%s\n' "$triggers"
state | contains '"admin service bound"' || die "Android never bound BelayAdminService"
service_running || die "BelayService isn't running in the foreground"
ash dumpsys activity services "$PKG/.service.BelayAdminService" | contains 'ServiceRecord' ||
  die "Android didn't bind BelayAdminService (the DeviceAdminService)"
echo "DeviceAdminService bound by the system"
# The managed notice is notification id 1 (ManagedNotice.NOTIFICATION_ID); Phase 2 can also
# show "Waiting for your parent" (id 2).
record="$(ash dumpsys notification --noredact | grep -F "pkg=$PKG " | grep -F " id=1 " || true)"
record="${record%%$'\n'*}"
[ -n "$record" ] || die "no managed notice (notification id 1) from $PKG"
printf '%s\n' "$record"
# FLAG_NO_DISMISS (hidden, 0x2000): Android 14+ keeps a device owner's ongoing notice
# undismissable. Android 17's dumpsys prints the flags by name; older versions in hex.
flags="$(grep -o 'flags=[A-Za-z0-9_|]*' <<<"$record" || true)"
flags="${flags%%$'\n'*}"
flags="${flags#flags=}"
case "$flags" in
  *NO_DISMISS*) ;;
  0x*) [ $((flags & 0x2000)) != 0 ] || die "the managed notice can be dismissed (flags=$flags)" ;;
  *) die "the managed notice can be dismissed (flags=$flags)" ;;
esac
echo "managed notice flags=$flags: not dismissible"
bucket="$(ash am get-standby-bucket "$PKG")"
[ "$bucket" = 5 ] || die "standby bucket is $bucket, expected 5 (exempted)"
echo "standby bucket: $bucket (exempted)"
ash dumpsys deviceidle whitelist | contains ",$PKG," || die "not on the battery-optimization allowlist"
ash appops get "$PKG" GET_USAGE_STATS | contains allow || die "usage access not granted"
out="$(adb uninstall "$PKG" 2>&1 || true)"
printf '%s\n' "$out"
if grep -q '^Success' <<<"$out"; then die "Belay could be uninstalled"; fi

if [ -n "$E2E_SERVER" ]; then
  step "The server: the phone enrolled and sent its app list"
  grep -qF 'enrolled: ' "$provision_log" || die "provision.sh didn't connect the phone to $E2E_SERVER"
  wait_server '.last_app_list != null and .user_apps >= 0' "the phone's app list"
  wait_server '[.problems[] | select(test("device owner"))] | length == 0' "a status with Belay as device owner"
  server_status | jq '.phones[0] | {name, status, problems, user_apps, apps_to_review, last_app_list}'
fi

# Any layer may catch a change first (broadcast, getChangedPackages, full scan); what
# matters is that none is missed. The matching log line shows which layer it was.
step "Install, update and remove are detected"
adb logcat -c
adb install -t "$TEST_APK"
wait_log "change: INSTALLED $TEST_PKG by " || { diagnose; die "install not detected"; }
adb logcat -c
adb install -r -t "$TEST_APK"
wait_log "change: UPDATED $TEST_PKG by " || { diagnose; die "update not detected"; }

step "Instrumented tests"
if [ -n "$FIXTURE_V1" ]; then
  adb push "$FIXTURE_V1" /data/local/tmp/belay-fixture-v1.apk
  adb push "$FIXTURE_V2" /data/local/tmp/belay-fixture-v2.apk
else
  echo "no fixture APKs given: the fixture test is skipped"
fi
out="$(ash am instrument -w "$TEST_PKG/androidx.test.runner.AndroidJUnitRunner")"
printf '%s\n' "$out"
grep -q '^OK (' <<<"$out" || die "instrumented tests failed"

# `am instrument` force-stops Belay before and after the tests (AOSP 17
# ActivityManagerService: "start instr", "finished inst"). That also cancels its jobs and
# alarms, and the system rebinds its DeviceAdminService only after an hour, so nothing
# runs Belay (or its long-poll) until something starts it. Open it, as a person would.
step "Opening Belay after the instrumented tests starts it again"
ash am start -W -n "$PKG/.ui.MainActivity" >/dev/null
for _ in $(seq 1 60); do service_running && break; sleep 1; done
service_running || { diagnose; die "BelayService didn't start when Belay was opened"; }
ash input keyevent KEYCODE_HOME

if [ -n "$E2E_SERVER" ] && [ -n "$FIXTURE_V1" ]; then
  step "The server got the fixture app's install, update and removal"
  for kind in installed updated removed; do
    wait_server "[.recent_changes[] | select(.package == \"$FIXTURE_PKG\" and .kind == \"$kind\")] | length > 0" "the fixture app's $kind event"
    echo "the server has: $kind $FIXTURE_PKG"
  done
  server_status | jq -c '.phones[0].recent_changes[]'
fi

if [ -n "$E2E_CLI" ] && [ -n "$FIXTURE_V1" ]; then
  phone="$(server_status | jq -r '.phones[0].name')"
  # Waits until the phone reports the server's current policy version as applied (it checks
  # in when what it enforces changes).
  wait_applied() {
    local version
    version="$(server_status | jq -r '.phones[0].policy_version')"
    [[ "$version" =~ ^[0-9]+$ ]] || die "the server's status has no policy_version" "$(server_status | jq -c '.phones[0]')"
    wait_server ".enforcement.policy_version == $version" "the phone's report that it applied policy $version"
    echo "the phone applied policy $version"
  }

  step "Phase 2: with new apps on \"ask\", a new app waits for a parent"
  server_cli policy "$phone" --new-apps ask
  wait_applied
  adb uninstall "$FIXTURE_PKG" >/dev/null 2>&1 || true
  adb install -r -t "$FIXTURE_V1"
  wait_fixture "hidden=false suspended=true" 30 || { diagnose; die "the new app wasn't suspended on install"; }
  echo "suspended on install: $(fixture_state)"
  wait_server "[.requests[] | select(.package == \"$FIXTURE_PKG\" and .status == \"pending\")] | length > 0" \
    "a pending request for the new app"
  server_status | jq -c ".phones[0].requests[] | select(.package == \"$FIXTURE_PKG\")"

  step "A parent allows it: it runs within seconds (the long-poll)"
  server_cli decide "$phone" "$FIXTURE_PKG" allow
  wait_fixture "hidden=false suspended=false" 15 || { diagnose; die "the allowed app was still suspended after 15 s"; }
  echo "allowed: $(fixture_state)"

  step "A parent blocks it: it's hidden"
  server_cli decide "$phone" "$FIXTURE_PKG" block
  wait_fixture "hidden=true suspended=true" 15 || { diagnose; die "the blocked app wasn't hidden and suspended after 15 s"; }
  if fixture_listed; then die "the blocked app is still listed by pm list packages"; fi
  ash pm list packages -u "$FIXTURE_PKG" | contains "package:$FIXTURE_PKG" || die "the blocked app is gone, not hidden"
  echo "blocked: $(fixture_state), and only listed with -u"

  step "Put it back: new apps allowed again, no decision, the app removed"
  server_cli policy "$phone" --new-apps allow
  server_cli decide "$phone" "$FIXTURE_PKG" undecided
  wait_applied
  wait_fixture "hidden=false suspended=false" 15 || { diagnose; die "the app was still held back after the policy allowed it"; }
  adb uninstall "$FIXTURE_PKG"
  server_status | jq '.phones[0] | {policy_version, enforcement, requests}'
elif [ -n "$E2E_SERVER" ]; then
  echo "BELAY_E2E_CLI or the fixture APKs not given: the Phase 2 end-to-end checks are skipped"
fi

adb logcat -c
adb uninstall "$TEST_PKG"
wait_log "change: REMOVED $TEST_PKG by " || { diagnose; die "removal not detected"; }

step "Restart: Belay comes back by itself, and its log survives"
adb reboot
wait_boot
for _ in $(seq 1 120); do service_running && break; sleep 1; done
service_running || die "BelayService didn't come back after the restart"
state | contains "\"$TEST_PKG\"" || die "the change log didn't survive the restart"
# BOOT_COMPLETED reaches apps late on images with Google services; the DeviceAdminService
# has usually started Belay well before. Wait for the boot heartbeat.
booted=0
for _ in $(seq 1 60); do
  if state | contains '"phone started"'; then booted=1; break; fi
  sleep 2
done
[ "$booted" = 1 ] || { diagnose; die "no boot heartbeat within two minutes of the restart"; }

step "Unprovision (debug builds only)"
"$SCRIPTS_DIR/unprovision.sh" --yes --serial "$SERIAL"
if has_owner; then die "still has an owner" "$(owners_text)"; fi
if ash pm path "$PKG" | contains 'package:'; then die "Belay is still installed"; fi

step "All emulator checks passed"
