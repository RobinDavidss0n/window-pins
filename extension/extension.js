// Window Pins loader.
//
// GJS caches ES modules by URL for the life of the shell process, so after
// an update a disable and enable would run the old code again, and on
// Wayland updates would need a logout. This loader is small and rarely
// changes. Each install puts the actual code in versions/<id>/ and writes
// <id> to the file `current` (and the id it replaces to `previous`); every
// enable imports versions/<id>/main.js, whose own imports resolve inside
// that directory, so a new version runs entirely from new URLs.
//
// The modules of earlier versions stay in memory until the shell exits.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const decoder = new TextDecoder();

export default class WindowPinsLoader extends Extension {
    enable() {
        // The import is asynchronous; a disable (or another enable) before
        // it finishes replaces this token, and the late result is dropped.
        const attempt = {};
        this._attempt = attempt;
        this._load(attempt).catch(e => console.error(`[window-pins] loader: ${e}`));
    }

    disable() {
        this._attempt = null;
        const impl = this._impl;
        this._impl = null;
        impl?.disable();
    }

    _readId(name) {
        try {
            const [, bytes] = this.dir.get_child(name).load_contents(null);
            return decoder.decode(bytes).trim() || null;
        } catch {
            return null;
        }
    }

    // Runs the current version; if it cannot be imported or enabled, the
    // previous one.
    async _load(attempt) {
        const ids = [...new Set([this._readId('current'), this._readId('previous')])]
            .filter(Boolean);
        if (ids.length === 0) {
            console.error('[window-pins] no installed version (the file "current" is missing); not running');
            return;
        }
        for (const id of ids) {
            let impl = null;
            try {
                const main = this.dir.get_child('versions').get_child(id).get_child('main.js');
                const module = await import(main.get_uri());
                if (this._attempt !== attempt)
                    return;
                impl = new module.default(this);
                impl.enable();
            } catch (e) {
                console.error(`[window-pins] cannot load version ${id}: ${e}\n${e?.stack ?? ''}`);
                try {
                    impl?.disable();
                } catch {}
                continue;
            }
            this._impl = impl;
            console.log(`[window-pins] running version ${id}` +
                `${id === ids[0] ? '' : ' (the previous version, since the current one failed)'}`);
            return;
        }
        console.error('[window-pins] no version could be loaded; not running');
    }
}
