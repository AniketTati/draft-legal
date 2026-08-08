"""Record/replay of model responses — docs/37 E12, ADR-01.

The central problem with agent evals is that the model is nondeterministic, so
you cannot gate a pull request on one. The usual answers are both bad:
`temperature=0` does not make tool-calling deterministic and is not how
production runs, and loosening assertions until they stop discriminating
defeats the point of having them.

So separate the two questions:

  * "Does my code do the right thing GIVEN what the model said?" — tool
    dispatch, the confirm gate, RBAC, error surfacing, memory replay, budget
    enforcement. This is most of the agent, it is entirely deterministic, and
    it is where every defect docs/36 found actually lived.
  * "Is what the model said any GOOD?" — genuinely model-dependent, genuinely
    expensive, genuinely noisy.

Record real responses once; replay them to answer the first question on every
PR, for free, with no API key. Real calls are reserved for the second, nightly.

WHAT THE FIXTURE IS KEYED ON, and why it matters
------------------------------------------------
`(session_id, call_index)` — NOT a hash of the messages.

Hashing the conversation was the obvious design and it is wrong here: the
system prompt is part of every message list, so editing one line of a 240-line
prompt would invalidate every fixture in the suite and force a full re-record.
That makes the fixtures so annoying to maintain that people stop replaying.

Keying on call order means a prompt edit does NOT invalidate anything — which
is consistent with ADR-01's statement that tier 2 is deliberately blind to
prompt regressions (that is tier 3's job). What it DOES catch is the code
making a different NUMBER or ORDER of model calls than when it was recorded,
which is a real behavioural change worth failing on.

Callers control the key by choosing a stable `sessionId`. Evals use
`replay:<case-name>`; nothing else needs to change, because session_id already
flows to the router as `thread_id`.

A MISSING FIXTURE IS A LOUD FAILURE, NEVER A REAL CALL
------------------------------------------------------
The one thing this module must never do is quietly fall back to a live model:
that would turn a "free, deterministic" PR gate into an unpredictable bill, and
a green run would no longer mean what it says.
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator, Iterator, Sequence

from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

log = logging.getLogger(__name__)

# Where fixtures live. Committed, reviewable, diffable — when a change alters
# which tool the model picks, that shows up in code review rather than as a
# flaky number in a nightly report.
FIXTURE_DIR = Path(__file__).resolve().parent.parent / "evals" / "replay"

MODE_ENV = "AGENT_REPLAY_MODE"          # "replay" | "record" | unset (off)
_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def mode() -> str | None:
    """Current replay mode, or None when the seam is inert (the default)."""
    m = (os.environ.get(MODE_ENV) or "").strip().lower()
    return m if m in {"replay", "record"} else None


def _fixture_path(session_id: str) -> Path:
    # Session ids reach us from a request body, so they are untrusted input and
    # must not be able to escape the fixture directory via `../`.
    safe = _SAFE.sub("_", session_id or "unkeyed")[:120]
    return FIXTURE_DIR / f"{safe}.json"


class MissingFixture(RuntimeError):
    """Replay was asked for a call that was never recorded."""


def _load(session_id: str) -> list[dict[str, Any]]:
    path = _fixture_path(session_id)
    if not path.exists():
        raise MissingFixture(
            f"no replay fixture for session {session_id!r} (expected {path}). "
            f"Record it with {MODE_ENV}=record and commit the file. "
            f"Replay never falls back to a live model call."
        )
    data = json.loads(path.read_text())
    return data.get("calls", [])


def _dump(session_id: str, calls: list[dict[str, Any]]) -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    path = _fixture_path(session_id)
    path.write_text(json.dumps({"session_id": session_id, "calls": calls}, indent=2) + "\n")


def _to_ai_message(call: dict[str, Any]) -> AIMessage:
    return AIMessage(
        content=call.get("content") or "",
        tool_calls=[
            {"name": tc["name"], "args": tc.get("args") or {}, "id": tc.get("id") or f"replay_{i}"}
            for i, tc in enumerate(call.get("tool_calls") or [])
        ],
    )


def _chunks_for(call: dict[str, Any]) -> list[AIMessageChunk]:
    """Split one recorded response into streamed chunks.

    Text is split so the stream looks like a stream — the orchestrator asserts
    on incremental delivery (docs/36 L10), and a replay that emitted one frame
    would make those assertions vacuous under replay.
    """
    out: list[AIMessageChunk] = []
    text = call.get("content") or ""
    if text:
        step = max(1, len(text) // 4)
        for i in range(0, len(text), step):
            out.append(AIMessageChunk(content=text[i:i + step]))

    tool_calls = call.get("tool_calls") or []
    if tool_calls:
        out.append(AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "name": tc["name"],
                    "args": json.dumps(tc.get("args") or {}),
                    "id": tc.get("id") or f"replay_{i}",
                    "index": i,
                }
                for i, tc in enumerate(tool_calls)
            ],
        ))
    if not out:
        out.append(AIMessageChunk(content=""))
    return out


class ReplayChatModel(BaseChatModel):
    """Serves recorded responses in order. Never touches the network."""

    session_id: str = "unkeyed"
    calls: list[dict[str, Any]] = []
    cursor: int = 0

    @property
    def _llm_type(self) -> str:
        return "replay"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> "ReplayChatModel":
        # The recorded response already contains whatever tool calls the real
        # model chose, so the catalog is irrelevant at replay time. Returning
        # self (rather than a RunnableBinding) keeps `.astream` reachable, which
        # is what the orchestrator calls.
        return self

    def _next(self) -> dict[str, Any]:
        if self.cursor >= len(self.calls):
            raise MissingFixture(
                f"session {self.session_id!r} recorded {len(self.calls)} model call(s) "
                f"but the code asked for call #{self.cursor + 1}. The code now makes a "
                f"different NUMBER of model calls than when this was recorded — that is "
                f"a real behavioural change. Re-record only if it is intended."
            )
        call = self.calls[self.cursor]
        self.cursor += 1
        return call

    def _generate(self, messages, stop=None, run_manager: CallbackManagerForLLMRun | None = None, **kw) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=_to_ai_message(self._next()))])

    async def _agenerate(self, messages, stop=None, run_manager: AsyncCallbackManagerForLLMRun | None = None, **kw) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=_to_ai_message(self._next()))])

    def _stream(self, messages, stop=None, run_manager=None, **kw) -> Iterator[ChatGenerationChunk]:
        for chunk in _chunks_for(self._next()):
            yield ChatGenerationChunk(message=chunk)

    async def _astream(self, messages, stop=None, run_manager=None, **kw) -> AsyncIterator[ChatGenerationChunk]:
        for chunk in _chunks_for(self._next()):
            yield ChatGenerationChunk(message=chunk)


class RecordingChatModel(BaseChatModel):
    """Delegates to a real model and writes what it said to a fixture."""

    inner: Any = None
    session_id: str = "unkeyed"
    calls: list[dict[str, Any]] = []

    @property
    def _llm_type(self) -> str:
        return "recording"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> "RecordingChatModel":
        return RecordingChatModel(
            inner=self.inner.bind_tools(tools, **kwargs),
            session_id=self.session_id,
            calls=self.calls,          # shared list: bound copies append to the same recording
        )

    def _capture(self, message: BaseMessage) -> None:
        self.calls.append({
            "content": message.content if isinstance(message.content, str) else str(message.content),
            "tool_calls": [
                {"name": tc.get("name"), "args": tc.get("args") or {}, "id": tc.get("id")}
                for tc in (getattr(message, "tool_calls", None) or [])
            ],
        })
        _dump(self.session_id, self.calls)

    def _generate(self, messages, stop=None, run_manager=None, **kw) -> ChatResult:
        result = self.inner._generate(messages, stop=stop, run_manager=run_manager, **kw)
        self._capture(result.generations[0].message)
        return result

    async def _agenerate(self, messages, stop=None, run_manager=None, **kw) -> ChatResult:
        result = await self.inner._agenerate(messages, stop=stop, run_manager=run_manager, **kw)
        self._capture(result.generations[0].message)
        return result

    async def _astream(self, messages, stop=None, run_manager=None, **kw) -> AsyncIterator[ChatGenerationChunk]:
        merged: Any = None
        async for chunk in self.inner.astream(messages, **({"stop": stop} if stop else {})):
            merged = chunk if merged is None else merged + chunk
            yield ChatGenerationChunk(message=chunk)
        if merged is not None:
            self._capture(merged)


def wrap(llm: Any, session_id: str | None) -> Any:
    """Apply the seam if a mode is set. Inert otherwise — production is untouched."""
    m = mode()
    if m is None:
        return llm
    key = session_id or "unkeyed"
    if m == "replay":
        calls = _load(key)
        log.info("[replay] serving %d recorded call(s) for session %s", len(calls), key)
        return ReplayChatModel(session_id=key, calls=calls, cursor=0)
    log.info("[replay] RECORDING model calls for session %s", key)
    return RecordingChatModel(inner=llm, session_id=key, calls=[])
