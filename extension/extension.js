// Window Pins: puts windows back where they were for each monitor setup,
// and places pinned windows on their pins.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Engine} from './shell/engine.js';
import {Indicator} from './shell/indicator.js';
import {Logger} from './shell/log.js';
import {Store, defaultStatePath} from './shell/store.js';

const KEYBINDING = 'pin-window';

export default class WindowPinsExtension extends Extension {
    // The extension also runs on the lock screen (session mode
    // "unlock-dialog"): docking and undocking often happen while the
    // screen is locked, and GNOME would otherwise disable the extension
    // exactly then. On the lock screen only the window tracking runs; the
    // panel menu and the shortcut exist only in the user session.
    enable() {
        this._settings = this.getSettings();
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
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        Main.wm.addKeybinding(KEYBINDING, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._pinFocused());
    }

    _removeUi() {
        if (!this._indicator)
            return;
        Main.wm.removeKeybinding(KEYBINDING);
        this._indicator.destroy();
        this._indicator = null;
    }

    _pinFocused() {
        const win = this._engine.focusedWindow();
        const pin = this._engine.pinWindow(win);
        if (!pin)
            this._logger.debug('pin: no app window to pin, or the monitor layout is changing');
    }
}
