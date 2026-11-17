# shellcheck shell=bash
# Shared helpers for provision.sh, unprovision.sh, qr-payload.sh and build-release.sh, and
# the interpreter that runs provisioning's plan (provision-plan.json; at the end).
# Sourced, not run. Variables here are used by the scripts that source it.
# shellcheck disable=SC2034

PKG=family.brooker.belay
ADMIN="$PKG/.AdminReceiver"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(dirname "$SCRIPTS_DIR")"

DRY_RUN=0
ASSUME_YES=0
SERIAL="${ANDROID_SERIAL:-}"

say() { printf '%s\n' "$*"; }

# `cmd | contains TEXT` and `cmd | matches REGEX`: like grep -q, but they read all of
# their input first. With pipefail, `cmd | grep -q` can fail although it matched:
# grep -q exits at the first match and cmd dies of SIGPIPE.
contains() {
  local text
  text="$(cat)"
  [[ "$text" == *"$1"* ]]
}
matches() {
  local text
  text="$(cat)"
  grep -Eq -- "$1" <<<"$text"
}
info() { printf '  %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nSTOPPED: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '%s\n' "$line" | sed 's/^/  /' >&2; done
  exit 1
}

# The first build tool found in $ANDROID_HOME/build-tools (newest version first), or empty.
build_tool() {
  local name="$1" sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}" dir
  if [ -d "$sdk/build-tools" ]; then
    while IFS= read -r dir; do
      if [ -x "$dir/$name" ]; then
        printf '%s\n' "$dir/$name"
        return
      fi
    done < <(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -r)
  fi
  command -v "$name" 2>/dev/null || true
}

find_adb() {
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
  if [ -n "${ADB:-}" ]; then
    ADB_BIN="$ADB"
  elif [ -x "$sdk/platform-tools/adb" ]; then
    ADB_BIN="$sdk/platform-tools/adb"
  elif command -v adb >/dev/null 2>&1; then
    ADB_BIN="$(command -v adb)"
  else
    die "adb not found." "Install Android SDK Platform-Tools, or set ANDROID_HOME."
  fi
}

adb() {
  if [ -n "$SERIAL" ]; then "$ADB_BIN" -s "$SERIAL" "$@"; else "$ADB_BIN" "$@"; fi
}

# adb shell, with the carriage returns of older adb versions removed. Read-only use.
ash() { adb shell "$@" | tr -d '\r'; }

# Runs a command that changes the phone, or only prints it with --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry run] %s\n' "$*"
  else
    "$@"
  fi
}

# Like run, but hides the command's output (never the dry-run line).
run_quiet() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry run] %s\n' "$*"
  else
    "$@" >/dev/null
  fi
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ "$DRY_RUN" = 1 ] && return 0
  local answer
  printf '%s [y/N] ' "$1"
  read -r answer
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# Picks the one connected phone (or $SERIAL) and checks it is reachable. Its messages are
# the plan's (provision-plan.json, "device"), which the setup kit shows too.
pick_device() {
  local list ready unauthorized
  list="$("$ADB_BIN" devices | tail -n +2)"
  ready="$(printf '%s\n' "$list" | awk '$2 == "device" { print $1 }')"
  unauthorized="$(printf '%s\n' "$list" | awk '$2 == "unauthorized" { print $1 }')"
  if [ -n "$SERIAL" ]; then
    grep -qxF -- "$SERIAL" <<<"$ready" || device_stop notConnected "$list" "$ready"
    return
  fi
  local count
  count="$(grep -c . <<<"$ready" || true)"
  if [ "$count" = 0 ]; then
    if [ -n "$unauthorized" ]; then device_stop unauthorized "$list" "$ready"; fi
    device_stop none "$list" "$ready"
  fi
  if [ "$count" -gt 1 ]; then device_stop several "$list" "$ready"; fi
  SERIAL="$ready"
}

