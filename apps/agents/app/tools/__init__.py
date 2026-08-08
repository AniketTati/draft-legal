"""
Agent tools (D.1.4+)

Tools are the verbs the model can invoke. Each tool has a strict Pydantic
args schema so LangChain can bind it to the LLM's tool-calling API cleanly.
Implementation bodies are thin HTTP calls into the Node API's internal
`/api/internal/ai/tools/*` endpoints — that keeps Prisma access + org
scoping + audit in one place.

Registry model:
  get_read_tools(org_id) → list[StructuredTool]

Tools are partially applied with org_id at binding time so the LLM can't
accidentally escape its tenant by hallucinating a different orgId in the
arguments. The args schema only exposes the fields the model should see
(contractId, query terms, etc.) — never orgId/userId.

Design reference:
  - Cursor tools: strict JSON schemas, unambiguous names (`read_file`,
    `codebase_search` vs our `contract_get`, `contract_search`)
  - Anthropic tool-use: one-shot invoke → result → next turn loop
  - GitHub Copilot @workspace: tool scope = current project

Current tools (D.1.4a + D.1.4b):
  - contract_get       — fetch a contract snapshot + full plaintext
  - contract_search    — list the org's contracts by query/filters
  - contract_summarize — compact summary (no full body) for overview asks
  - clause_search      — windowed text search inside a single contract
"""
from __future__ import annotations

from langchain_core.tools import StructuredTool

from .contract_get       import build_contract_get
from .contract_search    import build_contract_search
from .contract_summarize import build_contract_summarize
from .clause_search      import build_clause_search
from .playbook_check     import build_playbook_check
from .redline_propose    import build_redline_propose
from .contract_cite      import build_contract_cite
from .portfolio_search   import build_portfolio_search
from .portfolio_compare  import build_portfolio_compare
from .counterparty_memory import build_counterparty_memory
from .contract_validate  import build_contract_validate
from .approval_list      import build_approval_list
from .counterparty_get   import build_counterparty_get
from .counterparty_list  import build_counterparty_list
from .request_list       import build_request_list
from .custom_field_list  import build_custom_field_list
from .org_memory         import build_org_memory
from .obligations_list   import build_obligations_list
from .renewal_advice     import build_renewal_advice
from .matter_list        import build_matter_list
from .contract_create_from_template import build_contract_create_from_template
from .comment_add        import build_comment_add
from .contract_update    import build_contract_update
from .request_create     import build_request_create
from .approval_route     import build_approval_route
from .redline_apply      import build_redline_apply
from .compliance_get     import build_compliance_get


def get_read_tools(org_id: str, user_id: str | None = None) -> list[StructuredTool]:
    """Return the list of read tools bound to this org.

    D.1.4 (contract_get/search/summarize, clause_search) +
    D.5.1 (playbook_check) +
    P1.4 (redline_propose) +
    P3.1 (contract_cite) +
    P3.2 (portfolio_search) +
    P3.3 (counterparty_memory) +
    P3.4 (contract_validate) +
    P4.5 (approval_list, counterparty_get, request_list,
          custom_field_list) are wired. Writes land in separate
    routes via the ActionPreview surface, not through this list.

    user_id is optional — when passed, approval_list uses it to filter
    the my-queue scope by the current user.
    """
    return [
        build_contract_get(org_id),
        build_contract_search(org_id),
        build_contract_summarize(org_id),
        build_clause_search(org_id),
        build_playbook_check(org_id),
        build_redline_propose(org_id),
        build_contract_cite(org_id),
        build_portfolio_search(org_id),
        build_portfolio_compare(org_id),
        build_counterparty_memory(org_id),
        build_contract_validate(org_id),
        build_approval_list(org_id, user_id),
        build_counterparty_get(org_id),
        build_counterparty_list(org_id),
        build_request_list(org_id),
        build_custom_field_list(org_id),
        build_org_memory(org_id),
        build_obligations_list(org_id),
        build_renewal_advice(org_id),
        build_matter_list(org_id, user_id),
        build_compliance_get(org_id),
        build_contract_create_from_template(org_id, user_id),
        # Write tools — return an awaiting-confirmation payload that the
        # orchestrator surfaces as an ActionPreview card.
        build_comment_add(org_id, user_id),
        build_contract_update(org_id, user_id),
        build_request_create(org_id, user_id),
        build_approval_route(org_id, user_id),
        build_redline_apply(org_id, user_id),
    ]


__all__ = ["get_read_tools"]
