"""Token use of one run, across every model call in it (docs/39 A15).

Extraction spend used to be estimated by the API from the size of the request
and of the service's reply — for the fire-and-forget /review that reply was
"queued", so a 60-page contract's three model passes were costed as a few
hundred characters, and filed as `redline_analysis`. A run that wants its real
use opens a meter; every model resolved while it is open (router.resolve_llm)
reports its token counts to it, by provider and model.

    with metering() as meter:
        result = await run_review(...)
    usage = meter.summary()
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator

from langchain_core.callbacks import AsyncCallbackHandler


class UsageMeter:
    """Totals per (provider, model, source) of one run."""

    def __init__(self) -> None:
        self._by: dict[tuple[str, str, str], dict[str, int]] = {}

    def add(self, provider: str, model: str, source: str, input_tokens: int, output_tokens: int) -> None:
        row = self._by.setdefault((provider, model, source), {"calls": 0, "inputTokens": 0, "outputTokens": 0})
        row["calls"] += 1
        row["inputTokens"] += max(0, int(input_tokens or 0))
        row["outputTokens"] += max(0, int(output_tokens or 0))

    def handler(self, provider: str, model: str, source: str) -> "MeterHandler":
        """A callback for one resolved model, reporting under its name."""
        return MeterHandler(self, provider, model, source)

    def summary(self) -> dict[str, Any]:
        by_model = [
            {"provider": p, "model": m, "source": s, **row}
            for (p, m, s), row in self._by.items()
        ]
        return {
            "calls": sum(r["calls"] for r in by_model),
            "inputTokens": sum(r["inputTokens"] for r in by_model),
            "outputTokens": sum(r["outputTokens"] for r in by_model),
            "byModel": by_model,
        }


def _tokens(response: Any) -> tuple[int, int]:
    """Input and output tokens of one model response, whichever way the provider reports them."""
    inp = out = 0
    for gens in getattr(response, "generations", None) or []:
        for g in gens:
            usage = getattr(getattr(g, "message", None), "usage_metadata", None) or {}
            inp += int(usage.get("input_tokens") or 0)
            out += int(usage.get("output_tokens") or 0)
    if inp or out:
        return inp, out
    # Older integrations put it in llm_output instead.
    lo = getattr(response, "llm_output", None) or {}
    tu = lo.get("token_usage") or lo.get("usage") or {}
    return (
        int(tu.get("prompt_tokens") or tu.get("input_tokens") or 0),
        int(tu.get("completion_tokens") or tu.get("output_tokens") or 0),
    )


class MeterHandler(AsyncCallbackHandler):
    """Reports each finished model call of one resolved model to the meter."""

    def __init__(self, meter: UsageMeter, provider: str, model: str, source: str) -> None:
        super().__init__()
        self.meter, self.provider, self.model, self.source = meter, provider, model, source

    async def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        inp, out = _tokens(response)
        self.meter.add(self.provider, self.model, self.source, inp, out)


_current: ContextVar[UsageMeter | None] = ContextVar("usage_meter", default=None)


def current_meter() -> UsageMeter | None:
    return _current.get()


@contextmanager
def metering() -> Iterator[UsageMeter]:
    meter = UsageMeter()
    token = _current.set(meter)
    try:
        yield meter
    finally:
        _current.reset(token)
