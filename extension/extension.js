// SPDX-License-Identifier: MIT

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Gio.DBusProxy, 'new_for_bus', 'new_for_bus_finish');
Gio._promisify(Soup.Session.prototype,
    'send_and_read_async', 'send_and_read_finish');

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const TICK_INTERVAL_MS = 200;
const MAX_CACHE_ENTRIES = 50;

function unpack(value) {
    return value instanceof GLib.Variant ? value.deepUnpack() : value;
}

function makeUrl(endpoint, parameters) {
    const query = Object.entries(parameters)
        .filter(([, value]) => value !== '' && value !== null && value !== undefined)
        .map(([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');

    return `https://lrclib.net/api/${endpoint}?${query}`;
}

function parseSyncedLyrics(syncedLyrics) {
    if (!syncedLyrics)
        return [];

    const lines = [];
    const timestampPattern = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

    for (const rawLine of syncedLyrics.split('\n')) {
        const timestamps = [...rawLine.matchAll(timestampPattern)];
        const text = rawLine.replace(
            /^(?:\[\d+:\d+(?:\.\d+)?\]\s*)+/, '');

        for (const match of timestamps) {
            lines.push({
                time: Number(match[1]) * 60 + Number(match[2]),
                text,
            });
        }
    }

    return lines.sort((a, b) => a.time - b.time);
}

export default class EnlightenerExtension extends Extension {
    enable() {
        this._lifecycleGeneration = (this._lifecycleGeneration ?? 0) + 1;
        this._enabled = true;
        this._players = new Map();
        this._pendingPlayers = new Set();
        this._lyricsCache = new Map();
        this._selectedPlayer = null;
        this._trackKey = null;
        this._lines = [];
        this._currentText = '';
        this._positionUs = 0;
        this._positionReadAtUs = GLib.get_monotonic_time();
        this._playbackStatus = 'Stopped';
        this._rate = 1;
        this._userVisible = true;
        this._lyricsGeneration = 0;
        this._positionSerial = 0;
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 15});

        this._createOverlay();

        this._settings = this.getSettings();
        Main.wm.addKeybinding(
            'toggle-overlay',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleOverlay());

        this._nameOwnerSignalId = Gio.DBus.session.signal_subscribe(
            DBUS_INTERFACE,
            DBUS_INTERFACE,
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, parameters) => {
                const [name, oldOwner, newOwner] = parameters.deepUnpack();

                if (!name.startsWith(MPRIS_PREFIX) ||
                    name === `${MPRIS_PREFIX}playerctld`)
                    return;

                if (newOwner && !oldOwner)
                    this._addPlayer(name);
                else if (oldOwner && !newOwner)
                    this._removePlayer(name);
            });

        this._tickId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TICK_INTERVAL_MS,
            () => {
                this._updateCurrentLine();
                return GLib.SOURCE_CONTINUE;
            });

        this._discoverPlayers().catch(error => this._logError(error));
    }

    disable() {
        this._enabled = false;
        this._lifecycleGeneration++;
        this._lyricsGeneration++;
        this._positionSerial++;

        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }

        if (this._nameOwnerSignalId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerSignalId);
            this._nameOwnerSignalId = 0;
        }

        Main.wm.removeKeybinding('toggle-overlay');

        this._cancellable?.cancel();
        this._lyricsCancellable?.cancel();
        this._session?.abort();

        for (const entry of this._players.values())
            this._disconnectPlayer(entry);

        this._players.clear();
        this._pendingPlayers.clear();

        if (this._monitorSignalId) {
            Main.layoutManager.disconnect(this._monitorSignalId);
            this._monitorSignalId = 0;
        }

        if (this._overlay) {
            Main.layoutManager.removeChrome(this._overlay);
            this._overlay.destroy();
        }

        this._overlay = null;
        this._label = null;
        this._settings = null;
        this._session = null;
        this._cancellable = null;
        this._lyricsCancellable = null;
        this._players = null;
        this._pendingPlayers = null;
        this._lyricsCache = null;
    }

    _createOverlay() {
        this._overlay = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            visible: false,
        });
        this._label = new St.Label({
            style_class: 'enlightener-overlay',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        this._label.clutter_text.set({
            line_alignment: Pango.Alignment.CENTER,
            line_wrap: true,
        });
        this._overlay.add_child(this._label);

        Main.layoutManager.addChrome(this._overlay, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._monitorSignalId = Main.layoutManager.connect(
            'monitors-changed', () => this._updateOverlayGeometry());
        this._updateOverlayGeometry();
    }

    _updateOverlayGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._overlay)
            return;

        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._label.set_width(Math.floor(monitor.width * 0.8));
    }

    _toggleOverlay() {
        this._userVisible = !this._userVisible;
        this._overlay.visible = this._userVisible && Boolean(this._currentText);
    }

    async _discoverPlayers() {
        const lifecycle = this._lifecycleGeneration;
        const result = await Gio.DBus.session.call(
            DBUS_INTERFACE,
            '/org/freedesktop/DBus',
            DBUS_INTERFACE,
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable);

        if (!this._enabled || lifecycle !== this._lifecycleGeneration)
            return;

        const [names] = result.deepUnpack();
        for (const name of names) {
            if (name.startsWith(MPRIS_PREFIX) &&
                name !== `${MPRIS_PREFIX}playerctld`)
                this._addPlayer(name);
        }
    }

    async _addPlayer(name) {
        if (!this._enabled || this._players.has(name) ||
            this._pendingPlayers.has(name))
            return;

        this._pendingPlayers.add(name);
        const lifecycle = this._lifecycleGeneration;

        try {
            const proxy = await Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START |
                    Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
                null,
                name,
                MPRIS_PATH,
                PLAYER_INTERFACE,
                this._cancellable);

            if (!this._enabled || lifecycle !== this._lifecycleGeneration ||
                !proxy.g_name_owner)
                return;

            const entry = {proxy};
            entry.propertiesSignalId = proxy.connect(
                'g-properties-changed', (_proxy, changed) =>
                    this._onPropertiesChanged(name, changed));
            entry.signalId = proxy.connect(
                'g-signal', (_proxy, _sender, signalName, parameters) => {
                    if (signalName === 'Seeked' && name === this._selectedPlayer) {
                        const [positionUs] = parameters.deepUnpack();
                        this._positionSerial++;
                        this._setPosition(Number(positionUs));
                        this._updateCurrentLine();
                    }
                });
            entry.ownerSignalId = proxy.connect('notify::g-name-owner', () => {
                if (!proxy.g_name_owner)
                    this._removePlayer(name);
            });

            this._players.set(name, entry);
            this._choosePlayer();
        } catch (error) {
            if (lifecycle === this._lifecycleGeneration)
                this._logError(error);
        } finally {
            if (lifecycle === this._lifecycleGeneration)
                this._pendingPlayers?.delete(name);
        }
    }

    _removePlayer(name) {
        const entry = this._players?.get(name);
        if (!entry)
            return;

        this._disconnectPlayer(entry);
        this._players.delete(name);

        if (name === this._selectedPlayer) {
            this._selectedPlayer = null;
            this._trackKey = null;
            this._lines = [];
            this._setText('');
        }

        this._choosePlayer();
    }

    _disconnectPlayer(entry) {
        for (const signalId of [
            entry.propertiesSignalId,
            entry.signalId,
            entry.ownerSignalId,
        ]) {
            if (signalId)
                entry.proxy.disconnect(signalId);
        }
    }

    _onPropertiesChanged(name, changed) {
        const changedProperties = changed.deepUnpack();
        this._choosePlayer();

        if (name !== this._selectedPlayer)
            return;

        if ('Metadata' in changedProperties)
            this._updateTrack();

        if ('PlaybackStatus' in changedProperties ||
            'Rate' in changedProperties) {
            this._readPlaybackState();
            this._syncPosition();
        }
    }

    _choosePlayer() {
        if (!this._players?.size)
            return;

        const entries = [...this._players.entries()];
        const playing = entries.find(([, entry]) =>
            this._property(entry.proxy, 'PlaybackStatus', 'Stopped') === 'Playing');
        const nextName = playing?.[0] ??
            (this._players.has(this._selectedPlayer)
                ? this._selectedPlayer
                : entries[0][0]);

        if (nextName === this._selectedPlayer)
            return;

        this._selectedPlayer = nextName;
        this._trackKey = null;
        this._lines = [];
        this._readPlaybackState();
        this._updateTrack();
        this._syncPosition();
    }

    _property(proxy, name, fallback = null) {
        const value = proxy.get_cached_property(name);
        return value ? unpack(value.deepUnpack()) : fallback;
    }

    _readPlaybackState() {
        const entry = this._players.get(this._selectedPlayer);
        if (!entry)
            return;

        this._positionUs = this._currentPositionUs();
        this._positionReadAtUs = GLib.get_monotonic_time();
        this._playbackStatus = this._property(
            entry.proxy, 'PlaybackStatus', 'Stopped');
        this._rate = Number(this._property(entry.proxy, 'Rate', 1)) || 1;

        if (this._playbackStatus === 'Stopped')
            this._setText('');
    }

    _updateTrack() {
        const entry = this._players.get(this._selectedPlayer);
        if (!entry)
            return;

        const metadata = this._property(entry.proxy, 'Metadata', {});
        const title = String(unpack(metadata['xesam:title']) ?? '');
        const artistValue = unpack(metadata['xesam:artist']);
        const artists = Array.isArray(artistValue)
            ? artistValue.map(String)
            : [String(artistValue ?? '')];
        const artist = artists.filter(Boolean).join(', ');
        const album = String(unpack(metadata['xesam:album']) ?? '');
        const durationUs = Number(unpack(metadata['mpris:length']) ?? 0);
        const trackId = String(unpack(metadata['mpris:trackid']) ?? '');

        if (!title || !artist) {
            this._trackKey = null;
            this._lines = [];
            this._setText('');
            return;
        }

        const metadataKey = `${artist}\u0000${album}\u0000${title}\u0000${durationUs}`;
        const trackKey = `${this._selectedPlayer}\u0000${trackId}\u0000${metadataKey}`;
        if (trackKey === this._trackKey)
            return;

        this._trackKey = trackKey;
        this._lines = [];
        this._positionSerial++;
        this._setPosition(0);
        this._setText('Finding synchronized lyrics...');
        this._syncPosition();

        const track = {
            key: trackKey,
            cacheKey: metadataKey,
            title,
            artist,
            album,
            duration: Math.round(durationUs / 1_000_000),
        };

        const cached = this._lyricsCache.get(track.cacheKey);
        if (cached) {
            this._lines = cached;
            this._updateCurrentLine();
            return;
        }

        this._loadLyrics(track);
    }

    async _syncPosition() {
        const playerName = this._selectedPlayer;
        const trackKey = this._trackKey;
        const lifecycle = this._lifecycleGeneration;
        const serial = ++this._positionSerial;
        if (!playerName)
            return;

        try {
            const result = await Gio.DBus.session.call(
                playerName,
                MPRIS_PATH,
                PROPERTIES_INTERFACE,
                'Get',
                new GLib.Variant('(ss)', [PLAYER_INTERFACE, 'Position']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable);

            if (!this._enabled || lifecycle !== this._lifecycleGeneration ||
                serial !== this._positionSerial ||
                playerName !== this._selectedPlayer || trackKey !== this._trackKey)
                return;

            const [position] = result.deepUnpack();
            this._setPosition(Number(unpack(position)));
            this._updateCurrentLine();
        } catch (error) {
            if (lifecycle === this._lifecycleGeneration &&
                serial === this._positionSerial)
                this._logError(error);
        }
    }

    _setPosition(positionUs) {
        this._positionUs = positionUs;
        this._positionReadAtUs = GLib.get_monotonic_time();
    }

    _currentPositionUs() {
        let positionUs = this._positionUs;

        if (this._playbackStatus === 'Playing') {
            positionUs += (GLib.get_monotonic_time() - this._positionReadAtUs) *
                this._rate;
        }

        return positionUs;
    }

    _currentPositionSeconds() {
        return this._currentPositionUs() / 1_000_000;
    }

    async _loadLyrics(track) {
        const lifecycle = this._lifecycleGeneration;
        const generation = ++this._lyricsGeneration;
        this._lyricsCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._lyricsCancellable = cancellable;

        try {
            let lyrics;
            const exactParameters = {
                track_name: track.title,
                artist_name: track.artist,
                album_name: track.album,
                duration: track.duration || null,
            };

            try {
                lyrics = await this._requestJson(
                    makeUrl('get', exactParameters), cancellable);
            } catch (error) {
                if (error.status !== Soup.Status.NOT_FOUND)
                    throw error;

                const results = await this._requestJson(makeUrl('search', {
                    track_name: track.title,
                    artist_name: track.artist,
                }), cancellable);
                lyrics = this._bestSearchResult(results, track.duration);
            }

            if (!this._enabled || lifecycle !== this._lifecycleGeneration ||
                generation !== this._lyricsGeneration ||
                track.key !== this._trackKey)
                return;

            const lines = parseSyncedLyrics(lyrics?.syncedLyrics);
            if (!lines.length) {
                this._setText('No synchronized lyrics found');
                return;
            }

            if (this._lyricsCache.size >= MAX_CACHE_ENTRIES) {
                const oldestKey = this._lyricsCache.keys().next().value;
                this._lyricsCache.delete(oldestKey);
            }
            this._lyricsCache.set(track.cacheKey, lines);
            this._lines = lines;
            this._updateCurrentLine();
        } catch (error) {
            if (lifecycle === this._lifecycleGeneration &&
                !this._isCancelled(error)) {
                this._setText('Could not load lyrics');
                this._logError(error);
            }
        } finally {
            if (lifecycle === this._lifecycleGeneration &&
                generation === this._lyricsGeneration &&
                this._lyricsCancellable === cancellable)
                this._lyricsCancellable = null;
        }
    }

    async _requestJson(url, cancellable) {
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', 'Enlightener/0.1');

        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();

        if (status < 200 || status >= 300) {
            const error = new Error(`LRCLIB returned HTTP ${status}`);
            error.status = status;
            throw error;
        }

        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    _bestSearchResult(results, targetDuration) {
        if (!Array.isArray(results) || !results.length)
            return null;

        return results.toSorted((a, b) => {
            const syncedDifference = Number(b.syncedLyrics !== null) -
                Number(a.syncedLyrics !== null);
            if (syncedDifference)
                return syncedDifference;

            return Math.abs(Number(a.duration) - targetDuration) -
                Math.abs(Number(b.duration) - targetDuration);
        })[0];
    }

    _updateCurrentLine() {
        if (!this._lines.length || this._playbackStatus === 'Stopped')
            return;

        const position = this._currentPositionSeconds();
        let low = 0;
        let high = this._lines.length - 1;
        let match = -1;

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (this._lines[middle].time <= position) {
                match = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        this._setText(match >= 0 ? this._lines[match].text : '');
    }

    _setText(text) {
        this._currentText = text;
        if (!this._label || !this._overlay)
            return;

        this._label.text = text;
        this._overlay.visible = this._userVisible && Boolean(text);
    }

    _isCancelled(error) {
        return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
    }

    _logError(error) {
        if (this._enabled && !this._isCancelled(error))
            console.error(`[${this.uuid}] ${error.message}`, error.stack ?? '');
    }
}
