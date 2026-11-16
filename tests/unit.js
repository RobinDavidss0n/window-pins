// Tests for the shell-free modules. Run: gjs -m tests/unit.js

import system from 'system';

import {assignMonitorIds, defaultSetupName, logicalMonitorId, monitorBaseId, setupKeyOf}
    from '../src/lib/setup.js';
import {landedAt, sameRect, toAbsolute, toRelative} from '../src/lib/geometry.js';
import {isAppWindow} from '../src/lib/filter.js';
import {assignPins, chooseClosedSpot, decideNewWindow, exactTitlePinsSkipped, planRestore, titleSimilarity}
    from '../src/lib/matching.js';
import {MonitorSettler, QuietTimer} from '../src/lib/timing.js';
import {
    CLOSED_MAX_AGE_MS, addClosedEntries, closeStaleOpenWindows, emptyState, heldPinIds, newPinId,
    normalizeState, pruneState,
} from '../src/lib/state.js';

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failures.push(`${name}: ${e.message}`);
    }
}

function eq(actual, expected, what = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${what} expected ${b}, got ${a}`);
}

// A fake clock for the timers.
class FakeTimers {
    constructor() {
        this.now = 0;
        this._next = 1;
        this._pending = new Map();
    }

    add(ms, fn) {
        const handle = {id: this._next++};
        this._pending.set(handle.id, {at: this.now + ms, fn});
        return handle;
    }

    remove(handle) {
        this._pending.delete(handle.id);
    }

    advance(ms) {
        const end = this.now + ms;
        for (;;) {
            let first = null;
            for (const [id, t] of this._pending) {
                if (t.at <= end && (!first || t.at < first[1].at))
                    first = [id, t];
            }
            if (!first)
                break;
            this._pending.delete(first[0]);
            this.now = first[1].at;
            first[1].fn();
        }
        this.now = end;
    }
}

// --- setup.js ---------------------------------------------------------------

test('monitor id uses vendor, product and serial, never the connector', () => {
    eq(monitorBaseId({vendor: 'PHL', product: '27E1N', serial: 'X1', connector: 'DP-1'}), 'PHL:27E1N:X1');
});

test('empty and zero serials are left out', () => {
    eq(monitorBaseId({vendor: 'BOE', product: '0x0bca', serial: ''}), 'BOE:0x0bca');
    eq(monitorBaseId({vendor: 'BOE', product: '0x0bca', serial: '0x00000000'}), 'BOE:0x0bca');
    eq(monitorBaseId({vendor: 'BOE', product: '0x0bca', serial: '0'}), 'BOE:0x0bca');
});

test('same monitors on other connectors give the same setup key', () => {
    const home = [
        {vendor: 'PHL', product: 'A', serial: '1', connector: 'DP-1'},
        {vendor: 'PHL', product: 'B', serial: '2', connector: 'DP-2'},
        {vendor: 'BOE', product: 'P', serial: '', connector: 'eDP-1'},
    ];
    const replugged = [
        {vendor: 'BOE', product: 'P', serial: '', connector: 'eDP-2'},
        {vendor: 'PHL', product: 'B', serial: '2', connector: 'DP-5'},
        {vendor: 'PHL', product: 'A', serial: '1', connector: 'HDMI-1'},
    ];
    eq(setupKeyOf(assignMonitorIds(home)), setupKeyOf(assignMonitorIds(replugged)));
});

test('identical monitors without serials are told apart by connector order', () => {
    const ids = assignMonitorIds([
        {vendor: 'X', product: 'Y', serial: '', connector: 'DP-2'},
        {vendor: 'X', product: 'Y', serial: '', connector: 'DP-1'},
        {vendor: 'Z', product: 'Q', serial: '9', connector: 'DP-3'},
    ]);
    eq(ids, ['X:Y#2', 'X:Y#1', 'Z:Q:9']);
});

test('logical monitor id joins mirrored monitors', () => {
    eq(logicalMonitorId(['b', 'a']), 'a = b');
    eq(logicalMonitorId(['a']), 'a');
});

test('default setup names', () => {
    eq(defaultSetupName([{builtin: true}]), 'Laptop only');
    eq(defaultSetupName([{builtin: false}]), '1 monitor');
    eq(defaultSetupName([{builtin: true}, {}, {}]), '3 monitors');
    eq(defaultSetupName([{}, {}, {}], ['3 monitors']), '3 monitors (2)');
    eq(defaultSetupName([{}, {}, {}], ['3 monitors', '3 monitors (2)']), '3 monitors (3)');
});

// --- geometry.js ------------------------------------------------------------

const area = {x: 1920, y: 32, width: 2560, height: 1408};

test('relative and back gives the same rect', () => {
    const frame = {x: 2000, y: 100, width: 800, height: 600};
    const rel = toRelative(frame, area);
    eq(rel, {x: 80, y: 68, width: 800, height: 600, areaWidth: 2560, areaHeight: 1408});
    eq(toAbsolute(rel, area), frame);
});

test('same-size area keeps a partly off-screen rect exactly', () => {
    const rel = {x: -50, y: 10, width: 800, height: 600, areaWidth: 2560, areaHeight: 1408};
    eq(toAbsolute(rel, {...area, x: 0}), {x: -50, y: 42, width: 800, height: 600});
});

test('rect moves with the monitor to another position', () => {
    const rel = toRelative({x: 2000, y: 100, width: 800, height: 600}, area);
    eq(toAbsolute(rel, {...area, x: 0, y: 0}), {x: 80, y: 68, width: 800, height: 600});
});

test('other area size scales and clamps', () => {
    const rel = {x: 1280, y: 704, width: 1280, height: 704, areaWidth: 2560, areaHeight: 1408};
    eq(toAbsolute(rel, {x: 0, y: 0, width: 1280, height: 704}), {x: 640, y: 352, width: 640, height: 352});
    const big = {x: 0, y: 0, width: 3000, height: 2000, areaWidth: 1000, areaHeight: 1000};
    eq(toAbsolute(big, {x: 0, y: 0, width: 1200, height: 900}), {x: 0, y: 0, width: 1200, height: 900});
});

test('sameRect tolerance', () => {
    eq(sameRect({x: 0, y: 0, width: 10, height: 10}, {x: 2, y: -2, width: 12, height: 8}), true);
    eq(sameRect({x: 0, y: 0, width: 10, height: 10}, {x: 3, y: 0, width: 10, height: 10}), false);
});

test('landedAt: exact position, size rounded to character cells', () => {
    const target = {x: 1920, y: 0, width: 640, height: 1024};
    eq(landedAt({x: 1920, y: 0, width: 630, height: 1020}, target), true);
    eq(landedAt({x: 1925, y: 0, width: 640, height: 1024}, target), false);
    eq(landedAt({x: 1920, y: 0, width: 400, height: 1024}, target), false);
});

// --- filter.js --------------------------------------------------------------

const normal = {
    normalType: true, overrideRedirect: false, skipTaskbar: false, transient: false,
    wmClass: 'org.gnome.TextEditor', gtkAppId: null, title: 'notes.txt',
};

test('normal app windows are placed; others are not', () => {
    eq(isAppWindow(normal), true);
    eq(isAppWindow({...normal, normalType: false}), false);
    eq(isAppWindow({...normal, overrideRedirect: true}), false);
    eq(isAppWindow({...normal, skipTaskbar: true}), false);
    eq(isAppWindow({...normal, transient: true}), false);
    eq(isAppWindow({...normal, wmClass: 'com.rastersoft.ding'}), false);
    eq(isAppWindow({...normal, wmClass: 'gjs', gtkAppId: 'com.rastersoft.ding'}), false);
    eq(isAppWindow({...normal, title: '@!0,0;BDHF'}), false);
});

// --- matching.js ------------------------------------------------------------

const spot = (monitor = 'M1') => ({
    monitor, workspace: 0, maximized: 0, fullscreen: false,
    rect: {x: 0, y: 0, width: 100, height: 100, areaWidth: 1000, areaHeight: 1000},
});
const pin = (id, wmClass, title, setupKey = 'S') => ({id, wmClass, title, setupKey, ...spot()});

test('pin with the same title wins over an earlier pin of the app', () => {
    const pins = [pin('a', 'chrome', 'Mail'), pin('b', 'chrome', 'Calendar')];
    const got = assignPins([{key: '1', wmClass: 'chrome', title: 'Calendar'}], pins);
    eq(got.get('1').id, 'b');
});

test('without a title match and nothing in common the oldest free pin is taken', () => {
    const pins = [pin('a', 'chrome', 'Mail'), pin('b', 'chrome', 'Calendar')];
    const got = assignPins([{key: '1', wmClass: 'chrome', title: 'New Tab'}], pins);
    eq(got.get('1').id, 'a');
    const got2 = assignPins([{key: '1', wmClass: 'chrome', title: 'New Tab'}], pins, new Set(['a']));
    eq(got2.get('1').id, 'b');
});

test('title similarity counts shared words', () => {
    eq(titleSimilarity('NOTE - RD - work - Obsidian 1.15.1', 'NOTE - HA - personal - Obsidian 1.15.1'), 3);
    eq(titleSimilarity('Todo - RD - work - Obsidian 1.15.1', 'NOTE - RD - work - Obsidian 1.15.1'), 4);
    eq(titleSimilarity('a a b', 'a b'), 2);
    eq(titleSimilarity(null, 'x'), 0);
    eq(titleSimilarity('Inbox (3)', 'inbox'), 1);
});

test('without a title match the free pin with the most similar title is taken', () => {
    const pins = [
        pin('ha', 'obsidian', 'NOTE - HA - personal - Obsidian 1.15.1'),
        pin('rd', 'obsidian', 'NOTE - RD - work - Obsidian 1.15.1'),
    ];
    // Another note open in the work vault goes to the work vault's pin.
    const got = assignPins([{key: '1', wmClass: 'obsidian', title: 'Meeting - RD - work - Obsidian 1.15.1'}], pins);
    eq(got.get('1').id, 'rd');
    const mail = [
        pin('home', 'chrome', 'Gmail - Inbox - someone@example.com - Gmail'),
        pin('work', 'chrome', 'Gmail - Inbox - someone@example.org - Example AB e-post'),
    ];
    const got2 = assignPins([{key: '1', wmClass: 'chrome',
        title: 'Gmail - Inbox (12) - someone@example.org - Example AB e-post'}], mail);
    eq(got2.get('1').id, 'work');
    // The work pin held: the window takes the other one anyway.
    const got3 = assignPins([{key: '1', wmClass: 'obsidian', title: 'X - RD - work'}], pins, new Set(['rd']));
    eq(got3.get('1').id, 'ha');
});

test('an exact-title pin takes only windows with its title', () => {
    const exact = {...pin('a', 'obsidian', 'NOTE - RD - work'), exactTitle: true};
    const other = pin('b', 'obsidian', 'NOTE - HA - personal');
    eq(assignPins([{key: '1', wmClass: 'obsidian', title: 'NOTE - RD - work'}], [exact, other]).get('1').id, 'a');
    // A similar title falls back to the other pin, not the exact-title one.
    eq(assignPins([{key: '1', wmClass: 'obsidian', title: 'Todo - RD - work'}], [exact, other]).get('1').id, 'b');
    eq(assignPins([{key: '1', wmClass: 'obsidian', title: 'Todo - RD - work'}], [exact]).size, 0);
    const window = {wmClass: 'obsidian', title: 'Todo - RD - work'};
    eq(exactTitlePinsSkipped(window, [exact, other], new Set()).map(p => p.id), ['a']);
    eq(exactTitlePinsSkipped(window, [exact, other], new Set(['a'])), []);
    eq(exactTitlePinsSkipped({...window, title: 'NOTE - RD - work'}, [exact], new Set()), []);
    eq(decideNewWindow({window: {key: '1', ...window}, pins: [exact], held: new Set(),
        remember: false, closed: [], setupKey: 'S'}), null);
});

test('similarity ties go to the oldest pin', () => {
    const pins = [pin('old', 'app', 'one shared'), pin('new', 'app', 'two shared')];
    eq(assignPins([{key: '1', wmClass: 'app', title: 'shared'}], pins).get('1').id, 'old');
});

test('one window per pin; exact titles are matched before fallbacks', () => {
    const pins = [pin('a', 'chrome', 'Mail'), pin('b', 'chrome', 'Calendar')];
    const windows = [
        {key: '1', wmClass: 'chrome', title: 'Something'},
        {key: '2', wmClass: 'chrome', title: 'Mail'},
        {key: '3', wmClass: 'chrome', title: 'Other'},
    ];
    const got = assignPins(windows, pins);
    eq(got.get('2').id, 'a');
    eq(got.get('1').id, 'b');
    eq(got.has('3'), false);
});

test('pins of other apps and windows without wm_class are not matched', () => {
    const pins = [pin('a', 'firefox', 'Mail')];
    eq(assignPins([{key: '1', wmClass: 'chrome', title: 'Mail'}], pins).size, 0);
    eq(assignPins([{key: '1', wmClass: null, title: 'Mail'}], pins).size, 0);
});

test('a held pin is not taken even by an exact title', () => {
    const pins = [pin('a', 'chrome', 'Mail')];
    eq(assignPins([{key: '1', wmClass: 'chrome', title: 'Mail'}], pins, new Set(['a'])).size, 0);
});

test('closed spot: same title in this setup, else the most recent in this setup', () => {
    const entries = [
        {title: 'A', setupKey: 'S', closedAt: 10, ...spot('a')},
        {title: 'B', setupKey: 'S', closedAt: 30, ...spot('b')},
        {title: 'A', setupKey: 'T', closedAt: 50, ...spot('c')},
    ];
    eq(chooseClosedSpot(entries, 'A', 'S').monitor, 'a');
    eq(chooseClosedSpot(entries, 'Z', 'S').monitor, 'b');
    eq(chooseClosedSpot(entries, 'A', 'T').monitor, 'c');
    eq(chooseClosedSpot(entries, 'A', 'U'), null);
});

test('closed spot: else the most similar title in this setup, newest on a tie', () => {
    const entries = [
        {title: 'NOTE - RD - work - Obsidian', setupKey: 'S', closedAt: 10, ...spot('work')},
        {title: 'NOTE - HA - personal - Obsidian', setupKey: 'S', closedAt: 30, ...spot('home')},
        {title: 'Other - HA - personal - Obsidian', setupKey: 'S', closedAt: 20, ...spot('home-old')},
    ];
    eq(chooseClosedSpot(entries, 'Todo - RD - work - Obsidian', 'S').monitor, 'work');
    eq(chooseClosedSpot(entries, 'Todo - HA - personal - Obsidian', 'S').monitor, 'home');
    eq(chooseClosedSpot(entries, 'Unrelated', 'S').monitor, 'home');
});

test('new window: pins take precedence over closed spots', () => {
    const closed = [{title: 'Mail', setupKey: 'S', closedAt: 1, ...spot('closed')}];
    const base = {window: {key: '1', wmClass: 'chrome', title: 'Mail'}, held: new Set(), closed, setupKey: 'S'};
    eq(decideNewWindow({...base, pins: [pin('a', 'chrome', 'X')], remember: true}).kind, 'pin');
    eq(decideNewWindow({...base, pins: [], remember: true}).kind, 'closed');
    eq(decideNewWindow({...base, pins: [], remember: false}), null);
    eq(decideNewWindow({...base, pins: [pin('a', 'chrome', 'X')], held: new Set(['a']), remember: true}).kind,
        'closed');
});

test('restore: remembered spot first, then held pin, then free pins', () => {
    const pins = [pin('a', 'chrome', 'Mail'), pin('b', 'chrome', 'Cal'), pin('c', 'code', 'proj')];
    const plan = planRestore([
        {key: '1', wmClass: 'chrome', title: 'Mail', spot: spot('remembered'), heldPinId: 'a'},
        {key: '2', wmClass: 'chrome', title: 'Mail', spot: null, heldPinId: null},
        {key: '3', wmClass: 'code', title: 'x', spot: null, heldPinId: 'c'},
        {key: '4', wmClass: 'term', title: 'x', spot: null, heldPinId: null},
    ], pins);
    const byKey = Object.fromEntries(plan.map(p => [p.key, p]));
    eq(byKey['1'].kind, 'remembered');
    eq(byKey['1'].spot.monitor, 'remembered');
    // Pin a is held by window 1, so window 2 falls back to pin b.
    eq(byKey['2'].pin.id, 'b');
    eq(byKey['3'].pin.id, 'c');
    eq(byKey['4'], undefined);
});

// --- timing.js --------------------------------------------------------------

test('quiet timer waits for quiet', () => {
    const t = new FakeTimers();
    let done = 0;
    const q = new QuietTimer(t, {quiet: 1000, onDone: () => done++});
    q.poke();
    t.advance(900);
    q.poke();
    t.advance(900);
    eq(done, 0);
    t.advance(100);
    eq(done, 1);
    eq(q.active, false);
    t.advance(5000);
    eq(done, 1);
});

test('quiet timer gives up waiting at max', () => {
    const t = new FakeTimers();
    let done = 0;
    const q = new QuietTimer(t, {quiet: 1000, max: 3000, onDone: () => done++});
    q.poke();
    for (let i = 0; i < 10; i++) {
        t.advance(500);
        if (q.active)
            q.poke();
    }
    eq(done, 1);
    eq(t.now, 5000);
});

test('title waiter: Chrome-like title change after mapping', () => {
    const t = new FakeTimers();
    let doneAt = -1;
    const q = new QuietTimer(t, {quiet: 1000, max: 3000, onDone: () => (doneAt = t.now)});
    q.poke(); // shown
    t.advance(200);
    q.poke(); // title changed
    t.advance(2000);
    eq(doneAt, 1200);
});

test('cancelled timer never fires', () => {
    const t = new FakeTimers();
    let done = 0;
    const q = new QuietTimer(t, {quiet: 1000, max: 3000, onDone: () => done++});
    q.poke();
    q.cancel();
    t.advance(10000);
    eq(done, 0);
});

test('monitor settler: one start and one settle per burst', () => {
    const t = new FakeTimers();
    const events = [];
    const s = new MonitorSettler(t, {
        delay: 1500,
        onStart: () => events.push(`start@${t.now}`),
        onSettled: () => events.push(`settled@${t.now}`),
    });
    s.poke();
    t.advance(400);
    s.poke();
    t.advance(1000);
    s.poke();
    eq(s.settling, true);
    t.advance(1499);
    eq(s.settling, true);
    t.advance(1);
    eq(events, ['start@0', 'settled@2900']);
    eq(s.settling, false);
    s.poke();
    t.advance(2000);
    eq(events, ['start@0', 'settled@2900', 'start@2900', 'settled@4400']);
});

// --- state.js ---------------------------------------------------------------

test('normalizeState drops malformed parts and keeps good ones', () => {
    const state = normalizeState({
        lastSetupKey: 'S',
        setups: {S: {name: 'Home', named: true, monitors: [{id: 'a'}, 5]}, T: 'x'},
        pins: [pin('a', 'chrome', 'Mail'), {id: 'b'}, pin('a', 'chrome', 'dup')],
        remember: {chrome: {appName: 'Chrome'}, code: 1},
        closed: {chrome: [{title: 'x', setupKey: 'S', closedAt: 1, ...spot()}, {title: 'bad'}]},
        openWindows: {12: {wmClass: 'chrome', spots: {S: spot(), T: {}}, pins: {S: 'a', T: 3}}},
    });
    eq(Object.keys(state.setups), ['S']);
    eq(state.setups.S.monitors, [{id: 'a', label: 'a', builtin: false}]);
    eq(state.pins.map(p => p.id), ['a']);
    eq(state.pins[0].exactTitle, false);
    eq(normalizeState({pins: [{...pin('x', 'a', 't'), exactTitle: true}]}).pins[0].exactTitle, true);
    eq(state.remember, {chrome: {appName: 'Chrome'}, code: {appName: 'code'}});
    eq(state.closed.chrome.length, 1);
    eq(Object.keys(state.openWindows['12'].spots), ['S']);
    eq(state.openWindows['12'].pins, {S: 'a'});
    eq(normalizeState(null), emptyState());
    eq(normalizeState('garbage'), emptyState());
});

test('prune drops old closed spots, apps switched off, dead windows, removed pins', () => {
    const now = 100 * CLOSED_MAX_AGE_MS;
    const state = emptyState();
    state.remember = {chrome: {appName: 'Chrome'}};
    state.closed = {
        chrome: [
            {title: 'old', setupKey: 'S', closedAt: now - CLOSED_MAX_AGE_MS - 1, ...spot()},
            {title: 'new', setupKey: 'S', closedAt: now - 1000, ...spot()},
        ],
        code: [{title: 'x', setupKey: 'S', closedAt: now, ...spot()}],
    };
    state.pins = [pin('a', 'chrome', 'Mail')];
    state.openWindows = {
        1: {wmClass: 'chrome', title: null, lastSeen: 0, spots: {}, pins: {S: 'a', T: 'gone'}},
        2: {wmClass: 'chrome', title: null, lastSeen: 0, spots: {}, pins: {}},
    };
    pruneState(state, {now, liveKeys: new Set(['1'])});
    eq(state.closed.chrome.map(e => e.title), ['new']);
    eq(state.closed.code, undefined);
    eq(Object.keys(state.openWindows), ['1']);
    eq(state.openWindows['1'].pins, {S: 'a'});
});

test('closed entries: one per title and setup, newest kept', () => {
    const state = emptyState();
    addClosedEntries(state, 'chrome', 'Mail', {S: {...spot('m1'), at: 5}, T: spot('m2')}, 10);
    addClosedEntries(state, 'chrome', 'Mail', {S: spot('m3')}, 20);
    addClosedEntries(state, 'chrome', 'Cal', {S: spot('m4')}, 30);
    const list = state.closed.chrome;
    eq(list.length, 3);
    eq(list.filter(e => e.setupKey === 'S' && e.title === 'Mail').map(e => e.monitor), ['m3']);
    eq('at' in list[0], false);
});

test('open windows of an earlier shell become closed windows for remembered apps', () => {
    const state = emptyState();
    state.remember = {obsidian: {appName: 'Obsidian'}};
    state.closed = {obsidian: [
        {title: 'Vault', setupKey: 'S', closedAt: 50, ...spot('older')},
        {title: 'Notes', setupKey: 'S', closedAt: 900, ...spot('newer')},
    ]};
    state.openWindows = {
        5: {wmClass: 'obsidian', title: 'Vault', lastSeen: 100,
            spots: {S: {...spot('m1'), at: 90}, T: {...spot('m2'), at: 120}}, pins: {}},
        6: {wmClass: 'obsidian', title: 'Notes', lastSeen: 500, spots: {S: spot('stale')}, pins: {}},
        7: {wmClass: 'chrome', title: 'Mail', lastSeen: 100, spots: {S: spot('c')}, pins: {}},
        8: {wmClass: 'obsidian', title: 'Empty', lastSeen: 100, spots: {}, pins: {}},
    };
    closeStaleOpenWindows(state, 1000);
    eq(state.openWindows, {});
    eq(state.closed.chrome, undefined);
    const byKey = Object.fromEntries(state.closed.obsidian.map(e => [`${e.title}/${e.setupKey}`, e]));
    // Replaces the older closed entry; time is the latest it was seen.
    eq([byKey['Vault/S'].monitor, byKey['Vault/S'].closedAt], ['m1', 120]);
    eq([byKey['Vault/T'].monitor, byKey['Vault/T'].closedAt], ['m2', 120]);
    // A newer closed entry with the same title wins over an older open one.
    eq(byKey['Notes/S'].monitor, 'newer');
    eq(byKey['Empty/S'], undefined);
    eq(chooseClosedSpot(state.closed.obsidian, 'Vault', 'S').monitor, 'm1');
});

test('held pins exclude the asking window and dead windows', () => {
    const state = emptyState();
    state.openWindows = {
        1: {pins: {S: 'a'}}, 2: {pins: {S: 'b'}}, 3: {pins: {S: 'c', T: 'd'}},
    };
    eq([...heldPinIds(state, 'S', new Set(['1', '2']), '2')], ['a']);
    eq([...heldPinIds(state, 'T', new Set(['1', '2', '3']))], ['d']);
});

test('pin ids are unique', () => {
    const ids = new Set();
    for (let i = 0; i < 500; i++)
        ids.add(newPinId(12345));
    eq(ids.size, 500);
});

// ---------------------------------------------------------------------------

for (const f of failures)
    print(`FAIL ${f}`);
print(`${passed} passed, ${failures.length} failed`);
if (failures.length)
    system.exit(1);
