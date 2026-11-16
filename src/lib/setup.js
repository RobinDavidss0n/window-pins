// Monitor and setup identity. No Shell imports: testable outside the shell.
//
// A monitor is identified by the vendor, product and serial its EDID
// reports, never by its connector name (DP-1, HDMI-1, ...), which changes
// with the dock or port. A setup is the set of active monitors.

const UNKNOWN = '?';

function clean(value) {
    return String(value ?? '').trim();
}

// Laptop panels and some cheap monitors report no serial, or only zeros.
function usefulSerial(serial) {
    const s = clean(serial);
    return s !== '' && !/^(0x)?0*$/i.test(s);
}

/**
 * Identity of one physical monitor from its EDID data.
 *
 * @param {{vendor?: string, product?: string, serial?: string}} monitor
 * @returns {string}
 */
export function monitorBaseId({vendor, product, serial}) {
    const parts = [clean(vendor) || UNKNOWN, clean(product) || UNKNOWN];
    if (usefulSerial(serial))
        parts.push(clean(serial));
    return parts.join(':');
}

/**
 * Ids for all active monitors, in the order given.
 *
 * Two monitors with identical EDID data (same model without a serial)
 * cannot be told apart; they get "#1", "#2", ... in connector order, which
 * is the best that can be done for them.
 *
 * @param {Array<{vendor?: string, product?: string, serial?: string,
 *   connector?: string}>} monitors
 * @returns {string[]}
 */
export function assignMonitorIds(monitors) {
    const base = monitors.map(m => monitorBaseId(m));
    const groups = new Map();
    base.forEach((id, i) => {
        if (!groups.has(id))
            groups.set(id, []);
        groups.get(id).push(i);
    });
    const ids = [...base];
    for (const [id, indexes] of groups) {
        if (indexes.length < 2)
            continue;
        const sorted = [...indexes].sort((a, b) =>
            clean(monitors[a].connector).localeCompare(clean(monitors[b].connector)));
        sorted.forEach((index, n) => {
            ids[index] = `${id}#${n + 1}`;
        });
    }
    return ids;
}

/**
 * Key of a setup: its monitor ids, sorted.
 *
 * @param {string[]} ids
 * @returns {string}
 */
export function setupKeyOf(ids) {
    return [...ids].sort().join(' + ');
}

/**
 * Id of a logical monitor (one area windows are placed on). Normally one
 * physical monitor; when monitors mirror each other, all of them.
 *
 * @param {string[]} memberIds
 * @returns {string}
 */
export function logicalMonitorId(memberIds) {
    return [...memberIds].sort().join(' = ');
}

/**
 * Default name for a setup the user has not named.
 *
 * @param {Array<{builtin?: boolean}>} monitors physical active monitors
 * @param {Iterable<string>} takenNames names of the other known setups
 * @returns {string}
 */
export function defaultSetupName(monitors, takenNames = []) {
    let name;
    if (monitors.length === 1 && monitors[0].builtin)
        name = 'Laptop only';
    else if (monitors.length === 1)
        name = '1 monitor';
    else
        name = `${monitors.length} monitors`;

    const taken = new Set(takenNames);
    if (!taken.has(name))
        return name;
    for (let n = 2; ; n++) {
        const candidate = `${name} (${n})`;
        if (!taken.has(candidate))
            return candidate;
    }
}
