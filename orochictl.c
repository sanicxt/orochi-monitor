// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * orochictl - battery, DPI and polling rate control for the Razer Orochi V2
 *
 * Talks Razer's HID control protocol over /dev/hidraw. Protocol constants
 * derived from OpenRazer (https://github.com/openrazer/openrazer).
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/hidraw.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

/*
 * hidraw buffer layout:
 *   byte 0       = HID report ID
 *   bytes 1..90  = struct razer_report
 *
 * struct razer_report (offsets from hidraw byte 0):
 *   1 status, 2 transaction id, 3-4 remaining packets, 5 protocol type,
 *   6 data size, 7 command class, 8 command id,
 *   9..88 arguments[80], 89 crc, 90 reserved
 *
 * arguments[n] = hidraw byte 9 + n
 */
#define REPORT_SIZE 90
#define HIDRAW_SIZE (REPORT_SIZE + 1)

#define ARG(n) (9 + (n))

#define RAZER_VID 0x1532
#define RAZER_PID_OROCHI_V2_RECEIVER  0x0094
#define RAZER_PID_OROCHI_V2_BLUETOOTH 0x0095

#define RAZER_CMD_BUSY       0x01
#define RAZER_CMD_SUCCESSFUL 0x02

#define RAZER_STATUS_NEW 0x00

/*
 * Orochi V2 values from the OpenRazer driver (razermouse_driver.c):
 *   - transaction id 0x1f for all battery/DPI/polling commands
 *   - RAZER_ATHERIS_RECEIVER_WAIT_US = 400000 between request and response
 */
#define OROCHI_TRANSACTION_ID 0x1f
#define OROCHI_WAIT_US 400000
#define TRANSACT_ATTEMPTS 5

#define OROCHI_MIN_DPI 100
#define OROCHI_MAX_DPI 18000

#define NOSTORE 0x00

static void dump(const unsigned char *p, int n)
{
    for (int i = 0; i < n; i++)
        printf("%02x%s", p[i], (i + 1 == n) ? "\n" : " ");
}

/*
 * Send a Razer report and read the response.
 * Returns 0 on success and fills response (HIDRAW_SIZE bytes),
 * negative errno otherwise.
 */
static int razer_transact(int fd, unsigned char command_class,
                          unsigned char command_id, unsigned char data_size,
                          const unsigned char *args, size_t args_len,
                          unsigned char *response, bool verbose)
{
    unsigned char request[HIDRAW_SIZE];

    for (int attempt = 1; attempt <= TRANSACT_ATTEMPTS; attempt++) {
        memset(request, 0, sizeof(request));

        request[0] = 0x00;                    // HID report ID
        request[1] = RAZER_STATUS_NEW;        // status
        request[2] = OROCHI_TRANSACTION_ID;   // transaction ID
        request[6] = data_size;
        request[7] = command_class;
        request[8] = command_id;

        if (args != NULL && args_len > 0) {
            if (args_len > 80)
                args_len = 80;
            memcpy(&request[ARG(0)], args, args_len);
        }

        unsigned char crc = 0;

        for (int i = 3; i <= 88; i++)
            crc ^= request[i];

        request[89] = crc;

        if (verbose) {
            printf("request:\n");
            dump(request, sizeof(request));
        }

        if (ioctl(fd, HIDIOCSFEATURE(HIDRAW_SIZE), request) < 0)
            return -errno;

        usleep(OROCHI_WAIT_US);

        memset(response, 0, HIDRAW_SIZE);

        if (ioctl(fd, HIDIOCGFEATURE(HIDRAW_SIZE), response) < 0)
            return -errno;

        if (verbose) {
            printf("response (attempt %d):\n", attempt);
            dump(response, HIDRAW_SIZE);
        }

        if (response[2] != OROCHI_TRANSACTION_ID ||
            response[7] != command_class ||
            response[8] != command_id)
            continue;

        if (response[1] == RAZER_CMD_SUCCESSFUL ||
            response[1] == RAZER_CMD_BUSY)
            return 0;
    }

    return -EIO;
}

static int read_battery_value(int fd, unsigned int *percent, bool verbose)
{
    /*
     * command class 0x07, command 0x80
     * (razer_chroma_misc_get_battery_level)
     * arguments[1] = level 0-255
     */
    unsigned char response[HIDRAW_SIZE];
    int err = razer_transact(fd, 0x07, 0x80, 0x02, NULL, 0, response, verbose);

    if (err < 0)
        return err;

    unsigned int raw = response[ARG(1)];

    *percent = (raw * 100 + 127) / 255;
    return 0;
}

static int read_dpi_value(int fd, unsigned int *dpi_x, unsigned int *dpi_y,
                          bool verbose)
{
    /*
     * command class 0x04, command 0x85
     * (razer_chroma_misc_get_dpi_xy)
     * arguments[1..2] = dpi_x, arguments[3..4] = dpi_y
     */
    unsigned char args[7] = { NOSTORE };
    unsigned char response[HIDRAW_SIZE];
    int err = razer_transact(fd, 0x04, 0x85, 0x07, args, sizeof(args),
                             response, verbose);

    if (err < 0)
        return err;

    *dpi_x = (response[ARG(1)] << 8) | response[ARG(2)];
    *dpi_y = (response[ARG(3)] << 8) | response[ARG(4)];
    return 0;
}

static int write_dpi_value(int fd, unsigned int dpi_x, unsigned int dpi_y,
                           bool verbose)
{
    if (dpi_x < OROCHI_MIN_DPI || dpi_x > OROCHI_MAX_DPI ||
        dpi_y < OROCHI_MIN_DPI || dpi_y > OROCHI_MAX_DPI)
        return -ERANGE;

    /*
     * command class 0x04, command 0x05
     * (razer_chroma_misc_set_dpi_xy)
     * arguments[0] = storage (Orochi V2 uses NOSTORE),
     * arguments[1..2] = dpi_x, arguments[3..4] = dpi_y (big endian)
     */
    unsigned char args[7];

    memset(args, 0, sizeof(args));
    args[0] = NOSTORE;
    args[1] = (dpi_x >> 8) & 0xff;
    args[2] = dpi_x & 0xff;
    args[3] = (dpi_y >> 8) & 0xff;
    args[4] = dpi_y & 0xff;

    unsigned char response[HIDRAW_SIZE];

    return razer_transact(fd, 0x04, 0x05, 0x07, args, sizeof(args),
                          response, verbose);
}

static int read_poll_value(int fd, unsigned int *rate, bool verbose)
{
    /*
     * command class 0x00, command 0x85
     * (razer_chroma_misc_get_polling_rate)
     * arguments[0]: 0x01 = 1000Hz, 0x02 = 500Hz, 0x08 = 125Hz
     */
    unsigned char response[HIDRAW_SIZE];
    int err = razer_transact(fd, 0x00, 0x85, 0x01, NULL, 0, response, verbose);

    if (err < 0)
        return err;

    switch (response[ARG(0)]) {
    case 0x01:
        *rate = 1000;
        return 0;
    case 0x02:
        *rate = 500;
        return 0;
    case 0x08:
        *rate = 125;
        return 0;
    default:
        return -ERANGE;
    }
}

static int write_poll_value(int fd, unsigned int rate, bool verbose)
{
    unsigned char code;

    switch (rate) {
    case 1000:
        code = 0x01;
        break;
    case 500:
        code = 0x02;
        break;
    case 125:
        code = 0x08;
        break;
    default:
        return -ERANGE;
    }

    /*
     * command class 0x00, command 0x05
     * (razer_chroma_misc_set_polling_rate)
     */
    unsigned char args[1] = { code };
    unsigned char response[HIDRAW_SIZE];

    return razer_transact(fd, 0x00, 0x05, 0x01, args, sizeof(args),
                          response, verbose);
}

static bool is_orochi(int fd)
{
    struct hidraw_devinfo info;

    if (ioctl(fd, HIDIOCGRAWINFO, &info) < 0)
        return false;

    return info.vendor == RAZER_VID &&
           (info.product == RAZER_PID_OROCHI_V2_RECEIVER ||
            info.product == RAZER_PID_OROCHI_V2_BLUETOOTH);
}

/* HID mouse protocol; the configuration interface we speak Razer on. */
#define HID_PROTOCOL_MOUSE 2

static bool is_mouse_interface(int minor)
{
    char path[128];
    char buf[16];
    int fd;

    snprintf(path, sizeof(path),
             "/sys/class/hidraw/hidraw%d/device/../bInterfaceProtocol", minor);

    fd = open(path, O_RDONLY);

    if (fd < 0)
        return false;

    ssize_t n = read(fd, buf, sizeof(buf) - 1);

    close(fd);

    if (n <= 0)
        return false;

    buf[n] = '\0';

    return atoi(buf) == HID_PROTOCOL_MOUSE;
}

/*
 * Find the Orochi V2 control (mouse protocol) interface.
 * Stores its path in out and returns fd, or -1 if not found /
 * -2 if permission denied.
 */
static int find_device(char *out, size_t out_len)
{
    int fallback = -1;
    char fallback_path[32] = "";
    bool denied = false;

    for (int i = 0; i < 32; i++) {
        char path[32];
        int fd;

        snprintf(path, sizeof(path), "/dev/hidraw%d", i);

        fd = open(path, O_RDWR);

        if (fd < 0) {
            if ((errno == EACCES || errno == EPERM) &&
                access(path, F_OK) == 0)
                denied = true;
            continue;
        }

        if (!is_orochi(fd)) {
            close(fd);
            continue;
        }

        if (is_mouse_interface(i)) {
            snprintf(out, out_len, "%s", path);
            return fd;
        }

        if (fallback < 0) {
            fallback = fd;
            snprintf(fallback_path, sizeof(fallback_path), "%s", path);
        } else {
            close(fd);
        }
    }

    if (fallback >= 0) {
        snprintf(out, out_len, "%s", fallback_path);
        return fallback;
    }

    return denied ? -2 : -1;
}

static void setup_hint(void)
{
    fprintf(stderr,
            "Permission denied opening hidraw device(s).\n"
            "Run as root (sudo) or install a udev rule:\n"
            "  SUBSYSTEM==\"hidraw\", ATTRS{idVendor}==\"1532\", "
            "ATTRS{idProduct}==\"0094\", TAG+=\"uaccess\"\n");
}

static int cmd_battery(int fd, bool verbose)
{
    unsigned int percent;
    int err = read_battery_value(fd, &percent, verbose);

    if (err < 0)
        return err;

    printf("battery: %u%%\n", percent);
    return 0;
}

static int cmd_dpi_get(int fd, bool verbose)
{
    unsigned int dpi_x, dpi_y;
    int err = read_dpi_value(fd, &dpi_x, &dpi_y, verbose);

    if (err < 0)
        return err;

    printf("dpi: %u:%u\n", dpi_x, dpi_y);
    return 0;
}

static int cmd_dpi_set(int fd, unsigned int dpi_x, unsigned int dpi_y,
                       bool verbose)
{
    int err = write_dpi_value(fd, dpi_x, dpi_y, verbose);

    if (err == -ERANGE) {
        fprintf(stderr, "dpi must be between %u and %u\n",
                OROCHI_MIN_DPI, OROCHI_MAX_DPI);
        return err;
    }

    if (err < 0)
        return err;

    printf("dpi set to %u:%u\n", dpi_x, dpi_y);
    return 0;
}

static int cmd_poll_get(int fd, bool verbose)
{
    unsigned int rate;
    int err = read_poll_value(fd, &rate, verbose);

    if (err < 0)
        return err;

    printf("poll: %u Hz\n", rate);
    return 0;
}

static int cmd_poll_set(int fd, unsigned int rate, bool verbose)
{
    int err = write_poll_value(fd, rate, verbose);

    if (err == -ERANGE) {
        fprintf(stderr, "polling rate must be 125, 500 or 1000\n");
        return err;
    }

    if (err < 0)
        return err;

    printf("poll set to %u Hz\n", rate);
    return 0;
}

/*
 * Machine readable status for the GNOME extension:
 *   device=/dev/hidraw2
 *   battery=85
 *   dpi=1600:1600
 *   poll=1000
 * An optional filter (battery, dpi or poll) restricts the queries.
 * Keys ending in _error mean the value could not be read.
 */
static int cmd_status(int fd, const char *path, bool verbose,
                      const char *filter)
{
    unsigned int percent, dpi_x, dpi_y, rate;
    bool all = filter == NULL;
    int err;

    printf("device=%s\n", path);

    if (all || strcmp(filter, "battery") == 0) {
        err = read_battery_value(fd, &percent, verbose);

        if (err == 0)
            printf("battery=%u\n", percent);
        else
            printf("battery_error=%d\n", err);
    }

    if (all || strcmp(filter, "dpi") == 0) {
        err = read_dpi_value(fd, &dpi_x, &dpi_y, verbose);

        if (err == 0)
            printf("dpi=%u:%u\n", dpi_x, dpi_y);
        else
            printf("dpi_error=%d\n", err);
    }

    if (all || strcmp(filter, "poll") == 0) {
        err = read_poll_value(fd, &rate, verbose);

        if (err == 0)
            printf("poll=%u\n", rate);
        else
            printf("poll_error=%d\n", err);
    }

    return 0;
}

static void usage(const char *prog)
{
    fprintf(stderr,
            "Usage: %s [-v] [command]\n"
            "\n"
            "Commands:\n"
            "  battery           show battery percentage\n"
            "  dpi               show current DPI\n"
            "  dpi <x> [y]       set DPI (both axes when y is omitted)\n"
            "  poll              show polling rate\n"
            "  poll <rate>       set polling rate (125, 500 or 1000)\n"
            "  info              show battery, DPI and polling rate\n"
            "  status [filter]   machine readable, filter: battery|dpi|poll\n"
            "\n"
            "  -v                dump raw requests/responses\n",
            prog);
}

int main(int argc, char **argv)
{
    bool verbose = false;
    const char *command = NULL;
    const char *filter = NULL;
    unsigned int value1 = 0, value2 = 0;
    bool have_value1 = false, have_value2 = false;

    int argi = 1;

    if (argi < argc && strcmp(argv[argi], "-v") == 0) {
        verbose = true;
        argi++;
    }

    if (argi < argc)
        command = argv[argi++];

    if (command != NULL && strcmp(command, "dpi") == 0) {
        if (argi < argc) {
            value1 = strtoul(argv[argi++], NULL, 0);
            have_value1 = true;
        }
        if (argi < argc) {
            value2 = strtoul(argv[argi++], NULL, 0);
            have_value2 = true;
        }
    } else if (command != NULL && strcmp(command, "poll") == 0) {
        if (argi < argc) {
            value1 = strtoul(argv[argi++], NULL, 0);
            have_value1 = true;
        }
    } else if (command != NULL && strcmp(command, "status") == 0) {
        if (argi < argc)
            filter = argv[argi++];
    }

    if (command != NULL &&
        strcmp(command, "battery") != 0 &&
        strcmp(command, "dpi") != 0 &&
        strcmp(command, "poll") != 0 &&
        strcmp(command, "info") != 0 &&
        strcmp(command, "status") != 0) {
        usage(argv[0]);
        return 1;
    }

    int found;
    char path[32] = "";

    found = find_device(path, sizeof(path));

    if (found < 0) {
        if (found == -2) {
            if (verbose)
                printf("error=permission\n");
            setup_hint();
            return 1;
        }

        fprintf(stderr, "Razer Orochi V2 (1532:0094/0095) not found\n");
        if (verbose)
            printf("error=not-found\n");
        return 1;
    }

    int ret = 0;

    if (command == NULL || strcmp(command, "info") == 0) {
        if (cmd_battery(found, verbose) < 0 ||
            cmd_dpi_get(found, verbose) < 0 ||
            cmd_poll_get(found, verbose) < 0)
            ret = 1;
    } else if (strcmp(command, "status") == 0) {
        if (filter != NULL &&
            strcmp(filter, "battery") != 0 &&
            strcmp(filter, "dpi") != 0 &&
            strcmp(filter, "poll") != 0) {
            usage(argv[0]);
            close(found);
            return 1;
        }

        ret = cmd_status(found, path, verbose, filter);
    } else if (strcmp(command, "battery") == 0) {
        ret = cmd_battery(found, verbose) < 0;
    } else if (strcmp(command, "dpi") == 0) {
        if (have_value1)
            ret = cmd_dpi_set(found, value1,
                              have_value2 ? value2 : value1, verbose) < 0;
        else
            ret = cmd_dpi_get(found, verbose) < 0;
    } else if (strcmp(command, "poll") == 0) {
        if (have_value1)
            ret = cmd_poll_set(found, value1, verbose) < 0;
        else
            ret = cmd_poll_get(found, verbose) < 0;
    }

    close(found);
    return ret;
}
