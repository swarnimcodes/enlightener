// SPDX-License-Identifier: MIT

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

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

function captureShortcut(parent, settings, gettext) {
    const dialog = new Adw.Dialog({
        title: gettext('Set Visibility Shortcut'),
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
        label: gettext('Press the new keyboard shortcut'),
        css_classes: ['title-2'],
    }));
    const hint = new Gtk.Label({
        label: gettext('Escape cancels · Backspace disables'),
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
            hint.label = gettext('Use a modifier such as Super, Ctrl, or Alt');
            hint.add_css_class('error');
            return true;
        }

        const accelerator = Gtk.accelerator_name(keyval, modifiers);
        const conflict = findConfiguredShortcutConflict(accelerator);
        if (conflict) {
            hint.label = gettext(`Already used by ${conflict}`);
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

export function addShortcutPreferences(group, window, settings, gettext) {
    const shortcutRow = new Adw.ActionRow({
        title: gettext('Visibility shortcut'),
        subtitle: gettext(
            'Select, then press a new shortcut. Backspace disables it.'),
    });
    const shortcutLabel = new Gtk.ShortcutLabel({
        accelerator: settings.get_strv('toggle-overlay')[0] ?? '',
        disabled_text: gettext('Disabled'),
    });
    const shortcutButton = new Gtk.Button({
        child: shortcutLabel,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: gettext('Change shortcut'),
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

        const [, keyval, modifiers] = Gtk.accelerator_parse(accelerator);
        window.add_toast(new Adw.Toast({
            title: gettext(`“${Gtk.accelerator_get_label(
                keyval, modifiers)}” is already in use`),
        }));
    });
    shortcutButton.connect('clicked', () =>
        captureShortcut(window, settings, gettext));
}
