#!/usr/bin/env bash
# Укладывает файл в GitHub Actions secret, шифруя публичным ключом репозитория.
# Нужен только curl и openssl; сам секрет в логи и файлы репозитория не попадает.
#
#   GITHUB_TOKEN=... ./scripts/set-secret.sh owner/repo SECRET_NAME path/to/file
set -euo pipefail

REPO="${REPO:-${1:-}}"
NAME="${NAME:-${2:-}}"
FILE="${FILE:-${3:-}}"

if [ -z "$REPO" ] || [ -z "$NAME" ] || [ -z "$FILE" ]; then
    echo "usage: REPO=owner/repo NAME=SECRET FILE=path $0" >&2
    exit 2
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "GITHUB_TOKEN is required" >&2
    exit 2
fi
if [ ! -f "$FILE" ]; then
    echo "file not found: $FILE" >&2
    exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -sS -f -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/actions/secrets/public-key" -o "$TMP/meta.json"

KEY_ID="$(sed -n 's/.*"key_id":"\([^"]*\)".*/\1/p' "$TMP/meta.json")"
if [ -z "$KEY_ID" ]; then
    KEY_ID="$(sed -n 's/.*"key_id": *"\([^"]*\)".*/\1/p' "$TMP/meta.json")"
fi
if [ -z "$KEY_ID" ]; then
    echo "failed to read key_id" >&2
    exit 1
fi

sed -n 's/.*"key": *"\([^"]*\)".*/\1/p' "$TMP/meta.json" | base64 -d > "$TMP/pub.der"
openssl pkey -pubin -inform DER -in "$TMP/pub.der" -out "$TMP/pub.pem" 2>/dev/null

base64 -w0 "$FILE" > "$TMP/plain.b64"
openssl pkeyutl -encrypt -pubin -inkey "$TMP/pub.pem" \
    -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 \
    -in "$TMP/plain.b64" -out "$TMP/sealed.bin" 2>/dev/null
SEALED="$(base64 -w0 "$TMP/sealed.bin")"

printf '{"encrypted_value":"%s","key_id":"%s"}' "$SEALED" "$KEY_ID" > "$TMP/body.json"
curl -sS -f -X PUT -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    --data @"$TMP/body.json" \
    "https://api.github.com/repos/$REPO/actions/secrets/$NAME" > /dev/null

echo "secret $NAME updated in $REPO"