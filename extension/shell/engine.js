// The core: follows windows and the monitor layout, records where windows
// are per setup, and places windows on pins and remembered spots.
//
// It never corrects a window after placing it: a window is placed once
// when it opens, and once per switch to another setup. Moves by the user,
// GNOME or other extensions in between are recorded, not undone.

import GLib from 'gi://GLib';

import {decideNewWindow, planRestore} from '../lib/matching.js';
import {defaultSetupName} from '../lib/setup.js';
import {
    addClosedEntries, closeStaleOpenWindows, heldPinIds, newPinId, normalizeState, pruneState,
} from '../lib/state.js';
import {
    MonitorSettler, QuietTimer, RECORD_DEBOUNCE_MS, SAVE_DEBOUNCE_MS,
    TITLE_MAX_WAIT_MS, TITLE_QUIET_MS,
} from '../lib/timing.js';
import {readLayout, refreshWorkAreas} from './monitors.js';
import {shellInstanceId} from './store.js';
import {
    applySpot, appNameOf, describeSpot, isTrackable, readSpot, windowKey,
} from './windows.js';

const timers = {
    add(ms, fn) {
        const handle = {id: 0};
        handle.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            handle.id = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
        return handle;
    },
    remove(handle) {
        if (handle.id)
            GLib.source_remove(handle.id);
        handle.id = 0;
    },
};

function describeWindow(win) {
    return `${win.get_wm_class() ?? '?'} "${win.get_title() ?? ''}" (#${win.get_stable_sequence()})`;
}

/**
 * @typedef {object} Entry a window being followed
 * @property {Meta.Window} win
 * @property {string} key
 * @property {'waiting'|'tracked'} phase waiting: new, its title not settled
 *   yet and not placed; tracked: placed (or left alone) and recorded
 * @property {boolean} ready waiting window whose title settled while the
 *   monitor layout was changing
 * @property {boolean} grabbed the user moved or resized it before it was
 *   placed
 * @property {QuietTimer|null} waiter
 * @property {QuietTimer} recordTimer
 * @property {number[]} signalIds
 * @property {number} shownId
 */

export class Engine {
    /**
     * @param {object} args
     * @param {import('./store.js').Store} args.store
     * @param {import('./log.js').Logger} args.logger
     */
    constructor({store, logger}) {
        this._store = store;
        this._log = logger;
        /** @type {Map<string, Entry>} */
        this._windows = new Map();
        this._lastFocusedKey = null;
        this._globalSignals = [];
    }

    enable() {
        const instance = shellInstanceId();
        this._state = normalizeState(this._store.load());
        const sameInstance = this._state.shellInstance === instance;
        // Windows of an earlier shell process (before logout or reboot)
        // are gone; their sequence numbers mean nothing now.
        if (!sameInstance)
            closeStaleOpenWindows(this._state, Date.now());
        this._state.shellInstance = instance;
        const previousKey = this._state.lastSetupKey;

        this._settler = new MonitorSettler(timers, {
            onStart: () => this._onSettleStart(),
            onSettled: () => this._restore('monitor layout settled'),
        });
        this._saveTimer = new QuietTimer(timers, {
            quiet: SAVE_DEBOUNCE_MS,
            onDone: () => this._saveNow(),
        });

        this._layout = readLayout();
        const setup = this._registerSetup(this._layout);
        this._log.debug(`enabled in setup "${setup.name}" [${this._layout.key}]`);

        for (const win of global.display.list_all_windows())
            this._track(win, 'tracked');
        // Memory of windows from an earlier enable that are gone now, or
        // whose sequence number now belongs to another app.
        for (const [key, entry] of this._windows) {
            const mem = this._state.openWindows[key];
            if (mem?.wmClass && mem.wmClass !== entry.win.get_wm_class())
                this._state.openWindows[key] = this._newMemory(entry.win);
        }
        pruneState(this._state, {now: Date.now(), liveKeys: new Set(this._windows.keys())});

        const manager = global.backend.get_monitor_manager();
        this._connect(manager, 'monitors-changing', () => this._onMonitorsChanging());
        this._connect(manager, 'monitors-changed', () => this._settler.poke());
        this._connect(global.display, 'window-created', (_d, win) => this._track(win, 'waiting'));
        this._connect(global.display, 'workareas-changed', () => {
            if (!this._settler.settling)
                refreshWorkAreas(this._layout);
        });
        // A new window the user starts moving or resizing before it is
        // placed stays where the user puts it.
        this._connect(global.display, 'grab-op-begin', (_d, win) => {
            const entry = win ? this._windows.get(windowKey(win)) : null;
            if (entry?.phase === 'waiting')
                entry.grabbed = true;
        });
        this._connect(global.display, 'notify::focus-window', () => {
            const win = global.display.focus_window;
            if (win && this._windows.has(windowKey(win)))
                this._lastFocusedKey = windowKey(win);
        });

        // The layout changed while the extension was off (it is off only
        // between sessions, or when it is turned off or updated).
        if (sameInstance && previousKey && previousKey !== this._layout.key)
            this._restore('setup changed while the extension was off');
        this._state.lastSetupKey = this._layout.key;
        this._saveSoon();
    }

