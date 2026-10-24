"""Talking to the local Ollama on loopback: the one-GPU-user guard and the hold-out chat call.

Only 127.0.0.1 / localhost / ::1 are accepted (NFR-001), and no proxy is ever used for it. The
wire format (`GET /api/ps`, `POST /api/chat`) follows `src/server/model/ollama-wire.ts` and is
UNVERIFIED until the builder runs it against the real server (T-012).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

DEFAULT_BASE_URL = "http://127.0.0.1:11434"
PS_PATH = "/api/ps"
CHAT_PATH = "/api/chat"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
MAX_RESPONSE_BYTES = 8 * 1024 * 1024

ONE_GPU_USER_MESSAGE = (
    "One GPU user at a time: Ollama has {models} loaded on 127.0.0.1:11434. "
    "Run `ollama stop <model>` for each loaded model (see `ollama ps`) first."
)


class OllamaError(RuntimeError):
    """Ollama did not answer as expected."""


class GpuBusyError(RuntimeError):
    """Ollama holds a model in memory, so training must not start (AGENTS.md, domain rules)."""


@dataclass(frozen=True)
class OllamaStatus:
    reachable: bool
    loaded_models: tuple[str, ...] = ()


ChatCall = Callable[[dict[str, Any]], dict[str, Any]]
OllamaProbe = Callable[[], OllamaStatus]


def assert_loopback(base_url: str) -> str:
    parts = urlsplit(base_url)
    if parts.scheme != "http" or parts.hostname not in LOOPBACK_HOSTS:
        raise OllamaError(
            f"{base_url!r} is not a loopback address; Ollama stays on 127.0.0.1 (NFR-001)"
        )
    return base_url.rstrip("/")


def _opener() -> urllib.request.OpenerDirector:
    # An empty ProxyHandler: loopback traffic must never go through HTTP(S)_PROXY.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _request(url: str, body: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url,
        data=data,
        method="GET" if data is None else "POST",
        headers={"Content-Type": "application/json"} if data else {},
    )
    with _opener().open(request, timeout=timeout) as response:
        payload = response.read(MAX_RESPONSE_BYTES + 1)
    if len(payload) > MAX_RESPONSE_BYTES:
        raise OllamaError("Ollama answered with more data than expected")
    try:
        value = json.loads(payload)
    except json.JSONDecodeError as error:
        raise OllamaError(f"Ollama did not answer with JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise OllamaError("Ollama did not answer with a JSON object")
    return value


def probe_ollama(base_url: str = DEFAULT_BASE_URL, timeout: float = 2.0) -> OllamaStatus:
    """Asks a local Ollama which models it holds in memory; nobody listening is `reachable=False`.

    A daemon that is up but holds no model uses no meaningful VRAM, and `ollama stop` unloads
    models without stopping the daemon, so only loaded models count as a busy GPU.
    """
    url = assert_loopback(base_url) + PS_PATH
    try:
        value = _request(url, None, timeout)
    except urllib.error.HTTPError as error:
        raise OllamaError(f"Ollama answered {error.code} to {PS_PATH}") from error
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return OllamaStatus(reachable=False)
    models = value.get("models")
    if not isinstance(models, list):
        raise OllamaError(f"unexpected answer from {PS_PATH}: no models list")
    names = tuple(
        str(entry.get("name") or entry.get("model") or "?")
        for entry in models
        if isinstance(entry, dict)
    )
    return OllamaStatus(reachable=True, loaded_models=names)


def ensure_gpu_free(status: OllamaStatus) -> None:
    """Raises `GpuBusyError` when Ollama has a model loaded."""
    if status.loaded_models:
        raise GpuBusyError(ONE_GPU_USER_MESSAGE.format(models=", ".join(status.loaded_models)))


def make_chat_call(base_url: str = DEFAULT_BASE_URL, timeout: float = 300.0) -> ChatCall:
    """A function that POSTs one non-streaming chat request to the local Ollama."""
    url = assert_loopback(base_url) + CHAT_PATH

    def chat(body: dict[str, Any]) -> dict[str, Any]:
        try:
            return _request(url, body, timeout)
        except urllib.error.HTTPError as error:
            raise OllamaError(f"Ollama answered {error.code} to {CHAT_PATH}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise OllamaError(f"cannot reach Ollama at {base_url}: {error}") from error

    return chat
