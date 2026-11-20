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

/** A window that was placed is checked once its frame has not changed for
 * this long while it is on the workspace that is shown. Clients ack a new
 * size within a frame or two; a client that moves or resizes the window
 * again on its own does so right after (or right after its workspace is
 * shown). */
export const PLACED_QUIET_MS = 1000;

/** ...but at the latest this long after the wait started counting, even if
 * the frame keeps changing. The wait only starts counting once the window
 * is on the workspace that is shown. */
export const LAND_TIMEOUT_MS = 2000;

/** How often a window is placed on its spot at most: the placement, and
 * one more when the check finds it elsewhere. */
export const PLACE_ATTEMPTS = 2;

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

/**
 * Checks that a window window-pins placed stays on its spot, and places it
 * again once when it does not.
 *
 * A Wayland client whose window is on a workspace that is not shown may
 * not ack its new size until that workspace is shown, and some clients
 * move or resize their window on their own right after it is placed. So
 * the check waits until the window is on the workspace that is shown and
 * its frame has been quiet for PLACED_QUIET_MS (at most LAND_TIMEOUT_MS
 * once that wait has started; it then runs to the end, even if the window
 * is hidden again). Until then there is no timeout.
 *
 * When the window is not on its spot, placeAgain() puts it there again
 * and the wait starts over; when it misses again, the check gives up.
 *
 * Callbacks:
 * - isVisible(): the window is on the shown workspace (or on all)
 * - isAtSpot(): the window is on its spot
 * - placeAgain(): place it again; returns applySpot's result
 *   ('moved', 'already-there', or why it could not be placed)
 * - onDeferred(): the wait is held back for a hidden workspace (once per
 *   attempt)
 * - onDone(outcome): 'confirmed' (on its spot), 'missed' (not on its spot
 *   after the last attempt, or it could not be placed again)
 */
export class PlacementCheck {
    /**
     * @param {{add: Function, remove: Function}} timers
     * @param {object} callbacks
     */
    constructor(timers, {isVisible, isAtSpot, placeAgain, onDeferred = () => {}, onDone}) {
        this._isVisible = isVisible;
        this._isAtSpot = isAtSpot;
        this._placeAgain = placeAgain;
        this._onDeferred = onDeferred;
        this._onDone = onDone;
        this._timer = new QuietTimer(timers, {
            quiet: PLACED_QUIET_MS,
            max: LAND_TIMEOUT_MS,
            onDone: () => this._check(),
        });
        this.attempt = 1;
        this.deferred = false;
        this.active = true;
    }

    /** The window was placed, its frame, maximize state or workspace
     * changed, or another workspace is shown. */
    changed() {
        if (!this.active)
            return;
        if (this._timer.active || this._isVisible()) {
            this._timer.poke();
        } else if (!this.deferred) {
            this.deferred = true;
            this._onDeferred();
        }
    }

    _check() {
        if (this._isAtSpot()) {
            this._finish('confirmed');
            return;
        }
        if (this.attempt >= PLACE_ATTEMPTS) {
            this._finish('missed');
            return;
        }
        this.attempt++;
        this.deferred = false;
        const result = this._placeAgain();
        if (result === 'already-there')
            this._finish('confirmed');
        else if (result !== 'moved')
            this._finish('missed');
        else
            this.changed();
    }

    _finish(outcome) {
        this._timer.cancel();
        this.active = false;
        this._onDone(outcome);
    }

    /** Stop checking without calling onDone. */
    cancel() {
        this._timer.cancel();
        this.active = false;
    }
}
