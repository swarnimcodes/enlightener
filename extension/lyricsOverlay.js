// SPDX-License-Identifier: MIT

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {getActiveWordIndex, getPlaybackFrame} from './lyricsModel.js';

const MAX_WIDTH_RATIO = 0.8;
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

export class LyricsOverlay {
    constructor(settings) {
        this._settings = settings;
        this._userVisible = settings.get_boolean('overlay-visible');
        this._hasContent = false;
        this._renderSignature = null;
        this._document = null;
        this._positionMs = 0;
        this._playbackStatus = 'Stopped';

        this._createActors();
        this._settingsSignalIds = [
            settings.connect('changed::position', () => {
                this._applyPosition();
                this._invalidateAndRender();
            }),
            settings.connect('changed::context-lines', () =>
                this._invalidateAndRender()),
            settings.connect('changed::background-opacity', () =>
                this._applyColors()),
        ];
        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        this._colorSchemeSignalId = this._interfaceSettings.connect(
            'changed::color-scheme', () => this._applyColors());
        this._applyPosition();
        this._applyColors();
    }

    destroy() {
        for (const signalId of this._settingsSignalIds)
            this._settings.disconnect(signalId);
        this._settingsSignalIds = [];

        if (this._colorSchemeSignalId)
            this._interfaceSettings.disconnect(this._colorSchemeSignalId);
        if (this._monitorSignalId)
            Main.layoutManager.disconnect(this._monitorSignalId);

        if (this._actor) {
            Main.layoutManager.removeChrome(this._actor);
            this._actor.destroy();
        }

        this._actor = null;
        this._card = null;
        this._settings = null;
        this._interfaceSettings = null;
        this._document = null;
    }

    toggleVisibility() {
        this._userVisible = !this._userVisible;
        this._settings.set_boolean('overlay-visible', this._userVisible);
        this._actor.visible = this._userVisible && this._hasContent;
    }

    render(document, positionMs, playbackStatus) {
        if (document !== this._document)
            this._renderSignature = null;
        this._document = document;
        this._positionMs = positionMs;
        this._playbackStatus = playbackStatus;

        if (!this._actor || !this._card || !document ||
            playbackStatus === 'Stopped')
            return;

        const contextLength = this._settings.get_uint('context-lines');
        const frame = getPlaybackFrame(document, positionMs, contextLength);
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

    showStatus(text) {
        if (!this._card)
            return;

        this._document = null;
        this._renderSignature = `status:${text}`;
        this._clearCard();
        const label = this._createLineLabel('enlightener-status');
        label.text = text;
        this._card.add_child(label);
        this._resizeCard();
        this._setHasContent(true);
    }

    hide() {
        this._document = null;
        this._hasContent = false;
        this._renderSignature = null;
        this._actor?.hide();
    }

    _createActors() {
        this._actor = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            visible: false,
        });
        this._actor.connect('destroy', actor => {
            if (this._actor === actor) {
                this._actor = null;
                this._card = null;
            }
        });
        this._card = new St.BoxLayout({
            style_class: 'enlightener-card',
            vertical: true,
        });
        this._xConstraint = new Clutter.AlignConstraint({
            source: this._actor,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        });
        this._yConstraint = new Clutter.AlignConstraint({
            source: this._actor,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 1,
        });
        this._card.add_constraint(this._xConstraint);
        this._card.add_constraint(this._yConstraint);
        this._actor.add_child(this._card);

        Main.layoutManager.addChrome(this._actor, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._monitorSignalId = Main.layoutManager.connect(
            'monitors-changed', () => this._updateGeometry());
        this._updateGeometry();
    }

    _updateGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._actor)
            return;

        this._workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        this._actor.set_position(this._workArea.x, this._workArea.y);
        this._actor.set_size(this._workArea.width, this._workArea.height);
        this._invalidateAndRender();
    }

    _invalidateAndRender() {
        this._renderSignature = null;
        this.render(this._document, this._positionMs, this._playbackStatus);
    }

    _applyPosition() {
        if (!this._card || !this._xConstraint || !this._yConstraint)
            return;

        const position = this._settings.get_string('position');
        const [xFactor, yFactor] = POSITION_FACTORS[position] ??
            POSITION_FACTORS['bottom-center'];
        this._xConstraint.factor = xFactor;
        this._yConstraint.factor = yFactor;
    }

    _applyColors() {
        if (!this._card || !this._interfaceSettings)
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

    _resizeCard() {
        if (!this._card || !this._workArea)
            return;

        this._card.set_width(-1);
        const [, naturalWidth] = this._card.get_preferred_width(-1);
        const maxWidth = Math.floor(this._workArea.width * MAX_WIDTH_RATIO);
        this._card.set_width(Math.min(Math.ceil(naturalWidth), maxWidth));
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
        if (this._actor)
            this._actor.visible = this._userVisible && hasContent;
    }
}