phone_summary() {
  local model release sdk patch
  model="$(ash getprop ro.product.manufacturer) $(ash getprop ro.product.model)"
  release="$(ash getprop ro.build.version.release)"
  sdk="$(ash getprop ro.build.version.sdk)"
  patch="$(ash getprop ro.build.version.security_patch)"
  info "Phone: $model, Android $release (API $sdk), security update $patch, serial $SERIAL"
  PHONE_SDK="$sdk"
}

# The lines of `dpm list-owners`: "User 0: admin=<component>,DeviceOwner" per owner.
# Android 17 prints nothing when there are none (older versions said "no owners").
owners() { ash dpm list-owners 2>/dev/null || true; }
has_owner() { owners | contains "admin="; }
is_belay_owner() { owners | contains "admin=$PKG/"; }
# For messages: the owners, or "none".
owners_text() {
  local text
  text="$(owners)"
  if [[ "$text" == *"admin="* ]]; then printf '%s\n' "$text"; else printf 'none\n'; fi
}

# The types of the accounts on the phone, with counts. Never the names: they are email
# addresses.
account_types() {
  local text
  text="$(ash dumpsys account 2>/dev/null || true)"
  sed -n 's/.*Account {name=[^,]*, type=\([^}]*\)}.*/\1/p' <<<"$text" | sort | uniq -c | sed 's/^ *//'
}

# SHA-256 of a file (Linux sha256sum, macOS shasum).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Test-only (debug) builds can be released without a factory reset.
apk_is_test_only() {
  local aapt2
  aapt2="$(build_tool aapt2)"
  [ -n "$aapt2" ] || return 2
  "$aapt2" dump xmltree --file AndroidManifest.xml "$1" 2>/dev/null | matches 'android:testOnly\([^)]*\)=true'
}

apk_package() {
  local aapt2
  aapt2="$(build_tool aapt2)"
  [ -n "$aapt2" ] || return 2
  "$aapt2" dump badging "$1" 2>/dev/null | sed -n "s/^package: name='\([^']*\)'.*/\1/p"
}

# "<sha256 hex>|<certificate DN>" of the APK's first signer, or empty when unsigned.
apk_signer() {
  local apksigner out
  apksigner="$(build_tool apksigner)"
  [ -n "$apksigner" ] || return 2
  out="$("$apksigner" verify --print-certs "$1" 2>/dev/null)" || return 1
  # apksigner prints "Signer #1 certificate ..." or, in newer versions, "V2 Signer: certificate ...".
  printf '%s|%s\n' \
    "$(printf '%s\n' "$out" | sed -nE 's/^(Signer #1|V[0-9.]+ Signer:) certificate SHA-256 digest: //p' | head -1)" \
    "$(printf '%s\n' "$out" | sed -nE 's/^(Signer #1|V[0-9.]+ Signer:) certificate DN: //p' | head -1)"
}

# ---------------------------------------------------------------------------------------
# The provisioning plan.
#
# provision-plan.json holds provision.sh's steps: each step's command, how its result is
# checked, what it says when that fails, and its waits and retries. The setup kit
# (setup-kit/src/plan/) runs the same file with its own interpreter, and both pass the
# fixtures in plan-tests/ (test-plan.sh runs them here). The format is in
# docs/setup-kit.md.
#
# Written for bash 3.2 (macOS's) and later: no associative arrays or namerefs. The plan is
# read into variables PJ__<path> (PJ__steps__3__kind; an array's length is <path>__n), and
# the plan's own variables, {name} in its texts, are PV_<name>. Results come back in
# PLAN_GOT, PLAN_OUT, PLAN_WORDS, PLAN_LINES, PLAN_SH_OUT and PLAN_SH_STATUS rather than
# on standard output, so nothing here needs a subshell.

PLAN_FILE="$SCRIPTS_DIR/provision-plan.json"
PLAN_FORMAT=1

