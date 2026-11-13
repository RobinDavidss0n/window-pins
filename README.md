# window-pins

GNOME Shell extension that puts windows back where they were when you
switch between monitor setups, and pins app windows to fixed places per
setup.

- **Monitor setups.** Docking, undocking, plugging in the office or home
  monitors: each set of monitors is a *setup*. When you come back to a
  setup, every open window that has been there before goes back to where
  you last had it in that setup: same monitor, workspace, position, size,
  maximized or fullscreen.
- **Monitors are recognised by what they are, not where they are
  plugged in.** A monitor is identified by the vendor, product and serial
  number in its EDID, never by its connector name (`DP-1`, `HDMI-1`, ...),
  which changes with the dock and the port.
- **Open windows are followed as the windows they are**, not guessed by
  title, so two windows of the same app never swap places.
- **Pins.** "Pin this window here" remembers an app window's place in the
  current setup. A new window of that app opening in that setup goes to
  the pin, and so does the pinned window when you switch back to the
  setup.
- **Remember closed windows** (per app, off by default). For the apps you
  switch it on for, a window that closes leaves its places behind, and
  the next window of that app opens there.

It never fights other extensions or the user: a window is placed once
when it opens and once per switch of setup, and never corrected after
that. Tiling and centering extensions keep working as before.

Requires GNOME Shell 50.

## Install

From a release zip, or one built with `make zip`:

```sh
gnome-extensions install --force window-pins@robindavidss0n.github.io.shell-extension.zip
```

Or, for development, link the source tree (compiles the settings schema
first):

```sh
make link
```

Then log out and back in (on Wayland GNOME Shell only loads new
extensions at login), and enable it:

```sh
gnome-extensions enable window-pins@robindavidss0n.github.io
```

## Using it

The pin icon in the top bar opens the menu:

- **Setup**: the name of the current monitor setup. New setups get a name
  like "Laptop only" or "3 monitors"; type another name and press Enter to
  rename it. An empty name gives back the default.
- **Pin this window here** pins the focused window at its current place,
  for the current setup. Pinning a window that already has a pin in this
  setup moves that pin.
- The pins of the current setup, each with a remove button, and under
  **Pins in other setups** those of the other setups.
- **Remember closed windows**: a switch per app, for apps with open
  windows and apps already switched on.

The shortcut **Super+Ctrl+P** pins the focused window here, like the menu
item, and briefly shows "Pinned", "Pin moved" or "Can't pin this window".

### How windows are placed

When the monitors change (dock, undock, hotplug, resume), window-pins
stops recording, waits until the layout has been quiet for 1.5 s, works
out the new setup, and then:

1. Every open window that has been in this setup before goes back to
   where it was last in it.
2. Other windows that match a pin of this setup go to their pin.
3. All other windows stay where GNOME put them.

Moves GNOME makes while the monitors change are not taken as yours; what
is remembered is where windows were just before the change.

When a new window opens, window-pins waits until its title has settled
(1 s without a change, at most 3 s after it is shown, because browsers and
Electron apps change their title right after opening), so GNOME and other
extensions have placed it first. Then:

1. A pin of this app in this setup with the same title as the window wins.
2. Otherwise the window takes the first pin of the app that no other open
   window holds. Each pin holds at most one window.
3. Without a pin, if the app has "remember closed windows" on: the place
   of a closed window of the app with the same title in this setup,
   otherwise of the app's most recently closed window in this setup.
4. Otherwise it stays where it opened.

A window you start moving or resizing before it is placed is left where
you put it.

Only normal app windows are placed: dialogs, windows that skip the
taskbar, popups and the desktop icons window are ignored.

### Lock screen

GNOME turns extensions off on the lock screen, and docking or undocking
often happens while the screen is locked. window-pins therefore keeps
running on the lock screen (session mode `unlock-dialog`), but only its
window tracking: the panel menu and the shortcut are removed while
locked.

## Files

Everything is kept in `~/.config/window-pins/state.json` (pins, setup
names, the per-app switches, closed-window places, and where open windows
are per setup). It is written atomically, at most every 2 seconds.
Closed-window places older than 60 days, and memory of windows that no
longer exist, are dropped.

## Debug logging

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/window-pins@robindavidss0n.github.io/schemas \
    set org.gnome.shell.extensions.window-pins debug true
journalctl --user -f -o cat | grep '\[window-pins\]'
```

It logs setup changes and which window was moved where and why. The
shortcut is the `pin-window` key in the same schema.

## Development

- `make test` runs the tests of the decision logic (setup keys, matching
  windows to pins and closed windows, rect conversion, settle timing,
  state pruning), which has no GNOME Shell imports, with `gjs`.
- `make test-nested` runs an end-to-end check in a headless GNOME Shell
  on its own D-Bus session, with virtual monitors turned on and off and
  hotplugged, and test windows. It needs `gst-launch-1.0` with the
  PipeWire plugin, and leaves the running session and its settings alone.
- `make zip` builds the zip; `make link` links the source tree for
  development.

## License

MIT
