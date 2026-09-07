# Enlightener

Enlightener is a GNOME Shell extension that displays synchronized lyrics for
the currently playing song in a bottom-center overlay.

It discovers MPRIS-compatible media players over D-Bus and requests lyrics
from [LRCLIB](https://lrclib.net). Song title, artist, album, and duration are
therefore sent to LRCLIB when a track starts.

## Current Features

- GNOME Shell 50 support
- Automatic MPRIS player and track detection
- Synchronized LRCLIB lyrics
- Lyricsfile 1.0 and word-synchronized lyric support
- Word highlighting and overlapping vocal lines
- Configurable surrounding lyric context
- Eight work-area-aware overlay positions
- Natural-width lyric cards with Adwaita-neutral colors
- Configurable background opacity
- Music indicator for instrumentals and timed interludes
- Pause, resume, and seek synchronization
- In-memory lyrics cache
- `Super+Alt+L` visibility toggle

## Install

Build and install the extension locally:

```sh
make install
```

Log out and back in after the first installation, then enable it:

```sh
gnome-extensions enable enlightener@swarnim
```

## Development

GNOME 50 can run a nested Shell for testing:

```sh
sudo pacman -S mutter-devkit
dbus-run-session gnome-shell --devkit --wayland
```

After changing the extension, rebuild and reinstall it, then restart the
nested Shell because GJS caches extension modules.

Open the preferences window with:

```sh
gnome-extensions prefs enlightener@swarnim
```

Run the lyric model tests with:

```sh
gjs -m tests/lyricsModel.test.js
```

The repository also contains `lyrics.sh`, the initial CLI prototype. It
requires `playerctl`, `curl`, and `jq`.

## License

MIT
