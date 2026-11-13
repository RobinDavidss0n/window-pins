// Opens test windows in the nested shell.
//
//   gjs -m tests/nested/win.js APP_ID SPEC...
//
// SPEC is "Title", or "Title@MS=Later title" to change the title MS
// milliseconds after the window is shown (like Chrome and Electron do).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const [appId, ...specs] = ARGV;
const app = new Gtk.Application({application_id: appId, flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    for (const spec of specs) {
        const m = spec.match(/^(.*?)(?:@(\d+)=(.*))?$/);
        const win = new Gtk.ApplicationWindow({
            application: app, title: m[1], default_width: 400, default_height: 300,
        });
        win.present();
        if (m[2]) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(m[2]), () => {
                win.title = m[3];
                return GLib.SOURCE_REMOVE;
            });
        }
    }
});
app.run([]);
