UUID := window-pins@robindavidss0n.github.io
SRC := extension
EXTENSIONS_DIR := $(HOME)/.local/share/gnome-shell/extensions

.PHONY: all schemas zip install link test test-nested clean

all: schemas

schemas: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SRC)/schemas/*.gschema.xml
	glib-compile-schemas $(SRC)/schemas

# Builds $(UUID).shell-extension.zip for `gnome-extensions install`.
zip: schemas
	gnome-extensions pack --force --out-dir=. \
		--extra-source=lib --extra-source=shell $(SRC)

# Installs the zip (a copy); log out and in to load it on Wayland.
install: zip
	gnome-extensions install --force $(UUID).shell-extension.zip

# Links the source tree instead of copying it, for development.
link: schemas
	mkdir -p $(EXTENSIONS_DIR)
	ln -sfn $(CURDIR)/$(SRC) $(EXTENSIONS_DIR)/$(UUID)

test:
	gjs -m tests/unit.js

# Starts a headless nested GNOME Shell; does not touch the running session.
test-nested:
	tests/nested/e2e.sh

clean:
	rm -f $(UUID).shell-extension.zip $(SRC)/schemas/gschemas.compiled
