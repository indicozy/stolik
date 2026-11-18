#!/usr/bin/env python3
"""Print X11 user idle time in milliseconds (XScreenSaver extension). Exit 1 with a stderr message on failure.

Run as: python3 -I bin/xidle.py   (-I keeps the script directory off sys.path)
"""
import ctypes
import sys


class XScreenSaverInfo(ctypes.Structure):
    _fields_ = [
        ("window", ctypes.c_ulong),
        ("state", ctypes.c_int),
        ("kind", ctypes.c_int),
        ("til_or_since", ctypes.c_ulong),
        ("idle", ctypes.c_ulong),
        ("eventMask", ctypes.c_ulong),
    ]


def main() -> int:
    try:
        x11 = ctypes.CDLL("libX11.so.6")
        xss = ctypes.CDLL("libXss.so.1")
    except OSError as e:
        print(f"xidle: cannot load X libraries: {e}", file=sys.stderr)
        return 1

    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.restype = ctypes.c_int
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XFree.restype = ctypes.c_int
    x11.XFree.argtypes = [ctypes.c_void_p]
    xss.XScreenSaverAllocInfo.restype = ctypes.POINTER(XScreenSaverInfo)
    xss.XScreenSaverAllocInfo.argtypes = []
    xss.XScreenSaverQueryInfo.restype = ctypes.c_int
    xss.XScreenSaverQueryInfo.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XScreenSaverInfo)]

    dpy = x11.XOpenDisplay(None)
    if not dpy:
        print("xidle: cannot open X display", file=sys.stderr)
        return 1
    try:
        info = xss.XScreenSaverAllocInfo()
        if not info:
            print("xidle: XScreenSaverAllocInfo failed", file=sys.stderr)
            return 1
        try:
            root = x11.XDefaultRootWindow(dpy)
            if xss.XScreenSaverQueryInfo(dpy, root, info) == 0:
                print("xidle: XScreenSaverQueryInfo failed (no XScreenSaver extension?)", file=sys.stderr)
                return 1
            print(int(info.contents.idle))
            return 0
        finally:
            x11.XFree(info)
    finally:
        x11.XCloseDisplay(dpy)


if __name__ == "__main__":
    sys.exit(main())
