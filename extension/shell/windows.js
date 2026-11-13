// Reading a window's spot and putting a window on a spot.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {isAppWindow} from '../lib/filter.js';
import {toAbsolute, toRelative, sameRect} from '../lib/geometry.js';

const BOTH = Meta.MaximizeFlags.BOTH;

/** Key of a live window: Mutter's stable sequence, unique per shell run. */
export function windowKey(win) {
    return String(win.get_stable_sequence());
}

/** Whether the window is an app window that may be placed. */
export function isTrackable(win) {
    return isAppWindow({
        normalType: win.get_window_type() === Meta.WindowType.NORMAL,
        overrideRedirect: win.is_override_redirect(),
        skipTaskbar: win.is_skip_taskbar(),
        transient: win.get_transient_for() !== null,
        wmClass: win.get_wm_class(),
        gtkAppId: win.get_gtk_application_id(),
        title: win.get_title(),
    });
}

/** Display name of the window's app, or its wm_class. */
export function appNameOf(win) {
    const app = Shell.WindowTracker.get_default().get_window_app(win);
    return app?.get_name() ?? win.get_wm_class() ?? '';
}

function workspaceOf(win) {
    if (win.is_on_all_workspaces())
        return -1;
    return win.get_workspace()?.index() ?? -1;
}

/**
 * The window's current spot on a layout, or null when it is not on a
 * monitor of that layout.
 *
 * A maximized or fullscreen window's frame is the whole work area or
 * monitor; then the rect of `previous` (its last spot in this setup) is
 * kept if it was on the same monitor, so restoring and later unmaximizing
 * gives back its normal size.
 *
 * @param {Meta.Window} win
 * @param {import('./monitors.js').Layout} layout
 * @param {object|null} previous
 * @returns {object|null}
 */
export function readSpot(win, layout, previous = null) {
    const monitor = layout.monitors.find(m => m.index === win.get_monitor());
    if (!monitor)
        return null;
    const maximized = win.get_maximize_flags();
    const fullscreen = win.is_fullscreen();
    let rect = toRelative(win.get_frame_rect(), monitor.workArea);
    if ((maximized || fullscreen) && previous?.monitor === monitor.id)
        rect = {...previous.rect};
    return {
        monitor: monitor.id,
        workspace: workspaceOf(win),
        rect,
        maximized,
        fullscreen,
    };
}

/**
 * Whether the window is already on the spot.
 */
function isAt(win, spot, monitor, target) {
    if (win.get_monitor() !== monitor.index)
        return false;
    if (spot.workspace >= 0 && !win.is_on_all_workspaces() &&
        workspaceOf(win) !== spot.workspace)
        return false;
    if (win.is_fullscreen() !== spot.fullscreen ||
        win.get_maximize_flags() !== spot.maximized)
        return false;
    if (spot.fullscreen || spot.maximized === BOTH)
        return true;
    return sameRect(win.get_frame_rect(), target);
}

/**
 * Put the window on a spot of the current layout.
 *
 * @param {Meta.Window} win
 * @param {object} spot
 * @param {import('./monitors.js').Layout} layout
 * @returns {'moved'|'already-there'|'no-monitor'|'not-movable'}
 */
export function applySpot(win, spot, layout) {
    const monitor = layout.monitors.find(m => m.id === spot.monitor);
    if (!monitor)
        return 'no-monitor';
    const target = toAbsolute(spot.rect, monitor.workArea);
    if (isAt(win, spot, monitor, target))
        return 'already-there';
    if (!win.allows_move())
        return 'not-movable';

    if (spot.fullscreen && win.is_fullscreen()) {
        if (win.get_monitor() !== monitor.index)
            win.move_to_monitor(monitor.index);
    } else if (!spot.fullscreen && spot.maximized === BOTH && win.get_maximize_flags() === BOTH &&
               !win.is_fullscreen()) {
        // Mutter moves a maximized window to another monitor and keeps it
        // maximized there, with its normal size carried along.
        if (win.get_monitor() !== monitor.index)
            win.move_to_monitor(monitor.index);
    } else {
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        if (win.get_maximize_flags())
            win.unmaximize();
        win.move_resize_frame(false, target.x, target.y, target.width, target.height);
        if (spot.maximized === BOTH)
            win.maximize();
        else if (spot.maximized)
            win.set_maximize_flags(spot.maximized);
        if (spot.fullscreen)
            win.make_fullscreen();
    }

    // After the move: with "workspaces on primary display only", windows on
    // other monitors are on all workspaces and have none to change.
    if (spot.workspace >= 0 && !win.is_on_all_workspaces()) {
        const count = global.workspace_manager.get_n_workspaces();
        const index = Math.min(spot.workspace, count - 1);
        if (workspaceOf(win) !== index)
            win.change_workspace_by_index(index, false);
    }
    return 'moved';
}

/** Short human description of a spot, for the debug log. */
export function describeSpot(spot, layout) {
    const monitor = layout.monitors.find(m => m.id === spot.monitor);
    const where = monitor ? `monitor ${monitor.index}` : 'missing monitor';
    const state = spot.fullscreen ? ' fullscreen' : spot.maximized === BOTH ? ' maximized' : '';
    const r = spot.rect;
    return `${where} (${spot.monitor}), workspace ${spot.workspace}, ` +
        `${r.width}x${r.height}+${r.x}+${r.y}${state}`;
}