# json_load FILE PREFIX: reads the JSON in FILE into variables PREFIX__<path>, for example
# PREFIX__steps__0__kind. An object or an array is "{}" or "[]" there, and an array's
# length is in <path>__n. Keys are letters, digits and single underscores; strings may use
# the escapes \" \\ \/ \b \f \n \r \t (not \u).
json_load() {
  local file="$1" tok expect=value path="$2" depth=0 joined="" stripped
  local key_re='^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$'
  local -a cpath=("$2") ctype=(root) cidx=(0)
  [ -r "$file" ] || die "Can't read $file."
  while IFS= read -r tok; do
    joined+="$tok"
    case "$expect" in
      key | nextkey)
        if [ "$tok" = '}' ] && [ "$expect" = key ]; then
          depth=$((depth - 1))
          expect=after
          continue
        fi
        case "$tok" in '"'*) ;; *) json_bad "$file" "$tok" ;; esac
        json_unquote "$tok" || json_bad "$file" "$tok"
        [[ $JSON_STR =~ $key_re ]] || json_bad "$file" "the key $tok"
        path="${cpath[depth]}__$JSON_STR"
        expect=separator
        ;;
      separator)
        [ "$tok" = ':' ] || json_bad "$file" "$tok"
        expect=value
        ;;
      value | first)
        case "$tok" in
          ']')
            [ "$expect" = first ] || json_bad "$file" "$tok"
            printf -v "${cpath[depth]}__n" '%s' 0
            depth=$((depth - 1))
            expect=after
            ;;
          '{' | '[')
            depth=$((depth + 1))
            cpath[depth]="$path"
            if [ "$tok" = '{' ]; then
              ctype[depth]=object
              printf -v "$path" '%s' '{}'
              expect=key
            else
              ctype[depth]=array
              cidx[depth]=0
              printf -v "$path" '%s' '[]'
              path="${path}__0"
              expect=first
            fi
            ;;
          '"'*)
            json_unquote "$tok" || json_bad "$file" "$tok"
            printf -v "$path" '%s' "$JSON_STR"
            expect=after
            ;;
          true | false | [-0-9]*)
            printf -v "$path" '%s' "$tok"
            expect=after
            ;;
          null)
            printf -v "$path" '%s' ''
            expect=after
            ;;
          *) json_bad "$file" "$tok" ;;
        esac
        ;;
      after)
        case "$tok:${ctype[depth]}" in
          ,:object) expect=nextkey ;;
          ,:array)
            cidx[depth]=$((cidx[depth] + 1))
            path="${cpath[depth]}__${cidx[depth]}"
            expect=value
            ;;
          '}:object') depth=$((depth - 1)) ;;
          ']:array')
            printf -v "${cpath[depth]}__n" '%s' $((cidx[depth] + 1))
            depth=$((depth - 1))
            ;;
          *) json_bad "$file" "$tok" ;;
        esac
        ;;
    esac
  done < <(grep -oE '"([^"\\]|\\.)*"|-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?|true|false|null|[][{}:,]' "$file")
  if [ "$depth" != 0 ] || [ "$expect" != after ]; then json_bad "$file" "the end of the file"; fi
  # grep -o skips what isn't a token: the file must be nothing but tokens and white space.
  stripped="$(tr -d ' \t\r\n' <"$file")"
  [ "${joined//[[:space:]]/}" = "$stripped" ] || json_bad "$file" "something that isn't JSON"
}

json_bad() { die "$1 isn't JSON that lib.sh can read (at $2)."; }

# json_unquote TOKEN: JSON_STR is the text of the JSON string TOKEN.
json_unquote() {
  local s="${1:1:${#1}-2}" out="" chunk
  case "$s" in
    *\\*) ;;
    *)
      JSON_STR="$s"
      return 0
      ;;
  esac
  while [ -n "$s" ]; do
    case "$s" in
      \\*)
        case "${s:1:1}" in
          '"' | \\ | /) out+="${s:1:1}" ;;
          b) out+=$'\b' ;;
          f) out+=$'\f' ;;
          n) out+=$'\n' ;;
          r) out+=$'\r' ;;
          t) out+=$'\t' ;;
          *) return 1 ;;
        esac
        s="${s:2}"
        ;;
      *)
        chunk="${s%%\\*}"
        out+="$chunk"
        s="${s:${#chunk}}"
        ;;
    esac
  done
  JSON_STR="$out"
}

