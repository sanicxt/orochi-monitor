// SPDX-License-Identifier: GPL-2.0-or-later
//
// Orochi Monitor - GNOME Shell extension for the Razer Orochi V2.
// Spawns the bundled orochictl helper for all HID communication.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MIN_DPI = 100;
const MAX_DPI = 18000;
const POLL_RATES = [125, 500, 1000];

const UDEV_RULE_PATH = '/etc/udev/rules.d/70-razer-orochi-v2.rules';
const UDEV_RULE_PATH_OLD = '/etc/udev/rules.d/99-razer-orochi-v2.rules';

export default class OrochiV2Extension extends Extension {
    enable() {
        this._disabled = false;
        this._settings = this.getSettings();
        this._helperPath = this._resolveHelper();
        this._cancellable = new Gio.Cancellable();
        this._status = {battery: null, dpi: null, poll: null};
        this._refreshing = false;
        this._notificationSource = null;
        this._batteryNotified = false;
        this._batteryRefreshing = false;
        this._retryDelay = 0;
        this._scheduledId = null;
        this._idleWatchId = null;
        this._dbusSubId = null;
        this._devMonitor = null;

        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);

        // PanelMenu.Button only allocates its first child, so icon and label
        // must live in a single container.
        const box = new St.BoxLayout({
            style_class: 'orochi-v2-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const icon = new St.Icon({
            icon_name: 'input-mouse-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(icon);

        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'orochi-v2-label',
        });
        box.add_child(this._label);

        this._indicator.add_child(box);

        this._settings.bind('show-battery-label', this._label,
            'visible', Gio.SettingsBindFlags.DEFAULT);

        this._buildMenu();