    disable() {
        if (!this._settler.settling)
            this._snapshot('extension disabled');
        this._settler.cancel();
        for (const [object, id] of this._globalSignals)
            object.disconnect(id);
        this._globalSignals = [];
        this._saveNow();
        for (const entry of [...this._windows.values()])
            this._untrack(entry);
        this._saveTimer.cancel();
    }

    // --- Following windows -------------------------------------------------

    _connect(object, signal, handler) {
        this._globalSignals.push([object, object.connect(signal, handler)]);
    }

    _newMemory(win) {
        return {
            wmClass: win.get_wm_class(),
            title: win.get_title(),
            lastSeen: Date.now(),
            spots: {},
            pins: {},
        };
    }

    _memoryOf(entry) {
        let mem = this._state.openWindows[entry.key];
        if (!mem) {
            mem = this._newMemory(entry.win);
            this._state.openWindows[entry.key] = mem;
        }
        return mem;
    }

    /**
     * Start following a window. 'waiting' is for new windows: they are
     * placed once their title has settled after they are first shown.
     */
    _track(win, phase) {
        if (!isTrackable(win))
            return null;
        const key = windowKey(win);
        if (this._windows.has(key))
            return this._windows.get(key);

        /** @type {Entry} */
        const entry = {
            win, key, phase, ready: false, grabbed: false, waiter: null, shownId: 0,
        };
        entry.recordTimer = new QuietTimer(timers, {
            quiet: RECORD_DEBOUNCE_MS,
            onDone: () => this._record(entry),
        });
        const recordSoon = () => this._recordSoon(entry);
        entry.signalIds = [
            win.connect('position-changed', recordSoon),
            win.connect('size-changed', recordSoon),
            win.connect('workspace-changed', recordSoon),
            win.connect('notify::maximized-horizontally', recordSoon),
            win.connect('notify::maximized-vertically', recordSoon),
            win.connect('notify::fullscreen', recordSoon),
            win.connect('notify::title', () => {
                if (entry.waiter?.active)
                    entry.waiter.poke();
            }),
            win.connect('unmanaging', () => this._onUnmanaging(entry)),
        ];
        if (phase === 'waiting') {
            entry.waiter = new QuietTimer(timers, {
                quiet: TITLE_QUIET_MS,
                max: TITLE_MAX_WAIT_MS,
                onDone: () => this._onTitleSettled(entry),
            });
            entry.shownId = win.connect('shown', () => {
                win.disconnect(entry.shownId);
                entry.shownId = 0;
                entry.waiter.poke();
            });
        }
        this._windows.set(key, entry);
        this._memoryOf(entry);
        return entry;
    }

    _untrack(entry) {
        entry.waiter?.cancel();
        entry.recordTimer.cancel();
        for (const id of entry.signalIds)
            entry.win.disconnect(id);
        if (entry.shownId)
            entry.win.disconnect(entry.shownId);
        this._windows.delete(entry.key);
    }

    _liveKeys() {
        return new Set(this._windows.keys());
    }

    _trackedEntries() {
        return [...this._windows.values()]
            .filter(e => e.phase === 'tracked')
            .sort((a, b) => a.win.get_stable_sequence() - b.win.get_stable_sequence());
    }

