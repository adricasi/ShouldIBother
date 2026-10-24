import json
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from training.ollama import (
    GpuBusyError,
    OllamaError,
    OllamaStatus,
    assert_loopback,
    ensure_gpu_free,
    make_chat_call,
    probe_ollama,
)


class FakeOllama(BaseHTTPRequestHandler):
    loaded: list[dict[str, Any]] = []
    status = 200
    raw: bytes | None = None
    received: list[dict[str, Any]] = []

    def _send(self, body: bytes) -> None:
        self.send_response(self.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        assert self.path == "/api/ps"
        self._send(
            self.raw if self.raw is not None else json.dumps({"models": self.loaded}).encode()
        )

    def do_POST(self) -> None:
        assert self.path == "/api/chat"
        length = int(self.headers["Content-Length"])
        FakeOllama.received.append(json.loads(self.rfile.read(length)))
        self._send(json.dumps({"message": {"role": "assistant", "content": "{}"}}).encode())

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    monkeypatch.setattr(FakeOllama, "loaded", [])
    monkeypatch.setattr(FakeOllama, "status", 200)
    monkeypatch.setattr(FakeOllama, "raw", None)
    monkeypatch.setattr(FakeOllama, "received", [])
    httpd = HTTPServer(("127.0.0.1", 0), FakeOllama)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()
    httpd.server_close()


def test_nobody_listening_means_ollama_is_not_running() -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert probe_ollama(f"http://127.0.0.1:{port}") == OllamaStatus(reachable=False)


def test_a_running_ollama_with_a_loaded_model_is_reported(server: str) -> None:
    FakeOllama.loaded = [{"name": "gemma4:e4b", "model": "gemma4:e4b"}]
    status = probe_ollama(server)
    assert status == OllamaStatus(reachable=True, loaded_models=("gemma4:e4b",))
    with pytest.raises(GpuBusyError, match="ollama stop"):
        ensure_gpu_free(status)


def test_a_running_ollama_with_no_model_loaded_leaves_the_gpu_free(server: str) -> None:
    status = probe_ollama(server)
    assert status == OllamaStatus(reachable=True, loaded_models=())
    ensure_gpu_free(status)


def test_an_unexpected_answer_is_an_error_not_a_free_gpu(server: str) -> None:
    FakeOllama.raw = b'{"unexpected": true}'
    with pytest.raises(OllamaError, match="no models list"):
        probe_ollama(server)
    FakeOllama.raw = b"not json"
    with pytest.raises(OllamaError, match="JSON"):
        probe_ollama(server)
    FakeOllama.raw = b"[]"
    with pytest.raises(OllamaError, match="JSON object"):
        probe_ollama(server)
    FakeOllama.raw = None
    FakeOllama.status = 500
    with pytest.raises(OllamaError, match="500"):
        probe_ollama(server)


def test_a_proxy_in_the_environment_is_not_used_for_loopback(
    server: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    assert probe_ollama(server).reachable is True


@pytest.mark.parametrize(
    "url", ["http://example.com:11434", "https://127.0.0.1:11434", "http://192.168.1.5:11434"]
)
def test_non_loopback_addresses_are_refused(url: str) -> None:
    with pytest.raises(OllamaError, match="loopback"):
        assert_loopback(url)
    with pytest.raises(OllamaError, match="loopback"):
        probe_ollama(url)
    with pytest.raises(OllamaError, match="loopback"):
        make_chat_call(url)


def test_the_chat_call_posts_json_and_returns_the_answer(server: str) -> None:
    chat = make_chat_call(server)
    answer = chat({"model": "m", "messages": []})
    assert answer["message"]["content"] == "{}"
    assert FakeOllama.received == [{"model": "m", "messages": []}]


def test_the_chat_call_reports_an_unreachable_ollama() -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with pytest.raises(OllamaError, match="cannot reach"):
        make_chat_call(f"http://127.0.0.1:{port}")({"model": "m"})
