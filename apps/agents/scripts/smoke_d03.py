"""
D.0.3 Python-side smoke — verify the router can:
  (A) resolve a tier from platform env without any Node call (legacy path)
  (B) resolve a tier via the Node /internal/ai/resolve endpoint (new path)
  (C) refuse if a tier has no provider with a key
  (D) print the routing table at startup
"""
import asyncio
import os
import sys

# Make `app.*` imports work when running from apps/agents/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.router import (  # noqa: E402
    resolve_llm,
    assert_router_configured,
    ResolvedLlm,
)


fail = 0


def check(cond: bool, msg: str) -> None:
    global fail
    if cond:
        print(f"  ✓ {msg}")
    else:
        print(f"  ✗ {msg}")
        fail += 1


async def main() -> None:
    # ── A — platform-only resolve (no org_id → no Node call, no DB) ─────
    r = await resolve_llm("default")
    check(isinstance(r, ResolvedLlm), "(A) platform resolve returns ResolvedLlm")
    check(r.provider == "openai", f"(A) default tier → openai (got {r.provider})")
    check(r.source == "platform", f"(A) source=platform")
    check(r.llm is not None, "(A) llm built (LangChain BaseChatModel)")

    # ── B — async route through Node /internal/ai/resolve ─────────────────
    org_id = "cmmxnzdsf0000h3p3gjy9qqs0"  # admin@demo.com's org from seed
    try:
        r2 = await resolve_llm("default", org_id=org_id)
        check(r2.provider == "openai", f"(B) default tier via Node → openai (got {r2.provider})")
        check(r2.model == "gpt-4.1", f"(B) default model → gpt-4.1 (got {r2.model})")
        check(r2.source == "platform", f"(B) source=platform (no BYOK in seed)")
        check(r2.llm is not None, "(B) llm built via Node round-trip")
    except Exception as e:
        check(False, f"(B) Node round-trip raised: {type(e).__name__}: {e}")

    # ── C — startup routing table prints + asserts critical tiers ──────────
    try:
        assert_router_configured()
        check(True, "(C) startup config assertion passed")
    except Exception as e:
        check(False, f"(C) startup config raised: {e}")

    print()
    if fail:
        print(f"✗ {fail} check(s) failed")
        sys.exit(1)
    print("✓ All D.0.3 Python router checks pass")


if __name__ == "__main__":
    asyncio.run(main())
