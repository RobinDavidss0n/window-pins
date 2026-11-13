// The saved state: its shape, loading it defensively, and pruning it.
// No Shell imports: testable outside the shell.
//
// {
//   version: 1,
//   shellInstance: string,        // which gnome-shell process wrote openWindows
//   lastSetupKey: string|null,
//   setups: {[setupKey]: {name, named: bool, monitors: [{id, label, builtin}],
//            lastSeen}},
//   pins: [{id, wmClass, appName, title, setupKey, monitor, workspace, rect,
//           maximized, fullscreen, created}],
//   remember: {[wmClass]: {appName}},           // apps with the toggle on
//   closed: {[wmClass]: [{title, setupKey, monitor, workspace, rect,
//                         maximized, fullscreen, closedAt}]},
//   openWindows: {[stableSequence]: {wmClass, title, lastSeen,
//                 spots: {[setupKey]: spot}, pins: {[setupKey]: pinId}}},
// }

export const STATE_VERSION = 1;

/** Closed-window spots older than this are dropped. */
export const CLOSED_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export function emptyState() {
    return {
        version: STATE_VERSION,
        shellInstance: '',
        lastSetupKey: null,
        setups: {},
        pins: [],
        remember: {},
        closed: {},
        openWindows: {},
    };
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = v => typeof v === 'string';
const isNumber = v => typeof v === 'number' && Number.isFinite(v);

function validRect(r) {
    return isObject(r) && ['x', 'y', 'width', 'height', 'areaWidth', 'areaHeight']
        .every(k => isNumber(r[k]));
}

/**
 * A spot from untrusted JSON, or null if unusable.
 *
 * @param {any} s
 * @returns {object|null}
 */
export function normalizeSpot(s) {
    if (!isObject(s) || !isString(s.monitor) || !validRect(s.rect))
        return null;
    return {
        monitor: s.monitor,
        workspace: isNumber(s.workspace) ? Math.trunc(s.workspace) : -1,
        rect: {...s.rect},
        maximized: isNumber(s.maximized) ? s.maximized & 3 : 0,
        fullscreen: s.fullscreen === true,
    };
}

/** Copy of the spot fields of a spot, pin or closed entry. */
export function spotOf(s) {
    return {
        monitor: s.monitor,
        workspace: s.workspace,
        rect: {...s.rect},
        maximized: s.maximized,
        fullscreen: s.fullscreen,
    };
}

/**
 * Build a valid state from parsed JSON, dropping anything malformed.
 *
 * @param {any} raw
 * @returns {object}
 */
export function normalizeState(raw) {
    const state = emptyState();
    if (!isObject(raw))
        return state;

    if (isString(raw.shellInstance))
        state.shellInstance = raw.shellInstance;
    if (isString(raw.lastSetupKey))
        state.lastSetupKey = raw.lastSetupKey;

    if (isObject(raw.setups)) {
        for (const [key, s] of Object.entries(raw.setups)) {
            if (!isObject(s) || !isString(s.name))
                continue;
            state.setups[key] = {
                name: s.name,
                named: s.named === true,
                monitors: Array.isArray(s.monitors)
                    ? s.monitors.filter(m => isObject(m) && isString(m.id))
                        .map(m => ({
                        id: m.id,
                        label: isString(m.label) ? m.label : m.id,
                        builtin: m.builtin === true,
                    }))
                    : [],
                lastSeen: isNumber(s.lastSeen) ? s.lastSeen : 0,
            };
        }
    }

    if (Array.isArray(raw.pins)) {
        const ids = new Set();
        for (const p of raw.pins) {
            const spot = normalizeSpot(p);
            if (!spot || !isString(p.id) || ids.has(p.id) || !isString(p.wmClass) ||
                !isString(p.setupKey))
                continue;
            ids.add(p.id);
            state.pins.push({
                id: p.id,
                wmClass: p.wmClass,
                appName: isString(p.appName) ? p.appName : p.wmClass,
                title: isString(p.title) ? p.title : '',
                setupKey: p.setupKey,
                ...spot,
                created: isNumber(p.created) ? p.created : 0,
            });
        }
    }

    if (isObject(raw.remember)) {
        for (const [wmClass, r] of Object.entries(raw.remember)) {
            state.remember[wmClass] = {
                appName: isObject(r) && isString(r.appName) ? r.appName : wmClass,
            };
        }
    }

    if (isObject(raw.closed)) {
        for (const [wmClass, list] of Object.entries(raw.closed)) {
            if (!Array.isArray(list))
                continue;
            const entries = [];
            for (const e of list) {
                const spot = normalizeSpot(e);
                if (!spot || !isString(e.setupKey) || !isNumber(e.closedAt))
                    continue;
                entries.push({
                    title: isString(e.title) ? e.title : '',
                    setupKey: e.setupKey,
                    ...spot,
                    closedAt: e.closedAt,
                });
            }
            if (entries.length)
                state.closed[wmClass] = entries;
        }
    }

    if (isObject(raw.openWindows)) {
        for (const [key, w] of Object.entries(raw.openWindows)) {
            if (!isObject(w))
                continue;
            const spots = {};
            if (isObject(w.spots)) {
                for (const [setupKey, s] of Object.entries(w.spots)) {
                    const spot = normalizeSpot(s);
                    if (spot)
                        spots[setupKey] = {...spot, at: isNumber(s.at) ? s.at : 0};
                }
            }
            const pins = {};
            if (isObject(w.pins)) {
                for (const [setupKey, pinId] of Object.entries(w.pins)) {
                    if (isString(pinId))
                        pins[setupKey] = pinId;
                }
            }
            state.openWindows[key] = {
                wmClass: isString(w.wmClass) ? w.wmClass : null,
                title: isString(w.title) ? w.title : null,
                lastSeen: isNumber(w.lastSeen) ? w.lastSeen : 0,
                spots,
                pins,
            };
        }
    }
    return state;
}

/**
 * Drop what is no longer needed: closed-window spots older than
 * CLOSED_MAX_AGE_MS or of apps whose toggle is off, open-window entries
 * of windows that no longer exist, and pin holdings of removed pins.
 *
 * @param {object} state modified in place
 * @param {object} args
 * @param {number} args.now
 * @param {Set<string>|null} args.liveKeys keys of the open windows, or
 *   null to keep all open-window entries
 * @returns {object} state
 */
export function pruneState(state, {now, liveKeys = null}) {
    for (const [wmClass, list] of Object.entries(state.closed)) {
        const kept = state.remember[wmClass]
            ? list.filter(e => now - e.closedAt <= CLOSED_MAX_AGE_MS)
            : [];
        if (kept.length)
            state.closed[wmClass] = kept;
        else
            delete state.closed[wmClass];
    }

    const pinIds = new Set(state.pins.map(p => p.id));
    for (const [key, w] of Object.entries(state.openWindows)) {
        if (liveKeys && !liveKeys.has(key)) {
            delete state.openWindows[key];
            continue;
        }
        for (const [setupKey, pinId] of Object.entries(w.pins)) {
            if (!pinIds.has(pinId))
                delete w.pins[setupKey];
        }
    }
    return state;
}

/**
 * Remember the spots of a closing window for its app. Keeps one entry per
 * title and setup (the newest), since only the newest is ever used.
 *
 * @param {object} state modified in place
 * @param {string} wmClass
 * @param {string|null} title
 * @param {{[setupKey: string]: object}} spots
 * @param {number} now
 */
export function addClosedEntries(state, wmClass, title, spots, now) {
    const list = state.closed[wmClass] ?? [];
    const t = title ?? '';
    for (const [setupKey, spot] of Object.entries(spots)) {
        const i = list.findIndex(e => e.setupKey === setupKey && e.title === t);
        if (i >= 0)
            list.splice(i, 1);
        list.push({title: t, setupKey, ...spotOf(spot), closedAt: now});
    }
    if (list.length)
        state.closed[wmClass] = list;
}

/**
 * Pin ids held by open windows in a setup.
 *
 * @param {object} state
 * @param {string} setupKey
 * @param {Set<string>} liveKeys keys of the windows that count
 * @param {string|null} exceptKey a window to leave out
 * @returns {Set<string>}
 */
export function heldPinIds(state, setupKey, liveKeys, exceptKey = null) {
    const held = new Set();
    for (const [key, w] of Object.entries(state.openWindows)) {
        if (key === exceptKey || !liveKeys.has(key))
            continue;
        const pinId = w.pins[setupKey];
        if (pinId)
            held.add(pinId);
    }
    return held;
}

let pinCounter = 0;

/** A new unique pin id. */
export function newPinId(now) {
    pinCounter = (pinCounter + 1) % 1296;
    return `p${now.toString(36)}${pinCounter.toString(36).padStart(2, '0')}`;
}
