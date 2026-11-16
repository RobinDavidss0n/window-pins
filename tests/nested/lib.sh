# Helpers for talking to the nested shell started by session.sh.
#   source tests/nested/lib.sh WORKDIR
# shellcheck shell=bash

WP_WORK=$(readlink -f "${1:?usage: source lib.sh WORKDIR}")
WP_HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
WP_UUID=window-pins@robindavidss0n.github.io

wp_wait_shell() {
    local i
    for i in $(seq 60); do
        if [[ -s $WP_WORK/bus ]]; then
            export DBUS_SESSION_BUS_ADDRESS
            DBUS_SESSION_BUS_ADDRESS=$(cat "$WP_WORK/bus")
            if [[ $(ev '"up"' 2>/dev/null) == '"up"' ]]; then
                export WAYLAND_DISPLAY=wp-test-0 GDK_BACKEND=wayland
                unset DISPLAY
                return 0
            fi
        fi
        sleep 0.5
    done
    echo "nested shell did not come up; see $WP_WORK/shell.log" >&2
    return 1
}

# Evaluate JS in the nested shell; prints the result (JSON-ish string).
ev() {
    # gdbus parses arguments as GVariant text, so pass a quoted string.
    local arg
    arg=$(python3 -I -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1")
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$arg" |
        python3 -I -c '
import sys, re, ast
s = sys.stdin.read().strip()
m = re.match(r"^\((true|false), (.*)\)$", s, re.S)
ok, val = m.group(1), ast.literal_eval(m.group(2))
print(val if ok == "true" else "EVAL-FAIL " + val)
'
}

# JSON list of app windows: [seq, wmClass, title, monitor, workspace, x, y, w, h, maxFlags]
wins() {
    ev 'JSON.stringify(global.display.list_all_windows().filter(w => !w.is_override_redirect()).map(w => {
        const r = w.get_frame_rect();
        return [w.get_stable_sequence(), w.get_wm_class(), w.get_title(), w.get_monitor(),
            w.get_workspace()?.index() ?? -1, r.x, r.y, r.width, r.height, w.get_maximize_flags()];
    }))'
}

# Monitor geometries: [[index, x, y, w, h], ...]
monitors() {
    ev 'JSON.stringify([...Array(global.display.get_n_monitors()).keys()].map(i => {
        const r = global.display.get_monitor_geometry(i); return [i, r.x, r.y, r.width, r.height];
    }))'
}

# Run JS with `w` bound to the first window with this title.
with_win() {
    local title=$1 js=$2
    local quoted
    quoted=$(python3 -I -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$title")
    ev "(() => { const w = global.display.list_all_windows().find(w => w.get_title() === $quoted); if (!w) return 'no such window'; $js })()"
}

# The extension's engine in the nested shell.
ENGINE="Main.extensionManager.lookup('$WP_UUID').stateObj._engine"

# Press Super+KEY (a Clutter key name such as Left) on a virtual keyboard,
# so GNOME's own keybindings run, e.g. edge tiling.
super_key() {
    ev "(() => { const C = imports.gi.Clutter;
      globalThis.wpKeyboard ??= C.get_default_backend().get_default_seat()
          .create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE);
      const t = () => imports.gi.GLib.get_monotonic_time();
      for (const [key, state] of [[C.KEY_Super_L, 1], [C.KEY_$1, 1], [C.KEY_$1, 0], [C.KEY_Super_L, 0]])
          wpKeyboard.notify_keyval(t(), key, state ? C.KeyState.PRESSED : C.KeyState.RELEASED);
      return 'ok'; })()" > /dev/null
}

open_app() {
    gjs -m "$WP_HERE/win.js" "$@" > /dev/null 2>&1 &
    echo $!
}

add_monitor() {
    gjs -m "$WP_HERE/vmon.js" "$@" > /dev/null 2>&1 &
    echo $!
}

journal() {
    grep -a '\[window-pins\]' "$WP_WORK/shell.log" | sed 's/^.*\[window-pins\] /  /'
}