    // --- Recording ------------------------------------------------------------

    _recordSoon(entry) {
        if (entry.phase !== 'tracked' || this._settler.settling)
            return;
        entry.recordTimer.poke();
    }

    /** Record where the window is now, for the current setup. */
    _record(entry, force = false) {
        if (entry.phase !== 'tracked' || (this._settler.settling && !force))
            return;
        const mem = this._memoryOf(entry);
        const setupKey = this._layout.key;
        const previous = mem.spots[setupKey] ?? null;
        const spot = readSpot(entry.win, this._layout, previous);
        if (!spot)
            return;
        mem.spots[setupKey] = {...spot, at: Date.now()};
        mem.wmClass = entry.win.get_wm_class();
        mem.title = entry.win.get_title();
        mem.lastSeen = Date.now();
        this._log.debug(`recorded ${describeWindow(entry.win)} at ${describeSpot(spot, this._layout)}`);
        this._saveSoon();
    }

    /** Record all windows at once, using the layout they are placed on. */
    _snapshot(reason) {
        this._log.debug(`recording all windows (${reason})`);
        for (const entry of this._trackedEntries()) {
            entry.recordTimer.cancel();
            this._record(entry, true);
        }
    }

    // --- Monitor layout changes ---------------------------------------------

    // Mutter emits monitors-changing after it has worked out the new layout
    // but before it moves windows off monitors that are gone, so this is
    // the last moment the windows are where the user had them.
    _onMonitorsChanging() {
        if (!this._settler.settling)
            this._snapshot('monitor layout about to change');
        this._settler.poke();
    }

    _onSettleStart() {
        this._log.debug('monitor layout changing; recording paused');
        for (const entry of this._windows.values())
            entry.recordTimer.cancel();
    }

    /**
     * Put open windows back where they were in the current setup, and
     * pinned windows on their pins.
     */
    _restore(reason) {
        const oldKey = this._layout.key;
        this._layout = readLayout();
        const setupKey = this._layout.key;
        const setup = this._registerSetup(this._layout);
        this._log.debug(`${reason}: ${oldKey === setupKey ? 'still in' : 'switched to'} ` +
            `setup "${setup.name}" [${setupKey}]`);

        const entries = this._trackedEntries();
        const windows = entries.map(entry => {
            const mem = this._memoryOf(entry);
            return {
                key: entry.key,
                wmClass: entry.win.get_wm_class(),
                title: entry.win.get_title(),
                spot: mem.spots[setupKey] ?? null,
                heldPinId: mem.pins[setupKey] ?? null,
            };
        });
        const plan = planRestore(windows, this._pinsFor(setupKey));
        for (const item of plan) {
            const entry = this._windows.get(item.key);
            if (item.kind === 'pin')
                this._memoryOf(entry).pins[setupKey] = item.pin.id;
            const result = applySpot(entry.win, item.spot, this._layout);
            const why = item.kind === 'pin' ? 'its pin' : 'where it was last in this setup';
            this._log.debug(`${result}: ${describeWindow(entry.win)} -> ` +
                `${describeSpot(item.spot, this._layout)} (${why})`);
        }
        this._log.debug(`${entries.length - plan.length} window(s) without a spot in this setup left alone`);

        // New windows whose title settled while the layout was changing.
        for (const entry of [...this._windows.values()]) {
            if (entry.phase === 'waiting' && entry.ready)
                this._placeNew(entry);
        }

        // Record every window in the new setup once its moves have landed,
        // so windows the user never moves here still come back here.
        for (const entry of this._trackedEntries())
            this._recordSoon(entry);
        this._state.lastSetupKey = setupKey;
        this._saveSoon();
    }

    _registerSetup(layout) {
        let setup = this._state.setups[layout.key];
        const monitors = layout.physical.map(p => ({id: p.id, label: p.label, builtin: p.builtin}));
        if (!setup) {
            const taken = Object.values(this._state.setups).map(s => s.name);
            setup = {
                name: defaultSetupName(layout.physical, taken),
                named: false,
                monitors,
                lastSeen: Date.now(),
            };
            this._state.setups[layout.key] = setup;
            this._log.debug(`new setup "${setup.name}" [${layout.key}]`);
        } else {
            setup.monitors = monitors;
            setup.lastSeen = Date.now();
        }
        return setup;
    }

