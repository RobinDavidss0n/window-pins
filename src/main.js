// Window Pins: puts windows back where they were for each monitor setup,
// and places pinned windows on their pins.
//
// This is one installed version of the code (see the loader,
// extension.js); the loader creates it with the Extension object and
// forwards enable and disable to it.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Engine} from './shell/engine.js';
import {Indicator} from './shell/indicator.js';
import {Logger} from './shell/log.js';
import {Store, defaultStatePath} from './shell/store.js';

const KEYBINDING = 'pin-window';

export default class WindowPins {
    /** @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension */
    constructor(extension) {
        this._extension = extension;
    }

    // The extension also runs on the lock screen (session mode
    // "unlock-dialog"): docking and undocking often happen while the
    // screen is locked, and GNOME would otherwise disable the extension
    // exactly then. On the lock screen only the window tracking runs; the
    // panel menu and the shortcut exist only in the user session.
    enable() {
        this._settings = this._extension.getSettings();
        this._logger = new Logger(this._settings);
        this._engine = new Engine({
            store: new Store(defaultStatePath(), this._logger),
            logger: this._logger,
        });
        this._engine.enable();

        this._sessionId = Main.sessionMode.connect('updated', () => this._syncUi());
        this._syncUi();
    }

    disable() {
        Main.sessionMode.disconnect(this._sessionId);
        this._removeUi();
        this._engine.disable();
        this._engine = null;
        this._logger.destroy();
        this._logger = null;
        this._settings = null;
    }

    _syncUi() {
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            this._removeUi();
        else
            this._addUi();
    }

    _addUi() {
        if (this._indicator)
            return;
        this._indicator = new Indicator(this._engine, () => this._pinFocused());
        Main.panel.addToStatusArea(this._extension.uuid, this._indicator);
        Main.wm.addKeybinding(KEYBINDING, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._pinFromShortcut());
    }

    _removeUi() {
        if (!this._indicator)
            return;
        Main.wm.removeKeybinding(KEYBINDING);
        this._indicator.destroy();
        this._indicator = null;
    }

    /** @returns {{win: Meta.Window|null, result: object|null}} */
    _pinFocused() {
        const win = this._engine.focusedWindow();
        const result = this._engine.pinWindow(win);
        if (!result)
            this._logger.debug('pin: no app window to pin, or the monitor layout is changing');
        return {win, result};
    }

    // The shortcut gives no other sign that it worked, so it shows an
    // OSD on the window's monitor (or the current one).
    _pinFromShortcut() {
        const {win, result} = this._pinFocused();
        const label = !result ? "Can't pin this window" : result.moved ? 'Pin moved' : 'Pinned';
        const monitor = result ? win.get_monitor() : global.display.get_current_monitor();
        Main.osdWindowManager.showOne(monitor, Gio.ThemedIcon.new('view-pin-symbolic'), label, null);
    }
}
