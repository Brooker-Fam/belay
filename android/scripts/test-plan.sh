#!/usr/bin/env bash
# The provisioning plan's fixture tests: no phone, no Android SDK.
#
# Each android/scripts/plan-tests/<name>.json is a made-up phone (what a fake adb answers),
# an APK (what fake build tools say about it) and either provision.sh's arguments ("plan":
# "provision") or a small plan of its own with its variables. <name>.out is what must be
# printed, standard output and error together, and <name>.calls what adb is asked and each
# sleep, in order. The setup kit runs the same fixtures through its own interpreter
# (setup-kit/test/plan-fixtures.test.ts), so both must say and do the same.
#
# Usage: android/scripts/test-plan.sh [--update] [--against DIR] [NAME...]
#
#   --update       write each .out and .calls from this run (read the diff before keeping it)
#   --against DIR  run the provision fixtures with DIR/provision.sh instead and compare
#                  only what it prints and its exit status, to check a change to
#                  provision.sh or lib.sh against an older version (for example
#                  git worktree add /tmp/old main, then --against /tmp/old/android/scripts)
#
# A fixture's fields (all optional but "name"):
#   name, base       what it tests; another fixture whose phone, apk, devices and install
#                    it starts from (its own phone entries come first)
#   plan             "provision", or a plan file in plan-tests/ (with "vars")
#   args             provision.sh's arguments; "{apk}" is the fake APK's path
#   vars             a plan fixture's variables, like {"dry_run": "1"}
#   stdin            what is typed (for the question before device owner)
#   exit             the exit status it must end with (default 0)
#   apk              {"missing", "aapt2", "apksigner" (false: not installed), "package"
#                    (null: aapt2 can't read it), "testOnly", "signed", "sha256", "dn"}
#   devices          adb's devices: [{"serial", "state"}]
#   install          what adb install answers (a response)
#   phone            [{"run": "<shell command>", "after": "<a call, as in .calls>", and a
#                    response: "out", "err", "exit", or "seq": a response per call, the
#                    last one repeated}]. For each command, the last entry whose "after"
#                    call was already made answers, so the phone can change: after
#                    "reboot", or after "shell dpm set-device-owner ...".
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TESTS="$SCRIPTS_DIR/plan-tests"
SELF="$SCRIPTS_DIR/test-plan.sh"

# ---- The fakes: test-plan.sh --fake TOOL ARGS..., in FAKE_DIR ---------------------------

fake_log() { printf '%s\n' "$*" >>"$FAKE_DIR/calls"; }

# fake_value NAME: FAKE_VAL is the fixture's FX__NAME, or its base's FB__NAME.
fake_value() {
  local own="FX__$1" base="FB__$1"
  if [ -n "${!own+set}" ]; then FAKE_VAL="${!own}"; else FAKE_VAL="${!base-}"; fi
}
fake_has() {
  local own="FX__$1" base="FB__$1"
  [ -n "${!own+set}" ] || [ -n "${!base+set}" ]
}

# fake_respond PATH: answers with the response at PATH (a string is its output).
fake_respond() {
  local p="$1" k=0 n counter v
  v="${p}__seq__n"
  if [ -n "${!v+set}" ]; then
    n="${!v}"
    counter="$FAKE_DIR/count-${p}"
    [ -f "$counter" ] && k="$(cat "$counter")"
    printf '%s\n' $((k + 1)) >"$counter"
    [ "$k" -lt "$n" ] || k=$((n - 1))
    p="${p}__seq__$k"
  fi
  local out="" err="" status=0
  v="$p"
  if [ "${!v-}" = '{}' ]; then
    v="${p}__out"
    out="${!v-}"
    v="${p}__err"
    err="${!v-}"
    v="${p}__exit"
    status="${!v:-0}"
  else
    out="${!v-}"
  fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; fi
  if [ -n "$err" ]; then printf '%s\n' "$err" >&2; fi
  return "$status"
}

