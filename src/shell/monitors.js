// Reads the current monitor layout from Mutter.

import {assignMonitorIds, logicalMonitorId, setupKeyOf} from '../lib/setup.js';

/**
 * @typedef {object} LayoutMonitor
 * @property {number} index logical monitor number, as used by
 *   Meta.Window.get_monitor() and Meta.Display
 * @property {string} id logical monitor id (see lib/setup.js)
 * @property {{x: number, y: number, width: number, height: number}} workArea
 *
 * @typedef {object} Layout
 * @property {string} key setup key
 * @property {LayoutMonitor[]} monitors
 * @property {Array<{id: string, label: string, builtin: boolean}>} physical
 */

function plainRect(r) {
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}

/**
 * The active monitors, identified by EDID vendor, product and serial
 * (Meta.Monitor), grouped into the logical monitors windows live on.
 *
 * @returns {Layout}
 */
export function readLayout() {
    const manager = global.backend.get_monitor_manager();
    const physical = [];
    for (const logical of manager.get_logical_monitors()) {
        for (const m of logical.get_monitors()) {
            physical.push({
                logical: logical.get_number(),
                vendor: m.get_vendor(),
                product: m.get_product(),
                serial: m.get_serial(),
                connector: m.get_connector(),
                builtin: m.is_builtin(),
                label: m.get_display_name?.() ?? `${m.get_vendor()} ${m.get_product()}`,
            });
        }
    }
    const ids = assignMonitorIds(physical);
    physical.forEach((p, i) => (p.id = ids[i]));

    const workspace = global.workspace_manager.get_active_workspace();
    const monitors = [];
    for (let index = 0; index < global.display.get_n_monitors(); index++) {
        const members = physical.filter(p => p.logical === index).map(p => p.id);
        if (!members.length)
            continue;
        monitors.push({
            index,
            id: logicalMonitorId(members),
            workArea: plainRect(workspace.get_work_area_for_monitor(index)),
        });
    }

    return {
        key: setupKeyOf(ids),
        monitors,
        physical: physical.map(p => ({id: p.id, label: p.label, builtin: p.builtin})),
    };
}

/** Refresh the work areas of a layout (panels or docks changed). */
export function refreshWorkAreas(layout) {
    const workspace = global.workspace_manager.get_active_workspace();
    for (const m of layout.monitors) {
        if (m.index < global.display.get_n_monitors())
            m.workArea = plainRect(workspace.get_work_area_for_monitor(m.index));
    }
}
