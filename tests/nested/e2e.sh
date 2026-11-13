#!/bin/bash
# End-to-end check in a headless nested GNOME Shell (see session.sh).
#
#   tests/nested/e2e.sh [WORKDIR]
#
# Two virtual monitors from the command line, A (1920x1080, primary) and
# B (1280x1024, right of A); B is turned off and on to switch between the
# setups "A" and "A+B" the way undocking and docking does. A third monitor
# with its own serial is hotplugged through the ScreenCast API.
set -uo pipefail

here=$(dirname "$(readlink -f "$0")")
work=${1:-$(mktemp -d)}
rm -rf "$work"
mkdir -p "$work"

WP_SECOND_MONITOR=1280x1024 "$here/session.sh" "$work" &
session=$!
# shellcheck source=lib.sh
source "$here/lib.sh" "$work"

pids=()
cleanup() {
    for p in "${pids[@]}"; do kill "$p" 2> /dev/null; done
    pkill -P "$session" 2> /dev/null
    kill "$session" 2> /dev/null
    wait 2> /dev/null
}
trap cleanup EXIT

wp_wait_shell || exit 1

fails=0
step() { echo "== $*"; }

# expect_win TITLE MONITOR X Y [W H]: window frame within 2 px.
expect_win() {
    local result
    result=$(wins | python3 -I -c '
import json, sys
title, mon, x, y = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
size = [int(v) for v in sys.argv[5:7]]
raw = sys.stdin.read().strip()
data = json.loads(raw)
if isinstance(data, str):
    data = json.loads(data)
w = next((w for w in data if w[2] == title), None)
if w is None:
    print("missing")
    sys.exit()
ok = w[3] == mon and abs(w[5] - x) <= 2 and abs(w[6] - y) <= 2
if size:
    ok = ok and abs(w[7] - size[0]) <= 2 and abs(w[8] - size[1]) <= 2
print("ok" if ok else f"got monitor {w[3]} at {w[5]},{w[6]} {w[7]}x{w[8]}")
' "$@")
    if [[ $result == ok ]]; then
        echo "   ok: \"$1\" on monitor $2 at $3,$4${5:+ ${5}x$6}"
    else
        echo "   FAIL: \"$1\" expected monitor $2 at $3,$4${5:+ ${5}x$6}, $result"
        fails=$((fails + 1))
    fi
}

expect_eq() {
    if [[ $2 == "$3" ]]; then
        echo "   ok: $1"
    else
        echo "   FAIL: $1: expected $3, got $2"
        fails=$((fails + 1))
    fi
}

settle() { sleep "${1:-3}"; }
move() { with_win "$1" "w.move_resize_frame(true, $2, $3, $4, $5); return 'ok'" > /dev/null; }
close_win() { with_win "$1" "w.delete(global.get_current_time()); return 'ok'" > /dev/null; }
pin() {
    with_win "$1" "w.activate(global.get_current_time()); return 'ok'" > /dev/null
    sleep 0.3
    ev "$ENGINE.pinWindow($ENGINE.focusedWindow())?.title ?? 'none'"
}
# Pin a window without going through focus (activating a window on
# another workspace switches workspaces first).
pin_window() { with_win "$1" "return $ENGINE.pinWindow(w)?.title ?? 'none'"; }
setup_name() { ev "$ENGINE.currentSetup.name"; }

step "open two windows of one app; nothing is pinned, so they stay where GNOME put them"
pids+=("$(open_app org.example.Alpha 'Alpha one' 'Alpha two@300=Alpha two')")
settle
expect_eq "setup" "$(setup_name)" '"2 monitors"'

step "the user moves both to monitor B and pins one"
move "Alpha one" 2100 200 400 300
move "Alpha two" 2500 400 500 350
sleep 1
expect_eq "pin made" "$(pin 'Alpha two')" '"Alpha two"'

step "undock: monitor B off; Mutter moves the windows to A, nothing is remembered for 'A only' yet"
gjs -m "$here/display.js" only Meta-0 > /dev/null
settle
expect_eq "setup" "$(setup_name)" '"1 monitor"'
move "Alpha one" 100 500 400 300
sleep 1

step "dock again: both windows go back to their places on B"
gjs -m "$here/display.js" all > /dev/null
settle
expect_win "Alpha one" 1 2100 200 400 300
expect_win "Alpha two" 1 2500 400 500 350

step "undock again: the window moved in 'A only' goes back there"
gjs -m "$here/display.js" only Meta-0 > /dev/null
settle
expect_win "Alpha one" 0 100 500 400 300

step "dock again; close the pinned window and open a new one whose title becomes the pin's title"
gjs -m "$here/display.js" all > /dev/null
settle
close_win "Alpha two"
sleep 1
pids+=("$(open_app org.example.Alpha 'Loading@400=Alpha two')")
settle
expect_win "Alpha two" 1 2500 400 500 350

step "another window of the app: the only pin is held, so it is left alone"
pids+=("$(open_app org.example.Alpha 'Alpha three')")
settle
expect_eq "Alpha three has no pin" \
    "$(with_win 'Alpha three' "return JSON.stringify($ENGINE._state.openWindows[String(w.get_stable_sequence())].pins)")" '"{}"'

step "first-free-pin fallback: a window with another title takes the app's pin"
pids+=("$(open_app org.example.Beta 'Beta x')")
settle
move "Beta x" 300 300 600 400
with_win "Beta x" "w.change_workspace_by_index(1, false); return 'ok'" > /dev/null
sleep 1
expect_eq "pin made" "$(pin_window 'Beta x')" '"Beta x"'
close_win "Beta x"
sleep 1
pids+=("$(open_app org.example.Beta 'Beta y')")
settle
expect_win "Beta y" 0 300 300 600 400
expect_eq "Beta y on the pin's workspace" "$(with_win 'Beta y' 'return String(w.get_workspace().index())')" '"1"'

step "a maximized window on B comes back maximized on B"
with_win "Alpha three" "w.move_frame(true, 2000, 300); w.maximize(); return 'ok'" > /dev/null
sleep 1
gjs -m "$here/display.js" only Meta-0 > /dev/null
settle
expect_eq "Alpha three moved to A" "$(with_win 'Alpha three' 'return String(w.get_monitor())')" '"0"'
gjs -m "$here/display.js" all > /dev/null
settle
expect_eq "Alpha three maximized on B" \
    "$(with_win 'Alpha three' 'return w.get_monitor() + " " + w.get_maximize_flags()')" '"1 3"'
with_win "Alpha three" "w.unmaximize(); return 'ok'" > /dev/null
sleep 1
expect_eq "Alpha three unmaximizes on B" "$(with_win 'Alpha three' 'return String(w.get_monitor())')" '"1"'

step "remember closed windows (switched on for Gamma only)"
ev "$ENGINE.setRemember('org.example.Gamma', 'Gamma', true)" > /dev/null
pids+=("$(open_app org.example.Gamma 'Gamma one')")
settle
move "Gamma one" 2000 600 450 300
sleep 1
close_win "Gamma one"
sleep 1
pids+=("$(open_app org.example.Gamma 'Gamma one')")
settle
expect_win "Gamma one" 1 2000 600 450 300
pids+=("$(open_app org.example.Gamma 'Gamma other')")
settle
expect_win "Gamma other" 1 2000 600 450 300
# Delta has the toggle off: a reopened window is not placed.
pids+=("$(open_app org.example.Delta 'Delta one')")
settle
move "Delta one" 2200 100 300 200
sleep 1
close_win "Delta one"
sleep 1
pids+=("$(open_app org.example.Delta 'Delta one')")
settle
expect_eq "Delta not placed on its closed spot" \
    "$(with_win 'Delta one' 'return String(w.get_monitor())')" '"0"'

step "hotplug a third monitor with its own serial, move a window there, unplug it"
vmon=$(add_monitor 1024 768)
pids+=("$vmon")
settle
expect_eq "setup" "$(setup_name)" '"3 monitors"'
expect_win "Alpha one" 1 2100 200 400 300
move "Alpha one" 3300 100 400 300
sleep 1
kill "$vmon"
settle
expect_eq "setup" "$(setup_name)" '"2 monitors"'
expect_win "Alpha one" 1 2100 200 400 300

step "extension turned off, monitor B off meanwhile, turned on: memory reloads by window sequence"
ev "Main.extensionManager.disableExtension('$WP_UUID')" > /dev/null
sleep 1
gjs -m "$here/display.js" only Meta-0 > /dev/null
settle
ev "Main.extensionManager.enableExtension('$WP_UUID')" > /dev/null
sleep 2
expect_win "Alpha one" 0 100 500 400 300
gjs -m "$here/display.js" all > /dev/null
settle
expect_win "Alpha one" 1 2100 200 400 300

step "lock screen: the extension keeps running, its panel menu and shortcut go away"
ev "Main.sessionMode.pushMode('unlock-dialog')" > /dev/null
sleep 1
expect_eq "state while locked" "$(ev "Main.extensionManager.lookup('$WP_UUID').state")" "1"
expect_eq "indicator while locked" "$(ev "String(Boolean(Main.panel.statusArea['$WP_UUID']))")" '"false"'
expect_eq "shortcut while locked" "$(ev "String(Boolean(Main.wm._allowedKeybindings['pin-window']))")" '"false"'
gjs -m "$here/display.js" only Meta-0 > /dev/null
settle
expect_win "Alpha one" 0 100 500 400 300
gjs -m "$here/display.js" all > /dev/null
settle
ev "Main.sessionMode.popMode('unlock-dialog')" > /dev/null
sleep 1
expect_eq "indicator after unlock" "$(ev "String(Boolean(Main.panel.statusArea['$WP_UUID']))")" '"true"'
expect_eq "shortcut after unlock" "$(ev "String(Boolean(Main.wm._allowedKeybindings['pin-window']))")" '"true"'
expect_win "Alpha one" 1 2100 200 400 300

step "panel menu builds and lists the pins of this setup"
labels=$(ev "(() => { const i = Main.panel.statusArea['$WP_UUID']; i.menu.open(false); const t = [];
  const walk = a => { if (a instanceof imports.gi.St.Label && a.text) t.push(a.text); a.get_children().forEach(walk); };
  walk(i.menu.box); i.menu.close(false); return JSON.stringify(t); })()")
