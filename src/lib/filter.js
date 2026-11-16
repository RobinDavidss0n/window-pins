// Which windows are app windows worth placing. No Shell imports.

// The desktop icons extension (DING) draws the desktop in ordinary
// toplevel windows; they must never be moved.
const DESKTOP_ICON_APP_IDS = new Set(['com.rastersoft.ding', 'com.rastersoft.dingtest']);

/**
 * @param {object} w
 * @param {boolean} w.normalType window type is Meta.WindowType.NORMAL
 * @param {boolean} w.overrideRedirect
 * @param {boolean} w.skipTaskbar
 * @param {boolean} w.transient has a transient-for parent (a dialog)
 * @param {string|null} w.wmClass
 * @param {string|null} w.gtkAppId
 * @param {string|null} w.title
 * @returns {boolean}
 */
export function isAppWindow(w) {
    if (!w.normalType || w.overrideRedirect || w.skipTaskbar || w.transient)
        return false;
    if (DESKTOP_ICON_APP_IDS.has(w.wmClass ?? '') || DESKTOP_ICON_APP_IDS.has(w.gtkAppId ?? ''))
        return false;
    // DING marks its windows with a title starting with "@!".
    if ((w.title ?? '').startsWith('@!'))
        return false;
    return true;
}
