// Turns monitors of the nested shell on and off through
// org.gnome.Mutter.DisplayConfig, like the Displays settings panel does.
// Turning a monitor off and on again keeps its identity (unlike removing
// a virtual monitor and adding a new one, which gets a new serial).
//
//   gjs -m tests/nested/display.js only CONNECTOR...   # others off
//   gjs -m tests/nested/display.js all                 # all on, side by side
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [command, ...connectors] = ARGV;
const call = (method, params, type) => Gio.DBus.session.call_sync('org.gnome.Mutter.DisplayConfig',
    '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', method, params,
    type ? new GLib.VariantType(type) : null, 0, -1, null);

const [serial, monitors] = call('GetCurrentState', null, '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})')
    .deepUnpack();

const wanted = monitors.filter(([spec]) => command === 'all' || connectors.includes(spec[0]));
let x = 0;
const logical = wanted.map(([spec, modes], i) => {
    const mode = modes.find(m => m[6]['is-current']?.deepUnpack()) ??
        modes.find(m => m[6]['is-preferred']?.deepUnpack()) ?? modes[0];
    const entry = [x, 0, 1.0, 0, i === 0, [[spec[0], mode[0], {}]]];
    x += mode[1];
    return entry;
});
call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, logical, {}]), null);
print(`on: ${wanted.map(([spec]) => spec[0]).join(' ')}`);