# plan_load [FILE]: reads the plan (default: provision-plan.json next to this file).
plan_load() {
  json_load "${1:-$PLAN_FILE}" PJ
  [ "${PJ__format-}" = "$PLAN_FORMAT" ] ||
    die "${1:-$PLAN_FILE} is a format ${PJ__format:-?} plan; this lib.sh reads format $PLAN_FORMAT."
  plan_set package "${PJ__package-}"
  plan_set admin "${PJ__admin-}"
}

# plan_get PATH: PLAN_GOT is the plan's value at PATH (like steps__3__kind), or empty.
plan_get() {
  local v="PJ__$1"
  PLAN_GOT="${!v-}"
}
plan_has() {
  local v="PJ__$1"
  [ -n "${!v+set}" ]
}

# plan_set NAME VALUE: sets the plan variable {NAME}.
plan_set() { printf -v "PV_$1" '%s' "$2"; }

# plan_expand TEXT: PLAN_OUT is TEXT with each {name} replaced by that plan variable (empty
# when unset), in one pass. Other braces, like a regular expression's {8,12}, stay.
plan_expand() {
  local rest="$1" out="" before v
  local re='^([a-z_][a-z0-9_]*)\}'
  while :; do
    case "$rest" in
      *'{'*) ;;
      *)
        PLAN_OUT="$out$rest"
        return 0
        ;;
    esac
    before="${rest%%\{*}"
    out+="$before"
    rest="${rest:$((${#before} + 1))}"
    if [[ $rest =~ $re ]]; then
      v="PV_${BASH_REMATCH[1]}"
      out+="${!v-}"
      rest="${rest:${#BASH_REMATCH[0]}}"
    else
      out+='{'
    fi
  done
}

# plan_text PATH: PLAN_OUT is the plan's text at PATH, expanded.
plan_text() {
  plan_get "$1"
  plan_expand "$PLAN_GOT"
}

# plan_cond CONDITION: whether it holds. A condition is [!]{a}[OP text]. "{a}" alone holds
# when the variable isn't empty; OP compares the variables on the left with the text after
# it: "=", "!=", "~" (contains) or "<" (a whole number below it; empty counts as 0). A
# leading "!" turns the answer around.
plan_cond() {
  local re='^(!?)((\{[a-z_][a-z0-9_]*\})+)(!=|=|~|<)?(.*)$' int_re='^-?[0-9]+$'
  local neg=0 vars op text a b yes=0
  [[ $1 =~ $re ]] || die "provision-plan.json: can't read the condition '$1'."
  [ -z "${BASH_REMATCH[1]}" ] || neg=1
  vars="${BASH_REMATCH[2]}"
  op="${BASH_REMATCH[4]}"
  text="${BASH_REMATCH[5]}"
  if [ -z "$op" ] && [ -n "$text" ]; then die "provision-plan.json: can't read the condition '$1'."; fi
  plan_expand "$vars"
  a="$PLAN_OUT"
  plan_expand "$text"
  b="$PLAN_OUT"
  case "$op" in
    '') if [ -n "$a" ]; then yes=1; fi ;;
    '=') if [ "$a" = "$b" ]; then yes=1; fi ;;
    '!=') if [ "$a" != "$b" ]; then yes=1; fi ;;
    '~') if [[ $a == *"$b"* ]]; then yes=1; fi ;;
    '<')
      a="${a:-0}"
      if [[ $a =~ $int_re ]] && [[ $b =~ $int_re ]] && [ "$a" -lt "$b" ]; then yes=1; fi
      ;;
  esac
  [ "$yes" != "$neg" ]
}

