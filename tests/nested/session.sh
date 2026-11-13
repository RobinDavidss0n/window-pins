#!/bin/bash
# Start a headless GNOME Shell on its own D-Bus session bus, with this
# extension loaded from the source tree. Nothing of the running desktop
# session is touched: data, config, cache and GSettings (keyfile backend)
# all live in WORKDIR.
#
#   tests/nested/session.sh WORKDIR    # runs until killed
#
# WORKDIR/bus gets the bus address once the shell is up; source
# tests/nested/lib.sh to talk to it.
set -euo pipefail

work=$(readlink -f "${1:?usage: session.sh WORKDIR}")
here=$(dirname "$(readlink -f "$0")")
repo=$(readlink -f "$here/../..")
uuid=window-pins@robindavidss0n.github.io

if [[ $# -lt 2 || $2 != --inner ]]; then
    mkdir -p "$work"/{data/gnome-shell/extensions,config,cache,state}
    rm -f "$work/bus"
    ln -sfn "$repo/extension" "$work/data/gnome-shell/extensions/$uuid"
    glib-compile-schemas "$repo/extension/schemas"
    # A helper that turns on unsafe mode, so the tests can use
    # org.gnome.Shell.Eval to inspect windows.
    helper="$work/data/gnome-shell/extensions/wp-test-helper@local"
    mkdir -p "$helper"
    cp "$here/helper/metadata.json" "$here/helper/extension.js" "$helper/"

    export XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config"
    export XDG_CACHE_HOME="$work/cache" XDG_STATE_HOME="$work/state"
    export GSETTINGS_BACKEND=keyfile
    unset WAYLAND_DISPLAY DISPLAY
    exec dbus-run-session -- "$0" "$work" --inner > "$work/shell.log" 2>&1
fi

# WP_WITHOUT_EXTENSION=1 starts the shell without window-pins, to tell
# its problems apart from the shell's own.
if [[ ${WP_WITHOUT_EXTENSION:-} == 1 ]]; then
    gsettings set org.gnome.shell enabled-extensions "['wp-test-helper@local']"
else
    gsettings set org.gnome.shell enabled-extensions "['wp-test-helper@local', '$uuid']"
fi
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings --schemadir "$repo/extension/schemas" set org.gnome.shell.extensions.window-pins debug true
echo "$DBUS_SESSION_BUS_ADDRESS" > "$work/bus"
# Command-line virtual monitors all have identical EDID data (serial
# included), so the extension tells them apart by connector order. They
# can be turned off and on with display.js. Monitors added with vmon.js
# each have their own serial, but Mutter 50 crashes when one of those is
# turned off through DisplayConfig, so those are only added and removed.
monitors=(--virtual-monitor 1920x1080)
if [[ -n ${WP_SECOND_MONITOR:-} ]]; then
    monitors+=(--virtual-monitor "$WP_SECOND_MONITOR")
fi
exec gnome-shell --headless --no-x11 --wayland-display wp-test-0 "${monitors[@]}"
