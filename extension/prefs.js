// SPDX-License-Identifier: MIT

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {addShortcutPreferences} from './shortcutPreferences.js';

const POSITIONS = [
    ['top-left', 'Top Left'],
    ['top-center', 'Top Center'],
    ['top-right', 'Top Right'],
    ['center-left', 'Center Left'],
    ['center-right', 'Center Right'],
    ['bottom-left', 'Bottom Left'],
    ['bottom-center', 'Bottom Center'],
    ['bottom-right', 'Bottom Right'],
];

export default class EnlightenerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Lyrics Overlay'),
            description: _('Choose where and how synchronized lyrics appear.'),
        });

        addShortcutPreferences(group, window, settings, _);

        const positionModel = Gtk.StringList.new(
            POSITIONS.map(([, label]) => _(label)));
        const positionRow = new Adw.ComboRow({
            title: _('Position'),
            model: positionModel,
        });
        const selectedPosition = POSITIONS.findIndex(([value]) =>
            value === settings.get_string('position'));
        positionRow.selected = Math.max(0, selectedPosition);
        positionRow.connect('notify::selected', () => {
            const selected = POSITIONS[positionRow.selected];
            if (selected)
                settings.set_string('position', selected[0]);
        });
        group.add(positionRow);

        const contextRow = Adw.SpinRow.new_with_range(0, 5, 1);
        contextRow.title = _('Context lines');
        contextRow.subtitle = _('Previous and next lines shown around the active lyric');
        contextRow.value = settings.get_uint('context-lines');
        contextRow.connect('notify::value', () =>
            settings.set_uint('context-lines', Math.round(contextRow.value)));
        group.add(contextRow);

        const opacityRow = Adw.SpinRow.new_with_range(0, 100, 5);
        opacityRow.title = _('Background opacity');
        opacityRow.subtitle = _('Percentage of the Adwaita-neutral background shown');
        opacityRow.value = Math.round(
            settings.get_double('background-opacity') * 100);
        opacityRow.connect('notify::value', () =>
            settings.set_double('background-opacity', opacityRow.value / 100));
        group.add(opacityRow);

        page.add(group);
        window.add(page);
    }
}
