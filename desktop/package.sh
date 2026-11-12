#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="${1:-$source_dir/build/Bot Crew.app}"
mkdir -p "$app_dir/Contents/MacOS"
CGO_ENABLED=1 go -C "$source_dir" build -o "$app_dir/Contents/MacOS/desktop" .
cp "$source_dir/Info.plist" "$app_dir/Contents/Info.plist"
plutil -lint "$app_dir/Contents/Info.plist"
codesign --force --sign - "$app_dir"
codesign --verify --strict "$app_dir"
printf '%s\n' "$app_dir"
