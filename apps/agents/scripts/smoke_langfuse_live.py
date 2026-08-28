"""
Langfuse LIVE round-trip smoke — does a trace actually arrive?

scripts/smoke_d07.py is deliberately offline: it proves the wiring is shaped
correctly without touching the network. That is necessary but not sufficient,
and the gap is not hypothetical — the SDK's handler constructor changed in v3
(auth moved to a client singleton, trace attributes moved into the LangChain
run config), so passing v2's kwargs raised TypeError, got swallowed by
get_callback's `except Exception`, and every agent ran untraced while
tracing_enabled() cheerfully returned True. An offline test cannot see that.
This one can: it sends a trace and then reads it back.

What it does:
  1. Builds a handler through the real tracing.get_callback().
  2. Drives a LangChain run through it with a fake chat model — no LLM
     provider key needed, no provider call, no spend.
  3. Flushes, then polls the Langfuse API until the trace shows up.
  4. Asserts the filter axes the dashboard depends on: trace name, session,
     user, tags, metadata.

It covers BOTH root shapes, because they take different code paths inside the
handler and only one of them was ever right:
  - a direct chat-model call (what most of our call sites do)
  - a chain-rooted run (what the LangGraph agents do)

Usage — against the local open-source stack (`pnpm langfuse:up`):

    LANGFUSE_HOST=http://localhost:3100 \\
    LANGFUSE_PUBLIC_KEY=pk-lf-draftlegal-local \\
    LANGFUSE_SECRET_KEY=sk-lf-draftlegal-local \\
    python apps/agents/scripts/smoke_langfuse_live.py

It works against Langfuse Cloud too — same three variables. It writes a
handful of traces named `smoke.live.*`, so prefer a dev project.

Exit codes: 0 all good, 1 a check failed, 2 not configured / can't reach.
See docs/operations/LANGFUSE.md.
"""
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import httpx  # noqa: E402

from app import tracing  # noqa: E402
from app.config import settings  # noqa: E402

POLL_ATTEMPTS = 15
POLL_INTERVAL = 4.0   # Langfuse ingests async (S3 -> worker -> ClickHouse).

fail = 0


def check(cond: bool, msg: str) -> None:
    global fail
    if cond:
        print(f"  ✓ {msg}")
    else:
        print(f"  ✗ {msg}")
        fail += 1


def fetch_trace(name: str) -> dict | None:
    """Poll the Langfuse read API for a trace by name."""
    url = f"{settings.langfuse_host.rstrip('/')}/api/public/traces"
    auth = (settings.langfuse_public_key, settings.langfuse_secret_key)
    for attempt in range(1, POLL_ATTEMPTS + 1):
        try:
            r = httpx.get(url, params={"name": name}, auth=auth, timeout=20.0)
        except Exception as e:
            print(f"    (attempt {attempt}: {type(e).__name__}: {e})")
            time.sleep(POLL_INTERVAL)
            continue
        if r.status_code == 401:
            print("✗ 401 from Langfuse — the keys are wrong for this host.")
            sys.exit(2)
        if r.status_code == 200:
            data = r.json().get("data") or []
            if data:
                return data[0]
        time.sleep(POLL_INTERVAL)
    return None


def main() -> None:
    if not (settings.langfuse_public_key and settings.langfuse_secret_key and settings.langfuse_host):
        print("✗ LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST must all be set.")
        print("  Local: pnpm langfuse:up, then use the keys in .env.example.")
        sys.exit(2)

    print(f"Langfuse host: {settings.langfuse_host}")

    if not tracing.tracing_enabled():
        print("✗ tracing_enabled() is False — the SDK failed to import. See the warning above.")
        sys.exit(2)

    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langchain_core.prompts import ChatPromptTemplate

    run = uuid.uuid4().hex[:8]

    # ── 1. Direct chat-model call — the root run IS the model ────────────────
    name_llm = f"smoke.live.llm.{run}"
    print(f"\n[1/2] direct chat-model call → {name_llm}")
    handler = tracing.get_callback(
        trace_name=name_llm,
        org_id="org_smoke_live",
        user_id="user_smoke_live",
        tier="default",
        provider="openai",
        model="gpt-4.1",
        source="platform",
        thread_id=f"thread_{run}",
        tool_name="contract_search",
        extra_metadata={"smoke_run": run},
    )
    check(handler is not None, "get_callback returned a handler")
    if handler is None:
        print("\n✗ No handler — everything downstream would run untraced.")
        sys.exit(1)

    FakeListChatModel(responses=["a termination clause summary"]).invoke(
        "Summarize the termination clause.", config={"callbacks": [handler]}
    )

    # ── 2. Chain-rooted run — the root run is a chain, the model is a child ──
    name_chain = f"smoke.live.chain.{run}"
    print(f"[2/2] chain-rooted run      → {name_chain}")
    handler2 = tracing.get_callback(
        trace_name=name_chain,
        org_id="org_smoke_live",
        tier="fast",
        provider="anthropic",
        model="claude-haiku-4-5",
        source="byok",
    )
    chain = ChatPromptTemplate.from_template("Q: {q}") | FakeListChatModel(responses=["ok"])
    chain.invoke({"q": "hi"}, config={"callbacks": [handler2]})

    tracing.flush()
    print("\nflushed; polling for ingestion (async, usually a few seconds)…")

    # ── Read back #1 and assert every filter axis ────────────────────────────
    trace = fetch_trace(name_llm)
    check(trace is not None, f"trace '{name_llm}' arrived in Langfuse")
    if trace:
        md = trace.get("metadata") or {}
        tags = trace.get("tags") or []
        # The name is the regression that matters most: on v3+ the trace would
        # otherwise be named after the model class ("ChatAnthropic"), which
        # makes the dashboard useless for finding a given call site.
        check(trace.get("name") == name_llm,
              f"trace name is the trace_name, not the model class (got {trace.get('name')!r})")
        check(trace.get("sessionId") == f"thread_{run}",
              f"sessionId = thread id (got {trace.get('sessionId')!r})")
        check(trace.get("userId") == "user_smoke_live",
              f"userId (got {trace.get('userId')!r})")
        for t in ("tier:default", "provider:openai", "model:gpt-4.1",
                  "source:platform", "tool:contract_search"):
            check(t in tags, f"tag {t}")
        check(md.get("org_id") == "org_smoke_live", "metadata.org_id")
        check(md.get("tool_name") == "contract_search", "metadata.tool_name")
        check(md.get("smoke_run") == run, "extra_metadata merged through")

    # ── Read back #2 — the chain path ────────────────────────────────────────
    trace2 = fetch_trace(name_chain)
    check(trace2 is not None, f"trace '{name_chain}' arrived in Langfuse")
    if trace2:
        check(trace2.get("name") == name_chain,
              f"chain-rooted trace name (got {trace2.get('name')!r})")
        check("source:byok" in (trace2.get("tags") or []), "chain-rooted tags carried through")

    print()
    if fail:
        print(f"✗ {fail} check(s) failed")
        sys.exit(1)
    print(f"✓ Langfuse live round-trip OK — open {settings.langfuse_host} and search 'smoke.live.{run}'")


if __name__ == "__main__":
    main()
