// SPDX-License-Identifier: MIT

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LyricsClient} from './lyricsClient.js';
import {LyricsOverlay} from './lyricsOverlay.js';
import {ShortcutManager} from './shortcutManager.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Gio.DBusProxy, 'new_for_bus', 'new_for_bus_finish');

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const TICK_INTERVAL_MS = 200;

function unpack(value) {
    return value instanceof GLib.Variant ? value.deepUnpack() : value;
}

export default class EnlightenerExtension extends Extension {
    enable() {
        this._lifecycleGeneration = (this._lifecycleGeneration ?? 0) + 1;
        this._enabled = true;
        this._players = new Map();
        this._pendingPlayers = new Set();
        this._lyricsClient = new LyricsClient();
        this._selectedPlayer = null;
        this._playerActivitySerial = 0;
        this._trackKey = null;
        this._document = null;
        this._positionUs = 0;
        this._positionReadAtUs = GLib.get_monotonic_time();
        this._playbackStatus = 'Stopped';
        this._rate = 1;
        this._lyricsGeneration = 0;
        this._positionSerial = 0;
        this._cancellable = new Gio.Cancellable();
        this._settings = this.getSettings();
        this._overlay = new LyricsOverlay(this._settings);

        this._shortcutManager = new ShortcutManager(
            this._settings, () => this._overlay.toggleVisibility());

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
                this._renderPlaybackFrame();
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

        this._shortcutManager?.destroy();
        this._shortcutManager = null;

        this._cancellable?.cancel();
        this._lyricsCancellable?.cancel();
        this._lyricsClient?.abort();

        for (const entry of this._players.values())
            this._disconnectPlayer(entry);

        this._players.clear();
        this._pendingPlayers.clear();

        this._overlay?.destroy();

        this._overlay = null;
        this._settings = null;
        this._cancellable = null;
        this._lyricsCancellable = null;
        this._players = null;
        this._pendingPlayers = null;
        this._lyricsClient = null;
        this._document = null;
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

            const entry = {
                proxy,
                lastActive: this._property(
                    proxy, 'PlaybackStatus', 'Stopped') === 'Playing'
                    ? ++this._playerActivitySerial
                    : 0,
            };
            entry.propertiesSignalId = proxy.connect(
                'g-properties-changed', (_proxy, changed) =>
                    this._onPropertiesChanged(name, changed));
            entry.signalId = proxy.connect(
                'g-signal', (_proxy, _sender, signalName, parameters) => {
                    if (signalName === 'Seeked' && name === this._selectedPlayer) {
                        const [positionUs] = parameters.deepUnpack();
                        this._positionSerial++;
                        this._setPosition(Number(positionUs));
                        this._renderPlaybackFrame();
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
            this._document = null;
            this._overlay.hide();
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
        const entry = this._players.get(name);
        if (entry &&
            ('PlaybackStatus' in changedProperties ||
                'Metadata' in changedProperties) &&
            this._property(entry.proxy, 'PlaybackStatus', 'Stopped') ===
                'Playing')
            entry.lastActive = ++this._playerActivitySerial;

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
        const playing = entries
            .filter(([, entry]) =>
                this._property(entry.proxy, 'PlaybackStatus', 'Stopped') ===
                    'Playing')
            .toSorted(([, a], [, b]) => b.lastActive - a.lastActive)[0];
        const nextName = playing?.[0] ??
            (this._players.has(this._selectedPlayer)
                ? this._selectedPlayer
                : entries[0][0]);

        if (nextName === this._selectedPlayer)
            return;

        this._selectedPlayer = nextName;
        this._trackKey = null;
        this._document = null;
        this._readPlaybackState();
        this._updateTrack();
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
            this._overlay.hide();
        else {
            this._renderPlaybackFrame();
        }
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
            this._document = null;
            this._overlay.hide();
            return;
        }

        const metadataKey = `${artist}\u0000${album}\u0000${title}\u0000${durationUs}`;
        const trackKey = `${this._selectedPlayer}\u0000${trackId}\u0000${metadataKey}`;
        if (trackKey === this._trackKey)
            return;

        this._trackKey = trackKey;
        this._document = null;
        this._positionSerial++;
        this._setPosition(0);
        this._overlay.showStatus('Finding synchronized lyrics...');
        this._syncPosition();

        const track = {
            key: trackKey,
            cacheKey: metadataKey,
            title,
            artist,
            album,
            duration: Math.round(durationUs / 1_000_000),
        };

        const cached = this._lyricsClient.getCached(track.cacheKey);
        if (cached) {
            this._document = cached;
            this._renderPlaybackFrame();
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
            this._renderPlaybackFrame();
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
            const document = await this._lyricsClient.fetch(track, cancellable);

            if (!this._enabled || lifecycle !== this._lifecycleGeneration ||
                generation !== this._lyricsGeneration ||
                track.key !== this._trackKey)
                return;

            if (!document.instrumental && !document.lines.length) {
                this._overlay.showStatus('No synchronized lyrics found');
                return;
            }

            this._lyricsClient.cache(track.cacheKey, document);
            this._document = document;
            this._renderPlaybackFrame();
        } catch (error) {
            if (lifecycle === this._lifecycleGeneration &&
                !this._isCancelled(error)) {
                this._overlay.showStatus('Could not load lyrics');
                this._logError(error);
            }
        } finally {
            if (lifecycle === this._lifecycleGeneration &&
                generation === this._lyricsGeneration &&
                this._lyricsCancellable === cancellable)
                this._lyricsCancellable = null;
        }
    }

    _renderPlaybackFrame() {
        this._overlay?.render(
            this._document,
            this._currentPositionSeconds() * 1_000,
            this._playbackStatus);
    }

    _isCancelled(error) {
        return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
    }

    _logError(error) {
        if (this._enabled && !this._isCancelled(error))
            console.error(`[${this.uuid}] ${error.message}`, error.stack ?? '');
    }
}