echo "   menu: $labels"
[[ $labels == *'Alpha two'* && $labels == *'Pin this window here'* && $labels == *'Remember closed windows'* ]] &&
    echo "   ok: menu content" || { echo "   FAIL: menu content"; fails=$((fails + 1)); }

step "rename the setup, give it back its default name, remove a pin"
ev "$ENGINE.renameSetup($ENGINE.currentSetup.key, 'Office')" > /dev/null
expect_eq "renamed" "$(setup_name)" '"Office"'
ev "$ENGINE.renameSetup($ENGINE.currentSetup.key, '  ')" > /dev/null
expect_eq "default name back" "$(setup_name)" '"2 monitors"'
ev "$ENGINE.removePin($ENGINE.pinsFor($ENGINE.currentSetup.key).find(p => p.wmClass === 'org.example.Beta').id)" > /dev/null
expect_eq "pins left" "$(ev "$ENGINE.pinsFor($ENGINE.currentSetup.key).map(p => p.title).join(',')")" '"Alpha two"'

step "state file"
state="$work/config/window-pins/state.json"
python3 -I -c '
import json, sys
s = json.load(open(sys.argv[1]))
print("   setups:", sorted(v["name"] for v in s["setups"].values()))
print("   pins:", [(p["wmClass"], p["title"]) for p in s["pins"]])
print("   remember:", list(s["remember"]), "closed:", {k: len(v) for k, v in s["closed"].items()})
print("   open windows:", len(s["openWindows"]))
' "$state" || fails=$((fails + 1))

echo
echo "journal (debug log):"
journal | tail -n "${WP_JOURNAL_LINES:-40}"
grep -a -E 'JS ERROR|JS WARNING|TypeError|ReferenceError' "$work/shell.log" | grep -v -E 'NM.Object|Gvc' | head -5

echo
if ((fails)); then
    echo "e2e: $fails check(s) failed"
    exit 1
fi
echo "e2e: all checks passed"
