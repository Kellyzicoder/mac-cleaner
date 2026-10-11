#!/bin/bash
# Copies the built app into your Applications folder.
set -e
cd "$(dirname "$0")/.."
APP=$(ls -d release/Mac\ Purificator-darwin-*/Mac\ Purificator.app 2>/dev/null | head -1)
if [ -z "$APP" ]; then echo "Run npm run package first."; exit 1; fi
ditto "$APP" "/Applications/Mac Purificator.app"
echo "Installed: /Applications/Mac Purificator.app"
