#!/usr/bin/env bash
# Собирает артефакт rootfs (Ubuntu arm64) для proot.
# Без этого артефакта приложение работает полностью, кроме инструмента bash.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/build/runtime}"
DISTRO="${DISTRO:-ubuntu-base-24.04-base-arm64}"
URL="${URL:-https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/${DISTRO}.tar.gz}"

mkdir -p "$OUT"
TARGET="$OUT/botchat-rootfs-arm64.tar.gz"

if [ -f "$TARGET" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "rootfs уже собран: $TARGET"
    exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> загрузка базового rootfs"
curl -sSL --retry 5 -o "$TMP/base.tar.gz" "$URL"
echo "==> подготовка"
mkdir -p "$TMP/rootfs"
tar -xzf "$TMP/base.tar.gz" -C "$TMP/rootfs"

cat > "$TMP/rootfs/etc/resolv.conf" <<'RESOLV'
nameserver 1.1.1.1
nameserver 8.8.8.8
RESOLV

mkdir -p "$TMP/rootfs/workspace"
cat > "$TMP/rootfs/etc/motd" <<'MOTD'
botCHAT rootfs
MOTD

echo "==> упаковка"
( cd "$TMP/rootfs" && tar -czf "$TARGET" . )
ls -la "$TARGET"
