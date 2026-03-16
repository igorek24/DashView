#!/bin/bash
# DashView Uninstaller
set -e

if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (sudo ./uninstall.sh)"
    exit 1
fi

echo "Removing DashView..."
rm -rf /opt/dashview
rm -f /usr/local/bin/dashview
rm -f /usr/share/applications/dashview.desktop
rm -f /usr/share/icons/hicolor/scalable/apps/dashview.svg
update-desktop-database /usr/share/applications 2>/dev/null || true

echo "DashView has been removed."
