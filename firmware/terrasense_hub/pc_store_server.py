
import re
import sys
import zlib
from pathlib import Path

import serial

BAUD = 115200
ROOT = Path(__file__).parent / "terrasense_store"
ROOT.mkdir(exist_ok=True)
NAME_OK = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")  # no paths, no leading dot


def handle(ser, parts):
    cmd = parts[0]
    name = parts[1] if len(parts) > 1 else ""
    if not NAME_OK.match(name):
        ser.write(b"@ERR name\n")
        return
    path = ROOT / name

    if cmd == "@GET":
        if not path.exists():
            ser.write(b"@NOTFOUND\n")
            print(f"[store] GET {name}: not found")
            return
        data = path.read_bytes()
        ser.write(f"@OK {len(data)} {zlib.crc32(data)}\n".encode() + data)
        print(f"[store] GET {name}: sent {len(data)} bytes")

    elif cmd == "@PUT":
        try:
            size, crc = int(parts[2]), int(parts[3])
        except (IndexError, ValueError):
            ser.write(b"@ERR args\n")
            return
        ser.timeout = 3
        data = ser.read(size)
        ser.timeout = 1
        if len(data) != size or zlib.crc32(data) != crc:
            ser.write(b"@ERR corrupt\n")
            print(f"[store] PUT {name}: corrupt or short ({len(data)}/{size} bytes), ESP will retry")
            return
        path.write_bytes(data)
        ser.write(b"@OK\n")
        print(f"[store] PUT {name}: saved {size} bytes")

    elif cmd == "@DEL":
        path.unlink(missing_ok=True)
        ser.write(b"@OK\n")
        print(f"[store] DEL {name}")


def main(port):
    ser = serial.Serial()
    ser.port, ser.baudrate, ser.timeout = port, BAUD, 1
    ser.dtr = False  # do not reset the ESP just because the port was opened
    ser.rts = False
    ser.open()
    print(f"TerraSense USB store on {port}, folder: {ROOT}\n")
    while True:
        raw = ser.readline()
        if not raw:
            continue
        line = raw.decode("utf-8", "replace").rstrip()
        if not line:
            continue
        parts = line.split()
        if parts[0] in ("@GET", "@PUT", "@DEL"):
            handle(ser, parts)
        else:
            print(line)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python pc_usb_store.py <serial port>")
    main(sys.argv[1])