// Deciding where windows go. No Shell imports: testable outside the shell.
//
// A spot is {monitor, workspace, rect, maximized, fullscreen}: monitor is a
// logical monitor id (see setup.js), workspace an index or -1 for "on all
// workspaces", rect relative to the monitor's work area (see geometry.js),
// maximized the Meta.MaximizeFlags bits (0 none, 1 horizontal, 2 vertical,
// 3 both).

function titleWords(title) {
    return (title ?? '').toLowerCase().split(/[\s\-–—|·:,;()[\]{}<>"']+/).filter(Boolean);
}

/**
 * How alike two titles are: the number of words of `title` that also
 * occur in `other` (each word of `other` counts once). Apps put fixed
 * parts in their titles, such as the vault or account and the app's name
 * ("NOTE - RD - work - Obsidian 1.15.1", "Gmail - Inbox (3) - name@work
 * - Work Mail"), around a part that changes (the note, the mail); the
 * fixed parts are what two titles of the same window share.
 *
 * @param {string|null} title
 * @param {string|null} other
 * @returns {number}
 */
export function titleSimilarity(title, other) {
    const counts = new Map();
    for (const word of titleWords(other))
        counts.set(word, (counts.get(word) ?? 0) + 1);
    let shared = 0;
    for (const word of titleWords(title)) {
        const n = counts.get(word) ?? 0;
        if (n > 0) {
            shared++;
            counts.set(word, n - 1);
        }
    }
    return shared;
}

/**
 * The item whose title is most like `title`; the first one on a tie.
 *
 * @param {Array<{title: string}>} items
 * @param {string|null} title
 * @returns {object|null}
 */
export function mostSimilar(items, title) {
    let best = null;
    let bestScore = -1;
    for (const item of items) {
        const score = titleSimilarity(title, item.title);
        if (score > bestScore) {
            best = item;
            bestScore = score;
        }
    }
    return best;
}

/**
 * Match windows to pins of one setup.
 *
 * A pin whose title equals the window's title wins. A window without such
 * a pin takes the pin of its app (by wm_class) that no window holds yet
 * and whose title is most like the window's (see titleSimilarity); on a
 * tie, the oldest. Each pin is held by at most one window.
 *
 * Exact titles are matched for all windows before any falls back, so an
 * earlier window cannot take the pin a later window matches by title.
 *
 * @param {Array<{key: string, wmClass: string|null, title: string|null}>} windows
 *   in the order they should get fallback pins (oldest first)
 * @param {Array<{id: string, wmClass: string, title: string}>} pins
 *   pins of the setup, in the order they were made
 * @param {Set<string>} held ids of pins other windows already hold
 * @returns {Map<string, object>} window key -> pin
 */
export function assignPins(windows, pins, held = new Set()) {
    const result = new Map();
    const taken = new Set(held);
    const take = (w, pin) => {
        result.set(w.key, pin);
        taken.add(pin.id);
    };

    for (const w of windows) {
        if (!w.wmClass)
            continue;
        const pin = pins.find(p => !taken.has(p.id) &&
            p.wmClass === w.wmClass && p.title === w.title);
        if (pin)
            take(w, pin);
    }
    for (const w of windows) {
        if (!w.wmClass || result.has(w.key))
            continue;
        const pin = mostSimilar(pins.filter(p => !taken.has(p.id) && p.wmClass === w.wmClass), w.title);
        if (pin)
            take(w, pin);
    }
    return result;
}

/**
 * Pick the remembered spot of a closed window for a new window of the
 * same app: the most recent one with the same title in this setup,
 * otherwise the one in this setup with the most similar title (see
 * titleSimilarity), the most recently closed on a tie.
 *
 * @param {Array<{title: string, setupKey: string, closedAt: number}>} entries
 *   closed-window entries of the app
 * @param {string|null} title
 * @param {string} setupKey
 * @returns {object|null}
 */
export function chooseClosedSpot(entries, title, setupKey) {
    const inSetup = entries
        .filter(e => e.setupKey === setupKey)
        .sort((a, b) => b.closedAt - a.closedAt);
    return inSetup.find(e => e.title === title) ?? mostSimilar(inSetup, title);
}

/**
 * Where a newly opened window goes, if anywhere.
 *
 * @param {object} args
 * @param {{key: string, wmClass: string|null, title: string|null}} args.window
 * @param {Array<object>} args.pins pins of the current setup
 * @param {Set<string>} args.held ids of pins held by other open windows
 * @param {boolean} args.remember the app has "remember closed windows" on
 * @param {Array<object>} args.closed closed-window entries of the app
 * @param {string} args.setupKey
 * @returns {{kind: 'pin', pin: object} | {kind: 'closed', entry: object} | null}
 */
export function decideNewWindow({window, pins, held, remember, closed, setupKey}) {
    const pin = assignPins([window], pins, held).get(window.key);
    if (pin)
        return {kind: 'pin', pin};
    if (remember && window.wmClass) {
        const entry = chooseClosedSpot(closed ?? [], window.title, setupKey);
        if (entry)
            return {kind: 'closed', entry};
    }
    return null;
}

/**
 * Where open windows go after switching to a setup.
 *
 * A window that has been in this setup before goes back to where it was
 * last. Otherwise, a window that holds a pin of this setup goes to it, and
 * the remaining windows are matched to the free pins (see assignPins).
 * Windows with neither are left where they are.
 *
 * @param {Array<{key: string, wmClass: string|null, title: string|null,
 *   spot: object|null, heldPinId: string|null}>} windows oldest first;
 *   spot is the remembered spot for this setup, heldPinId the pin the
 *   window holds in this setup
 * @param {Array<object>} pins pins of the setup
 * @returns {Array<{key: string, kind: 'remembered'|'pin', spot: object,
 *   pin?: object}>}
 */
export function planRestore(windows, pins) {
    const byId = new Map(pins.map(p => [p.id, p]));
    const plan = [];
    const held = new Set();
    const unmatched = [];

    for (const w of windows) {
        const heldPin = w.heldPinId ? byId.get(w.heldPinId) : null;
        if (heldPin)
            held.add(heldPin.id);
        if (w.spot)
            plan.push({key: w.key, kind: 'remembered', spot: w.spot});
        else if (heldPin)
            plan.push({key: w.key, kind: 'pin', spot: heldPin, pin: heldPin});
        else
            unmatched.push(w);
    }

    const assigned = assignPins(unmatched, pins, held);
    for (const w of unmatched) {
        const pin = assigned.get(w.key);
        if (pin)
            plan.push({key: w.key, kind: 'pin', spot: pin, pin});
    }
    return plan;
}
