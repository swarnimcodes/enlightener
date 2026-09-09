// SPDX-License-Identifier: MIT

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SETTING_KEY = 'toggle-overlay';

export class ShortcutManager {
    constructor(settings, callback) {
        this._settings = settings;
        this._callback = callback;
        this._shortcut = settings.get_strv(SETTING_KEY);
        this._registered = false;
        this._updating = false;
        this._signalId = settings.connect(`changed::${SETTING_KEY}`, () =>
            this._update());

        if (!this._register() && this._shortcut.length)
            settings.set_string('shortcut-error', this._shortcut[0]);
    }

    destroy() {
        if (this._registered)
            Main.wm.removeKeybinding(SETTING_KEY);
        if (this._signalId)
            this._settings.disconnect(this._signalId);

        this._registered = false;
        this._signalId = 0;
        this._settings = null;
        this._callback = null;
    }

    _register() {
        if (!this._shortcut.length)
            return true;

        const accelerator = this._shortcut[0];
        const probeAction = global.display.grab_accelerator(
            accelerator, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
        if (probeAction === Meta.KeyBindingAction.NONE)
            return false;
        global.display.ungrab_accelerator(probeAction);

        const action = Main.wm.addKeybinding(
            SETTING_KEY,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this._callback);
        this._registered = action !== Meta.KeyBindingAction.NONE;
        return this._registered;
    }

    _update() {
        if (this._updating)
            return;

        const previousShortcut = this._shortcut;
        const requestedShortcut = this._settings.get_strv(SETTING_KEY);
        if (this._registered)
            Main.wm.removeKeybinding(SETTING_KEY);
        this._registered = false;
        this._shortcut = requestedShortcut;

        if (this._register()) {
            this._settings.set_string('shortcut-error', '');
            return;
        }

        this._updating = true;
        this._settings.set_string(
            'shortcut-error', requestedShortcut[0] ?? '');
        this._settings.set_strv(SETTING_KEY, previousShortcut);
        this._shortcut = previousShortcut;
        this._register();
        this._updating = false;
    }
}
