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
#
# Phases 6 and 10, with BELAY_E2E_CLI and:
#   BELAY_E2E_UPDATE_APK   a second debug build of Belay, from the same computer (so the same
#                          debug key), with a higher version code and not test-only:
#                          ./gradlew :app:assembleDebug -PbelayVersionCode=<n> -PbelayTestOnly=false
#   BELAY_E2E_UPDATE_CODE  its version code <n>
# the server offers it and the phone updates itself; the recovery key from the server opens
# repair access on the phone (typed through a debug-only receiver); and remove-other-users,
# with no other user, is reported done. Then the test-only build goes back on (adb install
# -d), so unprovision.sh can release it.
#
# Phase 3, with BELAY_E2E_CLI, the fixture APKs and a server whose status has screen_time: a
# 0-minute limit on the fixture app suspends it and removing it lets it run; a schedule from a
# minute ago to half an hour from now (the emulator's clock and zone) suspends it, but not Belay
# or the dialer; with measuring on, a little over a minute in the fixture app reaches the
# server's usage for today (a debug-only receiver has Belay send at once); and lock-now is
# reported done with the screen off or locked.
#
# Phases 4 and 7, with BELAY_E2E_CLI and a server whose status has fixes: location on demand with
# keep_on grants Belay location by policy and sets no_config_location; with `adb emu geo fix`,
# locate-now produces a fix on the server answering that command at that point, and the command is
# done; the location instrumented tests run with that point; a help request (a debug-only receiver
# taps "I need help", sharing where the phone is) reaches the server as a pending help request, and
# after help-seen the phone's state shows it seen; location off takes the permission away (Android
# restarts Belay, which comes back); and with location off, a help request's shared fix still gets
# in, and the permission is gone again afterwards.
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
UPDATE_APK="${BELAY_E2E_UPDATE_APK:-}"
UPDATE_CODE="${BELAY_E2E_UPDATE_CODE:-}"
if [ -n "$UPDATE_APK" ]; then
  [ -n "$E2E_CLI" ] || die "BELAY_E2E_UPDATE_APK needs BELAY_E2E_CLI (and the server) too."
  [ -f "$UPDATE_APK" ] || die "update APK not found: $UPDATE_APK"
  [[ "$UPDATE_CODE" =~ ^[0-9]+$ ]] || die "BELAY_E2E_UPDATE_CODE must be the update APK's version code, not '$UPDATE_CODE'."
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
# The same, for a command whose standard output is the result: the command line goes to stderr.
server_cli_out() {
  printf '  server: %s\n' "$*" >&2
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
# Waits until the phone reports the server's current policy version as applied (it checks
# in when what it enforces changes).
wait_applied() {
  local version
  version="$(server_status | jq -r '.phones[0].policy_version')"
  [[ "$version" =~ ^[0-9]+$ ]] || die "the server's status has no policy_version" "$(server_status | jq -c '.phones[0]')"
  wait_server ".enforcement.policy_version == $version" "the phone's report that it applied policy $version"
  echo "the phone applied policy $version"
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
  echo "--- the update, the recovery key and commands:"
  state | grep -oE '"(agent_update|recovery)":\{[^}]*\}|"commands":\[[^]]*\]' || true
  echo "--- why apps are held, and screen time:"
  state | grep -o '"reasons":.*' | cut -c 1-2000 || true
}
# Phase 3: "suspended=true" or "suspended=false" for package $1, user 0 (dumpsys package).
package_suspended() {
  local text
  text="$(ash dumpsys package "$1" 2>/dev/null || true)"
  sed -n 's/^ *User 0: .*\(suspended=[a-z]*\).*/\1/p' <<<"$text" | head -n 1
}
# The screen on, and the swipe lock screen out of the way (the emulators have no PIN).
wake_up() {
  ash input keyevent KEYCODE_WAKEUP || true
  ash wm dismiss-keyguard || true
  sleep 1
}
# The screen is off (PowerManagerService's dump says Asleep or Dozing) or the lock screen shows
# (KeyguardController's mKeyguardShowing): AOSP 17's dumpsys power and dumpsys window.
screen_off_or_locked() {
  ash dumpsys power | matches 'mWakefulness=(Asleep|Dozing)' || ash dumpsys window | contains 'mKeyguardShowing=true'
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
# The version code Android has installed for Belay.
installed_version() { ash dumpsys package "$PKG" | sed -n 's/^ *versionCode=\([0-9]*\).*/\1/p' | head -n 1; }
# Waits up to a minute until Belay's update record (in its debug state) has all of the given texts.
wait_record() {
  local record _ want ok
  for _ in $(seq 1 30); do
    record="$(state 2>/dev/null | grep -o '"agent_update":{[^}]*}' || true)"
    ok=1
    for want in "$@"; do [[ "$record" == *"$want"* ]] || ok=0; done
    if [ "$ok" = 1 ]; then
      printf 'the phone: %s\n' "$record"
      return 0
    fi
    sleep 2
  done
  printf -- '--- the update record: %s\n' "${record:-none}"
  return 1
}
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

if [ -n "$UPDATE_APK" ]; then
  phone="$(server_status | jq -r '.phones[0].name')"
  before="$(server_status | jq -r '.phones[0].agent_version_code')"
  [[ "$before" =~ ^[0-9]+$ ]] || die "the server's status has no agent_version_code" "$(server_status | jq -c '.phones[0]')"
  [ "$UPDATE_CODE" -gt "$before" ] || die "the update APK's version code $UPDATE_CODE isn't above the phone's $before"

  step "Phase 6: a parent offers a newer Belay, and the phone updates itself"
  sha="$(server_cli_out agent-add "$UPDATE_APK" --version-code "$UPDATE_CODE")"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "agent-add should print only the APK's SHA-256, lowercase" "$sha"
  [ "$sha" = "$(sha256_of "$UPDATE_APK")" ] || die "agent-add printed $sha, not the APK's SHA-256 $(sha256_of "$UPDATE_APK")"
  server_cli agent-offer "$phone" "$sha"
  # The long-poll brings the offer; Belay downloads, checks and installs it with a device
  # owner's session; Android kills Belay and starts the new one (MY_PACKAGE_REPLACED), which
  # checks in. The server may drop the offer once it's done: then agent_update goes too.
  wait_server ".agent_version_code == $UPDATE_CODE and ((.enforcement.agent_update.state // \"done\") == \"done\")" \
    "a check-in from Belay version $UPDATE_CODE" 150
  installed="$(installed_version)"
  [ "$installed" = "$UPDATE_CODE" ] || die "Android has Belay version '$installed' installed, not $UPDATE_CODE"
  # The new Belay records the update as its own, done, right after it starts.
  wait_record '"state":"done"' '"installed":true' || { diagnose; die "Belay doesn't record the update as its own, done"; }
  for _ in $(seq 1 60); do service_running && break; sleep 1; done
  service_running || { diagnose; die "BelayService didn't come back after the update"; }
  server_status | jq -c '.phones[0] | {agent_version_code, agent_signing_sha256, agent_update: .enforcement.agent_update}'
  # The signing certificate's SHA-256 the phone reports is apksigner's (platform notes I6).
  reported="$(server_status | jq -r '.phones[0].agent_signing_sha256 // empty')"
  signer="$(apk_signer "$UPDATE_APK" || true)"
  if [ -n "$reported" ] && [ -n "${signer%%|*}" ]; then
    [ "$reported" = "${signer%%|*}" ] || die "the phone reports signing certificate $reported; apksigner says ${signer%%|*}"
    echo "signing certificate SHA-256: $reported, as apksigner prints it"
  else
    echo "the signing certificate wasn't compared (no agent_signing_sha256 in the status, or no apksigner here)"
  fi

  step "Phase 6: the recovery key opens repair access on the phone, with no server needed"
  key="$(server_cli_out recovery-key "$phone")"
  # Crockford's base32 (no I, L, O, U), in four groups of five and one of six.
  c='[0-9A-HJKMNP-TV-Z]'
  grouped="^$c{5}-$c{5}-$c{5}-$c{5}-$c{6}\$"
  [[ "$key" =~ $grouped ]] || die "recovery-key should print only the grouped key (it printed ${#key} characters)"
  # The policy now carries the key's check; the phone checks the key against its stored copy.
  wait_applied
  out="$(ash am broadcast -a "$PKG.DEBUG_RECOVER" -n "$PKG/.DebugRecoveryReceiver" --es key "$key")"
  result="$(sed -n 's/^Broadcast completed: //p' <<<"$out")"
  echo "the phone: $result"
  version="$(sed -n 's/^result=-1, data="opened: version \([0-9]*\) until [0-9]*"$/\1/p' <<<"$result")"
  [ -n "$version" ] || { diagnose; die "the phone didn't open repair access with the recovery key" "$result"; }
  wait_server ".enforcement.recovery.version == $version" "the phone's report that it used recovery key version $version"
  server_status | jq -c '.phones[0].enforcement.recovery'

  step "Phase 10: a parent removes other users; with none here, the command is done"
  seen="$(server_status | jq -c '[.phones[0].enforcement.commands[]?.id]')"
  server_cli remove-other-users "$phone"
  wait_server "([.enforcement.commands[]? | select(.result == \"done\") | .id] - $seen) | length > 0" "a done result for remove-other-users"
  server_status | jq -c '.phones[0].enforcement.commands'

  step "Put the test-only build back, so unprovision.sh can release Belay"
  # The update isn't test-only (only the shell may install a test-only APK); a debuggable
  # app can go back to a lower version over adb (-d). Belay won't install the offered
  # version again by itself: an older one was put over it.
  out="$(adb install -r -t -d "$APK" 2>&1 || true)"
  printf '%s\n' "$out"
  grep -q '^Success' <<<"$out" || die "couldn't put the test-only build back"
  for _ in $(seq 1 60); do service_running && break; sleep 1; done
  service_running || { diagnose; die "BelayService didn't start after the test-only build went back"; }
  wait_server ".agent_version_code == $before" "a check-in from Belay version $before again"
  # The server offers version $UPDATE_CODE again while the phone runs an older one; Belay
  # records that it won't install it again. (If the server doesn't offer it, nothing changes.)
  wait_record '"state":"failed"' '"final":true' || echo "no refusal recorded: the server may not offer the update again"
  installed="$(installed_version)"
  [ "$installed" = "$before" ] || { diagnose; die "Belay installed version $installed again after the test-only build went back"; }
  echo "Belay runs version $before again and leaves version $UPDATE_CODE alone"
elif [ -n "$E2E_CLI" ]; then
  echo "BELAY_E2E_UPDATE_APK not given: the Phase 6 and 10 end-to-end checks are skipped"
fi

if [ -n "$E2E_CLI" ] && [ -n "$FIXTURE_V1" ] && ! server_status | jq -e '.phones[0] | has("screen_time")' >/dev/null 2>&1; then
  echo "the server's status has no screen_time (its Phase 3 isn't there yet): the Phase 3 end-to-end checks are skipped"
elif [ -n "$E2E_CLI" ] && [ -n "$FIXTURE_V1" ]; then
  phone="$(server_status | jq -r '.phones[0].name')"

  step "Phase 3: Belay may lock the screen, and the fixture app is installed"
  # device_admin.xml's force-lock, for lock-now (platform notes S5): dumpsys lists each admin's policies.
  ash dumpsys device_policy | contains 'force-lock' ||
    die "Android doesn't list force-lock among Belay's admin policies" "$(ash dumpsys device_policy | grep -A 12 -F "$PKG" | head -n 20)"
  # The screen stays on while this runs: screen time only counts an unlocked, lit screen.
  ash svc power stayon true || true
  ash settings put system screen_off_timeout 1800000 || true
  wake_up
  adb install -r -t "$FIXTURE_V1"
  wait_fixture "hidden=false suspended=false" 15 || { diagnose; die "the fixture app isn't installed and open to use"; }

  step "Phase 3: a limit of 0 minutes suspends the fixture app within 15 s, and removing it lets it run"
  limit_id="$(server_cli_out limit "$phone" "$FIXTURE_PKG" --minutes 0 --name "CI limit")"
  [[ "$limit_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "limit should print only the new limit's id" "$limit_id"
  wait_fixture "hidden=false suspended=true" 15 || { diagnose; die "a limit of 0 minutes didn't suspend the fixture app within 15 s"; }
  echo "limit $limit_id: $(fixture_state)"
  server_cli limit "$phone" "$FIXTURE_PKG" --remove
  wait_fixture "hidden=false suspended=false" 15 || { diagnose; die "the fixture app was still suspended 15 s after its limit was removed"; }
  echo "limit removed: $(fixture_state)"

  step "Phase 3: a schedule from a minute ago to half an hour from now suspends the fixture app, not Belay or the dialer"
  # The emulator's own clock and zone (the policy's zone is "phone"); the runner's GNU date does the sums.
  zone="$(ash getprop persist.sys.timezone)"
  zone="${zone:-UTC}"
  now="$(ash date +%s)"
  from="$(TZ="$zone" date -d "@$((now - 60))" +%H:%M)"
  until="$(TZ="$zone" date -d "@$((now + 1800))" +%H:%M)"
  echo "the emulator's clock: $(ash date) ($zone); the schedule: $from to $until, every day"
  schedule_id="$(server_cli_out schedule "$phone" --name "CI schedule" --start "$from" --end "$until" --days mon,tue,wed,thu,fri,sat,sun)"
  [[ "$schedule_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "schedule should print only the new schedule's id" "$schedule_id"
  wait_fixture "hidden=false suspended=true" 15 || { diagnose; die "the schedule didn't suspend the fixture app within 15 s"; }
  echo "schedule $schedule_id: $(fixture_state)"
  [ "$(package_suspended "$PKG")" = "suspended=false" ] || { diagnose; die "the schedule suspended Belay itself"; }
  dialer="$(ash telecom get-default-dialer 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$dialer" =~ ^[A-Za-z0-9_.]+$ ]] && ash pm path "$dialer" | contains 'package:'; then
    [ "$(package_suspended "$dialer")" = "suspended=false" ] || { diagnose; die "the schedule suspended the dialer, $dialer"; }
    echo "Belay and the dialer ($dialer) aren't suspended"
  else
    echo "Belay isn't suspended; this image has no default dialer to check"
  fi
  server_cli schedule "$phone" --remove "$schedule_id"
  wait_fixture "hidden=false suspended=false" 15 || { diagnose; die "the fixture app was still suspended 15 s after the schedule was removed"; }
  echo "schedule removed: $(fixture_state)"

  step "Phase 3: with measuring on, a minute in the fixture app reaches the server's usage for today"
  server_cli screen-time "$phone" --measure on
  wait_applied
  wake_up
  ash am start -W -n "$FIXTURE_PKG/.FixtureActivity" >/dev/null
  echo "the fixture app is open; 75 s"
  sleep 75
  ash input keyevent KEYCODE_HOME
  # Belay sends today's usage every 15 minutes while the phone is used; a debug build sends it now.
  ash am broadcast -a "$PKG.DEBUG_UPLOAD_USAGE" -n "$PKG/.DebugUsageReceiver" | sed -n 's/^Broadcast completed: //p'
  today="$(ash date +%F)"
  wait_server "[.usage[]? | select(.day == \"$today\") | .apps[]? | select(.package == \"$FIXTURE_PKG\" and .minutes >= 1)] | length > 0" \
    "today's usage ($today) with the fixture app's minute" 45
  server_status | jq -c "[.phones[0].usage[]? | select(.day == \"$today\")][0] | {day, zone, as_of, screen_minutes, apps}"
  server_cli screen-time "$phone" --measure off
  wait_applied

  step "Phase 3: lock-now is reported done, and the screen is off or locked"
  wake_up
  command_id="$(server_cli_out lock-now "$phone")"
  [[ "$command_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "lock-now should print only the command's id" "$command_id"
  wait_server "[.enforcement.commands[]? | select(.id == \"$command_id\" and .result == \"done\")] | length > 0" "a done result for lock-now"
  locked=0
  for _ in $(seq 1 15); do
    if screen_off_or_locked; then
      locked=1
      break
    fi
    sleep 1
  done
  [ "$locked" = 1 ] || { diagnose; die "lock-now was reported done, but the screen is on and unlocked" "$(ash dumpsys power | grep -m 1 'mWakefulness=')"; }
  echo "after lock-now: $(ash dumpsys power | grep -m 1 -o 'mWakefulness=[A-Za-z]*'), $(ash dumpsys window | grep -m 1 -o 'mKeyguardShowing=[a-z]*')"
  wake_up
  adb uninstall "$FIXTURE_PKG" >/dev/null
  server_status | jq -c '.phones[0] | {screen_time: .enforcement.screen_time, commands: .enforcement.commands}'
elif [ -n "$E2E_SERVER" ]; then
  echo "BELAY_E2E_CLI or the fixture APKs not given: the Phase 3 end-to-end checks are skipped"
fi

# Phase 4: "granted=true" or "granted=false" for Belay's fine location, from `dumpsys package`
# (AOSP 17 Settings.dumpRuntimePermissionsLPr: "<permission>: granted=<bool>, flags=[ … ]"), or
# "not listed".
fine_location() {
  local line
  line="$(ash dumpsys package "$PKG" | grep -m 1 -o 'android.permission.ACCESS_FINE_LOCATION: granted=[a-z]*' || true)"
  if [ -n "$line" ]; then printf '%s\n' "${line##*: }"; else echo "not listed"; fi
}
# Waits up to $2 seconds until Belay holds fine location ($1 = true) or doesn't ($1 = false).
wait_location_permission() {
  local _ now
  for _ in $(seq 1 "${2:-30}"); do
    now="$(fine_location)"
    if [ "$1" = true ] && [ "$now" = "granted=true" ]; then return 0; fi
    if [ "$1" = false ] && [ "$now" != "granted=true" ]; then return 0; fi
    sleep 1
  done
  echo "--- Belay's fine location: $(fine_location)"
  return 1
}
# The emulator's GNSS answers with this point (`adb emu geo fix <longitude> <latitude>`).
GEO_LAT=37.42
GEO_LNG=-122.08
geo_fix() { adb emu geo fix "$GEO_LNG" "$GEO_LAT" >/dev/null 2>&1 || echo "adb emu geo fix failed"; }
# Opens Belay, as after the instrumented tests (am instrument force-stops it), and waits for its service.
open_belay() {
  ash am start -W -n "$PKG/.ui.MainActivity" >/dev/null
  for _ in $(seq 1 60); do service_running && break; sleep 1; done
  service_running || { diagnose; die "BelayService didn't start when Belay was opened"; }
  ash input keyevent KEYCODE_HOME
}
# Taps "I need help" through the debug-only receiver, sharing where the phone is; prints the request's id.
ask_help() {
  local out
  # adb shell joins its arguments with spaces for the phone's shell to split again, so the words
  # are quoted for that shell too; unquoted, "words" and everything after it (--ez share) were lost.
  out="$(ash am broadcast -a "$PKG.DEBUG_HELP" -n "$PKG/.DebugHelpReceiver" --es reason "'Made-up words from CI'" --ez share true)"
  sed -n 's/^Broadcast completed: result=-1, data="help: \([A-Za-z0-9_-]*\)"$/\1/p' <<<"$out"
}

if [ -n "$E2E_CLI" ] && ! server_status | jq -e '.phones[0] | has("fixes")' >/dev/null 2>&1; then
  echo "the server's status has no fixes (its Phase 4 isn't there yet): the Phase 4 and 7 end-to-end checks are skipped"
elif [ -n "$E2E_CLI" ]; then
  phone="$(server_status | jq -r '.phones[0].name')"

  step "Phase 4: on demand, with location kept on: Belay holds location by policy, and the kid can't turn it off"
  [ "$(fine_location)" != "granted=true" ] || { diagnose; die "with location off, Belay holds location"; }
  server_cli location "$phone" --mode on_demand --keep-on on
  wait_applied
  wait_location_permission true 30 || { diagnose; die "Belay wasn't granted location by policy within 30 s of on_demand"; }
  ash dumpsys package "$PKG" | grep -m 1 'android.permission.ACCESS_FINE_LOCATION: granted=true' | contains 'POLICY_FIXED' ||
    die "Belay's location isn't fixed by policy" "$(ash dumpsys package "$PKG" | grep -m 1 'ACCESS_FINE_LOCATION: granted=')"
  ash dumpsys user | contains 'no_config_location' || { diagnose; die "keep_on didn't set no_config_location"; }
  [ "$(ash settings get secure location_mode)" != 0 ] || { diagnose; die "keep_on didn't turn location on"; }
  echo "location by policy, $(fine_location); no_config_location set; location mode $(ash settings get secure location_mode)"

  step "Phase 4: locate-now answers with the emulator's GPS fix, and is done"
  geo_fix
  sleep 2
  geo_fix
  command_id="$(server_cli_out locate-now "$phone")"
  [[ "$command_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "locate-now should print only the command's id" "$command_id"
  wait_server "[.fixes[]? | select(.command_id == \"$command_id\")] | length > 0" "a fix answering locate-now $command_id" 45
  # About 4 decimals: within 0.0002 degrees (about 20 m), without jq's libm functions.
  fix_ok="def off: if . < 0 then -. else . end; [.fixes[] | select(.command_id == \"$command_id\")][0] | ((.lat - $GEO_LAT) | off) < 0.0002 and ((.lng - ($GEO_LNG)) | off) < 0.0002 and .mock == false"
  server_status | jq -e ".phones[0] | $fix_ok" >/dev/null ||
    die "the fix answering $command_id isn't at $GEO_LAT,$GEO_LNG from the GPS" "$(server_status | jq -c "[.phones[0].fixes[] | select(.command_id == \"$command_id\")]")"
  wait_server "[.enforcement.commands[]? | select(.id == \"$command_id\" and .result == \"done\")] | length > 0" "a done result for locate-now"
  server_status | jq -c "[.phones[0].fixes[] | select(.command_id == \"$command_id\")][0]"

  step "Phases 4 and 7 on the phone: the location instrumented tests, with the emulator's point"
  geo_fix
  out="$(ash am instrument -w -e class "$PKG.LocationInstrumentedTest" -e belayGeoLat "$GEO_LAT" -e belayGeoLng "$GEO_LNG" "$TEST_PKG/androidx.test.runner.AndroidJUnitRunner")"
  printf '%s\n' "$out"
  grep -q '^OK (' <<<"$out" || { diagnose; die "the location instrumented tests failed"; }
  open_belay

  step "Phase 7: a help request reaches the server at once, and a parent seeing it reaches the phone"
  geo_fix
  help_id="$(ask_help)"
  [[ "$help_id" =~ ^[A-Za-z0-9_-]+$ ]] || { diagnose; die "the debug-only help receiver didn't answer with a request id"; }
  echo "help request $help_id"
  wait_server "[.requests[]? | select(.id == \"$help_id\" and .kind == \"help\" and .status == \"pending\")] | length > 0" "a pending help request $help_id" 30
  server_status | jq -c ".phones[0].requests[] | select(.id == \"$help_id\")"
  server_cli help-seen "$phone" "$help_id"
  seen=0
  for _ in $(seq 1 30); do
    if state | jq -e ".requests[] | select(.id == \"$help_id\") | .seen_at != null" >/dev/null 2>&1; then seen=1; break; fi
    sleep 1
  done
  [ "$seen" = 1 ] || { diagnose; die "the phone never showed help request $help_id as seen"; }
  state | jq -c ".requests[] | select(.id == \"$help_id\")"

  step "Phase 4: location off takes the permission away; Android restarts Belay, and it comes back"
  server_cli location "$phone" --mode off
  wait_location_permission false 60 || { diagnose; die "Belay still held location 60 s after location went off"; }
  for _ in $(seq 1 90); do service_running && break; sleep 1; done
  service_running || { diagnose; die "BelayService didn't come back after Belay lost location"; }
  wait_applied
  if ash dumpsys user | contains 'no_config_location'; then diagnose; die "no_config_location is still set with location off"; fi
  echo "location off: $(fine_location), no_config_location cleared, Belay running"

  step "Phase 7: with location off, a kid's shared fix still gets in their help request, once"
  geo_fix
  help_id="$(ask_help)"
  [[ "$help_id" =~ ^[A-Za-z0-9_-]+$ ]] || { diagnose; die "the debug-only help receiver didn't answer with a request id"; }
  shared=0
  for _ in $(seq 1 90); do
    if state 2>/dev/null | jq -e ".requests[] | select(.id == \"$help_id\") | .has_location" >/dev/null 2>&1; then shared=1; break; fi
    sleep 1
  done
  [ "$shared" = 1 ] || { diagnose; die "help request $help_id never got the fix the kid shared"; }
  wait_location_permission false 60 || { diagnose; die "Belay still held location 60 s after the help fix"; }
  for _ in $(seq 1 90); do service_running && break; sleep 1; done
  service_running || { diagnose; die "BelayService didn't come back after the help fix's grant ended"; }
  wait_server "[.requests[]? | select(.id == \"$help_id\" and .kind == \"help\")] | length > 0" "help request $help_id" 60
  echo "help request $help_id has the shared fix; $(fine_location) again"
elif [ -n "$E2E_SERVER" ]; then
  echo "BELAY_E2E_CLI not given: the Phase 4 and 7 end-to-end checks are skipped"
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
