#!/usr/bin/env python3
"""Run a task-authored Python script with a cross-platform, fail-closed policy.

This is the portable defense-in-depth layer. macOS additionally wraps this
process with Seatbelt; production Windows requires Microsoft MXC's native
BaseContainer tier and refuses AppContainer/DACL fallback. Native libraries
are enabled only when one of those OS boundaries is active.
"""

from __future__ import annotations

import base64
import builtins
import json
import os
from pathlib import Path
import runpy
import sys
from typing import Any


def _decode_policy(value: str) -> dict[str, Any]:
    padded = value + "=" * (-len(value) % 4)
    return json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))


def _canonical(value: str) -> str:
    resolved = os.path.normcase(os.path.realpath(os.path.abspath(value)))
    # macOS exposes /tmp and /var as aliases for /private/tmp and /private/var.
    # realpath may retain the alias when a parent lookup is sandbox-denied, so
    # normalize both spellings before comparing capability roots.
    if sys.platform == "darwin":
        if resolved == "/var" or resolved.startswith("/var/"):
            resolved = "/private" + resolved
        elif resolved == "/tmp" or resolved.startswith("/tmp/"):
            resolved = "/private" + resolved
    return resolved


def _inside(candidate: str, roots: tuple[str, ...]) -> bool:
    target = _canonical(candidate)
    for root in roots:
        try:
            if os.path.commonpath((target, root)) == root:
                return True
        except ValueError:
            continue
    return False


def _path_arg(value: Any) -> str | None:
    if isinstance(value, int):
        return None
    try:
        return os.fspath(value)
    except TypeError:
        return None


def _is_write_open(mode: Any, flags: Any) -> bool:
    if isinstance(mode, str) and any(marker in mode for marker in ("w", "a", "x", "+")):
        return True
    if isinstance(flags, int):
        write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
        return bool(flags & write_flags)
    return False


def _install_guards(policy: dict[str, Any]) -> None:
    native_os_sandbox = sys.platform == "darwin" or (
        sys.platform == "win32"
        and os.environ.get("FINWORK_OS_SANDBOX") == "windows-mxc-base-container"
    )
    write_root = _canonical(str(policy["writeRoot"]))
    read_roots = {_canonical(str(root)) for root in policy.get("readRoots", [])}
    read_roots.add(write_root)
    for entry in sys.path:
        if entry and os.path.isdir(entry):
            read_roots.add(_canonical(entry))
    for entry in (sys.prefix, sys.base_prefix, os.path.dirname(sys.executable)):
        if entry:
            read_roots.add(_canonical(entry))
    if sys.platform == "darwin":
        for entry in ("/System", "/usr", "/bin", "/sbin", "/Library/Fonts", "/private/var/db/timezone"):
            if os.path.exists(entry):
                read_roots.add(_canonical(entry))
    read_tuple = tuple(sorted(read_roots))
    write_tuple = (write_root,)

    def require_read(value: Any) -> None:
        target = _path_arg(value)
        if target is not None and not _inside(target, read_tuple):
            raise PermissionError(f"sandbox denied file read: {target}")

    def require_write(value: Any) -> None:
        target = _path_arg(value)
        if target is not None and not _inside(target, write_tuple):
            raise PermissionError(f"sandbox denied file write: {target}")

    def audit(event: str, args: tuple[Any, ...]) -> None:
        if event == "open" and args:
            if _is_write_open(args[1] if len(args) > 1 else None, args[2] if len(args) > 2 else None):
                require_write(args[0])
            else:
                require_read(args[0])
            return
        if event in {"os.listdir", "os.scandir", "os.chdir"} and args:
            require_read(args[0])
            return
        if event in {"os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.utime"} and args:
            require_write(args[0])
            return
        if event in {"os.rename", "os.replace"} and len(args) >= 2:
            require_write(args[0])
            require_write(args[1])
            return
        if event in {"os.symlink", "os.link"}:
            raise PermissionError(f"sandbox denied link creation: {event}")
        if event.startswith("socket.") or event in {"http.client.connect", "urllib.Request"}:
            raise PermissionError("sandbox denied network access")
        if event in {
            "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn",
            "os.fork", "pty.spawn",
        }:
            raise PermissionError(f"sandbox denied child process: {event}")
        if not native_os_sandbox and event == "ctypes.dlopen":
            raise PermissionError("sandbox denied dynamic native library loading")

    sys.addaudithook(audit)

    # Friendly failures for the most common escape paths. The audit hook above
    # remains authoritative for standard Python APIs.
    import socket
    import subprocess

    def denied(*_args: Any, **_kwargs: Any) -> Any:
        raise PermissionError("sandbox denied this operation")

    socket.socket = denied  # type: ignore[assignment]
    socket.create_connection = denied  # type: ignore[assignment]
    subprocess.Popen = denied  # type: ignore[assignment]
    subprocess.run = denied  # type: ignore[assignment]
    subprocess.call = denied  # type: ignore[assignment]
    subprocess.check_call = denied  # type: ignore[assignment]
    subprocess.check_output = denied  # type: ignore[assignment]
    os.system = denied  # type: ignore[assignment]
    for name in dir(os):
        if name.startswith("exec") or name.startswith("spawn") or name in {"fork", "forkpty", "posix_spawn", "posix_spawnp"}:
            setattr(os, name, denied)

    real_import = builtins.__import__

    def guarded_import(name: str, *args: Any, **kwargs: Any) -> Any:
        root = name.split(".", 1)[0]
        if not native_os_sandbox and root in {"numpy", "pandas", "scipy", "pyarrow"}:
            # openpyxl treats a missing numpy as an optional acceleration path
            # and remains fully usable. Native scientific stacks cannot be a
            # portable capability until Windows/Linux have an OS sandbox.
            raise ImportError(f"native package unavailable in guarded-process sandbox: {name}")
        if not native_os_sandbox and root in {"ctypes", "_ctypes", "cffi"}:
            raise PermissionError(f"sandbox denied native escape module: {name}")
        return real_import(name, *args, **kwargs)

    builtins.__import__ = guarded_import


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("usage: task_python_runner.py <policy-b64> <script> [args...]")
    policy = _decode_policy(sys.argv[1])
    script = _canonical(sys.argv[2])
    write_root = _canonical(str(policy["writeRoot"]))
    if not _inside(script, (write_root,)):
        raise PermissionError("task script must be inside the output directory")
    if not os.path.isfile(script) or os.path.islink(script):
        raise PermissionError("task script must be a regular file")
    os.chdir(write_root)
    _install_guards(policy)
    sys.argv = [script, *sys.argv[3:]]
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
