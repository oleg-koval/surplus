import os
import pty
import select
import signal
import sys
import tempfile
import time


def main() -> None:
    surplus, provider = sys.argv[1:]
    with tempfile.TemporaryDirectory(prefix="surplus-pty-") as home:
        ready = os.path.join(home, "ready")
        count = os.path.join(home, "signals")
        environment = os.environ.copy()
        environment.update({
            "HOME": home,
            "XDG_CONFIG_HOME": os.path.join(home, "config"),
            "XDG_STATE_HOME": os.path.join(home, "state"),
            "SURPLUS_CODEX_BIN": provider,
            "SURPLUS_SIGNAL_READY": ready,
            "SURPLUS_SIGNAL_COUNT": count,
        })
        pid, terminal = pty.fork()
        if pid == 0:
            os.execve(surplus, [surplus, "run", "codex", "--model", "test-model"], environment)
        output = bytearray()
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not os.path.exists(ready):
                readable, _, _ = select.select([terminal], [], [], 0.05)
                if readable:
                    try:
                        output.extend(os.read(terminal, 4096))
                    except OSError:
                        break
            if not os.path.exists(ready):
                raise RuntimeError(f"provider did not start in the pseudo-terminal: {output.decode(errors='replace')}")

            os.killpg(pid, signal.SIGINT)
            deadline = time.monotonic() + 5
            status = None
            while time.monotonic() < deadline:
                waited, candidate = os.waitpid(pid, os.WNOHANG)
                if waited:
                    status = candidate
                    break
                readable, _, _ = select.select([terminal], [], [], 0.05)
                if readable:
                    try:
                        output.extend(os.read(terminal, 4096))
                    except OSError:
                        pass
            if status is None:
                raise RuntimeError("Surplus did not exit after terminal interrupt")
            with open(count, encoding="utf-8") as signals:
                received = signals.read().splitlines()
            if received != ["SIGINT"]:
                raise RuntimeError(f"provider received {len(received)} terminal interrupts: {received}")
            print("PTY Ctrl-C delivered once to the provider.")
        finally:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            os.close(terminal)


if __name__ == "__main__":
    main()
