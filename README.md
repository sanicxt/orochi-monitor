# Orochi Monitor

GNOME Shell extension and standalone CLI for the **Razer Orochi V2** gaming
mouse — battery level, DPI and polling rate, **without OpenRazer**.

The Orochi V2 speaks Razer's HID control protocol. This project talks to it
directly through `/dev/hidraw`, so there is no kernel module, no DKMS, no
daemon and no DBus service.

```
┌──────────────────────────────────────────────────────────┐
│  GNOME top bar:   [mouse icon] 96%                        │
│                                                          │
│  Menu:            Battery: 96%                           │
│                   DPI: 800              ▸                │
│                     • 800                                │
│                     • 1600                               │
│                     • 3200                               │
│                     • Custom (2400)                      │
│                   Poll: 1000 Hz         ▸                │
│                     • 125 Hz                             │
│                     • 500 Hz                             │
│                     • 1000 Hz                            │
│                   ─────────────────────                  │
│                   Refresh now                            │
│                   Preferences                            │
└──────────────────────────────────────────────────────────┘
```

## Features

- **Top bar indicator** — mouse icon with a live battery percentage
- **Battery** — read from the mouse (no pairing quirks, works over the
  2.4 GHz receiver and Bluetooth)
- **DPI** — preset list plus a configurable custom value, applied to both axes
- **Polling rate** — 125 / 500 / 1000 Hz
- **Low battery notifications** — desktop notification with a configurable
  threshold, plus a latch so it does not spam
- **Preferences** — everything configurable from the standard GNOME
  preferences window
- **Standalone CLI** — `orochictl` works on its own for scripts, status bars
  and keybindings

## How it works

```
┌─────────────────┐   spawn   ┌──────────────┐  HID feature reports  ┌────────┐
│ GNOME extension │ ────────► │  orochictl   │ ────────────────────► │ Orochi │
│  (GJS, panel +  │ ────────► │  (C helper)  │ ◄──────────────────── │  V2    │
│   prefs + menu) │   stdout  └──────────────┘   /dev/hidrawN        └────────┘
└─────────────────┘
```

The GNOME extension cannot do `ioctl()` on `/dev/hidraw*`, so all USB
communication lives in a small C program. The extension spawns `orochictl`,
parses its `key=value` output and drives the panel and menu from it.

`orochictl`:

1. Finds the Orochi V2 control interface by probing `/dev/hidraw*` with
   `HIDIOCGRAWINFO` and picking the interface whose `bInterfaceProtocol` is
   mouse (the configuration interface).
2. Sends 91-byte HID feature reports: 1 report ID byte + the 90-byte Razer
   report, with the XOR CRC Razer expects.
3. Uses transaction id `0x1f` and waits 400 ms between the request and the
   response — the Orochi V2 (like the Atheris) does not answer sooner.

### Protocol reference

