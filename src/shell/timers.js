// GLib timers in the form the timers of lib/timing.js take.

import GLib from 'gi://GLib';

export const timers = {
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
