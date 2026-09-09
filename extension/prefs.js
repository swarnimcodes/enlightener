// SPDX-License-Identifier: MIT

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

const SHORTCUT_SETTING_PATTERN =
    /keybindings?|media-keys|shortcuts?|hotkeys?|accelerators?/i;

function acceleratorIdentity(accelerator) {
    const [parsed, keyval, modifiers] = Gtk.accelerator_parse(accelerator);
    if (!parsed)
        return null;

    return `${Gdk.keyval_to_lower(keyval)}:` +
        `${modifiers & Gtk.accelerator_get_default_mod_mask()}`;
}

function findShortcutInSettings(settings, schemaId, identity) {
    for (const key of settings.settings_schema.list_keys()) {
        if (!SHORTCUT_SETTING_PATTERN.test(`${schemaId}.${key}`))
            continue;

        const value = settings.get_value(key);
        const type = value.get_type_string();
        if (type !== 's' && type !== 'as')
            continue;

        const accelerators = type === 'as'
            ? value.deepUnpack()
            : [value.deepUnpack()];
        if (accelerators.some(accelerator =>
            acceleratorIdentity(accelerator) === identity))
            return `${schemaId} / ${key}`;
    }

    return null;
}

function findConfiguredShortcutConflict(accelerator) {
    const identity = acceleratorIdentity(accelerator);
    if (!identity)
        return null;

    const source = Gio.SettingsSchemaSource.get_default();
    const [schemaIds] = source.list_schemas(true);
    for (const schemaId of schemaIds) {
        if (schemaId === 'org.gnome.shell.extensions.enlightener')
            continue;

        try {
            const conflict = findShortcutInSettings(
                new Gio.Settings({schema_id: schemaId}),
                schemaId,
                identity);
            if (conflict)
                return conflict;
        } catch (_) {
            // Some installed schemas are unavailable in this process.
        }
    }

    try {
        const mediaKeys = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.plugins.media-keys',
        });
        for (const path of mediaKeys.get_strv('custom-keybindings')) {
            const schemaId =
                'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
            const conflict = findShortcutInSettings(
                new Gio.Settings({schema_id: schemaId, path}),
                schemaId,
                identity);
            if (conflict)
                return conflict;
        }
    } catch (_) {
        // The custom shortcut schema is optional.
    }

    return null;
}

function isSafeGlobalShortcut(keyval, modifiers) {
    if (!Gtk.accelerator_valid(keyval, modifiers))
        return false;

    if (modifiers !== 0)
        return true;

    const keyName = Gdk.keyval_name(keyval) ?? '';
    return (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) ||
        keyName.startsWith('XF86');
}

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

        const shortcutRow = new Adw.ActionRow({
            title: _('Visibility shortcut'),
            subtitle: _('Select, then press a new shortcut. Backspace disables it.'),
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv('toggle-overlay')[0] ?? '',
            disabled_text: _('Disabled'),
        });
        const shortcutButton = new Gtk.Button({
            child: shortcutLabel,
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Change shortcut'),
        });
        shortcutRow.add_suffix(shortcutButton);
        shortcutRow.activatable_widget = shortcutButton;
        group.add(shortcutRow);

        settings.connect('changed::toggle-overlay', () => {
            shortcutLabel.accelerator =
                settings.get_strv('toggle-overlay')[0] ?? '';
        });
        settings.connect('changed::shortcut-error', () => {
            const accelerator = settings.get_string('shortcut-error');
            if (!accelerator)
                return;

            window.add_toast(new Adw.Toast({
                title: _(`“${Gtk.accelerator_get_label(
                    ...Gtk.accelerator_parse(accelerator).slice(1))}” is already in use`),
            }));
        });
        shortcutButton.connect('clicked', () =>
            this._captureShortcut(window, settings));

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

    _captureShortcut(parent, settings) {
        const dialog = new Adw.Dialog({
            title: _('Set Visibility Shortcut'),
            content_width: 420,
            content_height: 180,
        });
        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(new Adw.HeaderBar());
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            valign: Gtk.Align.CENTER,
            margin_start: 24,
            margin_end: 24,
            margin_top: 24,
            margin_bottom: 24,
        });
        content.append(new Gtk.Label({
            label: _('Press the new keyboard shortcut'),
            css_classes: ['title-2'],
        }));
        const hint = new Gtk.Label({
            label: _('Escape cancels · Backspace disables'),
            css_classes: ['dim-label'],
        });
        content.append(hint);
        toolbarView.content = content;
        dialog.child = toolbarView;

        const controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            const modifiers = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && modifiers === 0) {
                dialog.close();
                return true;
            }
            if (keyval === Gdk.KEY_BackSpace && modifiers === 0) {
                settings.set_string('shortcut-error', '');
                settings.set_strv('toggle-overlay', []);
                dialog.close();
                return true;
            }

            keyval = Gdk.keyval_to_lower(keyval);
            if (!isSafeGlobalShortcut(keyval, modifiers)) {
                hint.label = _('Use a modifier such as Super, Ctrl, or Alt');
                hint.add_css_class('error');
                return true;
            }

            const accelerator = Gtk.accelerator_name(keyval, modifiers);
            const conflict = findConfiguredShortcutConflict(accelerator);
            if (conflict) {
                hint.label = _(`Already used by ${conflict}`);
                hint.add_css_class('error');
                return true;
            }

            settings.set_string('shortcut-error', '');
            settings.set_strv('toggle-overlay', [accelerator]);
            dialog.close();
            return true;
        });
        dialog.add_controller(controller);
        dialog.present(parent);
    }
}