Derived from [OpenRazer](https://github.com/openrazer/openrazer)'s
`razermouse_driver.c` / `razerchromacommon.c`:

| Value    | Class | Command | Request args                              | Response                        |
| -------- | ----- | ------- | ----------------------------------------- | ------------------------------- |
| Battery  | `0x07`| `0x80`  | —                                         | `args[1]` = 0-255               |
| DPI get  | `0x04`| `0x85`  | `args[0]` = storage (`0x00`)              | `args[1..2]` x, `args[3..4]` y  |
| DPI set  | `0x04`| `0x05`  | storage, x hi/lo, y hi/lo (big endian)    | —                               |
| Poll get | `0x00`| `0x85`  | —                                         | `args[0]`: 1=1000, 2=500, 8=125 |
| Poll set | `0x00`| `0x05`  | `args[0]` code                            | —                               |

## Requirements

- GNOME Shell 48, 49 or 50
- `gcc` and `glib2` (`glib-compile-schemas`) — build time only
- Linux with `hidraw` (any modern kernel)

## Install

```sh
git clone git@github.com:sanicxt/orochi-monitor.git
cd orochi-monitor
./install.sh
```

The script:

1. Builds `orochictl`
2. Installs the extension to
   `~/.local/share/gnome-shell/extensions/orochi-v2-control@sanic.github.io`
3. Compiles the GSettings schema and enables the extension
4. Offers to install the udev rule for `hidraw` access

If the extension is already installed, `install.sh` detects it and asks
whether to **update** or **remove**. Non-interactive flags:

```sh
./install.sh --install     # install or update without the menu
./install.sh --uninstall   # remove the extension
./install.sh --no-udev     # never touch the udev rule
./install.sh --help
```

> **Note:** GNOME Shell scans extensions only at startup and caches
> extension code for the whole session. After installing or updating, **log
> out and back in** — `gnome-extensions disable/enable` is not enough to
> load new code.

### Permissions

`/dev/hidraw*` is root-only by default. The install script (or the
**"Install udev rule for hidraw access…"** item in the extension menu) can
install this rule, which grants the active local user access via `uaccess`:

```
# /etc/udev/rules.d/99-razer-orochi-v2.rules
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1532", ATTRS{idProduct}=="0094", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1532", ATTRS{idProduct}=="0095", TAG+="uaccess"
```

Reload it manually with:

```sh
sudo udevadm control --reload-rules
sudo udevadm trigger --action=change --subsystem-match=hidraw
```

If access is still denied, unplug/replug the receiver or reboot.

### Uninstall

```sh
./install.sh --uninstall
```

## CLI usage

`orochictl` is a self-contained tool; run it from the repo, from the
installed extension directory, or copy it into `~/.local/bin`:

```sh
orochictl                 # battery, DPI and polling rate
orochictl battery         # battery only
orochictl dpi             # current DPI
orochictl dpi 1600        # set both axes
orochictl dpi 1600 1200   # set x and y independently
orochictl poll            # current polling rate
orochictl poll 1000       # set 125, 500 or 1000
orochictl status          # machine-readable output
orochictl status battery  # machine-readable, battery only
orochictl -v dpi          # dump raw requests/responses
```

The `status` output is designed for scripts and status bars:

```
device=/dev/hidraw2
battery=96
dpi=800:800
poll=1000
```

`*_error` keys appear instead when a value could not be read. Exit code is
non-zero on failure, and permission problems print the exact udev rule to
install.

Example — show the battery in a tmux status bar or a Waybar module:

```sh
orochictl status battery | sed -n 's/^battery=//p'
```

## Preferences

Open with `gnome-extensions prefs orochi-v2-control@sanic.github.io` or from
the menu.

| Setting                       | Default              | Description                             |
| ----------------------------- | -------------------- | --------------------------------------- |
| Show battery percentage       | on                   | `%` label next to the panel icon        |
| Refresh interval              | 300 s                | Battery poll interval, 0 disables       |
| Show DPI options              | on                   | Show the DPI submenu                    |
| Show polling rate options     | on                   | Show the polling rate submenu           |
| Low battery notification      | on                   | Notify when the battery is low          |
| Low battery threshold         | 20 %                 | Trigger level (5-50 %)                  |
| DPI presets                   | `800;1600;3200`      | Semicolon separated DPI values          |
| Custom DPI                    | 1600                 | Extra DPI entry in the menu             |
| Helper path                   | bundled `orochictl`  | Override the helper binary              |

## Troubleshooting

**`Extension ... does not exist` when enabling**
Log out and back in first so GNOME Shell scans the extension directory, then:
```sh
gnome-extensions enable orochi-v2-control@sanic.github.io
```
The UUID has no trailing dot.

**Changes to the extension have no effect**
GNOME Shell caches extension modules for the session. Log out and back in.

**`Permission denied opening hidraw device(s)`**
Install the udev rule above, then re-trigger udev or replug the receiver.

**`Razer Orochi V2 (1532:0094/0095) not found`**
Check `lsusb | grep 1532` — the receiver should show up as `1532:0094`.
Over Bluetooth the PID is `1532:0095`; make sure the mouse is paired and
awake. Bluetooth-connected Orochi V2 units expose the same Razer protocol.

**Values show `n/a`**
Run `orochictl status -v` to see the raw report exchange. The mouse may be
asleep — click it and refresh.

## Project layout

```
.
├── extension/
│   ├── extension.js     # panel indicator, menu, notifications
│   ├── prefs.js         # GNOME preferences window
│   ├── metadata.json    # extension manifest
│   ├── stylesheet.css   # panel spacing/icon tweaks
│   └── schemas/         # GSettings schema
├── orochictl.c          # the C helper (all HID communication)
├── install.sh           # build + install/update/uninstall script
└── README.md
```

## Credits

The Razer HID protocol constants and the Orochi V2 specifics were derived
from [OpenRazer](https://github.com/openrazer/openrazer) (GPL-2.0), which is
the reference open source implementation of Razer's drivers on Linux.

Not affiliated with Razer, Inc.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
