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
- Pause, resume, and seek synchronization
- In-memory lyrics cache
- `Super+Alt+L` visibility toggle

## Install

Build and install the extension locally:

```sh
gnome-extensions pack extension --force
gnome-extensions install --force enlightener@swarnim.shell-extension.zip
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

The repository also contains `lyrics.sh`, the initial CLI prototype. It
requires `playerctl`, `curl`, and `jq`.

## License

MIT