        this._indicator.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._refreshAll();
        });

        this._settings.connectObject(
            'changed::refresh-interval', () => this._startTimer(),
            'changed::show-dpi', () => this._updateSectionVisibility(),
            'changed::show-poll', () => this._updateSectionVisibility(),
            this);

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Watch for wake-ups so a sleeping mouse can be re-read promptly.
        this._watchIdleMonitor();
        this._watchSession();
        this._watchDevices();

        this._startTimer();
        this._refreshBattery();
    }

    disable() {
        this._disabled = true;
        this._stopTimer();

        this._settings?.disconnectObject(this);

        if (this._scheduledId) {
            GLib.Source.remove(this._scheduledId);
            this._scheduledId = null;
        }

        if (this._idleWatchId && this._idleMonitor) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = null;
        }
        this._idleMonitor = null;

        if (this._dbusSubId) {
            Gio.DBus.system.signal_unsubscribe(this._dbusSubId);
            this._dbusSubId = null;
        }

        this._devMonitor?.cancel();
        this._devMonitor = null;

        this._cancellable?.cancel();
        this._cancellable = null;

        this._notificationSource?.destroy();
        this._notificationSource = null;

        this._indicator?.destroy();
        this._indicator = null;
        this._label = null;
        this._settings = null;
    }

    /*
     * The mouse sleeps when idle; on wake it needs a moment before it
     * answers HID requests. Re-read the battery whenever the user becomes
     * active again, with a short delay for the device to wake up.
     */
    _watchIdleMonitor() {
        this._idleMonitor = global.backend.get_core_idle_monitor();

        this._idleWatchId = this._idleMonitor.add_user_active_watch(() => {
            this._idleWatchId = null;
            this._scheduleBatteryRefresh(1500, true);
            this._watchIdleMonitor();
        });
    }

    /*
     * Refresh shortly after the machine resumes from suspend.
     */
    _watchSession() {
        try {
            this._dbusSubId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (connection, sender, path, iface, signal, params) => {
                    const [sleeping] = params.deepUnpack();

                    if (!sleeping)
                        this._scheduleBatteryRefresh(3000, true);
                });
        } catch (e) {
            logError(e, 'orochi-monitor: failed to watch login1');
        }
    }

    /*
     * The receiver may be plugged in after the shell started, or replugged
     * after a suspend. Watch /sys/class/hidraw for device changes.
     */
    _watchDevices() {
        const dir = Gio.File.new_for_path('/sys/class/hidraw');

        try {
            this._devMonitor = dir.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            logError(e, 'orochi-monitor: failed to watch hidraw devices');
            return;
        }

        this._devMonitor.connect('changed', () => {
            this._scheduleBatteryRefresh(2000, true);
        });
    }

    /*
     * Schedule a battery refresh, collapsing bursts (idle wake, udev
     * events, resume) into a single helper invocation.
     *
     * Event-driven calls pass a short delay and take priority over a
     * pending (much longer) backoff retry so plugging the mouse back in
     * or waking the machine is reflected immediately.
     */
    _scheduleBatteryRefresh(delay, urgent = false) {
        if (this._disabled)
            return;

        if (this._scheduledId) {
            if (!urgent)
                return;

            GLib.Source.remove(this._scheduledId);
            this._scheduledId = null;
        }

        this._scheduledId = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._scheduledId = null;
                this._refreshBattery();
            });
        GLib.Source.set_name_by_id(this._scheduledId,
            '[orochi-monitor] refresh battery');
    }

    _resolveHelper() {
        const configured = this._settings.get_string('helper-path');

        if (configured && GLib.file_test(configured, GLib.FileTest.IS_EXECUTABLE))
            return configured;

        const bundled = GLib.build_filenamev([this.path, 'orochictl']);

        if (GLib.file_test(bundled, GLib.FileTest.IS_EXECUTABLE))
            return bundled;

        return GLib.find_program_in_path('orochictl');
    }

    _startTimer() {
        this._stopTimer();

        const interval = this._settings.get_int('refresh-interval');

        if (interval <= 0)
            return;

        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, Math.max(interval, 15), () => {
                this._refreshBattery();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
    }

    _buildMenu() {
        const menu = this._indicator.menu;

        this._batteryItem = new PopupMenu.PopupMenuItem(_('Battery: …'), {
            reactive: false,
        });
        menu.addMenuItem(this._batteryItem);

        this._errorItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._errorItem.label.add_style_class_name('orochi-v2-error');
        this._errorItem.visible = false;
        menu.addMenuItem(this._errorItem);

        this._grantItem = new PopupMenu.PopupMenuItem(
            _('Install udev rule for hidraw access…'));
        this._grantItem.visible = false;
        this._grantItem.connect('activate', () => this._installUdevRule());
        menu.addMenuItem(this._grantItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildDpiMenu(menu);
        this._buildPollMenu(menu);

        this._updateSectionVisibility();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        menu.addAction(_('Refresh now'), () => this._refreshAll());
        menu.addAction(_('Preferences'), () => this.openPreferences());
    }

    _updateSectionVisibility() {
        if (this._dpiSection) {
            this._dpiSection.visible =
                this._settings.get_boolean('show-dpi');
        }

        if (this._pollSection) {
            this._pollSection.visible =
                this._settings.get_boolean('show-poll');
        }
    }

    _buildDpiMenu(menu) {
        this._dpiSection = new PopupMenu.PopupSubMenuMenuItem(
            _('DPI: unavailable'), true);
        this._dpiItems = [];

        this._populateDpiItems();

        menu.addMenuItem(this._dpiSection);

        this._settings.connectObject('changed::dpi-presets',
            () => this._populateDpiItems(), this._dpiSection);
        this._settings.connectObject('changed::dpi',
            () => this._populateDpiItems(), this._dpiSection);
    }

    _populateDpiItems() {
        for (const {item} of this._dpiItems)
            item.destroy();

        this._dpiItems = [];

        const current = this._status.dpi;

        for (const dpi of this._parsePresets()) {
            const item = new PopupMenu.PopupMenuItem(String(dpi));

            item.connect('activate', () => this._applyDpi(dpi));

            this._dpiSection.menu.addMenuItem(item);
            this._dpiItems.push({dpi, item});
        }

        const custom = this._settings.get_int('dpi');
        const customItem = new PopupMenu.PopupMenuItem(
            _('Custom (%d)').format(custom));

        customItem.connect('activate', () => this._applyDpi(custom));
        this._dpiSection.menu.addMenuItem(customItem);
        this._dpiItems.push({dpi: custom, item: customItem});

        this._updateDpiOrnaments(current);
    }

    _parsePresets() {
        const presets = [];

        for (const part of this._settings.get_string('dpi-presets').split(';')) {
            const dpi = Number(part.trim());

            if (!Number.isFinite(dpi) || dpi < MIN_DPI || dpi > MAX_DPI)
                continue;

            if (!presets.includes(dpi))
                presets.push(dpi);
        }

        return presets;
    }

    _buildPollMenu(menu) {
        this._pollSection = new PopupMenu.PopupSubMenuMenuItem(
            _('Poll: unavailable'), true);
        this._pollItems = [];

        for (const rate of POLL_RATES) {
            const item = new PopupMenu.PopupMenuItem(_('%d Hz').format(rate));

            item.connect('activate', () => this._applyPoll(rate));

            this._pollSection.menu.addMenuItem(item);
            this._pollItems.push({rate, item});
        }

        menu.addMenuItem(this._pollSection);
    }

    _runHelper(args) {
        return new Promise((resolve, reject) => {
            if (!this._helperPath) {
                reject(new Error(_('orochictl helper not found')));
                return;
            }

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_PIPE,
            });
            let proc;

            try {
                proc = launcher.spawnv([this._helperPath, ...args]);
            } catch (e) {
                reject(e);
                return;
            }

            proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                let stdout, stderr;

                try {
                    [, stdout, stderr] = p.communicate_utf8_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        reject(e);
                    return;
                }

                if (!p.get_successful()) {
                    reject(new Error(stderr.trim() ||
                        _('Helper exited with status %d').format(
                            p.get_exit_status())));
                    return;
                }

                resolve(stdout);
            });
        });
    }

    _parseStatus(output) {
        const status = {battery: null, dpi: null, poll: null};

        for (const line of output.split('\n')) {
            const [key, value] = line.split('=', 2);

            if (key === 'battery')
                status.battery = Number(value);
            else if (key === 'dpi')
                status.dpi = {x: Number(value.split(':')[0]),
                              y: Number(value.split(':')[1])};
            else if (key === 'poll')
                status.poll = Number(value);
        }

        return status;
    }

    _refreshBattery() {
        if (this._batteryRefreshing)
            return;

        this._batteryRefreshing = true;

        this._runHelper(['status', 'battery'])
            .then(output => {
                if (this._disabled)
                    return;

                const status = this._parseStatus(output);

                if (status.battery == null) {
                    // The device did not answer, usually because it is
                    // asleep. Retry with backoff instead of going stale.
                    this._scheduleBatteryRetry();
                    return;
                }

                this._retryDelay = 0;
                this._status.battery = status.battery;

                if (this._label)
                    this._label.text = `${status.battery}%`;

                if (this._batteryItem)
                    this._batteryItem.label.text =
                        _('Battery: %d%%').format(status.battery);

                this._checkBatteryLevel(status.battery);
            })
            .catch(e => {
                if (this._disabled)
                    return;

                this._showError(e.message);

                if (this._isTransientError(e.message))
                    this._scheduleBatteryRetry();
            })
            .finally(() => {
                this._batteryRefreshing = false;
            });
    }

    /*
     * Retry a failed/empty battery read with exponential backoff (4s, 8s,
     * 16s, ... capped at 60s). Gives the mouse time to wake up.
     */
    _scheduleBatteryRetry() {
        if (this._scheduledId || this._disabled || this._cancellable === null)
            return;

        this._retryDelay = this._retryDelay
            ? Math.min(this._retryDelay * 2, 60000)
            : 4000;

        this._scheduleBatteryRefresh(this._retryDelay);
    }

    _isTransientError(message) {
        return message.includes('not found') ||
            message.includes('device=') ||
            message.includes('timed out') ||
            message.includes('Input/output error');
    }

    _checkBatteryLevel(percent) {
        if (!this._settings.get_boolean('notify-low-battery'))
            return;

        const threshold = this._settings.get_int('battery-threshold');

        if (percent > threshold) {
            this._batteryNotified = false;
            return;
        }

        if (this._batteryNotified)
            return;

        this._batteryNotified = true;

        const source = this._getNotificationSource();
        const notification = new MessageTray.Notification({
            source,
            title: _('Orochi V2 battery low'),
            body: _('Mouse battery is at %d%%. Time to charge or replace the battery.').format(percent),
            iconName: 'battery-caution-symbolic',
            urgency: MessageTray.Urgency.NORMAL,
        });

        notification.addAction(_('Refresh now'), () => this._refreshAll());
        notification.addAction(_('Preferences'), () => this.openPreferences());

        source.addNotification(notification);
    }

    _getNotificationSource() {
        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({
                title: this.metadata.name,
                iconName: 'input-mouse-symbolic',
            });

            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });

            Main.messageTray.add(this._notificationSource);
        }

        return this._notificationSource;
    }

    _refreshAll() {
        if (this._refreshing)
            return;

        this._refreshing = true;

        this._runHelper(['status'])
            .then(output => {
                if (this._disabled)
                    return;

                this._status = this._parseStatus(output);
                this._updateMenu();
            })
            .catch(e => {
                if (!this._disabled)
                    this._showError(e.message);
            })
            .finally(() => {
                this._refreshing = false;
            });
    }

    _applyDpi(dpi) {
        this._runHelper(['dpi', String(dpi)])
            .then(() => {
                if (this._disabled)
                    return;

                this._status.dpi = {x: dpi, y: dpi};
                this._updateMenu();
            })
            .catch(e => {
                if (!this._disabled)
                    this._showError(e.message);
            });
    }

    _applyPoll(rate) {
        this._runHelper(['poll', String(rate)])
            .then(() => {
                if (this._disabled)
                    return;

                this._status.poll = rate;
                this._updateMenu();
            })
            .catch(e => {
                if (!this._disabled)
                    this._showError(e.message);
            });
    }

    _updateMenu() {
        const {battery, dpi, poll} = this._status;

        this._label.text = battery != null ? `${battery}%` : 'n/a';
        this._batteryItem.label.text = battery != null
            ? _('Battery: %d%%').format(battery)
            : _('Battery: unavailable');

        if (this._dpiSection) {
            this._dpiSection.label.text = dpi
                ? (dpi.x === dpi.y
                    ? _('DPI: %d').format(dpi.x)
                    : _('DPI: %d:%d').format(dpi.x, dpi.y))
                : _('DPI: unavailable');

            this._updateDpiOrnaments(dpi);
        }

        if (this._pollSection) {
            this._pollSection.label.text = poll != null
                ? _('Poll: %d Hz').format(poll)
                : _('Poll: unavailable');

            for (const {rate, item} of this._pollItems) {
                item.setOrnament(rate === poll
                    ? PopupMenu.Ornament.DOT
                    : PopupMenu.Ornament.NONE);
            }
        }

        this._errorItem.visible = false;
        this._grantItem.visible = false;
    }

    _updateDpiOrnaments(dpi) {
        for (const {dpi: value, item} of this._dpiItems) {
            item.setOrnament(dpi && value === dpi.x
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
    }

    _showError(message) {
        if (!this._errorItem)
            return;

        this._errorItem.label.text = message;
        this._errorItem.visible = true;

        const denied = message.includes('Permission denied');
        this._grantItem.visible = denied;

        // Keep the last known battery reading on transient failures so the
        // panel does not flicker to "n/a" while the mouse is asleep.
        if (denied || this._status.battery == null) {
            this._label.text = 'n/a';
            this._batteryItem.label.text = _('Battery: unavailable');
        }
    }

    _installUdevRule() {
        /*
         * The rule file must sort before 73-seat-late.rules, which only
         * queues the "uaccess" builtin when the tag is already set at that
         * point. A 99- rule adds the tag too late, so no ACL is applied on
         * a cold boot and the device stays root-only.
         *
         * GROUP="plugdev" is a fallback for systems where the ACL is not
         * applied; MODE="0660" keeps it from being world-readable.
         */
        const rule = 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1532", ' +
            'ATTRS{idProduct}=="0094", MODE="0660", GROUP="plugdev", ' +
            'TAG+="uaccess"\n' +
            'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1532", ' +
            'ATTRS{idProduct}=="0095", MODE="0660", GROUP="plugdev", ' +
            'TAG+="uaccess"';

        const script =
            `printf '%s\\n' '${rule}' > ${UDEV_RULE_PATH} && ` +
            `rm -f ${UDEV_RULE_PATH_OLD} && ` +
            'udevadm control --reload-rules && ' +
            'udevadm trigger --action=add --subsystem-match=hidraw';

        try {
            Gio.Subprocess.new(['pkexec', 'sh', '-c', script],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._showError(e.message);
            return;
        }

        this._errorItem.label.text = _('Waiting for authorization…');
    }
}
