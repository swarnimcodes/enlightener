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

import {
    getActiveWordIndex,
    getPlaybackFrame,
    parseLyricsResponse,
} from './lyricsModel.js';

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
const MAX_OVERLAY_WIDTH_RATIO = 0.8;
const POSITION_FACTORS = {
    'top-left': [0, 0],
    'top-center': [0.5, 0],
    'top-right': [1, 0],
    'center-left': [0, 0.5],
    'center-right': [1, 0.5],
    'bottom-left': [0, 1],
    'bottom-center': [0.5, 1],
    'bottom-right': [1, 1],
};

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

export default class EnlightenerExtension extends Extension {
    enable() {
        this._lifecycleGeneration = (this._lifecycleGeneration ?? 0) + 1;
        this._enabled = true;
        this._players = new Map();
        this._pendingPlayers = new Set();
        this._lyricsCache = new Map();
        this._selectedPlayer = null;
        this._playerActivitySerial = 0;
        this._trackKey = null;
        this._document = null;
        this._renderSignature = null;
        this._hasContent = false;
        this._positionUs = 0;
        this._positionReadAtUs = GLib.get_monotonic_time();
        this._playbackStatus = 'Stopped';
        this._rate = 1;
        this._lyricsGeneration = 0;
        this._positionSerial = 0;
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 15});
        this._settings = this.getSettings();
        this._userVisible = this._settings.get_boolean('overlay-visible');

        this._createOverlay();

        this._settingsSignalIds = [
            this._settings.connect('changed::toggle-overlay', () =>
                this._updateToggleKeybinding()),
            this._settings.connect('changed::position', () => {
                this._applyPosition();
                this._renderSignature = null;
                this._renderPlaybackFrame();
            }),
            this._settings.connect('changed::context-lines', () => {
                this._renderSignature = null;
                this._renderPlaybackFrame();
            }),
            this._settings.connect('changed::background-opacity', () =>
                this._applyColors()),
        ];
        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        this._colorSchemeSignalId = this._interfaceSettings.connect(
            'changed::color-scheme', () => this._applyColors());
        this._applyPosition();
        this._applyColors();

        this._toggleShortcut = this._settings.get_strv('toggle-overlay');
        this._toggleKeybindingRegistered = false;
        this._updatingToggleShortcut = false;
        if (!this._registerToggleKeybinding() && this._toggleShortcut.length)
            this._settings.set_string('shortcut-error', this._toggleShortcut[0]);

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

        if (this._toggleKeybindingRegistered)
            Main.wm.removeKeybinding('toggle-overlay');
        this._toggleKeybindingRegistered = false;

        for (const signalId of this._settingsSignalIds)
            this._settings.disconnect(signalId);
        this._settingsSignalIds = [];

        if (this._colorSchemeSignalId) {
            this._interfaceSettings.disconnect(this._colorSchemeSignalId);
            this._colorSchemeSignalId = 0;
        }

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
        this._card = null;
        this._xConstraint = null;
        this._yConstraint = null;
        this._workArea = null;
        this._settings = null;
        this._interfaceSettings = null;
        this._session = null;
        this._cancellable = null;
        this._lyricsCancellable = null;
        this._players = null;
        this._pendingPlayers = null;
        this._lyricsCache = null;
        this._document = null;
    }

    _createOverlay() {
        this._overlay = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            visible: false,
        });
        this._overlay.connect('destroy', actor => {
            if (this._overlay === actor) {
                this._overlay = null;
                this._card = null;
            }
        });
        this._card = new St.BoxLayout({
            style_class: 'enlightener-card',
            vertical: true,
        });
        this._xConstraint = new Clutter.AlignConstraint({
            source: this._overlay,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        });
        this._yConstraint = new Clutter.AlignConstraint({
            source: this._overlay,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 1,
        });
        this._card.add_constraint(this._xConstraint);
        this._card.add_constraint(this._yConstraint);
        this._overlay.add_child(this._card);

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

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        this._workArea = workArea;
        this._overlay.set_position(workArea.x, workArea.y);
        this._overlay.set_size(workArea.width, workArea.height);
        this._renderSignature = null;
        this._renderPlaybackFrame();
    }

    _toggleOverlay() {
        this._userVisible = !this._userVisible;
        this._settings.set_boolean('overlay-visible', this._userVisible);
        this._overlay.visible = this._userVisible && this._hasContent;
    }

    _registerToggleKeybinding() {
        if (!this._toggleShortcut.length)
            return true;

        const accelerator = this._toggleShortcut[0];
        const probeAction = global.display.grab_accelerator(
            accelerator, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
        if (probeAction === Meta.KeyBindingAction.NONE)
            return false;
        global.display.ungrab_accelerator(probeAction);

        const action = Main.wm.addKeybinding(
            'toggle-overlay',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleOverlay());
        this._toggleKeybindingRegistered =
            action !== Meta.KeyBindingAction.NONE;
        return this._toggleKeybindingRegistered;
    }

    _updateToggleKeybinding() {
        if (this._updatingToggleShortcut)
            return;

        const previousShortcut = this._toggleShortcut;
        const requestedShortcut = this._settings.get_strv('toggle-overlay');
        if (this._toggleKeybindingRegistered)
            Main.wm.removeKeybinding('toggle-overlay');
        this._toggleKeybindingRegistered = false;
        this._toggleShortcut = requestedShortcut;

        if (this._registerToggleKeybinding()) {
            this._settings.set_string('shortcut-error', '');
            return;
        }

        this._updatingToggleShortcut = true;
        this._settings.set_string(
            'shortcut-error', requestedShortcut[0] ?? '');
        this._settings.set_strv('toggle-overlay', previousShortcut);
        this._toggleShortcut = previousShortcut;
        this._registerToggleKeybinding();
        this._updatingToggleShortcut = false;
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
                        this._renderSignature = null;
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
            this._hideOverlay();
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
            this._hideOverlay();
        else {
            this._renderSignature = null;
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
            this._hideOverlay();
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
        this._showStatus('Finding synchronized lyrics...');
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
            this._document = cached;
            this._renderSignature = null;
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
            this._renderSignature = null;
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
                if (this._isCancelled(error))
                    throw error;
            }

            let document = parseLyricsResponse(lyrics);
            if (!document.instrumental && !document.lines.length) {
                const results = await this._requestJson(makeUrl('search', {
                    track_name: track.title,
                    artist_name: track.artist,
                }), cancellable);
                lyrics = this._bestSearchResult(results, track.duration);
                document = parseLyricsResponse(lyrics);
            }

            if (!this._enabled || lifecycle !== this._lifecycleGeneration ||
                generation !== this._lyricsGeneration ||
                track.key !== this._trackKey)
                return;

            if (!document.instrumental && !document.lines.length) {
                this._showStatus('No synchronized lyrics found');
                return;
            }

            if (this._lyricsCache.size >= MAX_CACHE_ENTRIES) {
                const oldestKey = this._lyricsCache.keys().next().value;
                this._lyricsCache.delete(oldestKey);
            }
            this._lyricsCache.set(track.cacheKey, document);
            this._document = document;
            this._renderSignature = null;
            this._renderPlaybackFrame();
        } catch (error) {
            if (lifecycle === this._lifecycleGeneration &&
                !this._isCancelled(error)) {
                this._showStatus('Could not load lyrics');
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
            const qualityDifference = this._lyricsQuality(a) -
                this._lyricsQuality(b);
            if (qualityDifference)
                return qualityDifference;

            return Math.abs(Number(a.duration) - targetDuration) -
                Math.abs(Number(b.duration) - targetDuration);
        })[0];
    }

    _lyricsQuality(response) {
        const document = parseLyricsResponse(response);
        if (document.lines.some(line => line.words.length))
            return 0;
        if (document.lines.length)
            return 1;
        if (document.instrumental)
            return 2;
        return 3;
    }

    _applyPosition() {
        if (!this._card || !this._settings ||
            !this._xConstraint || !this._yConstraint)
            return;

        const position = this._settings.get_string('position');
        const [xFactor, yFactor] = POSITION_FACTORS[position] ??
            POSITION_FACTORS['bottom-center'];
        this._xConstraint.factor = xFactor;
        this._yConstraint.factor = yFactor;
    }

    _applyColors() {
        if (!this._card || !this._settings || !this._interfaceSettings)
            return;

        const dark = this._interfaceSettings.get_string('color-scheme') ===
            'prefer-dark';
        const background = dark ? '36, 36, 36' : '250, 250, 250';
        const foreground = dark ? '255, 255, 255' : '0, 0, 0';
        const opacity = Math.min(1, Math.max(0,
            this._settings.get_double('background-opacity')));

        this._card.set_style(
            `background-color: rgba(${background}, ${opacity}); ` +
            `color: rgba(${foreground}, 0.9);`);
    }

    _lineAlignment() {
        const position = this._settings.get_string('position');
        if (position.endsWith('-left'))
            return Pango.Alignment.LEFT;
        if (position.endsWith('-right'))
            return Pango.Alignment.RIGHT;
        return Pango.Alignment.CENTER;
    }

    _createLineLabel(styleClass) {
        const label = new St.Label({
            style_class: `enlightener-line ${styleClass}`,
            x_expand: true,
        });
        label.clutter_text.set({
            ellipsize: Pango.EllipsizeMode.NONE,
            line_alignment: this._lineAlignment(),
            line_wrap: true,
        });
        return label;
    }

    _activeLineMarkup(line, positionMs) {
        if (!line.words.length)
            return GLib.markup_escape_text(line.text, -1);

        const activeWord = getActiveWordIndex(line, positionMs);
        return line.words.map((word, index) => {
            const text = GLib.markup_escape_text(word.text, -1);
            if (index === activeWord)
                return `<span weight="bold" alpha="100%">${text}</span>`;
            if (word.endMs <= positionMs)
                return `<span alpha="85%">${text}</span>`;
            return `<span alpha="45%">${text}</span>`;
        }).join('');
    }

    _renderPlaybackFrame() {
        if (!this._overlay || !this._card || !this._document ||
            this._playbackStatus === 'Stopped')
            return;

        const positionMs = this._currentPositionSeconds() * 1_000;
        const contextLength = this._settings.get_uint('context-lines');
        const frame = getPlaybackFrame(
            this._document, positionMs, contextLength);
        const signature = frame.rows.map(row => {
            if (row.kind !== 'active' || !row.line.words.length)
                return `${row.kind}:${row.index ?? ''}`;
            const completedWords = row.line.words.filter(word =>
                word.endMs <= positionMs).length;
            return `${row.kind}:${row.index}:` +
                `${getActiveWordIndex(row.line, positionMs)}:${completedWords}`;
        }).join('|');

        if (signature === this._renderSignature)
            return;
        this._renderSignature = signature;
        this._clearCard();

        for (const row of frame.rows) {
            if (row.kind === 'music') {
                const label = this._createLineLabel('enlightener-music');
                label.text = '♪';
                this._card.add_child(label);
                continue;
            }

            const styleClass = row.kind === 'active'
                ? 'enlightener-active-line'
                : 'enlightener-context-line';
            const label = this._createLineLabel(styleClass);
            if (row.kind === 'active')
                label.clutter_text.set_markup(
                    this._activeLineMarkup(row.line, positionMs));
            else
                label.text = row.line.text;
            this._card.add_child(label);
        }

        this._resizeCard();
        this._setHasContent(frame.rows.length > 0);
    }

    _showStatus(text) {
        if (!this._card)
            return;

        this._renderSignature = `status:${text}`;
        this._clearCard();
        const label = this._createLineLabel('enlightener-status');
        label.text = text;
        this._card.add_child(label);
        this._resizeCard();
        this._setHasContent(true);
    }

    _resizeCard() {
        if (!this._card || !this._workArea)
            return;

        this._card.set_width(-1);
        const [, naturalWidth] = this._card.get_preferred_width(-1);
        const maxWidth = Math.floor(
            this._workArea.width * MAX_OVERLAY_WIDTH_RATIO);
        const width = Math.min(Math.ceil(naturalWidth), maxWidth);
        this._card.set_width(width);
        this._applyPosition();
    }

    _clearCard() {
        if (!this._card)
            return;

        for (const child of this._card.get_children())
            child.destroy();
    }

    _setHasContent(hasContent) {
        this._hasContent = hasContent;
        if (this._overlay)
            this._overlay.visible = this._userVisible && hasContent;
    }

    _hideOverlay() {
        this._hasContent = false;
        this._renderSignature = null;
        this._overlay?.hide();
    }

    _isCancelled(error) {
        return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
    }

    _logError(error) {
        if (this._enabled && !this._isCancelled(error))
            console.error(`[${this.uuid}] ${error.message}`, error.stack ?? '');
    }
}