# plan_when STEP: whether the step runs: every condition in its "when" holds, and not every
# one in its "unless".
plan_when() {
  local i n
  plan_get "${1}__when__n"
  n="${PLAN_GOT:-0}"
  for ((i = 0; i < n; i++)); do
    plan_get "${1}__when__$i"
    plan_cond "$PLAN_GOT" || return 1
  done
  plan_get "${1}__unless__n"
  n="${PLAN_GOT:-0}"
  [ "$n" -gt 0 ] || return 0
  for ((i = 0; i < n; i++)); do
    plan_get "${1}__unless__$i"
    plan_cond "$PLAN_GOT" || return 0
  done
  return 1
}

# plan_words PATH, plan_lines PATH: PLAN_WORDS or PLAN_LINES is the array of texts at PATH,
# each expanded.
plan_words() {
  local i n
  PLAN_WORDS=()
  plan_get "${1}__n"
  n="${PLAN_GOT:-0}"
  for ((i = 0; i < n; i++)); do
    plan_text "${1}__$i"
    PLAN_WORDS+=("$PLAN_OUT")
  done
}
plan_lines() {
  plan_words "$1"
  PLAN_LINES=("${PLAN_WORDS[@]}")
}

# plan_sh STEP: runs the step's "run" on the phone with ash (carriage returns removed, and
# trailing newlines, as $(...) does), with standard error dropped ("stderr": "drop"), in
# the output ("merge"), or left on the terminal. Sets PLAN_SH_OUT and PLAN_SH_STATUS
# (adb's exit status, which with shell protocol v2 is the command's).
plan_sh() {
  plan_words "${1}__run"
  plan_get "${1}__stderr"
  PLAN_SH_STATUS=0
  case "$PLAN_GOT" in
    drop) PLAN_SH_OUT="$(ash "${PLAN_WORDS[@]}" 2>/dev/null)" || PLAN_SH_STATUS=$? ;;
    merge) PLAN_SH_OUT="$(ash "${PLAN_WORDS[@]}" 2>&1)" || PLAN_SH_STATUS=$? ;;
    *) PLAN_SH_OUT="$(ash "${PLAN_WORDS[@]}")" || PLAN_SH_STATUS=$? ;;
  esac
}

# plan_match STEP TEXT STATUS WHOLE: whether TEXT passes the step's "contains" (it has that
# text), "matches" (an extended regular expression) or "equals". For a command's output
# (WHOLE=0), "contains" and "matches" also need its exit STATUS to be 0, like `cmd | grep -q`
# with pipefail, and "matches" looks at each line, like grep. For a "value" (WHOLE=1),
# "matches" looks at all of it at once, so a line break can't hide what follows it.
plan_match() {
  local text="$2" status="$3" whole="$4"
  if plan_has "${1}__contains"; then
    plan_text "${1}__contains"
    [ "$status" = 0 ] && [[ $text == *"$PLAN_OUT"* ]]
  elif plan_has "${1}__matches"; then
    plan_text "${1}__matches"
    if [ "$whole" = 1 ]; then
      [[ $text =~ $PLAN_OUT ]]
    else
      [ "$status" = 0 ] && grep -Eq -- "$PLAN_OUT" <<<"$text"
    fi
  elif plan_has "${1}__equals"; then
    plan_text "${1}__equals"
    [ "$text" = "$PLAN_OUT" ]
  else
    die "provision-plan.json: $1 has no contains, matches or equals."
  fi
}

# plan_run PATH: runs the steps in the list at PATH (steps, or a step's steps, pass, fail).
plan_run() {
  local i n
  plan_get "${1}__n"
  n="${PLAN_GOT:-0}"
  for ((i = 0; i < n; i++)); do plan_step "${1}__$i"; done
}

