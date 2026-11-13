// The panel menu: pin the focused window, list and remove pins, switch
// "remember closed windows" per app, and rename the current setup.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MAX_LABEL = 48;

function shorten(text, max = MAX_LABEL) {
    const t = (text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function pinLabel(pin) {
    const app = pin.appName || pin.wmClass;
    return pin.title ? shorten(`${app} — ${pin.title}`) : shorten(app);
}

/** A menu row with a label and a remove button. */
const PinItem = GObject.registerClass(
class PinItem extends PopupMenu.PopupBaseMenuItem {
    _init(pin, onRemove) {
        super._init({reactive: false, can_focus: false});
        this.add_child(new St.Label({
            text: pinLabel(pin),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const button = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            child: new St.Icon({icon_name: 'edit-delete-symbolic', style_class: 'popup-menu-icon'}),
            accessible_name: `Remove pin ${pinLabel(pin)}`,
        });
        button.connect('clicked', () => onRemove(pin));
        this.add_child(button);
    }
});

/** A menu row with an entry for the setup's name. */
const SetupNameItem = GObject.registerClass(
class SetupNameItem extends PopupMenu.PopupBaseMenuItem {
    _init(onRename) {
        super._init({reactive: false, can_focus: false});
        this._onRename = onRename;
        this.add_child(new St.Label({text: 'Setup', y_align: Clutter.ActorAlign.CENTER}));
        this._entry = new St.Entry({
            x_expand: true,
            can_focus: true,
            hint_text: 'Name of this monitor setup',
        });
        this._entry.clutter_text.connect('activate', () => this._commit());
        this._entry.clutter_text.connect('key-focus-out', () => this._commit());
        this.add_child(this._entry);
        this._key = null;
        this._name = '';
    }

    setSetup(key, name) {
        this._key = key;
        this._name = name;
        this._entry.text = name;
    }

    _commit() {
        if (this._key === null || this._entry.text === this._name)
            return;
        this._name = this._entry.text;
        this._onRename(this._key, this._entry.text);
    }
});

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    /**
     * @param {import('./engine.js').Engine} engine
     * @param {Function} onPin pins the focused window
     */
    _init(engine, onPin) {
        super._init(0.5, 'Window Pins');
        this._engine = engine;
        this._onPin = onPin;

        this.add_child(new St.Icon({
            icon_name: 'view-pin-symbolic',
            style_class: 'system-status-icon',
        }));

        this._nameItem = new SetupNameItem((key, name) => {
            this._engine.renameSetup(key, name);
            this._nameItem.setSetup(key, this._engine.currentSetup.name);
        });
        this.menu.addMenuItem(this._nameItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pinItem = new PopupMenu.PopupMenuItem('Pin this window here');
        this._pinItem.connect('activate', () => this._onPin());
        this.menu.addMenuItem(this._pinItem);

        this._pinsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._pinsSection);

        this._otherSetups = new PopupMenu.PopupSubMenuMenuItem('Pins in other setups');
        this.menu.addMenuItem(this._otherSetups);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._remember = new PopupMenu.PopupSubMenuMenuItem('Remember closed windows');
        this.menu.addMenuItem(this._remember);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });
        this._refresh();
    }

    _removePin(pin) {
        this._engine.removePin(pin.id);
        this._refresh();
    }

    _refresh() {
        const setup = this._engine.currentSetup;
        this._nameItem.setSetup(setup.key, setup.name);

        const focused = this._engine.focusedWindow();
        this._pinItem.setSensitive(Boolean(focused) && !this._engine.settling);

        this._pinsSection.removeAll();
        const pins = this._engine.pinsFor(setup.key);
        if (pins.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No pins in this setup', {reactive: false});
            this._pinsSection.addMenuItem(empty);
        }
        for (const pin of pins)
            this._pinsSection.addMenuItem(new PinItem(pin, p => this._removePin(p)));

        this._otherSetups.menu.removeAll();
        const others = this._engine.otherSetupsWithPins();
        this._otherSetups.visible = others.length > 0;
        for (const other of others) {
            const heading = new PopupMenu.PopupMenuItem(other.name, {reactive: false});
            heading.label.style = 'font-weight: bold;';
            this._otherSetups.menu.addMenuItem(heading);
            for (const pin of other.pins)
                this._otherSetups.menu.addMenuItem(new PinItem(pin, p => this._removePin(p)));
        }

        this._remember.menu.removeAll();
        const apps = this._engine.rememberChoices();
        this._remember.visible = apps.length > 0;
        for (const app of apps) {
            const item = new PopupMenu.PopupSwitchMenuItem(shorten(app.appName, 36), app.on);
            item.connect('toggled', (_item, on) => this._engine.setRemember(app.wmClass, app.appName, on));
            this._remember.menu.addMenuItem(item);
        }
    }
});
