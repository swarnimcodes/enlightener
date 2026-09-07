UUID := enlightener@swarnim
ZIP := $(UUID).shell-extension.zip

.PHONY: test pack install

test:
	gjs -m tests/lyricsModel.test.js
	glib-compile-schemas --strict --dry-run extension/schemas
	bash -n lyrics.sh

pack: test
	gnome-extensions pack extension --force \
		--extra-source=LICENSE \
		--extra-source=lyricsModel.js \
		--extra-source=vendor

install: pack
	gnome-extensions install --force $(ZIP)
