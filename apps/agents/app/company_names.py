"""docs/39 A8 — company names compared the way a person reads them.

The API's lib/company-names.ts decides when two names are one company (the
directory links contracts by it); the counterparty picker here must agree, or
a subsidiary the org listed as its own ("Acme UK Ltd") would still be taken
for the other party when a contract spells it "ACME UK LIMITED". Same rules:
case, accents, punctuation, a leading "The", a bracketed defined term, the
"a Delaware corporation" tail, "d/b/a …" and the legal form all go.
"""
from __future__ import annotations

import re
import unicodedata

_LEGAL_FORMS = [
    "limited liability company", "limited liability partnership", "limited partnership",
    "private limited company", "public limited company", "private limited", "private ltd", "pvt limited", "pvt ltd",
    "pte limited", "pte ltd", "pty limited", "pty ltd",
    "co ltd", "company limited", "gmbh and co kg", "gmbh co kg", "ag and co kg", "sa de cv", "sab de cv", "sp z oo", "sp zoo",
    "incorporated", "corporation", "company", "limited", "l l c", "l l p",
    "inc", "corp", "co", "llc", "llp", "lp", "ltd", "plc", "pbc", "pc", "pllc", "lllp",
    "gmbh", "mbh", "ag", "kg", "kgaa", "se", "sa", "sas", "sasu", "sarl", "sl", "slu", "srl", "spa", "sapa",
    "bv", "nv", "cv", "vof", "pty", "pvt", "pte", "kk", "yk", "oy", "oyj", "ab", "as", "asa", "aps", "a s",
    "lda", "ltda", "kft", "zrt", "nyrt", "sro", "ooo", "zao", "oao", "pjsc", "ojsc", "jsc", "ulc", "bhd", "sdn bhd",
]
_FORMS = sorted({tuple(f.split(" ")) for f in _LEGAL_FORMS}, key=len, reverse=True)


def company_key(name: object) -> str:
    """The words that identify a company ("ACME CORPORATION, INC." → "acme")."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower()
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]|\{[^}]*\}", " ", s)
    s = re.sub(r",\s*(a|an)\s.*$", " ", s)
    s = re.sub(r"\s(d/b/a|dba|d\.b\.a\.|t/a|trading as|doing business as)\s.*$", " ", s)
    s = re.sub(r"[“”\"‘’'`]", "", s)
    s = re.sub(r"[&+]", " and ", s)
    s = s.replace(".", "")
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    words = [w for w in s.split(" ") if w]
    if len(words) > 1 and words[0] == "the":
        words = words[1:]
    changed = True
    while changed and len(words) > 1:
        changed = False
        for form in _FORMS:
            if len(form) >= len(words):
                continue
            if tuple(words[-len(form):]) == form:
                words = words[: len(words) - len(form)]
                changed = True
                break
        if len(words) > 1 and words[-1] == "and":
            words = words[:-1]
            changed = True
    return " ".join(words)


def compact_key(name: object) -> str:
    """The key without spaces: "Face Book" and "Facebook" are one name."""
    return company_key(name).replace(" ", "")


def is_one_of(name: object, ours: list[str]) -> bool:
    """Is this party one of the companies we sign as?

    The same company by key; or, as the picker always allowed ("Demo Org" in
    "Demo Org Holdings"), one name inside the other — only for names long
    enough that containing means something.
    """
    k = compact_key(name)
    if not k:
        return False
    for o in ours:
        ok = compact_key(o)
        if not ok:
            continue
        if k == ok:
            return True
        short, long_ = (k, ok) if len(k) <= len(ok) else (ok, k)
        if len(short) >= 4 and short in long_:
            return True
    return False
