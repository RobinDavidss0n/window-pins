// Rectangle maths. No Shell imports: testable outside the shell.
//
// Positions are kept relative to the work area of the monitor the window
// is on (the monitor minus panels and docks), together with the size of
// that work area when the position was taken.

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rect
 * @typedef {{x: number, y: number, width: number, height: number,
 *   areaWidth: number, areaHeight: number}} RelRect
 */

/**
 * @param {Rect} frame window frame in stage coordinates
 * @param {Rect} area work area of the window's monitor
 * @returns {RelRect}
 */
export function toRelative(frame, area) {
    return {
        x: frame.x - area.x,
        y: frame.y - area.y,
        width: frame.width,
        height: frame.height,
        areaWidth: area.width,
        areaHeight: area.height,
    };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Turn a relative rect back into stage coordinates on a work area.
 *
 * When the work area has the size it had when the rect was taken, the rect
 * comes back exactly, even if partly off screen. When the size differs
 * (other resolution or scale, panel shown or hidden), it is scaled to the
 * new size and kept inside the work area.
 *
 * @param {RelRect} rel
 * @param {Rect} area
 * @returns {Rect}
 */
export function toAbsolute(rel, area) {
    let {x, y, width, height} = rel;
    const sameSize = rel.areaWidth === area.width && rel.areaHeight === area.height;
    if (!sameSize) {
        if (rel.areaWidth > 0) {
            const f = area.width / rel.areaWidth;
            x = Math.round(x * f);
            width = Math.round(width * f);
        }
        if (rel.areaHeight > 0) {
            const f = area.height / rel.areaHeight;
            y = Math.round(y * f);
            height = Math.round(height * f);
        }
        width = clamp(width, 1, area.width);
        height = clamp(height, 1, area.height);
        x = clamp(x, 0, area.width - width);
        y = clamp(y, 0, area.height - height);
    }
    return {x: area.x + x, y: area.y + y, width, height};
}

/**
 * Whether two rects are the same within a tolerance (Mutter and clients
 * round sizes, and some clients snap to their own size increments).
 *
 * @param {Rect} a
 * @param {Rect} b
 * @param {number} tolerance pixels
 * @returns {boolean}
 */
export function sameRect(a, b, tolerance = 2) {
    return Math.abs(a.x - b.x) <= tolerance &&
        Math.abs(a.y - b.y) <= tolerance &&
        Math.abs(a.width - b.width) <= tolerance &&
        Math.abs(a.height - b.height) <= tolerance;
}

/**
 * Whether a window's frame has arrived at a requested rect: the position
 * within 2 px, the size within 16 px (terminals and some editors round
 * their size to whole character cells).
 *
 * @param {Rect} frame
 * @param {Rect} target
 * @returns {boolean}
 */
export function landedAt(frame, target) {
    return Math.abs(frame.x - target.x) <= 2 &&
        Math.abs(frame.y - target.y) <= 2 &&
        Math.abs(frame.width - target.width) <= 16 &&
        Math.abs(frame.height - target.height) <= 16;
}