# plan_step STEP: runs one step, when its "when" and "unless" let it.
plan_step() {
  local s="$1" kind
  plan_when "$s" || return 0
  plan_get "${s}__kind"
  kind="$PLAN_GOT"
  case "$kind" in
    group) plan_run "${s}__steps" ;;
    say) plan_say "$s" ;;
    stop)
      plan_lines "${s}__message"
      die "${PLAN_LINES[@]}"
      ;;
    set)
      plan_text "${s}__value"
      plan_get "${s}__var"
      plan_set "$PLAN_GOT" "$PLAN_OUT"
      ;;
    read) plan_read "$s" ;;
    check) plan_check "$s" ;;
    wait) plan_wait "$s" ;;
    run)
      plan_words "${s}__run"
      plan_get "${s}__quiet"
      if [ "$PLAN_GOT" = true ]; then run_quiet adb shell "${PLAN_WORDS[@]}"; else run adb shell "${PLAN_WORDS[@]}"; fi
      ;;
    change | install) plan_change "$s" "$kind" ;;
    confirm)
      plan_text "${s}__text"
      if ! confirm "$PLAN_OUT"; then
        plan_lines "${s}__no"
        die "${PLAN_LINES[@]}"
      fi
      ;;
    sleep)
      plan_get "${s}__seconds"
      sleep "$PLAN_GOT"
      ;;
    reboot)
      adb reboot
      adb wait-for-device
      ;;
    broadcast) plan_broadcast "$s" ;;
    apk) plan_apk ;;
    device)
      find_adb
      pick_device
      plan_set serial "$SERIAL"
      ;;
    exit)
      plan_get "${s}__code"
      exit "$PLAN_GOT"
      ;;
    *) die "provision-plan.json: $s has an unknown kind, '$kind'." ;;
  esac
  return 0
}

# say: "text" at a "level": say (the default), info, warn, or err (standard error, as it
# is). With a "prefix", each line of the text starts with it instead (say and err only).
plan_say() {
  local text level prefix line
  plan_text "${1}__text"
  text="$PLAN_OUT"
  plan_get "${1}__level"
  level="${PLAN_GOT:-say}"
  plan_get "${1}__prefix"
  prefix="$PLAN_GOT"
  if [ -n "$prefix" ]; then
    while IFS= read -r line; do
      if [ "$level" = err ]; then printf '%s%s\n' "$prefix" "$line" >&2; else printf '%s%s\n' "$prefix" "$line"; fi
    done <<<"$text"
    return 0
  fi
  case "$level" in
    say) say "$text" ;;
    info) info "$text" ;;
    warn) warn "$text" ;;
    err) printf '%s\n' "$text" >&2 ;;
    *) die "provision-plan.json: $1 has an unknown level, '$level'." ;;
  esac
}

# read: the output of "run" goes "into" a variable; or only the number of its lines that
# have the text "count"; or the lines that have the text "lines", their leading white space
# replaced by "indent"; or a "tally" of the first group of an extended regular expression,
# one "<count> <value>" line per value, sorted.
plan_read() {
  local text line lit indent re out="" count=0 nl=$'\n'
  plan_sh "$1"
  text="$PLAN_SH_OUT"
  if plan_has "${1}__count"; then
    plan_get "${1}__count"
    lit="$PLAN_GOT"
    while IFS= read -r line; do
      if [[ $line == *"$lit"* ]]; then count=$((count + 1)); fi
    done <<<"$text"
    text="$count"
  elif plan_has "${1}__lines"; then
    plan_get "${1}__lines"
    lit="$PLAN_GOT"
    plan_get "${1}__indent"
    indent="$PLAN_GOT"
    while IFS= read -r line; do
      if [[ $line == *"$lit"* ]]; then
        line="${line#"${line%%[![:space:]]*}"}"
        out+="${out:+$nl}$indent$line"
      fi
    done <<<"$text"
    text="$out"
  elif plan_has "${1}__tally"; then
    plan_get "${1}__tally"
    re="$PLAN_GOT"
    while IFS= read -r line; do
      if [[ $line =~ $re ]]; then out+="${BASH_REMATCH[1]}$nl"; fi
    done <<<"$text"
    text="$(printf '%s' "$out" | LC_ALL=C sort | uniq -c | sed 's/^ *//')"
  fi
  plan_get "${1}__into"
  plan_set "$PLAN_GOT" "$text"
}

