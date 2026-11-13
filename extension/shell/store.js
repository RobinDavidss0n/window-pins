// Reading and writing ~/.config/window-pins/state.json.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Path of the state file (follows $XDG_CONFIG_HOME). */
export function defaultStatePath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'window-pins', 'state.json']);
}

/**
 * Id of the running gnome-shell process: its pid and start time. Window
 * stable sequences restart with every shell process, so remembered open
 * windows are only valid for the instance that wrote them.
 */
export function shellInstanceId() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/self/stat');
        const stat = decoder.decode(bytes);
        const pid = stat.split(' ')[0];
        // Fields after the command name, which is in parentheses and may
        // contain spaces; the start time is field 22 overall.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return `${pid}-${fields[19]}`;
    } catch {
        // Unknown: never matches a saved one, so nothing stale is reused.
        return `unknown-${Date.now()}`;
    }
}

export class Store {
    /**
     * @param {string} path
     * @param {{warn: Function}} logger
     */
    constructor(path, logger) {
        this._file = Gio.File.new_for_path(path);
        this._logger = logger;
    }

    /**
     * The parsed state file, or null when there is none. A file that
     * cannot be parsed is kept aside as state.json.broken-<time> so a
     * later save does not destroy pins the user may want back.
     *
     * @returns {any}
     */
    load() {
        let text;
        try {
            const [, bytes] = this._file.load_contents(null);
            text = decoder.decode(bytes);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                this._logger.warn(`cannot read ${this._file.get_path()}: ${e.message}`);
            return null;
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            const aside = `${this._file.get_path()}.broken-${Date.now()}`;
            this._logger.warn(`cannot parse ${this._file.get_path()} (${e.message}); kept as ${aside}`);
            try {
                this._file.move(Gio.File.new_for_path(aside), Gio.FileCopyFlags.NONE, null, null);
            } catch (moveError) {
                this._logger.warn(`cannot move it aside: ${moveError.message}`);
            }
            return null;
        }
    }

    /**
     * Write the state atomically: GLib writes a temporary file next to it
     * and renames it over the old one, so a crash never leaves half a file.
     *
     * @param {object} state
     */
    save(state) {
        try {
            const dir = this._file.get_parent();
            GLib.mkdir_with_parents(dir.get_path(), 0o700);
            const bytes = encoder.encode(`${JSON.stringify(state, null, 1)}\n`);
            this._file.replace_contents(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            this._logger.warn(`cannot write ${this._file.get_path()}: ${e.message}`);
        }
    }
}
