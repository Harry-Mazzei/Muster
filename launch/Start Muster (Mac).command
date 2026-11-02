#!/bin/bash
# Double-click to start Muster on a Mac.
cd "$(dirname "$0")"
xattr -dr com.apple.quarantine . 2>/dev/null
chmod +x bin/muster-mac-* 2>/dev/null
if [ "$(uname -m)" = "arm64" ]; then exec ./bin/muster-mac-arm64; else exec ./bin/muster-mac-intel; fi
