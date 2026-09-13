#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install / update / remove the Orochi Monitor GNOME extension.
#
# Usage:
#   ./install.sh              auto-detects: install or offer to update/remove
#   ./install.sh --install    force install/update, skip the interactive menu
#   ./install.sh --uninstall  remove the extension
#   ./install.sh --no-udev    do not prompt for the udev rule
#   ./install.sh --help
#
set -euo pipefail

UUID="orochi-v2-control@sanic.github.io"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
UDEV_RULE="/etc/udev/rules.d/99-razer-orochi-v2.rules"
VERSION="1.0.0"
NEED_LOGOUT=0

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

is_installed() {
    [[ -f "$EXT_DIR/metadata.json" ]]
}

installed_version() {
    python3 - "$EXT_DIR/metadata.json" <<'PY' 2>/dev/null || echo "unknown"
import json, sys
with open(sys.argv[1]) as f:
    m = json.load(f)
print(m.get('version-name', m.get('version', 'unknown')))
PY
}

gsettings_enable() {
    local enabled new

    enabled=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ "$enabled" != *"$UUID"* ]]; then
        new=$(python3 - "$enabled" "$UUID" <<'PY'
import ast, sys
items = ast.literal_eval(sys.argv[1])
if sys.argv[2] not in items:
    items.append(sys.argv[2])
print(repr(items).replace("'", '"'))
PY
)
        gsettings set org.gnome.shell enabled-extensions "$new"
        NEED_LOGOUT=1
    fi
}

gsettings_disable() {
    local enabled new

    enabled=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ "$enabled" == *"$UUID"* ]]; then
        new=$(python3 - "$enabled" "$UUID" <<'PY'
import ast, sys
items = [u for u in ast.literal_eval(sys.argv[1]) if u != sys.argv[2]]
print(repr(items).replace("'", '"'))
PY
)
        gsettings set org.gnome.shell enabled-extensions "$new"
    fi
}

install_udev() {
    say "Installing udev rule for Razer Orochi V2 (1532:0094, 1532:0095)"
    sudo tee "$UDEV_RULE" > /dev/null <<'EOF'
# Razer Orochi V2 - hidraw access for the desktop user
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1532", ATTRS{idProduct}=="0094", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1532", ATTRS{idProduct}=="0095", TAG+="uaccess"
EOF
    sudo udevadm control --reload-rules
    sudo udevadm trigger --action=change --subsystem-match=hidraw
    say "udev rule installed"
}

remove_udev() {
    if [[ ! -f "$UDEV_RULE" ]]; then
        return
    fi

    read -rp "Remove udev rule $UDEV_RULE? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
        sudo rm -f "$UDEV_RULE"
        sudo udevadm control --reload-rules
        say "udev rule removed"
    fi
}

do_install() {
    local update="$1"
    local skip_udev="$2"

    command -v gcc >/dev/null || die "gcc is required to build the helper"
    command -v glib-compile-schemas >/dev/null || die "glib-compile-schemas is required (glib2)"

    if [[ "$update" == "yes" ]]; then
        say "Updating $UUID ($(installed_version) -> $VERSION)"
    else
        say "Installing $UUID $VERSION"
    fi

    say "Building orochictl"
    gcc -Wall -Wextra -O2 -o "$SRC_DIR/orochictl" "$SRC_DIR/orochictl.c"

    say "Installing to $EXT_DIR"
    mkdir -p "$EXT_DIR/schemas"
    install -m 644 "$SRC_DIR/extension/extension.js"   "$EXT_DIR/extension.js"
    install -m 644 "$SRC_DIR/extension/prefs.js"      "$EXT_DIR/prefs.js"
    install -m 644 "$SRC_DIR/extension/metadata.json" "$EXT_DIR/metadata.json"
    install -m 644 "$SRC_DIR/extension/stylesheet.css" "$EXT_DIR/stylesheet.css"
    install -m 644 "$SRC_DIR/extension/schemas/"*.xml "$EXT_DIR/schemas/"
    install -m 755 "$SRC_DIR/orochictl"               "$EXT_DIR/orochictl"

    glib-compile-schemas "$EXT_DIR/schemas/"

    say "Enabling $UUID"
    gsettings_enable

    if [[ "$skip_udev" -eq 0 ]]; then
        if [[ -f "$UDEV_RULE" ]]; then
            say "udev rule already present, skipping"
        else
            read -rp "Install udev rule for hidraw access (needed to read the mouse)? [Y/n] " answer
            if [[ ! "$answer" =~ ^[Nn]$ ]]; then
                install_udev
            else
                warn "skipped - battery/DPI/poll will show 'n/a' until it is installed"
            fi
        fi
    fi

    if command -v gnome-extensions >/dev/null && \
       gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
        gnome-extensions enable "$UUID" || true
        say "Extension enabled in the running session."
        if [[ "$update" == "yes" ]]; then
            warn "GNOME Shell caches extension code for the whole session."
            warn "To apply the update you must log out and back in."
        fi
    else
        NEED_LOGOUT=1
    fi

    say "Done."
    if [[ $NEED_LOGOUT -eq 1 ]]; then
        warn "GNOME Shell only scans extensions at startup."
        warn "Log out and back in to load the indicator."
    fi
    say "Test the helper with: $EXT_DIR/orochictl status"
}

do_uninstall() {
    say "Removing $UUID"
    rm -rf "$EXT_DIR"
    gsettings_disable
    remove_udev
    say "Uninstalled. Log out and back in if the indicator is still visible."
}

# --- argument parsing -------------------------------------------------------

ACTION=""
SKIP_UDEV=0

for arg in "$@"; do
    case "$arg" in
        --uninstall|--remove) ACTION="uninstall" ;;
        --install|--update)   ACTION="install" ;;
        --no-udev)            SKIP_UDEV=1 ;;
        -h|--help)            usage; exit 0 ;;
        *)                    die "unknown option: $arg (try --help)" ;;
    esac
done

# --- auto-detection ---------------------------------------------------------

if [[ -z "$ACTION" ]]; then
    if is_installed; then
        say "Orochi Monitor $VERSION is available"
        say "Installed version: $(installed_version) in $EXT_DIR"
        echo
        echo "  1) Update"
        echo "  2) Remove"
        echo "  3) Cancel"
        read -rp "Choose [1/2/3]: " choice
        case "$choice" in
            1) ACTION="install" ;;
            2) ACTION="uninstall" ;;
            3) exit 0 ;;
            *) die "invalid choice" ;;
        esac
    else
        ACTION="install"
    fi
fi

if [[ "$ACTION" == "uninstall" ]]; then
    do_uninstall
else
    UPDATE="no"
    is_installed && UPDATE="yes"
    do_install "$UPDATE" "$SKIP_UDEV"
fi
