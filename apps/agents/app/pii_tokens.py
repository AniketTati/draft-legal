"""X23 — personal data arrives as round-trip tokens.

The API replaces personal data in contract text with tokens such as
[PII:SSN:1a2b3c4d] before sending it here, and puts the values back into what
it stores: clause text, drafts, redlines. That only works if a model copies a
token exactly wherever it copies the text around it, so every prompt whose
output is stored carries this rule.
"""

PII_TOKEN_RULE = (
    "\n\nSome values in the text are replaced by placeholders such as [PII:SSN:1a2b3c4d]. "
    "Wherever you quote or rewrite text containing one, copy the placeholder exactly as written. "
    "Never alter, split, translate, invent or drop a placeholder."
)
