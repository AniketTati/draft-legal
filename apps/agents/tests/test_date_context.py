"""The assistant knows what day it is (relative dates were resolved to 2024)."""
from datetime import datetime, timezone

from app.orchestrator import date_context


def test_date_context_names_today_and_asks_for_exact_dates():
    text = date_context(datetime(2026, 9, 26, 1, 30, tzinfo=timezone.utc))
    assert "Today is Saturday 2026-09-26 (UTC)" in text
    assert "YYYY-MM-DD" in text