# check: "run" on the phone, or a "value", against "contains", "matches" or "equals"; then
# its "pass" or its "fail" steps. "into" a variable: 1 when it passed, else empty.
plan_check() {
  local text status=0 whole=0 ok=""
  if plan_has "${1}__run"; then
    plan_sh "$1"
    text="$PLAN_SH_OUT"
    status="$PLAN_SH_STATUS"
  else
    plan_text "${1}__value"
    text="$PLAN_OUT"
    whole=1
  fi
  if plan_match "$1" "$text" "$status" "$whole"; then ok=1; fi
  if plan_has "${1}__into"; then
    plan_get "${1}__into"
    plan_set "$PLAN_GOT" "$ok"
  fi
  if [ -n "$ok" ]; then plan_run "${1}__pass"; else plan_run "${1}__fail"; fi
}

# wait: up to "tries" times, "run" it and check; after each miss, sleep "every" seconds.
# "into" a variable: 1 when it passed, else empty.
plan_wait() {
  local tries every into i
  plan_get "${1}__tries"
  tries="$PLAN_GOT"
  plan_get "${1}__every"
  every="$PLAN_GOT"
  plan_get "${1}__into"
  into="$PLAN_GOT"
  for ((i = 0; i < tries; i++)); do
    plan_sh "$1"
    if plan_match "$1" "$PLAN_SH_OUT" "$PLAN_SH_STATUS" 0; then
      if [ -n "$into" ]; then plan_set "$into" 1; fi
      return 0
    fi
    sleep "$every"
  done
  if [ -n "$into" ]; then plan_set "$into" ""; fi
}

# change (a shell command that changes the phone) and install (adb install with its "args",
# each when its "when" holds, and the APK): only printed with --dry-run. Otherwise the
# output is shown, indented, and kept in {output}; without a line matching "success", the
# first of "failures" whose "contains" is in the output (or that has none) runs.
plan_change() {
  local s="$1" i n out
  local -a cmd
  if [ "$2" = install ]; then
    cmd=(install)
    plan_get "${s}__args__n"
    n="${PLAN_GOT:-0}"
    for ((i = 0; i < n; i++)); do
      if plan_when "${s}__args__$i"; then
        plan_text "${s}__args__${i}__arg"
        cmd+=("$PLAN_OUT")
      fi
    done
    plan_expand "{apk}"
    cmd+=("$PLAN_OUT")
  else
    plan_words "${s}__run"
    cmd=(shell "${PLAN_WORDS[@]}")
  fi
  if [ "$DRY_RUN" = 1 ]; then
    run adb "${cmd[@]}"
    return 0
  fi
  if [ "$2" = install ]; then
    out="$(adb "${cmd[@]}" 2>&1)" || true
  else
    out="$(ash "${cmd[@]:1}" 2>&1)" || true
  fi
  printf '%s\n' "$out" | sed 's/^/  /'
  plan_set output "$out"
  plan_get "${s}__success"
  if grep -Eq -- "$PLAN_GOT" <<<"$out"; then return 0; fi
  plan_get "${s}__failures__n"
  n="${PLAN_GOT:-0}"
  for ((i = 0; i < n; i++)); do
    if plan_has "${s}__failures__${i}__contains"; then
      plan_text "${s}__failures__${i}__contains"
      [[ $out == *"$PLAN_OUT"* ]] || continue
    fi
    plan_run "${s}__failures__${i}__steps"
    return 0
  done
}