# A shell command's answer: the last of the fixture's own entries for it (or, when it has
# none, its base's) whose "after" call, if it has one, was already made.
fake_adb() {
  if [ "${1:-}" = -s ]; then shift 2; fi
  local call="$*" sub="${1:-}" i n src best="" found v
  shift || true
  if [ "$sub" = shell ]; then
    for src in FX FB; do
      found=0
      v="${src}__phone__n"
      n="${!v:-0}"
      for ((i = 0; i < n; i++)); do
        v="${src}__phone__${i}__run"
        [ "${!v}" = "$*" ] || continue
        found=1
        v="${src}__phone__${i}__after"
        if [ -z "${!v-}" ] || grep -qxF -- "${!v}" "$FAKE_DIR/calls"; then best="${src}__phone__$i"; fi
      done
      if [ "$found" = 1 ]; then break; fi
    done
  fi
  fake_log "$call"
  case "$sub" in
    devices)
      echo "List of devices attached"
      for src in FX FB; do
        v="${src}__devices__n"
        [ -n "${!v+set}" ] || continue
        for ((i = 0; i < ${!v}; i++)); do
          local serial="${src}__devices__${i}__serial" state="${src}__devices__${i}__state"
          printf '%s\t%s\n' "${!serial}" "${!state}"
        done
        break
      done
      echo
      ;;
    shell) if [ -n "$best" ]; then fake_respond "$best"; fi ;;
    install)
      if fake_has install; then
        if [ -n "${FX__install+set}" ]; then fake_respond FX__install; else fake_respond FB__install; fi
      fi
      ;;
    *) ;;
  esac
}

fake_aapt2() {
  fake_value apk__package
  local package="$FAKE_VAL"
  [ -n "$package" ] || return 1
  case "$*" in
    "dump badging "*)
      printf "package: name='%s' versionCode='3' versionName='0.2.0' platformBuildVersionName='17'\n" "$package"
      ;;
    "dump xmltree --file AndroidManifest.xml "*)
      echo "N: android=http://schemas.android.com/apk/res/android (line=2)"
      echo "  E: manifest (line=2)"
      printf '    A: package="%s" (Raw: "%s")\n' "$package" "$package"
      echo "    E: application (line=10)"
      fake_value apk__testOnly
      if [ "$FAKE_VAL" = true ]; then
        echo "      A: http://schemas.android.com/apk/res/android:testOnly(0x01010272)=true"
      fi
      ;;
    *) return 1 ;;
  esac
}

fake_apksigner() {
  fake_value apk__signed
  if [ "$FAKE_VAL" = false ]; then
    echo "DOES NOT VERIFY" >&2
    return 1
  fi
  fake_value apk__dn
  echo "Signer #1 certificate DN: $FAKE_VAL"
  fake_value apk__sha256
  echo "Signer #1 certificate SHA-256 digest: $FAKE_VAL"
  echo "Signer #1 certificate SHA-1 digest: 0000000000000000000000000000000000000000"
}

if [ "${1:-}" = --fake ]; then
  # shellcheck disable=SC1091
  . "$FAKE_DIR/fixture.sh"
  tool="$2"
  shift 2
  case "$tool" in
    adb) fake_adb "$@" ;;
    aapt2) fake_aapt2 "$@" ;;
    apksigner) fake_apksigner "$@" ;;
    sleep) fake_log "sleep $*" ;;
  esac
  exit
fi

# ---- The runner ---------------------------------------------------------------------------

UPDATE=0
AGAINST=""
NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=1 ;;
    --against) AGAINST="${2:?--against needs a directory}"; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$SELF" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Unknown option $1" ;;
    *) NAMES+=("$1") ;;
  esac
  shift
done
if [ "${#NAMES[@]}" = 0 ]; then
  for f in "$TESTS"/*.json; do
    f="${f##*/}"
    NAMES+=("${f%.json}")
  done
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

wrapper() {
  printf '#!%s\nexec %q %q --fake %s "$@"\n' "$BASH" "$BASH" "$SELF" "$2" >"$1"
  chmod +x "$1"
}