    // --- New windows ------------------------------------------------------------

    _onTitleSettled(entry) {
        if (this._settler.settling) {
            entry.ready = true;
            return;
        }
        this._placeNew(entry);
    }

    _placeNew(entry) {
        entry.ready = false;
        const win = entry.win;
        if (!isTrackable(win)) {
            // Turned out to be a dialog or a skip-taskbar window.
            this._untrack(entry);
            delete this._state.openWindows[entry.key];
            return;
        }
        entry.phase = 'tracked';
        entry.waiter = null;

        if (entry.grabbed) {
            this._log.debug(`new ${describeWindow(win)}: left alone, the user moved or resized it first`);
            this._recordSoon(entry);
            this._saveSoon();
            return;
        }

        const setupKey = this._layout.key;
        const wmClass = win.get_wm_class();
        const decision = decideNewWindow({
            window: {key: entry.key, wmClass, title: win.get_title()},
            pins: this._pinsFor(setupKey),
            held: heldPinIds(this._state, setupKey, this._liveKeys(), entry.key),
            remember: Boolean(wmClass && this._state.remember[wmClass]),
            closed: (wmClass && this._state.closed[wmClass]) || [],
            setupKey,
        });
        if (decision?.kind === 'pin') {
            this._memoryOf(entry).pins[setupKey] = decision.pin.id;
            const result = applySpot(win, decision.pin, this._layout);
            const how = decision.pin.title === win.get_title() ? 'same title' : 'first free pin of the app';
            this._log.debug(`new ${describeWindow(win)}: ${result} -> ` +
                `${describeSpot(decision.pin, this._layout)} (pin "${decision.pin.title}", ${how})`);
        } else if (decision?.kind === 'closed') {
            const result = applySpot(win, decision.entry, this._layout);
            this._log.debug(`new ${describeWindow(win)}: ${result} -> ` +
                `${describeSpot(decision.entry, this._layout)} ` +
                `(closed window "${decision.entry.title}")`);
        } else {
            this._log.debug(`new ${describeWindow(win)}: no pin or remembered spot, left where it opened`);
        }
        this._recordSoon(entry);
        this._saveSoon();
    }

    _onUnmanaging(entry) {
        const win = entry.win;
        if (entry.recordTimer.active && !this._settler.settling) {
            entry.recordTimer.cancel();
            this._record(entry);
        }
        const mem = this._state.openWindows[entry.key];
        const wmClass = mem?.wmClass ?? win.get_wm_class();
        let urgent = false;
        if (mem && wmClass && this._state.remember[wmClass] && Object.keys(mem.spots).length) {
            addClosedEntries(this._state, wmClass, win.get_title() ?? mem.title, mem.spots, Date.now());
            this._log.debug(`closed ${describeWindow(win)}: remembered its spots in ` +
                `${Object.keys(mem.spots).length} setup(s)`);
            // Closing often comes right before logout; write at once.
            urgent = true;
        }
        this._untrack(entry);
        delete this._state.openWindows[entry.key];
        if (urgent)
            this._saveNow();
        else
            this._saveSoon();
    }

    // --- Saving -----------------------------------------------------------------

    _saveSoon() {
        this._saveTimer.poke();
    }

    _saveNow() {
        this._saveTimer.cancel();
        pruneState(this._state, {now: Date.now(), liveKeys: this._liveKeys()});
        this._store.save(this._state);
    }

    // --- For the menu and the shortcut ------------------------------------

    _pinsFor(setupKey) {
        return this._state.pins.filter(p => p.setupKey === setupKey);
    }

    /** @returns {{key: string, name: string}} */
    get currentSetup() {
        const key = this._layout.key;
        return {key, name: this._state.setups[key]?.name ?? key};
    }

    /** @returns {boolean} the monitor layout is changing right now */
    get settling() {
        return this._settler.settling;
    }

    /** Pins of a setup, oldest first. */
    pinsFor(setupKey) {
        return this._pinsFor(setupKey);
    }