# broadcast: an ordered broadcast ("run", am broadcast) whose answer is the line
# "Broadcast completed: result=<n>, data="<text>"" (platform notes E1). {output} is what
# am printed, {result} what follows "Broadcast completed: ", and {data} the text. While the
# result has "retry"'s "contains", it tries again, up to "tries" times in all, "every"
# seconds apart, saying "first" (info) before the first retry. Then the first of
# "outcomes" whose "prefix" and "contains" fit the result runs, with {data} "into" a
# variable.
plan_broadcast() {
  local s="$1" out result data until="" first="" tries=1 every=0 k=0 i n o
  local -a cmd
  plan_words "${s}__run"
  cmd=("${PLAN_WORDS[@]}")
  if [ "$DRY_RUN" = 1 ]; then
    run adb shell "${cmd[@]}"
    return 0
  fi
  if plan_has "${s}__retry"; then
    plan_text "${s}__retry__contains"
    until="$PLAN_OUT"
    plan_get "${s}__retry__tries"
    tries="$PLAN_GOT"
    plan_get "${s}__retry__every"
    every="$PLAN_GOT"
    plan_text "${s}__retry__first"
    first="$PLAN_OUT"
  fi
  while :; do
    out="$(adb shell "${cmd[@]}" 2>&1 | tr -d '\r')" || true
    result="$(sed -n 's/^Broadcast completed: //p' <<<"$out")"
    if [ -n "$until" ] && [[ $result == *"$until"* ]]; then
      k=$((k + 1))
      if [ "$k" -lt "$tries" ]; then
        if [ "$k" = 1 ] && [ -n "$first" ]; then info "$first"; fi
        sleep "$every"
        continue
      fi
    fi
    break
  done
  data="$(sed 's/^result=[-0-9]*, data="//; s/"$//' <<<"$result")"
  plan_set output "$out"
  plan_set result "$result"
  plan_set data "$data"
  plan_get "${s}__outcomes__n"
  n="${PLAN_GOT:-0}"
  for ((i = 0; i < n; i++)); do
    o="${s}__outcomes__$i"
    if plan_has "${o}__prefix"; then
      plan_text "${o}__prefix"
      [[ $result == "$PLAN_OUT"* ]] || continue
    fi
    if plan_has "${o}__contains"; then
      plan_text "${o}__contains"
      [[ $result == *"$PLAN_OUT"* ]] || continue
    fi
    if plan_has "${o}__into"; then
      plan_get "${o}__into"
      plan_set "$PLAN_GOT" "$data"
    fi
    plan_run "${o}__steps"
    return 0
  done
}

# apk: what the build tools say about the APK {apk}. Sets {apk_found} (1 when the file is
# there), {apk_package}, {test_only} (yes, no, or unknown without aapt2), {signer}
# ("<certificate SHA-256>|<DN>"; empty without apksigner or when it doesn't verify),
# {signer_sha256}, {signer_dn} and {signer_tool} (1 when apksigner is there).
plan_apk() {
  local apk signer t=0
  plan_expand "{apk}"
  apk="$PLAN_OUT"
  plan_set apk_found ""
  plan_set apk_package ""
  plan_set test_only unknown
  plan_set signer ""
  plan_set signer_sha256 ""
  plan_set signer_dn ""
  plan_set signer_tool ""
  [ -f "$apk" ] || return 0
  plan_set apk_found 1
  plan_set apk_package "$(apk_package "$apk" || true)"
  apk_is_test_only "$apk" || t=$?
  case "$t" in
    0) plan_set test_only yes ;;
    1) plan_set test_only no ;;
  esac
  signer="$(apk_signer "$apk" || true)"
  plan_set signer "$signer"
  plan_set signer_sha256 "${signer%%|*}"
  plan_set signer_dn "${signer#*|}"
  if [ -n "$(build_tool apksigner)" ]; then plan_set signer_tool 1; fi
}

# device_stop KEY LIST READY: stops with the plan's message for finding the phone
# (device.messages.KEY), with {serial}, {list} (what adb devices listed) and {ready}.
device_stop() {
  [ -n "${PJ__format-}" ] || plan_load
  plan_set serial "$SERIAL"
  plan_set list "$2"
  plan_set ready "$3"
  plan_lines "device__messages__$1"
  die "${PLAN_LINES[@]}"
}
