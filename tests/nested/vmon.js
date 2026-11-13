// Adds a virtual monitor to the nested shell through Mutter's ScreenCast
// API, the way remote desktop does; it goes away when this exits.
//
//   gjs -m tests/nested/vmon.js WIDTH HEIGHT
//
// The stream is consumed by gst-launch (pipewiresrc), which Mutter needs
// before it creates the monitor. Each such monitor gets its own serial.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

const [width, height] = [ARGV[0] ?? '1280', ARGV[1] ?? '1024'];
const bus = Gio.DBus.session;
const call = (path, iface, method, params, type) => bus.call_sync('org.gnome.Mutter.ScreenCast',
    path, iface, method, params, type ? new GLib.VariantType(type) : null, 0, -1, null);

const [sessionPath] = call('/org/gnome/Mutter/ScreenCast', 'org.gnome.Mutter.ScreenCast',
    'CreateSession', new GLib.Variant('(a{sv})', [{}]), '(o)').deepUnpack();
const [streamPath] = call(sessionPath, 'org.gnome.Mutter.ScreenCast.Session', 'RecordVirtual',
    new GLib.Variant('(a{sv})', [{'cursor-mode': new GLib.Variant('u', 0)}]), '(o)').deepUnpack();

const loop = new GLib.MainLoop(null, false);
let consumer = null;
bus.signal_subscribe('org.gnome.Mutter.ScreenCast', 'org.gnome.Mutter.ScreenCast.Stream',
    'PipeWireStreamAdded', streamPath, null, 0, (_c, _s, _p, _i, _sig, params) => {
        const [node] = params.deepUnpack();
        print(`node ${node}`);
        consumer = Gio.Subprocess.new(['gst-launch-1.0', '-q', 'pipewiresrc', `path=${node}`,
            'always-copy=true', '!', `video/x-raw,width=${width},height=${height}`, '!', 'fakesink'],
        Gio.SubprocessFlags.NONE);
    });
call(sessionPath, 'org.gnome.Mutter.ScreenCast.Session', 'Start', null, null);

const stop = () => {
    try {
        consumer?.force_exit();
    } catch {}
    try {
        call(sessionPath, 'org.gnome.Mutter.ScreenCast.Session', 'Stop', null, null);
    } catch {}
    loop.quit();
    return GLib.SOURCE_REMOVE;
};
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, stop);
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 2, stop);
loop.run();