    /** Other known setups that have pins: [{key, name, pins}]. */
    otherSetupsWithPins() {
        const current = this._layout.key;
        return Object.entries(this._state.setups)
            .filter(([key]) => key !== current)
            .map(([key, s]) => ({key, name: s.name, pins: this._pinsFor(key)}))
            .filter(s => s.pins.length > 0);
    }

    /** The window "pin this window" acts on: the focused app window. */
    focusedWindow() {
        const focus = global.display.focus_window;
        if (focus && isTrackable(focus))
            return focus;
        return this._windows.get(this._lastFocusedKey)?.win ?? null;
    }

    /**
     * Pin a window where it is now, in the current setup. A window that
     * already holds a pin in this setup moves that pin instead of getting
     * a second one.
     *
     * @returns {object|null} the pin, or null when the window cannot be pinned
     */
    pinWindow(win) {
        if (!win || this._settler.settling || !isTrackable(win))
            return null;
        const wmClass = win.get_wm_class();
        if (!wmClass)
            return null;
        const entry = this._track(win, 'tracked');
        if (entry.phase === 'waiting') {
            // Pinned before it was placed: it stays where the user has it.
            entry.waiter.cancel();
            if (entry.shownId)
                win.disconnect(entry.shownId);
            entry.shownId = 0;
            entry.waiter = null;
            entry.phase = 'tracked';
        }
        const setupKey = this._layout.key;
        const mem = this._memoryOf(entry);
        const spot = readSpot(win, this._layout, mem.spots[setupKey] ?? null);
        if (!spot)
            return null;

        const now = Date.now();
        const fields = {wmClass, appName: appNameOf(win), title: win.get_title() ?? '', ...spot};
        let pin = this._state.pins.find(p => p.id === mem.pins[setupKey]);
        if (pin) {
            Object.assign(pin, fields);
        } else {
            let id = newPinId(now);
            while (this._state.pins.some(p => p.id === id))
                id = newPinId(now);
            pin = {id, ...fields, setupKey, created: now};
            this._state.pins.push(pin);
            mem.pins[setupKey] = pin.id;
        }
        mem.spots[setupKey] = {...spot, at: now};
        this._log.debug(`pinned ${describeWindow(win)} at ${describeSpot(spot, this._layout)} ` +
            `in setup "${this.currentSetup.name}"`);
        this._saveNow();
        return pin;
    }

    removePin(id) {
        const pin = this._state.pins.find(p => p.id === id);
        if (!pin)
            return;
        this._state.pins = this._state.pins.filter(p => p.id !== id);
        this._log.debug(`removed pin ${pin.wmClass} "${pin.title}"`);
        this._saveNow();
    }

    /** Rename a setup; an empty name gives it back its default name. */
    renameSetup(setupKey, name) {
        const setup = this._state.setups[setupKey];
        if (!setup)
            return;
        const trimmed = name.trim();
        if (trimmed) {
            setup.name = trimmed;
            setup.named = true;
        } else {
            const taken = Object.entries(this._state.setups)
                .filter(([key]) => key !== setupKey).map(([, s]) => s.name);
            setup.name = defaultSetupName(setup.monitors, taken);
            setup.named = false;
        }
        this._saveNow();
    }

    /**
     * Apps for the "remember closed windows" switches: apps with open
     * windows and apps already switched on, by name.
     *
     * @returns {Array<{wmClass: string, appName: string, on: boolean}>}
     */
    rememberChoices() {
        const apps = new Map();
        for (const [wmClass, r] of Object.entries(this._state.remember))
            apps.set(wmClass, {wmClass, appName: r.appName, on: true});
        for (const entry of this._windows.values()) {
            const wmClass = entry.win.get_wm_class();
            if (wmClass && !apps.has(wmClass))
                apps.set(wmClass, {wmClass, appName: appNameOf(entry.win), on: false});
        }
        return [...apps.values()].sort((a, b) => a.appName.localeCompare(b.appName));
    }

    setRemember(wmClass, appName, on) {
        if (on) {
            this._state.remember[wmClass] = {appName};
        } else {
            delete this._state.remember[wmClass];
            delete this._state.closed[wmClass];
        }
        this._log.debug(`remember closed windows of ${wmClass}: ${on ? 'on' : 'off'}`);
        this._saveNow();
    }
}
