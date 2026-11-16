// Timers that wait for things to settle. No Shell imports: the timer
// functions are passed in, so tests can drive a fake clock.
//
// timers = {add(ms, fn) -> handle, remove(handle)}

/** Milliseconds after the last monitors-changed before the layout counts
 * as settled. Docks bring monitors up one after another over a second or
 * two, and a resume can drop and re-add them. */
export const MONITORS_SETTLE_MS = 1500;

/** A new window's title must stay unchanged this long before it is
 * matched (Chrome and Electron apps change it right after mapping). */
export const TITLE_QUIET_MS = 1000;

/** ...but a new window is matched at the latest this long after it was
 * shown, even if its title keeps changing. */
export const TITLE_MAX_WAIT_MS = 3000;

/** Window moves are recorded this long after the last change, so a drag
 * records once at the end. */
export const RECORD_DEBOUNCE_MS = 500;

/** State is written to disk this long after the last change. */
export const SAVE_DEBOUNCE_MS = 2000;

/**
 * Calls onDone once nothing has poked it for `quiet` ms, or `max` ms after
 * start, whichever comes first. Without `max`, it waits for quiet only.
 */
export class QuietTimer {
    /**
     * @param {{add: Function, remove: Function}} timers
     * @param {{quiet: number, max?: number, onDone: Function}} options
     */
    constructor(timers, {quiet, max = 0, onDone}) {
        this._timers = timers;
        this._quiet = quiet;
        this._max = max;
        this._onDone = onDone;
        this._quietHandle = null;
        this._maxHandle = null;
        this.active = false;
    }

    /** Start waiting, or restart the quiet period if already waiting. */
    poke() {
        if (!this.active) {
            this.active = true;
            if (this._max > 0)
                this._maxHandle = this._timers.add(this._max, () => this._finish());
        }
        if (this._quietHandle !== null)
            this._timers.remove(this._quietHandle);
        this._quietHandle = this._timers.add(this._quiet, () => this._finish());
    }

    _finish() {
        this._clear();
        this.active = false;
        this._onDone();
    }

    _clear() {
        if (this._quietHandle !== null)
            this._timers.remove(this._quietHandle);
        if (this._maxHandle !== null)
            this._timers.remove(this._maxHandle);
        this._quietHandle = null;
        this._maxHandle = null;
    }

    /** Stop waiting without calling onDone. */
    cancel() {
        this._clear();
        this.active = false;
    }
}

/**
 * Tracks the monitor layout changing. While it changes, nothing may be
 * recorded; when it has been quiet for MONITORS_SETTLE_MS, onSettled runs.
 */
export class MonitorSettler {
    /**
     * @param {{add: Function, remove: Function}} timers
     * @param {{onStart: Function, onSettled: Function, delay?: number}} options
     */
    constructor(timers, {onStart, onSettled, delay = MONITORS_SETTLE_MS}) {
        this._onStart = onStart;
        this._timer = new QuietTimer(timers, {quiet: delay, onDone: () => onSettled()});
    }

    /** @returns {boolean} the layout is changing */
    get settling() {
        return this._timer.active;
    }

    /** The layout changed (again). */
    poke() {
        const starting = !this._timer.active;
        this._timer.poke();
        if (starting)
            this._onStart();
    }

    cancel() {
        this._timer.cancel();
    }
}
