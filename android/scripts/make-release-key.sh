#!/usr/bin/env bash
# Create Belay's release signing key: once, ever, on the computer that builds releases.
#
# Usage: android/scripts/make-release-key.sh [directory]     (default: ~/.config/belay)
#
# It writes, outside the repository:
#   <directory>/belay-release.p12        the key (PKCS12, RSA 4096)
#   <directory>/signing.properties       where the key is; no password in it
#
# Android updates a device owner only with an APK signed by the same key. Lose this key
# and every phone has to be factory reset to update Belay. Back it up (docs/signing.md):
# the .p12 file in two places, and its password in your password manager.
set -euo pipefail

DIR="${1:-$HOME/.config/belay}"
KEYSTORE="$DIR/belay-release.p12"
PROPS="$DIR/signing.properties"
ALIAS=belay

if [ -e "$KEYSTORE" ]; then
  printf 'STOPPED: %s already exists. There is only ever one release key; not overwriting it.\n' "$KEYSTORE" >&2
  exit 1
fi
command -v keytool >/dev/null || { echo "STOPPED: keytool not found (it comes with a JDK)." >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
mkdir -p "$DIR"
case "$(cd "$DIR" && pwd -P)/" in
  "$REPO/"*)
    rmdir "$DIR" 2>/dev/null || true
    echo "STOPPED: $DIR is inside the repository. Keys never go in the repository." >&2
    exit 1 ;;
esac
chmod 700 "$DIR"

printf 'Choose a password for the key (at least 12 characters; keep it in your password manager): '
read -rs PASSWORD
printf '\nType it again: '
read -rs AGAIN
printf '\n'
[ "$PASSWORD" = "$AGAIN" ] || { echo "STOPPED: the two passwords differ." >&2; exit 1; }
[ "${#PASSWORD}" -ge 12 ] || { echo "STOPPED: use at least 12 characters." >&2; exit 1; }
export BELAY_STORE_PASSWORD="$PASSWORD"

# PKCS12 keystores use one password for the store and the key.
keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Belay release key" \
  -storepass:env BELAY_STORE_PASSWORD -keypass:env BELAY_STORE_PASSWORD
chmod 600 "$KEYSTORE"

cat >"$PROPS" <<EOF
# Belay release signing. The password is not stored here:
# android/scripts/build-release.sh asks for it (or reads BELAY_STORE_PASSWORD).
storeFile=$KEYSTORE
keyAlias=$ALIAS
EOF
chmod 600 "$PROPS"

SHA256="$(keytool -list -v -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
  -storepass:env BELAY_STORE_PASSWORD | sed -n 's/^[[:space:]]*SHA256: //p')"

cat <<EOF

Created $KEYSTORE

Certificate SHA-256 (not secret; you'll need it to register the app, docs/signing.md):
  $SHA256

Now, before anything else, back it up:
  1. Copy $KEYSTORE to two places that aren't this computer
     (an encrypted USB drive, and your password manager as an attachment).
  2. Put the password in your password manager.
Without both, a lost or broken computer means factory-resetting every phone.
EOF
