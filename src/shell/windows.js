// Reading a window's spot and putting a window on a spot.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {isAppWindow} from '../lib/filter.js';
import {atSpot, landedAt, toAbsolute, toRelative, sameRect} from '../lib/geometry.js';
import {PlacementCheck} from '../lib/timing.js';
import {timers} from './timers.js';

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

/** Whether the window is on the workspace that is shown, or on all. */
function onActiveWorkspace(win) {
    return win.located_on_workspace(global.workspace_manager.get_active_workspace());
}

function describe(win) {
    return `${win.get_wm_class()} "${win.get_title()}"`;
}

/**
 * Whether the window is on its spot, as the placement check sees it: the
 * spot's monitor and maximize state, and the frame within landedAt's
 * tolerance (not the workspace: the check runs once the window is on the
 * shown workspace).
 */
function isOnSpot(win, spot, layout) {
    const monitor = layout.monitors.find(m => m.id === spot.monitor);
    if (!monitor)
        return false;
    return atSpot({
        monitor: win.get_monitor(),
        frame: win.get_frame_rect(),
        maximized: win.get_maximize_flags(),
        fullscreen: win.is_fullscreen(),
    }, {
        monitor: monitor.index,
        target: toAbsolute(spot.rect, monitor.workArea),
        maximized: spot.maximized,
        fullscreen: spot.fullscreen,
    });
}

/**
 * Put the window on the spot.
 *
 * @returns {{result: 'moved'|'already-there'|'no-monitor'|'not-movable',
 *   target?: object, maximizeLater?: number}} maximizeLater: maximize
 *   flags to set once the frame has arrived at `target`
 */
function putOnSpot(win, spot, layout) {
    const monitor = layout.monitors.find(m => m.id === spot.monitor);
    if (!monitor)
        return {result: 'no-monitor'};
    const target = toAbsolute(spot.rect, monitor.workArea);
    if (isAt(win, spot, monitor, target))
        return {result: 'already-there'};
    if (!win.allows_move())
        return {result: 'not-movable'};

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
    return {result: 'moved', target, maximizeLater};
}

/** Placements in flight, by window: placed, and not yet checked on their
 * spot. */
const placements = new Map();

/**
 * Follow a window that was just moved to its spot until the placement
 * check (PlacementCheck) has found it on its spot, or given up.
 *
 * A window to be maximized in one direction is maximized once its frame
 * has arrived at the target. Maximizing in one direction keeps the
 * frame's other direction, so a half-tiled window comes back on its half.
 * Doing it before the move has landed (a Wayland client acks the new size
 * later, often only after a move to another monitor, or once the window's
 * workspace is shown) would keep the old x and width. Mutter has no public
 * call for its edge-tile mode, so the window ends up maximized vertically
 * at half width rather than edge-tiled; it looks the same, and
 * Super+Left/Right tile it again.
 *
 * The placement is dropped when the user grabs the window, the window is
 * placed again or no longer followed, the monitors change, or the
 * extension is disabled.
 */
function followPlacement(win, spot, layout, placed, {log, onDone}) {
    const placement = {
        target: placed.target,
        maximizeLater: placed.maximizeLater,
        ids: [],
        managerId: 0,
    };
    const manager = global.workspace_manager;
    const stop = () => {
        if (placements.get(win) === placement)
            placements.delete(win);
        for (const id of placement.ids)
            win.disconnect(id);
        placement.ids = [];
        if (placement.managerId)
            manager.disconnect(placement.managerId);
        placement.managerId = 0;
    };
    placement.check = new PlacementCheck(timers, {
        isVisible: () => onActiveWorkspace(win),
        isAtSpot: () => isOnSpot(win, spot, layout),
        placeAgain: () => {
            const r = win.get_frame_rect();
            log?.(`${describe(win)} is not on its spot (at ${r.width}x${r.height}+${r.x}+${r.y}, ` +
                `maximized ${win.get_maximize_flags()}); placing it again`);
            // Flags left from the first try would be set for its target.
            placement.maximizeLater = 0;
            const again = putOnSpot(win, spot, layout);
            placement.target = again.target;
            placement.maximizeLater = again.maximizeLater ?? 0;
            return again.result;
        },
        onDeferred: () => log?.(`${describe(win)} is on a hidden workspace; ` +
            'will check it is on its spot once that workspace is shown'),
        onDone: outcome => {
            stop();
            if (outcome === 'missed')
                log?.(`${describe(win)} did not stay on its spot; left where it is`);
            else if (placement.check.attempt > 1)
                log?.(`${describe(win)} is on its spot after placing it again`);
            onDone?.(outcome);
        },
    });
    const changed = () => {
        const flags = placement.maximizeLater;
        if (flags && landedAt(win.get_frame_rect(), placement.target)) {
            placement.maximizeLater = 0;
            win.set_maximize_flags(flags);
        }
        placement.check.changed();
    };
    placement.cancel = () => {
        placement.check.cancel();
        stop();
    };
    placement.ids = [
        win.connect('position-changed', changed),
        win.connect('size-changed', changed),
        // Whether the window is shown changes when it moves to another
        // workspace, or another workspace is shown (below).
        win.connect('workspace-changed', changed),
    ];
    placement.managerId = manager.connect('active-workspace-changed', changed);
    placements.set(win, placement);
    changed();
}

/**
 * Whether a placement of the window is in flight: it was moved to a spot
 * and not yet found there by the check (nor given up on). Where such a
 * window is must not be taken as its spot.
 */
export function placementInFlight(win) {
    return placements.has(win);
}

/** Drop the window's placement in flight, if any: the user grabbed it,
 * pinned it, or it is no longer followed. */
export function dropPlacement(win) {
    placements.get(win)?.cancel();
}

/** Drop all placements in flight (the monitors change again, or the
 * extension is disabled). */
export function cancelPendingPlacements() {
    for (const placement of [...placements.values()])
        placement.cancel();
}

/**
 * Put the window on a spot of the current layout. When it is moved, it is
 * checked once it is on the shown workspace and its frame has been quiet,
 * and placed again once if it is not on the spot (see PlacementCheck).
 *
 * @param {Meta.Window} win
 * @param {object} spot
 * @param {import('./monitors.js').Layout} layout
 * @param {object} [options]
 * @param {Function|null} [options.log] debug log for what happens later
 * @param {Function|null} [options.onDone] called with 'confirmed' or
 *   'missed' when the check of a moved window ends (not when the
 *   placement is dropped)
 * @returns {'moved'|'already-there'|'no-monitor'|'not-movable'}
 */
export function applySpot(win, spot, layout, {log = null, onDone = null} = {}) {
    // A placement in flight would check the window against its earlier
    // spot, or maximize it for that spot.
    dropPlacement(win);
    const placed = putOnSpot(win, spot, layout);
    if (placed.result === 'moved')
        followPlacement(win, spot, layout, placed, {log, onDone});
    return placed.result;
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
