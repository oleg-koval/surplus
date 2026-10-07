import json
import os
import pty
import select
import signal
import subprocess
import sys
import tempfile
import time


def start_pty(surplus: str, args: list[str], environment: dict[str, str], stdout_is_tty: bool = True) -> tuple[int, int]:
    pid, terminal = pty.fork()
    if pid == 0:
        if not stdout_is_tty:
            null_fd = os.open(os.devnull, os.O_WRONLY)
            os.dup2(null_fd, 1)
            os.close(null_fd)
        os.execve(surplus, [surplus, *args], environment)
    return pid, terminal


def wait_pty(pid: int, terminal: int) -> int:
    deadline = time.monotonic() + 10
    output = bytearray()
    while time.monotonic() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited:
            return status
        readable, _, _ = select.select([terminal], [], [], 0.05)
        if readable:
            try:
                output.extend(os.read(terminal, 4096))
            except OSError:
                pass
    raise RuntimeError(f"Surplus did not finish in the pseudo-terminal: {output.decode(errors='replace')}")


def terminal_signal_once(surplus: str, provider: str, sig: int, targeted: bool, stdout_is_tty: bool = True) -> None:
    with tempfile.TemporaryDirectory(prefix="surplus-signal-") as home:
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
        pid, terminal = start_pty(surplus, ["run", "codex", "--model", "test-model"], environment, stdout_is_tty)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not os.path.exists(ready):
                readable, _, _ = select.select([terminal], [], [], 0.05)
                if readable:
                    os.read(terminal, 4096)
            if not os.path.exists(ready):
                raise RuntimeError("provider did not start in the pseudo-terminal")
            if int(open(ready, encoding="utf-8").read()) != pid:
                raise RuntimeError("interactive provider did not replace Surplus in the same process")

            if targeted:
                os.kill(pid, sig)
            else:
                os.killpg(pid, sig)
            status = wait_pty(pid, terminal)
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                raise RuntimeError(f"provider exited unexpectedly after signal {sig}: wait status {status}")
            with open(count, encoding="utf-8") as signals:
                received = signals.read().splitlines()
            expected = signal.Signals(sig).name
            if received != [expected]:
                raise RuntimeError(f"provider received {len(received)} {expected} signals: {received}")
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError("provider process remained after handling the signal")
        finally:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            os.close(terminal)


def readonly_status_then_default_launch(surplus: str, provider: str) -> None:
    with tempfile.TemporaryDirectory(prefix="surplus-policy-") as home:
        state_dir = os.path.join(home, "state")
        provider_args = os.path.join(home, "provider-args.jsonl")
        environment = os.environ.copy()
        environment.update({
            "HOME": home,
            "XDG_CONFIG_HOME": os.path.join(home, "config"),
            "XDG_STATE_HOME": state_dir,
            "SURPLUS_CODEX_BIN": provider,
            "SURPLUS_TEST_WEEKLY_USED": "74",
            "SURPLUS_TEST_PROVIDER_ARGS": provider_args,
        })
        status = subprocess.run([surplus, "status", "codex"], env=environment, capture_output=True, text=True, check=True)
        if not status.stdout.startswith("PREMIUM"):
            raise RuntimeError(f"expected status to show a sample premium decision: {status.stdout}")
        state_path = os.path.join(state_dir, "surplus", "codex-state.json")
        if os.path.exists(state_path):
            raise RuntimeError("status wrote routing hysteresis before a provider launch")

        environment["SURPLUS_TEST_WEEKLY_USED"] = "78"
        pid, terminal = start_pty(surplus, ["run", "codex", "task"], environment)
        try:
            status = wait_pty(pid, terminal)
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                raise RuntimeError(f"Codex launch failed after a read-only status check: wait status {status}")
            with open(provider_args, encoding="utf-8") as args_file:
                args = [json.loads(line) for line in args_file if line.strip()]
            if args != [["task"]]:
                raise RuntimeError(f"first launch at 22% remaining received an upgrade: {args}")
            with open(state_path, encoding="utf-8") as state_file:
                state = json.load(state_file)
            if state.get("tier") != "default":
                raise RuntimeError(f"first launch should persist the default decision: {state}")
        finally:
            os.close(terminal)


def corrupt_config_falls_back(surplus: str, provider: str) -> None:
    with tempfile.TemporaryDirectory(prefix="surplus-config-fallback-") as home:
        config_dir = os.path.join(home, "config", "surplus")
        os.makedirs(config_dir)
        with open(os.path.join(config_dir, "config.json"), "w", encoding="utf-8") as config_file:
            config_file.write("{broken")
        provider_args = os.path.join(home, "provider-args.jsonl")
        environment = os.environ.copy()
        environment.update({
            "HOME": home,
            "XDG_CONFIG_HOME": os.path.join(home, "config"),
            "XDG_STATE_HOME": os.path.join(home, "state"),
            "SURPLUS_CODEX_BIN": provider,
            "SURPLUS_TEST_PROVIDER_ARGS": provider_args,
        })
        pid, terminal = start_pty(surplus, ["run", "codex", "original-prompt"], environment)
        try:
            status = wait_pty(pid, terminal)
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                raise RuntimeError(f"a corrupt local config blocked the original provider: wait status {status}")
            with open(provider_args, encoding="utf-8") as args_file:
                args = [json.loads(line) for line in args_file if line.strip()]
            if args != [["original-prompt"]]:
                raise RuntimeError(f"corrupt config changed the original provider arguments: {args}")
        finally:
            os.close(terminal)


def main() -> None:
    surplus, signal_provider, codex_provider = sys.argv[1:]
    readonly_status_then_default_launch(surplus, codex_provider)
    corrupt_config_falls_back(surplus, codex_provider)
    terminal_signal_once(surplus, signal_provider, signal.SIGINT, targeted=False)
    terminal_signal_once(surplus, signal_provider, signal.SIGTERM, targeted=True)
    terminal_signal_once(surplus, signal_provider, signal.SIGINT, targeted=False, stdout_is_tty=False)
    print("Interactive policy, Ctrl-C, and PID-targeted termination passed in pseudo-terminals.")


if __name__ == "__main__":
    main()
