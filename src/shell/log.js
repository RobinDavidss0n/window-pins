// Journal logging with a [window-pins] prefix. Decisions are logged only
// while the `debug` setting is on; warnings always.

export class Logger {
    /** @param {import('gi://Gio').default.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._enabled = settings.get_boolean('debug');
        this._changedId = settings.connect('changed::debug', () => {
            this._enabled = settings.get_boolean('debug');
        });
    }

    debug(message) {
        if (this._enabled)
            console.log(`[window-pins] ${message}`);
    }

    warn(message) {
        console.warn(`[window-pins] ${message}`);
    }

    destroy() {
        this._settings.disconnect(this._changedId);
    }
}
