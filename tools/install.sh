#!/bin/bash
# Installs window-pins, or updates it, and reloads it in the running
# GNOME Shell without logging out where that is possible.
#
#   tools/install.sh [--src DIR] [--dest DIR] [--no-reload]
#
#   --src DIR    versioned code to install (default: src/ of this repo)
#   --dest DIR   extension directory (default: the user's extensions
#                directory, following $XDG_DATA_HOME)
#   --no-reload  only install; do not turn the extension off and on
#
# The extension directory holds the loader (extension.js), metadata.json
# and the settings schema, plus versions/<id>/ with the code. The code is
# copied into a new version directory, named by the git commit, "-dirty"
# for uncommitted changes, and the time; `current` is switched to it and
# the id it replaces goes to `previous`. The newest $KEEP versions are
# kept. GJS caches modules by URL, so the new directory is what makes a
# disable and enable run the new code.
#
# A changed loader or metadata.json, or a first install, still needs a
# logout: the running shell keeps the loader and metadata it read at
# login. The script says so instead of reloading.
#
# After a reload it waits for the loader's "running version <id>" line in
# the journal (or in the file $WP_SHELL_LOG, for the nested test shell).
set -euo pipefail

KEEP=3
uuid=window-pins@robindavidss0n.github.io
repo=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
src=$repo/src
root=$repo/extension
dest=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid
reload=1

while (($#)); do
    case $1 in
        --src) src=$(readlink -f "$2"); shift 2 ;;
        --dest) dest=$2; shift 2 ;;
        --no-reload) reload=0; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

[[ -f $src/main.js ]] || { echo "no main.js in $src" >&2; exit 1; }

hash=$(git -C "$repo" rev-parse --short HEAD 2> /dev/null || echo nogit)
[[ -n $(git -C "$repo" status --porcelain 2> /dev/null) ]] && hash+=-dirty
base="$hash-$(date +%Y%m%d-%H%M%S)"
id=$base
n=1
while [[ -e $dest/versions/$id ]]; do
    n=$((n + 1))
    id=$base-$n
done

fresh=0
[[ -f $dest/extension.js && -f $dest/current ]] || fresh=1
loader_changed=0
for f in extension.js metadata.json; do
    cmp -s "$root/$f" "$dest/$f" || loader_changed=1
done
schema_changed=0
for f in "$root"/schemas/*.gschema.xml; do
    cmp -s "$f" "$dest/schemas/$(basename "$f")" || schema_changed=1
done

# The code, into a new version directory.
mkdir -p "$dest/versions"
rm -rf "$dest/versions/.incoming"
cp -r "$src" "$dest/versions/.incoming"
find "$dest/versions/.incoming" -name '*~' -delete
mv "$dest/versions/.incoming" "$dest/versions/$id"

# Loader, metadata and schema at the top.
cp "$root/extension.js" "$root/metadata.json" "$dest/"
mkdir -p "$dest/schemas"
cp "$root"/schemas/*.gschema.xml "$dest/schemas/"
glib-compile-schemas "$dest/schemas"
# Code from before the loader existed.
rm -rf "$dest/lib" "$dest/shell"

previous=$(cat "$dest/current" 2> /dev/null || true)
if [[ -n $previous && $previous != "$id" ]]; then
    echo "$previous" > "$dest/previous.new"
    mv -f "$dest/previous.new" "$dest/previous"
fi
echo "$id" > "$dest/current.new"
mv -f "$dest/current.new" "$dest/current"
echo "Installed version $id in $dest"

# Keep the newest versions, always including current and previous.
kept=0
while IFS= read -r dir; do
    name=$(basename "$dir")
    if [[ $name == "$id" || $name == "$previous" ]] || ((kept < KEEP)); then
        kept=$((kept + 1))
        continue
    fi
    rm -rf "$dir"
done < <(ls -1dt "$dest"/versions/*/ 2> /dev/null | sed 's:/$::')

((reload)) || exit 0

if ((fresh)); then
    echo "First install: log out and back in once, then enable it with"
    echo "  gnome-extensions enable $uuid"
    exit 0
fi
if ((loader_changed)); then
    echo "The loader or metadata.json changed: log out and back in once to load it."
    exit 0
fi

state=$(gnome-extensions info "$uuid" 2> /dev/null | sed -n 's/^ *State: *//p' || true)
case $state in
    ACTIVE | ENABLED) ;;
    "")
        echo "GNOME Shell does not know the extension yet: log out and back in once."
        exit 0
        ;;
    *)
        echo "The extension is not on (state $state); it will run version $id once it is enabled."
        exit 0
        ;;
esac

since=$(date +%s)
gnome-extensions disable "$uuid"
gnome-extensions enable "$uuid"

shell_log() {
    if [[ -n ${WP_SHELL_LOG:-} ]]; then
        cat "$WP_SHELL_LOG"
    else
        journalctl --user --since "@$since" -o cat 2> /dev/null
    fi
}
for _ in $(seq 20); do
    sleep 0.25
    lines=$(shell_log | grep -a '\[window-pins\]' || true)
    if grep -q "running version $id\$" <<< "$lines"; then
        echo "Reloaded: version $id is running."
        ((schema_changed)) && echo "The settings schema changed; new keys are available now."
        exit 0
    fi
    if grep -q "cannot load version $id" <<< "$lines"; then
        sleep 0.5
        lines=$(shell_log | grep -a '\[window-pins\]' || true)
        echo "Version $id failed to load:" >&2
        grep -a "cannot load version $id" <<< "$lines" | tail -1 | sed 's/^.*\[window-pins\] /  /' >&2
        running=$(grep -a "running version" <<< "$lines" | tail -1 | sed 's/^.*\[window-pins\] /  /')
        echo "${running:-  no version is running}" >&2
        exit 1
    fi
done
echo "Turned the extension off and on, but saw no \"running version $id\" in the log;" >&2
echo "check with: journalctl --user -o cat | grep '\\[window-pins\\]'" >&2
exit 1