# run_fixture NAME SCRIPTS: runs the fixture with SCRIPTS/provision.sh (or lib.sh, for a plan
# fixture); leaves out, calls and status in $FAKE_DIR.
run_fixture() {
  local name="$1" scripts="$2" fixture="$TESTS/$1.json" base plan i n v status=0 stdin
  FAKE_DIR="$WORK/$name"
  rm -rf "$FAKE_DIR"
  mkdir -p "$FAKE_DIR/bin" "$FAKE_DIR/sdk/build-tools/99.0.0"
  : >"$FAKE_DIR/calls"
  # The fixture (and its base) as variables the fakes read quickly.
  unset "${!FX__@}" "${!FB__@}" 2>/dev/null || true
  json_load "$fixture" FX
  if [ -n "${FX__base-}" ]; then json_load "$TESTS/$FX__base.json" FB; fi
  {
    for v in ${!FX__@} ${!FB__@}; do declare -p "$v"; done
  } >"$FAKE_DIR/fixture.sh"
  FAKE_APK="$FAKE_DIR/belay.apk"
  fake_value apk__missing
  [ "$FAKE_VAL" = true ] || : >"$FAKE_APK"
  wrapper "$FAKE_DIR/bin/adb" adb
  wrapper "$FAKE_DIR/bin/sleep" sleep
  fake_value apk__aapt2
  [ "$FAKE_VAL" = false ] || wrapper "$FAKE_DIR/sdk/build-tools/99.0.0/aapt2" aapt2
  fake_value apk__apksigner
  [ "$FAKE_VAL" = false ] || wrapper "$FAKE_DIR/sdk/build-tools/99.0.0/apksigner" apksigner
  stdin="$FAKE_DIR/stdin"
  printf '%s' "${FX__stdin-}" >"$stdin"
  local -a argv=(env -u ANDROID_SERIAL -u ANDROID_SDK_ROOT ADB="$FAKE_DIR/bin/adb" ANDROID_HOME="$FAKE_DIR/sdk"
    FAKE_DIR="$FAKE_DIR" HOME="$FAKE_DIR" PATH="$FAKE_DIR/bin:/usr/bin:/bin" "$BASH")
  plan="${FX__plan-provision}"
  if [ "$plan" = provision ]; then
    argv+=("$scripts/provision.sh")
    n="${FX__args__n:-0}"
    for ((i = 0; i < n; i++)); do
      v="FX__args__$i"
      argv+=("${!v//\{apk\}/$FAKE_APK}")
    done
  else
    # A plan of its own: lib.sh's interpreter with the fixture's variables.
    # shellcheck disable=SC2016 # expanded by that bash, not this one
    argv+=(-c 'set -euo pipefail; . "$1"; plan_load "$2"; shift 2
      find_adb
      while [ $# -gt 1 ]; do plan_set "$1" "$2"; shift 2; done
      [ -z "${PV_dry_run-}" ] || DRY_RUN=1
      [ -z "${PV_assume_yes-}" ] || ASSUME_YES=1
      plan_run steps' plan "$scripts/lib.sh" "$TESTS/$plan" apk "$FAKE_APK")
    for v in ${!FX__vars__@}; do argv+=("${v#FX__vars__}" "${!v}"); done
  fi
  "${argv[@]}" <"$stdin" >"$FAKE_DIR/out" 2>&1 || status=$?
  printf '%s\n' "$status" >"$FAKE_DIR/status"
}

# The text of FILE with the fake APK's path as {apk}.
normalized() {
  local text
  text="$(cat "$1")"
  printf '%s\n' "${text//"$FAKE_APK"/\{apk\}}"
}

failed=0
passed=0
for name in "${NAMES[@]}"; do
  [ -f "$TESTS/$name.json" ] || die "No fixture $TESTS/$name.json"
  if [ -n "$AGAINST" ]; then
    json_load "$TESTS/$name.json" FX
    [ "${FX__plan-provision}" = provision ] || continue
    run_fixture "$name" "$AGAINST"
  else
    run_fixture "$name" "$SCRIPTS_DIR"
  fi
  want_status="${FX__exit:-0}"
  status="$(cat "$FAKE_DIR/status")"
  normalized "$FAKE_DIR/out" >"$FAKE_DIR/out.txt"
  normalized "$FAKE_DIR/calls" >"$FAKE_DIR/calls.txt"
  if [ "$UPDATE" = 1 ] && [ -z "$AGAINST" ]; then
    cp "$FAKE_DIR/out.txt" "$TESTS/$name.out"
    cp "$FAKE_DIR/calls.txt" "$TESTS/$name.calls"
  fi
  problems=()
  [ "$status" = "$want_status" ] || problems+=("exit status $status, not $want_status")
  if ! diff -u "$TESTS/$name.out" "$FAKE_DIR/out.txt" >"$FAKE_DIR/out.diff" 2>&1; then problems+=("output differs"); fi
  if [ -z "$AGAINST" ] && ! diff -u "$TESTS/$name.calls" "$FAKE_DIR/calls.txt" >"$FAKE_DIR/calls.diff" 2>&1; then
    problems+=("calls differ")
  fi
  if [ "${#problems[@]}" = 0 ]; then
    passed=$((passed + 1))
    printf 'ok    %s\n' "$name"
  else
    failed=$((failed + 1))
    printf 'FAIL  %s: %s\n' "$name" "$(IFS=,; printf '%s' "${problems[*]}")"
    sed 's/^/      /' "$FAKE_DIR/out.diff" 2>/dev/null || true
    [ ! -s "$FAKE_DIR/calls.diff" ] || sed 's/^/      /' "$FAKE_DIR/calls.diff"
  fi
done
printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" = 0 ]
