UUID := window-pins@robindavidss0n.github.io
BUILD := build

.PHONY: all install reload zip test test-nested clean

all: zip

# Installs into ~/.local/share/gnome-shell/extensions and, unless the
# loader or metadata changed, reloads it in the running shell.
install reload:
	tools/install.sh

# Builds $(UUID).shell-extension.zip for `gnome-extensions install`.
zip:
	rm -rf $(BUILD)
	tools/install.sh --dest $(BUILD)/$(UUID) --no-reload
	gnome-extensions pack --force --out-dir=. \
		--extra-source=versions --extra-source=current $(BUILD)/$(UUID)

test:
	gjs -m tests/unit.js

# Starts a headless nested GNOME Shell; does not touch the running session.
test-nested:
	tests/nested/e2e.sh

clean:
	rm -rf $(BUILD) $(UUID).shell-extension.zip
