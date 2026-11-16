// GType names for this version's GObject classes.
//
// GObject.registerClass derives a class's GType name from its module's
// path inside the extension, so the same class in two installed versions
// would get the same name, and the second registration fails: a reload
// would never get past it. Each version's names carry a tag made from
// this module's URL, which differs per version directory.

function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++)
        h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(16);
}

const tag = hash(import.meta.url);

/**
 * @param {string} name class name
 * @returns {string} a GType name unique to this installed version
 */
export function gtypeName(name) {
    return `WindowPins_${name}_${tag}`;
}
