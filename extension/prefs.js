// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OrochiV2Preferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window._settings = settings;

        this._buildGeneralPage(window, settings);
        this._buildDpiPage(window, settings);
        this._buildAboutPage(window);
    }

    _buildGeneralPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Indicator'),
            description: _('How the panel indicator behaves'),
        });
        page.add(group);

        const refreshRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds between battery updates, 0 disables'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 3600,
                step_increment: 30,
                page_increment: 300,
                value: settings.get_int('refresh-interval'),
            }),
        });

        settings.bind('refresh-interval', refreshRow,
            'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(refreshRow);

        const showBatteryRow = new Adw.SwitchRow({
            title: _('Show battery percentage'),
            subtitle: _('Display the battery percentage next to the icon'),
        });

        settings.bind('show-battery-label', showBatteryRow,
            'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showBatteryRow);

        const showDpiRow = new Adw.SwitchRow({
            title: _('Show DPI options'),
        });

        settings.bind('show-dpi', showDpiRow,
            'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showDpiRow);

        const showPollRow = new Adw.SwitchRow({
            title: _('Show polling rate options'),
        });

        settings.bind('show-poll', showPollRow,
            'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showPollRow);

        const notificationGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('Notify when the mouse battery gets low'),
        });
        page.add(notificationGroup);

        const notifyRow = new Adw.SwitchRow({
            title: _('Low battery notification'),
        });

        settings.bind('notify-low-battery', notifyRow,
            'active', Gio.SettingsBindFlags.DEFAULT);
        notificationGroup.add(notifyRow);

        const thresholdRow = new Adw.SpinRow({
            title: _('Low battery threshold'),
            subtitle: _('Percentage at which the notification is sent'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 50,
                step_increment: 5,
                page_increment: 10,
                value: settings.get_int('battery-threshold'),
            }),
        });

        settings.bind('battery-threshold', thresholdRow,
            'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('notify-low-battery', thresholdRow,
            'sensitive', Gio.SettingsBindFlags.GET);
        notificationGroup.add(thresholdRow);

        const helperGroup = new Adw.PreferencesGroup({
            title: _('Helper'),
            description: _('The orochictl program that talks to the mouse'),
        });
        page.add(helperGroup);

        const helperRow = new Adw.EntryRow({
            title: _('Helper path'),
            text: settings.get_string('helper-path'),
        });

        helperRow.connect('changed', () => {
            settings.set_string('helper-path', helperRow.text.trim());
        });
        helperGroup.add(helperRow);
    }

    _buildDpiPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('DPI'),
            icon_name: 'input-mouse-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Presets'),
            description: _('Semicolon separated DPI values shown in the menu, ' +
                'for example 800;1600;3200'),
        });
        page.add(group);

        const presetsRow = new Adw.EntryRow({
            title: _('Presets'),
            text: settings.get_string('dpi-presets'),
        });

        presetsRow.connect('changed', () => {
            settings.set_string('dpi-presets', presetsRow.text.trim());
        });
        group.add(presetsRow);

        const customGroup = new Adw.PreferencesGroup({
            title: _('Custom'),
            description: _('Extra DPI entry shown in the menu'),
        });
        page.add(customGroup);

        const dpiRow = new Adw.SpinRow({
            title: _('Custom DPI'),
            adjustment: new Gtk.Adjustment({
                lower: 100,
                upper: 18000,
                step_increment: 100,
                page_increment: 400,
                value: settings.get_int('dpi'),
            }),
        });

        settings.bind('dpi', dpiRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        customGroup.add(dpiRow);
    }

    _buildAboutPage(window) {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup();
        page.add(group);

        const row = new Adw.ActionRow({
            title: this.metadata.name,
            subtitle: _('Version %s').format(this.metadata['version-name'] ??
                this.metadata.version ?? ''),
        });

        row.add_suffix(new Gtk.Label({
            label: 'Razer Orochi V2 1532:0094',
            css_classes: ['dim-label'],
        }));
        group.add(row);
    }
}
