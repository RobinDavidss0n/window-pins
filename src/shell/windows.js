// Reading a window's spot and putting a window on a spot.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {isAppWindow} from '../lib/filter.js';
import {landedAt, toAbsolute, toRelative, sameRect} from '../lib/geometry.js';
import {LAND_TIMEOUT_MS, landingStep} from '../lib/timing.js';

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
 * A fully maximized or fullscreen window's frame is the whole work area
 * or monitor; then the rect of `previous` (its last spot in this setup) is
 * kept if it was on the same monitor, so restoring and later unmaximizing
 * gives back its normal size.
 *
 * A window maximized in one direction only (GNOME's half tiling is
 * vertical maximize at half the width) keeps its actual frame: that frame
 * is where it has to come back to.
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
    if ((maximized === BOTH || fullscreen) && previous?.monitor === monitor.id)
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
 * Whether the window is already on the spot. Fully maximized and
 * fullscreen windows only need the right monitor; others, including
 * windows maximized in one direction, the same frame.
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

/** Waits of maximizePartlyAt still running, by window, so a new placement
 * of the window, a monitor change or disable can stop them. */
const pendingWaits = new Map();

/** Whether the window is on the workspace that is shown, or on all. */
function onActiveWorkspace(win) {
    return win.located_on_workspace(global.workspace_manager.get_active_workspace());
}

/**
 * Maximize a window in one direction once its frame has arrived at
 * `target`. Maximizing in one direction keeps the frame's other
 * direction, so a half-tiled window comes back on its half. Doing it
 * before the move has landed (a Wayland client acks the new size later,
 * often only after a move to another monitor) would keep the old x and
 * width.
 *
 * When the frame does not arrive within LAND_TIMEOUT_MS, the window is
 * left where it is, not maximized. That time only starts counting once
 * the window is on the workspace that is shown: a Wayland client may not
 * ack a new size for a window on a hidden workspace until the workspace
 * is shown, which can be any time later. Until then the wait has no
 * timeout; it is dropped when the user grabs the window, the window is
 * placed again or unmanaged, the monitors change, or the extension is
 * disabled.
 *
 * Mutter has no public call for its edge-tile mode, so the window ends
 * up maximized vertically at half width rather than edge-tiled; it looks
 * the same, and Super+Left/Right tile it again.
 */
function maximizePartlyAt(win, flags, target, log) {
    if (landedAt(win.get_frame_rect(), target)) {
        win.set_maximize_flags(flags);
        return;
    }
    const wait = {ids: [], managerId: 0, timeoutId: 0, deferred: false};
    const manager = global.workspace_manager;
    const finish = apply => {
        if (pendingWaits.get(win) === wait)
            pendingWaits.delete(win);
        for (const id of wait.ids)
            win.disconnect(id);
        wait.ids = [];
        if (wait.managerId)
            manager.disconnect(wait.managerId);
        wait.managerId = 0;
        if (wait.timeoutId)
            GLib.source_remove(wait.timeoutId);
        wait.timeoutId = 0;
        if (apply)
            win.set_maximize_flags(flags);
    };
    const startTimeout = () => {
        wait.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAND_TIMEOUT_MS, () => {
            wait.timeoutId = 0;
            finish(false);
            log?.(`${win.get_wm_class()} "${win.get_title()}" did not reach its spot; ` +
                'left there without maximizing it in one direction');
            return GLib.SOURCE_REMOVE;
        });
    };
    const check = () => {
        const step = landingStep({
            landed: landedAt(win.get_frame_rect(), target),
            visible: onActiveWorkspace(win),
            timing: wait.timeoutId !== 0,
        });
        if (step === 'apply') {
            finish(true);
        } else if (step === 'start-timeout') {
            startTimeout();
        } else if (step === 'defer' && !wait.deferred) {
            wait.deferred = true;
            log?.(`${win.get_wm_class()} "${win.get_title()}" is on a hidden workspace; ` +
                'will maximize it in one direction once that workspace is shown');
        }
    };

    wait.cancel = () => finish(false);
    wait.ids = [
        win.connect('position-changed', check),
        win.connect('size-changed', check),
        // Whether the window is shown changes when it moves to another
        // workspace, or another workspace is shown (below).
        win.connect('workspace-changed', check),
        win.connect('unmanaging', () => finish(false)),
    ];
    wait.managerId = manager.connect('active-workspace-changed', check);
    pendingWaits.set(win, wait);
    check();
}

/** Stop waiting for windows to arrive (the monitors change again, or the
 * extension is disabled). */
export function cancelPendingPlacements() {
    for (const wait of [...pendingWaits.values()])
        wait.cancel();
}

/**
 * The user started moving or resizing the window: a wait to maximize it
 * that is held back until its workspace is shown is dropped, so the
 * window is not changed under the user later. A wait whose timeout runs
 * goes on.
 */
export function dropDeferredPlacement(win) {
    const wait = pendingWaits.get(win);
    if (wait?.deferred && !wait.timeoutId)
        wait.cancel();
}

/**
 * Put the window on a spot of the current layout.
 *
 * @param {Meta.Window} win
 * @param {object} spot
 * @param {import('./monitors.js').Layout} layout
 * @param {Function|null} log debug log for what happens later
 * @returns {'moved'|'already-there'|'no-monitor'|'not-movable'}
 */
export function applySpot(win, spot, layout, log = null) {
    const monitor = layout.monitors.find(m => m.id === spot.monitor);
    if (!monitor)
        return 'no-monitor';
    // A wait from an earlier placement would maximize the window for that
    // placement's spot.
    pendingWaits.get(win)?.cancel();
    const target = toAbsolute(spot.rect, monitor.workArea);
    if (isAt(win, spot, monitor, target))
        return 'already-there';
    if (!win.allows_move())
        return 'not-movable';

    let maximizeLater = 0;
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
        else if (spot.maximized && landedAt(win.get_frame_rect(), target))
            win.set_maximize_flags(spot.maximized);
        else if (spot.maximized)
            maximizeLater = spot.maximized;
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
    // After the workspace change: whether the wait may time out depends on
    // the window's workspace being shown.
    if (maximizeLater)
        maximizePartlyAt(win, maximizeLater, target, log);
    return 'moved';
}

/** Short human description of a spot, for the debug log. */
export function describeSpot(spot, layout) {
    const monitor = layout.monitors.find(m => m.id === spot.monitor);
    const where = monitor ? `monitor ${monitor.index}` : 'missing monitor';
    const state = spot.fullscreen ? ' fullscreen'
        : spot.maximized === BOTH ? ' maximized'
            : spot.maximized ? ` maximized ${spot.maximized === Meta.MaximizeFlags.VERTICAL ? 'vertically' : 'horizontally'}`
                : '';
    const r = spot.rect;
    return `${where} (${spot.monitor}), workspace ${spot.workspace}, ` +
        `${r.width}x${r.height}+${r.x}+${r.y}${state}`;
}
