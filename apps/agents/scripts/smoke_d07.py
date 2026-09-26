"""
D.0.7 Python-side smoke — verify Langfuse tracing wiring is correct:

  (A) With LANGFUSE_* keys unset, tracing_enabled() is False, get_callback()
      returns None, and resolve_llm().callbacks is [].
  (B) With all three keys set, tracing_enabled() is True, get_callback()
      returns a real CallbackHandler, and resolve_llm()
      carries it through .callbacks.
  (C) The handler was built with the expected session_id, tags, and metadata
      so Langfuse UI filtering ("show me all openai/gpt-4.1 calls from org X")
      works on day one — not after a bug-fix patch.
  (D) flush() is safe to call whether Langfuse is on or off.

We stay off-network: no real Langfuse account is hit. We just verify the
handler object was constructed with the right constructor args.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app import tracing  # noqa: E402
from app.config import settings  # noqa: E402
from app.router import resolve_llm, ResolvedLlm  # noqa: E402

fail = 0


def check(cond: bool, msg: str) -> None:
    global fail
    if cond:
        print(f"  ✓ {msg}")
    else:
        print(f"  ✗ {msg}")
        fail += 1


def reset_tracing_cache() -> None:
    """Force the lazy SDK import to re-evaluate on the next call."""
    tracing._handler_factory = None  # type: ignore[attr-defined]
    tracing._import_checked = False  # type: ignore[attr-defined]
    # The generated handler subclass is bound to the factory, and the client to
    # a specific set of keys — both go stale when the import is re-evaluated.
    tracing._attributed_cls = None   # type: ignore[attr-defined]
    tracing._client = None           # type: ignore[attr-defined]
    tracing._client_signature = None  # type: ignore[attr-defined]


def main() -> None:
    # Snapshot and scrub the Langfuse env so (A) sees a true off-state even
    # if the developer has LANGFUSE_* set in their shell.
    saved = {
        "public_key": settings.langfuse_public_key,
        "secret_key": settings.langfuse_secret_key,
        "host":       settings.langfuse_host,
    }
    settings.langfuse_public_key = ""
    settings.langfuse_secret_key = ""
    reset_tracing_cache()

    try:
        # ── A — off state: keys unset → no tracing, empty callbacks ─────────
        check(tracing.tracing_enabled() is False, "(A) tracing_enabled() False when keys unset")
        handler = tracing.get_callback(trace_name="test.A")
        check(handler is None, "(A) get_callback returns None when keys unset")

        r = asyncio.run(resolve_llm("default", trace_name="test.A"))
        check(isinstance(r, ResolvedLlm), "(A) resolve_llm returns ResolvedLlm")
        check(r.callbacks == [], f"(A) callbacks is empty list (got {r.callbacks!r})")

        # ── B — on state: keys set → real CallbackHandler ───────────────────
        settings.langfuse_public_key = "pk-lf-smoke-d07"
        settings.langfuse_secret_key = "sk-lf-smoke-d07"
        settings.langfuse_host       = "https://cloud.langfuse.com"
        reset_tracing_cache()

        check(tracing.tracing_enabled() is True, "(B) tracing_enabled() True when all three keys set")
        handler = tracing.get_callback(
            trace_name="test.B",
            org_id="org_smoke",
            user_id="user_smoke",
            tier="default",
            provider="openai",
            model="gpt-4.1",
            source="platform",
            thread_id="thread_smoke",
            tool_name="list_contracts",
            extra_metadata={"custom_flag": True},
        )
        check(handler is not None, "(B) get_callback returns a handler when keys set")
        # The handler is our _AttributedHandler subclass; what matters is that
        # it IS a real Langfuse CallbackHandler, so assert on the base class
        # rather than the exact name.
        base_names = [c.__name__ for c in type(handler).__mro__] if handler else []
        check(
            "LangchainCallbackHandler" in base_names or "CallbackHandler" in base_names,
            f"(B) handler subclasses the Langfuse CallbackHandler (mro: {base_names[:3]})",
        )

        # ── C — metadata propagated correctly (the filter axes in Langfuse UI) ─
        # On the v3+ SDK the per-call attributes are no longer constructor args
        # readable off the handler — they are injected into the LangChain run
        # metadata at on_*_start time. tracing.py mirrors them onto the handler
        # as `langfuse_attributes` / `langfuse_trace_name` precisely so this
        # stays checkable without sending a trace over the network.
        if handler is not None:
            attrs = getattr(handler, "langfuse_attributes", None)
            if attrs is None:
                # v2 SDK — attributes live on the constructor.
                attrs = dict(getattr(handler, "metadata", None) or {})
                attrs["langfuse_tags"] = getattr(handler, "tags", None) or []
                attrs["langfuse_session_id"] = getattr(handler, "session_id", None)
                attrs["langfuse_user_id"] = getattr(handler, "user_id", None)
            tname = getattr(handler, "langfuse_trace_name", None) or getattr(handler, "trace_name", None)

            tags = attrs.get("langfuse_tags") or []
            check("tier:default" in tags,       f"(C) tags contain tier:default (got {tags})")
            check("provider:openai" in tags,    "(C) tags contain provider:openai")
            check("model:gpt-4.1" in tags,      "(C) tags contain model:gpt-4.1")
            check("source:platform" in tags,    "(C) tags contain source:platform")
            check("tool:list_contracts" in tags,"(C) tags contain tool:list_contracts")

            check(attrs.get("tier") == "default",          "(C) metadata.tier = default")
            check(attrs.get("provider") == "openai",       "(C) metadata.provider = openai")
            check(attrs.get("tool_name") == "list_contracts", "(C) metadata.tool_name preserved")
            check(attrs.get("thread_id") == "thread_smoke", "(C) metadata.thread_id preserved")
            check(attrs.get("custom_flag") is True,        "(C) extra_metadata merged in")

            check(attrs.get("langfuse_session_id") == "thread_smoke",
                  f"(C) session_id = thread_smoke (got {attrs.get('langfuse_session_id')!r})")
            check(attrs.get("langfuse_user_id") == "user_smoke",
                  f"(C) user_id = user_smoke (got {attrs.get('langfuse_user_id')!r})")
            check(tname == "test.B", f"(C) trace_name = test.B (got {tname!r})")

        # Resolver attaches handler to .callbacks
        r2 = asyncio.run(resolve_llm(
            "default",
            trace_name="test.B.resolver",
            extra_metadata={"resolver_test": True},
        ))
        check(len(r2.callbacks) == 1, f"(B) resolver returns 1 callback when tracing on (got {len(r2.callbacks)})")
        if r2.callbacks:
            cb_mro = [c.__name__ for c in type(r2.callbacks[0]).__mro__]
            check(
                "LangchainCallbackHandler" in cb_mro or "CallbackHandler" in cb_mro,
                f"(B) the callback is a Langfuse CallbackHandler (mro: {cb_mro[:3]})",
            )

        # ── D — flush() is safe on both off/on states ────────────────────────
        tracing.flush()
        check(True, "(D) flush() with on state did not raise")

        settings.langfuse_public_key = ""
        settings.langfuse_secret_key = ""
        reset_tracing_cache()
        tracing.flush()
        check(True, "(D) flush() with off state did not raise")

    finally:
        # Restore whatever the caller's environment had.
        settings.langfuse_public_key = saved["public_key"]
        settings.langfuse_secret_key = saved["secret_key"]
        settings.langfuse_host       = saved["host"]
        reset_tracing_cache()

    print()
    if fail:
        print(f"✗ {fail} check(s) failed")
        sys.exit(1)
    print("✓ All D.0.7 Langfuse tracing wiring checks pass")


if __name__ == "__main__":
    main()
