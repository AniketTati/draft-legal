# 39 — Capture, fix and trust contract data (highlight-to-field + extraction gaps)

**Goal:** when a contract is uploaded, the AI's extracted fields and clauses are
the start, not the end. People can check any value against its source, fix it
by pointing at the text, turn any passage into a new field or clause, and that
work is never overwritten. The same gesture turns our own paper into templates
with live variables.

**Branch:** `feat/field-capture` (worktree `.claude/worktrees/field-capture`).
**Status:** in progress — see the Status column below.

Research behind this plan (Ironclad, SpotDraft and others; our own extraction
audit) was done in the planning conversation on 2026-09-26. Every Ironclad
claim below comes from its help center; "not found" means we looked and found
no documentation, not that the feature does not exist.

## Principles

1. **One gesture, two behaviours.** In signed or third-party paper a highlight
   *captures* a value (the text never changes). In our own drafts and templates
   it *binds* a variable (change the value, the text changes).
2. **People win.** The AI never silently overwrites a value a person set or
   verified; when it now reads something different, it suggests.
3. **Everything shows its source and who set it** — AI · Verified · You ·
   Highlight · Variable · Amendment.
4. **Test before scaling.** Preview a field on 10 contracts before filling
   hundreds; every run can be undone.
5. **Every correction teaches.**

## Priority key

- **P0** — fix first: loses or corrupts data, or blocks everything else.
- **P1** — the core experience: see, fix, capture and use data.
- **P2** — parity with Ironclad/SpotDraft, or closes the loop.
- **P3** — edge case, later.

## Releases

| Release | Gaps | Done when |
|---|---|---|
| **R0 · Data you can trust** | A2, A3, B1, B5, D4, E2, F1, G1, I1 | Re-analysis keeps 100% of values people set; accuracy baseline recorded; one set of field names; opt-out deadlines use a confirmed notice type; totals never mix currencies. |
| **R1 · See and fix from the document** | A1, A4, A11, A15, B2, B4, C1, C2, D2, F2, F3, H3 | ≥90% of values link to their source; fixing a value takes one highlight; no contract stuck without a clear status. |
| **R2 · New fields and clauses from a highlight** | A5, C3, C4, C5, D1, D3, D5, E1, G4 | User-created fields previewed, then filled across the portfolio; new fields usable in list, export and dashboards. |
| **R3 · Keep it right over time** | A7, A8, A9, A10, A12, A13, A14, A16, B3, D6, E3, E4, G2, G3, I2 | Amended terms show on the parent; correction rate falls on fields with examples. |
| **R4 · Drafting variables** | H1, H2 | Variables survive generation; update-all-instances works; draft values flow into fields. |
| **Later** | A6 | Conflicting values are shown, not silently picked. |

## Register

Status: `TODO` · `IN PROGRESS` · `DONE` (with date) · `PARTIAL` (what is left).

### A. Upload and extraction

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| A1 | Extraction runs as an in-memory task (`review.py` background task); a restart or failed save is only logged; the contract turns FAILED after 5 min. | P1 | R1 | Run extraction inside the queued job with retries; retry failed saves; record the failing step. UX: "Retrying (2/3)" / "Failed at step X · Retry". | Not public | When I upload a batch, I want every contract processed or clearly flagged. | DONE 2026-09-26 — the extraction runs and is saved inside its queued job (3 attempts): agents /review/run answers with what to save (streaming heartbeats past fetch's 5-minute limit); a refused save is retried without a new run; each step and attempt shows on the contract (Retrying 2/3; failed while saving … · Re-analyze) and the document stays readable; the stuck sweep leaves live jobs alone; /review kept for an older API |
| A2 | The missing-field retry checks names the first pass never writes (`term_length`, `governing_law`, `total_value`): an extra model call on nearly every contract; recovered values land under names nothing reads. | P0 | R0 | Canonical names; fire only when a real required field is empty; map recovered values; merge stray keys. | Not public | When the AI finds a value, I want it where I look for it. | DONE 2026-09-26 — canonical keys, fires only when a real required field is empty (priced types need a value); unit tests + source tripwire |
| A3 | No single list of field names: notice period has four spellings, governing law two; labels built from raw keys. | P0 | R0 | One field registry in `packages/types` used by extraction, Review Queue, renewals, export and UI labels. | Each property defined once in Data Manager | When I see a term anywhere, I want it to mean one thing. | DONE 2026-09-26 — packages/types fields.ts (registry + shared parser) and type-fields.ts; drift tests for the prompt and TYPE_SCHEMAS; stored keys folded by the store / backfill script |
| A4 | Clause text cut at 800 characters in the extraction prompt. | P1 | R1 | Ask for each clause's first and last words; cut the full text from the document. | Tagged clause keeps the full highlighted text | When I review an indemnity, I want the whole clause. | DONE 2026-09-26 — the extraction gives each clause's first and last words; the API cuts the whole clause from the version text and stores where it sits (docStart/docEnd) |
| A5 | Custom fields packed into the big prompt on the fast model, never validated. | P1 | R2 | Separate custom-field pass with relevant clauses + examples, then validation. | Custom AI properties: ≤10 clause types, 5–10 examples | When I rely on a custom field, I want it held to the same bar. | DONE 2026-09-26 — the org's own fields are read in a pass of their own (agents app/agents/custom_fields.py, used by the review run and /extract-fields): each field with up to 5 examples of how people set or confirmed it on other contracts (API lib/field-examples.ts, quotes PII-redacted), the chunk that mentions them read first, and every answer checked — a quote not in the document word for word is flagged and capped at 0.5, choices matched to the field's options. The store no longer keeps an AI reading its field can't hold (a choice it doesn't have, 'several years' for a duration): it's stored as not found with 'The AI read “…”, which isn't …' at 0.3, so it lands in the Review Queue, and filters/charts never see a malformed value. |
| A6 | Long files: first value found wins across chunks. | P3 | Later | Keep every candidate with its location; flag disagreements. | Not public | When a contract says two things, I want to choose the one that governs. | DONE 2026-09-27 — a contract longer than one read (120,000 characters, exhibits included) keeps every chunk's reading of each field. The field takes the first whose words are in the document, in document order (custom fields too, which were in the order read); an empty answer ("", or a "no" with no words to show for it) no longer keeps a later real one out. When chunks read a field differently, each distinct reading goes to the API with it — alike ones once ("30 days" is "thirty (30) days", "Delaware" is "the State of Delaware"), one whose words aren't in the document not at all — and is kept on the value (`candidates`), which says "The contract says different things: 30 days and 60 days" and asks to be checked. The Fields panel shows each reading with its words, Show in document, and Use this (saved as picked from the text) or Keep; the Review Queue lists them as "Says different things" (1–5 picks a reading); Check all leaves them. A person's choice, check or rejection settles it, and a re-analysis leaves that alone. The custom pass keeps what the chunks it reads say; it still stops once every field has an answer. |
| A7 | OCR stops at 40 pages. | P2 | R3 | Background page-batch OCR to a high limit; per-page quality. | OCRs up to 1,000 pages | When I migrate old scans, I want every page read. | DONE 2026-09-27 — a scan is read a few pages at a time: the API asks the agents service for the digital text first (ocr=none says whether it's a scan), then sends the scan's pages in batches of 8 (pdf-lib), each its own request with retries, up to 1,000 pages — the page shows 'Reading the scanned pages… 16 of 30 pages' (it used to OCR inside one request the API gave a minute, and stop at page 40). The engine says how sure it was of each page (ocrmac's line confidence, tesseract's word confidence); the OCR'd chip says '· 1 page unclear' (which pages, on hover), and a value quoted from a hard page is marked Check — 'Read from page 2 of the scan, which is hard to read' — in the Fields and the Review Queue. Pages nothing could read (or past 1,000) are said on the contract, with Read the scan again. An agents service from before still reads the first 40 pages, as it did. |
| A8 | Counterparty picker knows only our org's name. | P2 | R3 | Settings → Our entities; offer to add on correction. | Admins list subsidiaries | When we sign through different entities, I want the other party right. | DONE 2026-09-27 — Settings › Organization › Our entities: the names the org signs as (subsidiaries, former and trading names), one per company, beside the org's own name (configure:contract; audited). The extraction is told them (ourEntities) and the counterparty picker never takes one, however it is spelled (company names compared as the API compares them; a test keeps the two lists of legal forms equal). A contract whose counterparty is one of ours says so, with the other parties it names one click each (and a note to check the address read with it). When a person replaces the AI's counterparty, the rail asks whether the old one was ours (It's ours adds it). Settings counts the contracts that name one of ours and puts them right in one go where the contract names exactly one other party, clearing the address read for our company with a note; a person's value is left; one run, undoable for 30 days. API: GET/PUT/POST /organization/entities, POST /organization/entities/pick-other-party; run kind counterparty. |
| A9 | Word tracked changes read as accepted, no warning. | P2 | R3 | Detect changes; extract agreed text; show proposed values. | Not found | When the other side sends a redline, I want agreed vs proposed. | DONE 2026-09-27 — a Word file's tracked changes nobody has accepted are counted when it is read (by who made them), and the contract says so: 'This Word file has 5 tracked changes by Daniel Okafor (Brightwave) that nobody has accepted' — Compare versions, Go through the proposals. The document still shows them made (Compare, the redline analysis and search see what they propose), but each value keeps what the file says with the changes rejected — what's agreed — and what their changes would make it waits beside it: 'Their tracked changes propose 45 days' / 'take this out', a person's value included; nothing agreed is overwritten or recorded as changed. The file is read both ways and the two readings' words lined up, so a value is placed exactly (a changed number, a sentence put in, a clause taken out). The Review Queue lists them as Proposed change, first; taking one sets it and checks it, and reading the file again doesn't offer the agreed value back; the next clean version settles them. A file uploaded before this is counted the next time it is analysed. |
| A10 | PDF tables flattened into lines. | P2 | R3 | Detect tables; keep cells; fields can point at a cell. | Custom properties read table cells | When fees sit in a table, I want them read reliably. | DONE 2026-09-27 — a table on a PDF page is read as a table (PyMuPDF's find_tables, two rows of two cells at least): in the document a table, header row and all, where it sits among the paragraphs; in the text the AI reads, a row to a line with its cells split by ' | ', so 'Business | USD 48,000 | 200' keeps each figure with its plan; its words are no longer run into the paragraphs as well. A value read from a row points at its cells — Show in document highlights them, in the Styled view and on the PDF. A ruled box around a line isn't taken for a table; a page without tables reads as before. |
| A11 | No date-order or language handling. | P1 | R1 | Org date-order setting; flag ambiguous dates; detect language; eval cases. | EN/FR/DE; US dates default | When a contract uses day-first dates, I want them read right. | DONE 2026-09-26 — org setting for dates written with numbers (Settings > Organization); typed dates read by it (editor preview too); the AI told it and the contract's language; a date quoted as 03/04/2025 is flagged with both readings; language detected and shown; eval cases for day-first and French |
| A12 | Only PDF/DOCX/TXT upload; exhibits stored, never read. | P2 | R3 | Accept .doc and scans; read attachments as part of the contract. | PDF, DOCX, DOC; OCR all | When I migrate old files and exhibits, I want all of it read. | DONE 2026-09-27 — a legacy .doc and a scan kept as an image (JPG, PNG, TIFF) are taken as a contract: made a PDF to be read (Gotenberg's LibreOffice for .doc and TIFF, pdf-lib for PNG and JPEG) — a scan then through OCR (A7) — and that PDF kept as the version's Original to view and download. An attachment (exhibit, schedule — a scanned one too) is read when it's attached and the contract is read again with it, once for exhibits attached together ('Reading the contract again with its exhibits…'): the analysis reads the contract's text and then each exhibit's under its name, a value quoted from an exhibit is placed in it ('From the exhibit “Exhibit B — Pricing”') rather than marked words-gone, and search finds its words. History in the rail lists each attachment as read (pages, or couldn't read), has Attach (the Overview tab's button couldn't be reached from the document for a contract without clauses), and offers 'read it with the contract' for one attached before. A spreadsheet isn't read. |
| A13 | Type decided from the first 5,000 characters; the full review can't overrule. | P2 | R3 | Classify from structure; flag disagreements; retype extracts only the new type's fields. | Contract type is an editable AI property | When the AI misjudges the type, I want the right fields. | DONE 2026-09-27 — the classifier reads the contract's opening and the headings of the rest (not its first 5,000 characters), and the full review keeps the type the contract was given but says when, read in full, it takes it for another: 'Read in full, this looks more like a vendor agreement than a statement of work' — Keep as is / Make it a vendor agreement. Changing the type (there, or on the type chip) reads only the new type's own fields — seconds, not a whole re-analysis; values a person set stay, a changed AI value can be put back for 30 days like a re-analysis, and the old type's values come back if it is changed back. The bar says 'Reading the statement of work fields…'; a read that fails leaves the analysis standing and says so, with Try again (it used to mark the whole analysis failed). A type a person set or kept stays through re-analysis, and the review offers no opinion on it. The type list has Data processing and Order form, which the AI could already give. |
| A14 | Extracted counterparty not linked to the directory (exact-name match only). | P2 | R3 | Match to directory (aliases, punctuation, suffixes); one-click create. | Not found | When I open a counterparty, I want every contract with them. | DONE 2026-09-27 — company names compared as a person reads them (case, accents, punctuation, The, defined term, a Delaware corporation, d/b/a, legal forms incl. Pvt Ltd, GmbH & Co. KG; shared in @clm/types). A contract links to its directory entry whenever its counterparty is written (extraction, a person, a template, an undo) by any of the entry's names; an entry added, renamed (the old name kept) or given another name links the contracts that name it; an alias taken off moves its contracts to the entry that has it, or none; placeholders ([Company Name], Buyer, Inc.) never link. Contract rail: In your directory (as …) ›; else the entries it might be (the other plus words, initials, a spelling apart) with Link, which teaches the entry the name; else Add to directory (named as a directory would name it). Counterparties: the names not linked, one row per company with its spellings, Link / Add. Counterparty page: Also written, editable. Analytics › top counterparties: one row per company, totals per currency (they added euros to dollars), every row opens its contracts. Legal name on create was silently dropped; saved now. Migration 20260927100600_counterparty_aliases; script link-counterparties.ts. |
| A15 | Extraction spend estimated from the request + "queued" reply; filed as `redline_analysis`. | P1 | R1 | Real token use per step, recorded as `extraction`. | Smart Import no per-doc cost (Sep 2026) | When I run a big import, I want to know the cost. | DONE 2026-09-26 — the run meters its real tokens per model (usage_meter); recorded as extraction with list prices per model (model-pricing.ts), BYOK kept off the cap; the size estimate only when a provider reports nothing |
| A16 | CSV import: nine fixed columns, no documents, its own type list (canonical types → OTHER). | P2 | R3 | Import wizard: spreadsheet + documents, map columns to any field, shared type list. | Bulk file import runs Smart Import | When I migrate with a spreadsheet and PDFs, I want one import. | DONE 2026-09-27 — Contracts › Import: one import for a spreadsheet (CSV with any separator, or Excel .xlsx) and the documents that go with it. Each column goes where it's pointed — title, type, status, owner by email, the document's file name, or any field (standard, a type's own, the org's) — suggested from the headers people use ('Vendor' → counterparty, 'End date' → expiry), with how many of its cells read as that field; a type or status column's words map to the app's one list, shared with the API (approval statuses can't be imported, X24). Documents match rows by file name (else title); a document no row names becomes a contract of its own. Rows go a chunk at a time with progress, each value written through the field store as Imported (an analysis never replaces it: where the AI reads the document otherwise, its reading waits beside the value), each document read by the AI after its row. The results say what was left out and why; 'Open the imported contracts' filters the list to the import. The old CSV route keeps working, with the shared type list. |

### B. See and trust what was extracted

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| B1 | Values read-only; type terms in a server-only key; custom values can't be typed. | P0 | R0 | Fields panel with typed inline edit and "who set it"; field store (one record per contract × field) behind one write service that keeps existing columns in sync. | Every property editable; suggestions accept/edit/dismiss | When a value is wrong or missing, I want to fix it where I see it. | DONE 2026-09-26 — field store (contract_field_values) + routes; Fields panel in the rail and Overview (typed editors, confirm, who set it) |
| B2 | Values not tied to their place in the text; only a hover tooltip. | P1 | R1 | Store positions; "show in document" on every value and clause. | "View in document" | When I see a value, I want to jump to its source. | DONE 2026-09-26 — each quoted value is placed in the version the contract stands on (re-placed after a new version; a value whose words are gone is flagged Check); Show in document on every value and clause, in the styled view and the original PDF (the PDF view itself is broken by pdfjs 5, tracked separately) |
| B3 | Confidence is the model's own number; no contract-level verified state. | P2 | R3 | Computed confidence; per-field thresholds; Unverified/Partly/Verified. | Unverified icon; verify accepts all | When I hand data over, I want to know what a person checked. | DONE 2026-09-27 — computed confidence: the model's number held down by what can be checked — no quote (0.65; a 'no' needs none), a flag the AI raised (0.6), words gone from the current version (0.5), and the field's record on the org's contracts (from 5 checks: as sure as it has been right) — with the reasons in the value's tooltip and the Review Queue. Per-field check levels (Always / When unsure / Only when very unsure) in Settings › Fields › How often the AI is right; the Review Queue decides by them (new reason Always checked) as the Fields panel does. A contract is Verified / Partly verified / Unverified by what a person set or checked: shown over its Fields with Check all (confirm; says how many are flagged; leaves second readings and notice types), a Checked by a person filter, a row marker and sort on the contracts list, and Values checked / Not yet checked columns in the export. Corrections keep what the AI read (correctedFrom). API: POST /contracts/:id/fields/verify-all, GET /field-definitions/records, PUT /field-definitions/checks, /contracts/query checked + sort checked; migration 20260927100700_field_corrections. |
| B4 | Review Queue: core fields only, <0.9 only, 500 contracts, no bulk, no document. | P1 | R1 | Queue on the field store; split view with source; keyboard; bulk verify. | Review Flagged Records; Focused Verification | When I migrate 2,000 contracts, I want to clear doubts fast. | DONE 2026-09-26 — queue on the field store: every field kind and contract in scope, paged, counted by reason (new reading, notice type, words changed, unsure, not found) and field; list beside the value's passage; J/K/V/E/X/Space; bulk confirm and bulk notice type; quotes placed by the queue itself so changed words are found; Renewals links its unconfirmed notices here |
| B5 | API value edits don't refresh the search index. | P0 | R0 | Every value write re-indexes via the field service. | Not public | When a value changes, I want search and the assistant to see it. | DONE 2026-09-26 — every person write re-indexes; PATCH re-indexes when the store wrote |

### C. Capture more from the document

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| C1 | No selection menu in view mode. | P1 | R1 | Selection menu in view and edit mode, document and PDF. | Highlight only on Clauses tab | When I spot something, I want to act without leaving the page. | DONE 2026-09-27 — selection menu over the document in view mode, the same actions in the edit-mode bubble menu, and (2026-09-27) over the original PDF: select words in it and Set as field value, New field, Tag as clause or Save to library, which of the passages worded alike it is counted across its pages. The PDF had no text layer at all — pdf.js is pinned at 4.2.67+ (CVE-2024-4367) and @react-pdf-viewer 3.12 draws its text with a pdf.js 3 call — so nothing in it could be selected and Show in document never found anything there; a small pdf.js shim for the viewer (src/lib/pdfjs-compat.ts) puts it back, without lowering the pin. |
| C2 | Can't fill an existing field from a highlight. | P1 | R1 | "Set as value of ▸" with ranked fields and cleaned value. | Not supported | When a value is wrong, I want to point at the right words. | DONE 2026-09-26 — Set as field value: fields ranked by how the words read and what they name, value cleaned for the field (New York from a governing-law sentence), saved as From text with the passage placed where the reader picked it |
| C3 | Can't create a field from a highlight; admins only, in Settings. | P1 | R2 | "New field" popover; scope; "Suggest to admin". | Not supported | When the AI missed a term, I want a field in two clicks. | DONE 2026-09-26 — New field in the selection menu: name guessed from the words around the highlight, type from how they read; for this contract type or all; the value saved on the contract in the same step; someone who can't add fields suggests it instead (field_suggestions), admins are notified and add or decline it in Settings, the asker is told |
| C4 | AI Findings read-only. | P2 | R2 | "Track as field". | No equivalent found | When the AI surfaces something, I want to track it in one click. | DONE 2026-09-26 — AI findings are in the rail beside Fields (they were only on the Overview tab, read-only), each with 'Track as field' (admins: field added for this contract type with this contract's value, quoting the AI's words; then 'Fill it in on other contracts') or 'Suggest as field' (everyone else, to admins). A finding the org has made a field leaves the list, and the review's open-ended pass is told the org's field names so it stops re-reporting them. |
| C5 | Assistant can't set or create fields. | P2 | R2 | Assistant tools on confirm cards; never silently overwrite. | Agents pre-fill, suggest, never overwrite | When I'm in chat, I want the assistant to fill a field. | DONE 2026-09-26 — two assistant write tools, each only on an Apply card: contract_field_set ('set payment terms on the Acme MSA to 45 days' — the field found by the name the user said, the value read in its terms, the card naming the value it replaces and who set it: never a silent overwrite; written as the person; undo within 15 min puts back the value before, with who had checked it, while nobody changed it since) and field_create ('track PO numbers on SOWs'; configure:contract; undo while it holds no values). Unknown field → the ones it might be; a redacted placeholder or a value the field can't hold is refused. Withheld from users who can't edit/configure. Cards now say what they'll do ('Ready to set a field') instead of the tool's name. |

### D. Standardise across the portfolio

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| D1 | No examples/test before a field goes live; backfill blind, no undo. | P1 | R2 | Preview on 10; improve description; fill N with cost; results + 30-day undo. | Description + examples; Extract Metadata + restore | When I add a field, I want to know it's right first. | DONE 2026-09-26 — Settings › Custom Fields › Try and fill in…: try on 5 contracts (nothing saved), reword what the AI looks for and try again, see N contracts without a value and about $X (or 'your own AI key'), fill in (saves the reworded description first). The row then says 'Filled in on X of N contracts without a value · Check the unsure ones (Review Queue, field + 90% bar) · Undo until <date>'. ?field=<id> from a new field opens it. API: POST /field-definitions/:id/preview, GET /:id/backfill/estimate, backfill.read, fillRun on the list. |
| D2 | No currency/duration/percentage/party types. | P1 | R1 | Add types with normalisation, typed inputs, range filters. | 10 types incl. Monetary, Duration | When I track money or time, I want to filter it. | DONE 2026-09-26 — currency, duration, percentage and long text types, one parser and typed editors for every field; range filters are D3 |
| D3 | Captured fields can't be filtered, exported or charted. | P1 | R2 | Column picker, filters, saved views, export, dashboards, assistant filter. | Properties usable in reports at once | When I've captured a term, I want to use it. | DONE 2026-09-26 — Contracts list: Columns (any field: standard, per type, custom; kept per browser), sort by any column or field (empty last), field filters in the field's own terms (a duration as a length of time, money with currency, date ranges, choices, yes/no, words, empty/has a value) as editable chips in the URL; saved views (private or shared, edited marker, update/rename/share/delete); Export CSV of the whole filtered list with its columns (BOM, CRLF, formula-safe, needs export:contract, audited CONTRACTS_EXPORTED). Search stays on the index but only nominates candidates: every filter now holds on a search too (SLA bands, counterparty, expiry). Analytics › By field: any field's spread (choices, words, ranges, months/years, money per currency, no-value line), each bar opens exactly its contracts. Assistant: contract_search field_conditions ('confidentiality period >= 3 years'), fields, sort_by_field; unknown names answered with similar fields; values PII-redacted. API: POST /contracts/query, /contracts/query/export, GET /contracts/fields, /saved-views, GET /analytics/by-field; migration 20260927100400_saved_views. |
| D4 | Portfolio total adds up different currencies. | P1 | R0 | Totals per currency (or converted and labelled). | Monetary Amount carries currency | When I see the total, I want currencies kept apart. | DONE 2026-09-26 — totalsByCurrency everywhere a total is shown (analytics, renewals, counterparties, assistant card) |
| D5 | Editing a field's description doesn't re-check values. | P2 | R2 | "Re-check N values" via Preview. | Re-predicts after property change | When I improve a field, I want its values re-checked. | DONE 2026-09-26 — Try and fill in… now also offers 'Re-check N': reads again every value the AI found (and fills the empty ones) with the field's current description, after trying the new wording on 5 contracts; values a person set or checked are never re-read. Estimate shows AI values and cost; the row reports 'Re-checked N contracts: M values changed' with Check the unsure ones and a 30-day Undo (the change set is a field run). API: POST /field-definitions/:id/backfill {mode:'recheck'} (replace_ai through the store), estimate.recheck. |
| D6 | Diligence rooms have fixed columns. | P2 | R3 | "Add column" (question or field) with per-cell sources. | Not found | When I run diligence, I want my own question as a column. | DONE 2026-09-27 — a diligence room's table takes columns of its own (up to 20): 'Add column' › Ask a question (asked of every document, answered as yes/no, a short answer, a date, an amount, a number, a length of time, a percentage or one of a list — the form guessed from how it's asked, the column named from it, with what asking costs) or Show a field (any field the contracts hold, from the field store). Every cell shows the words its answer came from and how sure the AI was; 'Show in the contract' opens it with those words highlighted; a person confirms an answer or gives their own, and asking again (or rewording the question) never replaces those. A field column's empty cells can be looked for, written through the field store and undone. Runs show progress, pause on a spent AI budget and go on from there; a document added or read again later is asked on its own. The export carries each column beside its source words; the standard terms it read from old key spellings (always empty) now come from the field store. |

### E. Clauses

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| E1 | Can't tag a clause from a highlight or fix an AI clause. | P1 | R2 | "Tag as clause ▸ type"; change type, adjust range, not a clause. | Highlight or box → Tag clause | When the AI missed a clause, I want to tag it. | DONE 2026-09-26 — Tag as clause in the selection menu (types ranked by the words); tagging over a same-type clause redraws it to the selection (never shrinks it); clause cards change type and dismiss (Not a clause, remembered so a re-analysis leaves it out); a person's clause is marked Tagged and kept by re-analysis; the tagged clause is embedded quietly, never failing the contract |
| E2 | Re-analysis deletes and recreates every clause row. | P0 | R0 | Replace only AI clauses; carry review status; keep user clauses. | Skips manual values | When I've reviewed clauses, I want that work to survive. | DONE 2026-09-26 — clause source column; only AI rows replaced; review kept for unchanged text; user clauses kept and not duplicated |
| E3 | Org can't add clause types for the AI to find. | P2 | R3 | New clause type with examples, preview, detect. | 10 custom AI clauses, ≤20 examples | When we care about a clause the AI doesn't know, teach it once. | DONE 2026-09-27 — Settings › Clause types: an organization adds a clause type the AI doesn't know (up to 25) — a name, what it is, and up to 20 passages that are one — never twice, never over a built-in one. 'Try it on a contract' shows the passages the AI finds there, nothing saved; every extraction from then on is told of the org's types and tags them like the built-in ones; 'Find it in all contracts' reads those analysed before (a page at a time, pausing on a spent AI budget and going on after), with its progress and 'Found in 40 of the 146 contracts read before'. The Tag as clause menu, a clause's type menu and the Clauses tab name them; a passage a person tagged isn't added again; removing a type stops the search and leaves the clauses found with their type (added again under its name, it comes back). |
| E4 | Can't save wording to the clause library from a contract. | P2 | R3 | "Save to clause library" (unapproved, linked back). | Not found | When I see good wording, I want to save it in place. | DONE 2026-09-27 — Save to library on a highlight of a sentence or more (view mode): the words grown to whole words, a title (the clause type it reads as, or its first words) and a category (the one named for its type, or Saved from contracts; any other can be picked); saved unapproved with the contract it came from (and section), the same wording never twice (the existing one is returned). The library lists it Not approved with From <contract> (row and editor), and opens it from ?clause=. API: POST /clauses/from-contract (create:clause, and the reader must see the contract); clause lists carry sourceContract; migration 20260927100800_clause_source_contract. |

### F. Term and renewal data

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| F1 | One undefined notice period drives the auto-renewal opt-out deadline. | P0 | R0 | Split into non-renewal and termination notice; deadline uses non-renewal only; legacy values "unconfirmed" until checked. | Separate built-in properties; Days to Opt Out | When a contract auto-renews, I want the opt-out date right. | DONE 2026-09-26 — prompt splits the notices; deadline from the non-renewal notice by calendar; unconfirmed badge on Renewals; 'which notice?' in the Fields panel |
| F2 | No initial term, renewal type/term, termination for convenience. | P1 | R1 | Add fields; calculated end date; Term & renewal card. | All built in | When I plan renewals, I want the full term picture. | DONE 2026-09-26 — initial term, renewal term, termination for convenience and termination notice; expiry calculated from start + term, marked Calculated |
| F3 | No execution date, signatories, address, venue, payment frequency, value basis. | P1 | R1 | Add fields; analytics use value basis. | Built in | When I report, I want who signed, when, and how we pay. | DONE 2026-09-26 — signed on, signed by, counterparty address, venue, billing and value basis; renewals ACV uses the value basis |

### G. Keeping data right over time

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| G1 | Re-extraction overwrites people's work. | P0 | R0 | AI writes only empty or AI-set values; "Fill blanks" vs "Replace AI values"; suggestions on protected fields; changed-values panel. | Add new data (default) vs Replace all + 30-day restore | When I've fixed something, I want it to stay fixed. | DONE 2026-09-26 — every re-analysis that changed a value and every fill-in is a run with before/after (field_value_runs); for 30 days one step puts back each value still as the run left it (one a person changed or checked since stays). Fields panel: 'The last analysis changed N values · Show · Put the old values back'; Settings: Undo on a fill-in. |
| G2 | In-app edits don't refresh extracted values. | P2 | R3 | Re-extract values whose source text changed, or mark "re-check". | Properties drive template docs | When I edit a contract, I want its data to keep up. | DONE 2026-09-27 — after an edit in the app (and any other edit that saves a new version: a clause applied, the signature page), the refresh-version job re-reads each value whose words are gone: the words that took their place are found by what surrounded the old ones, and a value is read from them the way the field is typed (where the old value sat in its quote; else the first number, length of time, amount, percentage or date; a word value the new words still hold stays). The same value takes the new words as its quote (it stops asking to be checked); another is offered beside the value — 'Since the edit, the contract reads 90 days' — for a person to use or keep, and lists in the Review Queue as a new reading. Nothing is overwritten, a person's value included; a passage rewritten wholesale stays marked 'words changed' (B2). Suggestions now show their unit (they said '45', not '45 days'). |
| G3 | Amendments don't change the parent; links by hand. | P2 | R3 | Detect and suggest parent; roll-up dialog; "amended by" on parent. | Roll-up chosen properties; Family Agent | When a contract is amended, I want the terms in force. | DONE 2026-09-27 — a contract that reads as an amendment, SOW, order form or renewal (its title or heading) is offered the agreements it most likely belongs to, with why (same counterparty; names it; refers to a master services agreement; mentions its date; its governing-agreement field), and links in one click — or to any agreement found by search; a link can be made, changed or removed later, never so a contract becomes its own ancestor. Linked, it lists the agreement's terms it changes (not its own date or parties), the agreement's value struck through beside its own; a person ticks the ones it changes and sets them on the agreement: source Amended, naming the amendment (a link on the value), kept through re-analysis, read by renewals and alerts — undoable for 30 days, from the amendment's page. Linked amendments and exhibits no longer renew on their own (the agreement carries their dates); an agreement whose amendment ends it on another date not yet set on it says so on its Renewals row. The 'Split from binder' banner now shows only for split documents (it showed on every amendment and SOW). API: GET /contracts/:id/parent-suggestions, PUT /contracts/:id/parent, GET /contracts/:id/amendment-changes, POST /contracts/:id/amendment-changes/apply; run kind rollup; migration 20260927100900_amendment_values. |
| G4 | Obligations only auto-extracted after in-app signing; no review state. | P1 | R2 | Extract on signed upload + bulk; "Suggested" until confirmed. | Drafts until verified; bulk 2,500 | When I upload a signed contract, I want its obligations. | DONE 2026-09-26 — obligations the AI finds are Suggested until a person confirms (optionally correcting due date, owner, severity) or dismisses them; a re-read replaces only its own open suggestions and never re-suggests what a person confirmed, dismissed or completed (it used to delete every open obligation). Signed contracts are read after their analysis (executed, uploaded as a signed copy — new upload option — or a signing date found), and in bulk from the Obligations page ('N signed contracts have never been read … Find their obligations', following progress). Obligations page: 'To confirm' tab (attention count), Suggested chips, Confirm/dismiss, Confirm all; contract rail the same. Dismissed ones leave lists, counts, reminders, invoice matching and the assistant; suggested ones still remind. API: POST /obligations/:id/confirm|dismiss, /obligations/review, /obligations/find, stats.suggested/unreadSigned, job extract-obligations; migration 20260927100500_obligation_review_state. |

### H. Drafting: templates and live variables

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| H1 | Template variables typed by hand as `{{key}}`; Word import finds none. | P2 | R4 | Select → Make variable; suggested variables on import. | Workflow Designer tag mode | When I upload our contract, I want variables from it. | DONE 2026-09-27 — a template's own placeholders become variables: in the builder (and on a Word upload) 'N placeholders in the text could be variables' lists each one once — `[Customer Name]`, `«Effective Date»`, `<<Account Manager>>`, a labelled blank (`Governing law: ____`), a `{{ spaced }}` token or one missing from the list — named from its words, typed (date, number, text) and matched to the field it fills; signature-block blanks and [Reserved] are left alone. 'Make N variables' rewrites them as `{{key}}` only between tags. Words selected in a section › Make variable: named from the words around them, typed from how they read, here or everywhere they appear (other sections counted), or pointed at a variable the template has. A variable can name the field it fills (`VariableDef.field`; 'No field' fills none), which drafting honours before matching by name. |
| H2 | Generated drafts lose variables; no update-all; values never reach fields. | P2 | R4 | Variables survive generation; Variables panel; write-through to fields. | Edit Information updates doc | When a term changes, I want to change it once. | DONE 2026-09-27 — a draft keeps its variables: the template engine marks each value it fills in, and each blank, with its variable (`<span data-variable>`, values escaped), the canvas keeps them as a mark, and the draft records its template and variables (`metadata._template`). A Variables panel on the contract lists them (with the fields they fill and the blanks still to fill in): change one and it changes everywhere it appears, saved at once as a version that says what changed, and in the field it fills (`PUT /contracts/:id/variables/:key`, source 'variable'; words that don't read as the field leave it and say so); a blank left in the title is filled too. A field changed in the Fields panel shows as out of step with the text, with 'Put “15 July 2026” in the document' (in the document's own date style) or 'Keep the document’s'. Clicking a term in the document opens it in the panel. Drafts made before this mark only their blanks; those are listed. |
| H3 | Assistant's template path skips extraction; known values re-guessed. | P1 | R1 | Queue extraction; write variable values into fields. | Launch-form answers become properties | When I create from a template, I want fields filled. | DONE 2026-09-26 — a contract drafted from a template (the assistant's tool and the web's new-contract draft) gets its filled-in variables as field values, marked From template and left alone by extraction; the assistant's path now queues the extraction for the rest |

### I. Quality and learning

| # | Gap | Pri | Rel | How draftLegal addresses it | Ironclad | User's JTBD | Status |
|---|---|---|---|---|---|---|---|
| I1 | Extraction accuracy isn't measured. | P0 | R0 | Labelled contracts scored per field; release gate; unit tests. | No published benchmark | When I decide to trust a field, I want its accuracy. | PARTIAL 2026-09-27 — /review/preview, eval target, fields_match / field_ok scorers (tested), 31 labelled contracts (18 added: initial vs renewal terms, venue vs governing law, signed vs effective dates, an explicit "no renewal", exclusivity, perpetual and milestone fees, yen, a German contract, a numbers-only US date, a percentage share and a price list that are no value, the counterparty beside our own name). Left: record the baseline with a model key (`pnpm evals push extraction-fields`, then `pnpm evals run extraction-fields`; about 31 extraction runs on the key). |
| I2 | Corrections and rejections don't improve anything. | P2 | R3 | Every correction is a labelled example; fields needing attention. | Admins add examples by hand | When I fix a mistake twice, I want the AI to stop making it. | DONE 2026-09-27 — every correction and rejection keeps what the AI read (correctedFrom). Each field's record (kept / corrected) shows in Settings › Fields › How often the AI is right, the ones right less than 80% of the time (from 5 checks) marked needs attention, and holds down how sure its next values are (B3). A field corrected twice or more goes to the next extraction as 'read → corrected' examples with the words it was read from (up to 3 each, 8 fields, PII policy applied; not the contract's own parties): the standard and contract-type fields in the extract and validate prompts, the org's own fields in their pass (A5). Re-analysis gets them the same way. |

## Running this branch locally (beside the shared stack)

The shared checkout serves `:3001`/`:5173`/`:8003` for another session. This
branch runs its own copy so neither disturbs the other:

- Database `clm_fields` (a copy of `clm_dev`) and test database `clm_test_fc`.
- Redis database 5 (queues never cross), search indexes prefixed `fc_`
  (`ES_INDEX_PREFIX`), API `:3201`, collab `:3230`, agents `:8013`, web `:5185`
  (`WEB_PORT`, `API_PROXY_TARGET`, `VITE_COLLAB_URL`).
- Root `.env` (gitignored) holds the local config; no model key, so AI
  features answer 503 and new uploads stop after parsing.

## Deploy notes

Each release that adds a migration: run `prisma migrate deploy` by hand before
the code goes live (CI does not migrate), then any backfill script listed in
that release's section below.

### R0

1. `prisma migrate deploy` — `20260927100000_contract_field_values` (the field
   store, with its tenant policy) and `20260927100100_clause_source`.
2. Deploy the API and the agents service together if possible. An API ahead of
   the agents service is safe: the old prompt's `noticePeriodDays` still lands,
   as the unconfirmed notice.
3. `npx tsx --env-file=… scripts/backfill-field-values.ts` — fills the store for
   every contract and rewrites keyTerms under canonical names, without touching
   `updatedAt`. Contracts work without it (the store reads legacy values on
   first touch); the Review Queue's cross-contract view (B4) needs it.
4. With a model key: `pnpm evals push extraction-fields` then
   `pnpm evals run extraction-fields` to record the accuracy baseline (I1).

What changed for people:
- The contract rail's "Key Terms" list is now **Fields**: every core, contract-type
  and custom field, who set each value, and inline editing with a typed input.
- Re-analysis and new versions never overwrite a value a person set or checked;
  a different reading shows beside it to take or keep. "Only fill empty fields"
  is in the Re-analyze menu.
- Notices are told apart: the opt-out deadline uses the notice to stop renewal,
  counted by the calendar; a notice found before the split is marked
  unconfirmed on Renewals and asks which notice it is.
- Totals are per currency everywhere.

### R1

1. No migration.
2. Deploy the agents service with the API, or first. The API now runs each
   extraction inside its queued job and waits on the agents service's
   `/review/run` (it streams heartbeats so fetch's 5-minute limit never ends a
   long run); an agents service without `/review/run` answers 404 and the API
   hands the run to the old fire-and-forget `/review`, as before. Restart the
   agents service so it loads the new Python.
3. Known issue, tracked separately: the original-PDF view is broken by pdfjs 5
   (react-pdf-viewer), so Show in document and the selection menu work in the
   styled view only until it is fixed (C1's remainder).

What changed for people:
- Every quoted value and clause has Show in document; a value whose words are
  gone from the latest version is marked Check.
- Highlight words in view mode → Set as field value (the field is guessed from
  the words; the value is cleaned for it).
- Settings › Organization: how dates written with numbers are read (03/04/2025).
- A contract's analysis shows each step and retry; a failed save is retried
  without running the extraction again.
- Review Queue covers every field, is counted by reason, has bulk confirm and
  keyboard keys (J/K/V/E/X/Space).
- New field types: currency, duration, percentage, long text. New fields: initial
  term, renewal term, termination for convenience and its notice, signed on,
  signed by, counterparty address, venue, billing, value basis.

### R2

1. `prisma migrate deploy` — `20260927100200_field_suggestions` (C3),
   `20260927100300_field_value_runs` (D1 and re-analysis undo),
   `20260927100400_saved_views` (D3), `20260927100500_obligation_review_state`
   (G4; existing obligations stay confirmed). The three new tables carry the
   tenant policy.
2. Deploy the API (with the web app) before the agents service: the assistant's
   new tools `contract_field_set` and `field_create` call API routes that only
   the new API has (`/api/internal/ai/tools/contract_field_preview` and the
   apply/undo pair). An older agents service ignores the new request fields
   (custom-field examples), so the order is only about the tools. Restart the
   agents service.
3. No backfill. Signed contracts that were never read for obligations are
   offered on the Obligations page ("N signed contracts have never been read …
   Find their obligations"); run it per org when convenient — it queues at most
   500 contracts per press, one model call each.

What changed for people:
- Highlight words → New field (admins add it; others suggest it to an admin).
  An AI finding can be tracked as a field.
- Settings › Fields: try a new field on 5 contracts, then fill it in across the
  portfolio, check the unsure ones, undo for 30 days; a changed description
  offers to re-check the AI's values.
- Contracts list: columns, sort, filters on any field, saved views (private or
  shared), Export CSV. Analytics › By field. The assistant searches by field
  conditions and can set a value or add a field, each on an Apply card.
- Obligations the AI finds are Suggested until someone confirms or dismisses
  them; a signed upload (new "This is a signed copy" option) is read for them.

### R3

1. `prisma migrate deploy` — `20260927100600_counterparty_aliases` (A14),
   `20260927100700_field_corrections` (B3/I2: what the AI read before a
   person corrected it; empty until people correct values),
   `20260927100800_clause_source_contract` (E4),
   `20260927100900_amendment_values` (G3),
   `20260927101000_contract_exhibits` (A12: each attachment's text as read,
   with its row-level security policy),
   `20260927101100_clause_type_definitions` (E3: clause types an org adds,
   with its row-level security policy),
   `20260927101200_diligence_columns` (D6: a room's own columns on
   `diligence_rooms.columns`, and each question's answers in
   `diligence_cells`, with its row-level security policy).
2. Deploy the API, then the agents service (restart it): the API sends the
   org's other names (`ourEntities`) and its reviewers' corrections
   (`corrections`, and per custom field) with each extraction; an older agents
   service ignores both and reads as before. A13: the classifier samples the
   opening and the headings of the rest, and the review keeps the type it is
   given, returning `typeOpinion` when the whole contract reads as another
   (stored as `metadata._typeOpinion`); the API sends `typeLocked` when a
   person set the type. An older agents service classifies as before and
   gives no opinion, so no banner shows. A retype queues the new
   `extract-type-fields` job, which runs in the API's in-process workers, so
   it ships with the API. A7: `/extract` takes `ocr` and `pageOffset` and
   answers `scanned`, `ocrQuality` and `pageStarts`. The API reads a scan in
   batches only when the service says `scanned`; an older agents service
   still OCRs the first 40 pages in one request, as before. A10: `/extract`
   finds a PDF's tables (PyMuPDF `find_tables`, in the pinned
   `pymupdf>=1.24`). PDFs read before this keep their flattened tables until
   the file is read again: a new upload, or `POST /contracts/:id/analyze?full=true`.
   The page's "Re-analyze" doesn't re-read the file. E3: the agents service has
   a new `/find-clause`, and the review takes `customClauseTypes`. Restart it
   before an org adds a type: an older service returns 404 to "Try it on a
   contract" and to the run over earlier contracts, and ignores the types in
   the review. That run (`detect-clause-type`) goes on the API's in-process
   workers. D6: a room's question goes to the existing `/extract-fields` as a
   field with `question` set; restart the agents service first — an older one
   ignores `question` and answers from the column's name alone. The new
   `answer-diligence-column` and `answer-diligence-document` jobs run on the
   API's in-process workers.
3. `npx tsx --env-file=… scripts/link-counterparties.ts` — links the contracts
   analysed before to their directory entry by any spelling of the company
   ("ACME CORPORATION, INC." to Acme Corp.). Idempotent; leaves updatedAt alone.
   Without it those contracts still show on a company's page when they spell
   its name exactly, as before.

What changed for people:
- A contract's counterparty links to its Counterparties entry by any spelling;
  the rail says which entry, or offers the one it might be (Link) or Add.
  Counterparties lists the names not linked yet, one row per company.
- Settings › Organization › Our entities: the companies you sign as. The AI
  never takes one for the other party; contracts that already do can be put
  right in one go (undoable).
- Analytics › Top counterparties: one row per company, totals per currency.
- Confidence is now the model's number held down by what can be checked (no
  quote, a flag, words gone, the field's record), so more values show Check;
  hovering says why. Settings › Fields › How often the AI is right: each
  field's record, and when to check it (always / when unsure / rarely).
- Contracts are Verified / Partly verified / Unverified: over the Fields (with
  Check all), as a filter and a row marker on the list, and in the export.
- A field people correct twice or more is read the way the corrections show on
  the next contracts (the extraction gets them as examples).
- Highlight wording in a contract → Save to library: saved unapproved, filed
  by its clause type, linked back to the contract.
- Editing a contract in the app re-reads the values whose words changed: the
  new reading waits beside the value ("Since the edit, the contract reads …").
- An amendment is offered the agreement it amends (or linked by search), and
  sets the terms it changes on that agreement, marked Amended. Linked
  amendments and exhibits leave Renewals: the agreement they belong to carries
  their dates once rolled up — worth telling teams who watch Renewals.
- When the whole contract reads as another type than it was filed as, a
  banner says so: Keep as is, or Make it that type. Changing a contract's type
  reads only the new type's fields, in seconds; it no longer re-runs the whole
  analysis. A type a person set stays through re-analysis.
- A Word file with tracked changes nobody has accepted (the other side's
  redline) says so on the contract. Its values stay what is agreed, and each
  change's proposal waits beside them, also in the Review Queue as "Proposed
  change". Before this, their proposals became the contract's values. No
  migration: a Word file's changes are counted when it is read, and one
  uploaded earlier is counted the next time it is analysed.
- Scanned PDFs are read in full, up to 1,000 pages (it stopped at 40), with
  progress on the contract. Pages the OCR engine was unsure of are named, and
  values from them are marked Check. Pages that couldn't be read are named too,
  with "Read the scan again". A scan uploaded before this that stopped at 40
  pages now says so on its contract, with the same button.
- Uploads also take a legacy .doc and a scan saved as an image (JPG, PNG,
  TIFF). The .doc and TIFF go through Gotenberg's LibreOffice, which the
  production image (`gotenberg/gotenberg:8`) has; its PDF is shown as the
  Original. Attachments are read as part of the contract: the contract is
  read again with them, which is one more model run per batch attached. Values
  quoted from one say which exhibit. Attachments from before this say "not read
  yet", with a link to read them.
- Tables in PDFs stay tables: in the document, and in the text the AI reads as
  one row per line, so a fee stays with its plan. "Show in document" highlights
  the cells a value came from.
- Settings › Clause types: an organization teaches the AI a clause it doesn't
  know, with a name, what it is and example passages. "Try it on a contract"
  previews what's found, new contracts are searched for it, and "Find it in
  all contracts" searches earlier ones. The run over earlier contracts uses the
  AI budget: one read per contract.
- The original PDF view has its text again: words in it can be selected
  (with the same menu as the Styled view: set a field, new field, tag a
  clause, save to library) and "Show in document" highlights them there.
  Since pdf.js was raised to 4.2.67+ for CVE-2024-4367, it showed the page
  with no text layer. The fix is a shim in the web app; pdf.js stays pinned.
- Contracts › Import (was Bulk import) takes a spreadsheet — CSV or Excel —
  and the documents together: map each column to any field, check how its
  values read, and import. Each document is read by the AI after its row;
  values from the sheet stay, and where the AI reads a document otherwise,
  its reading waits in the Review Queue. No migration; the old
  `POST /contracts/bulk-import` API still works (its types now follow the
  app's list: "DPA" is Data processing, not a type of its own).
- Diligence rooms: "Add column" asks every document a question of your own
  ("Can the supplier assign without consent?"), answered in the form you pick,
  or shows any field. Each cell shows the words it came from; confirm or
  correct it there, or open the contract at those words. Asking uses the AI
  budget — one read per document per question, shown before you ask — and
  documents added later are asked as they're read. The room's export carries
  the columns and their source words.

### R4

1. No migration: a draft records its template and variables in
   `contracts.metadata._template`.
2. Deploy the API and the web app together. The template engine now wraps each
   value it fills in with `<span data-variable="key">` (and escapes it, which it
   didn't); an older web app drops those spans when a draft is edited and saved,
   so the variables would be lost from that version on. Nothing changes for the
   agents service: the draft agent gets the same HTML from
   `/templates/:id/generate`.
3. No backfill. Drafts made before this marked only their blanks, so their
   Variables panel lists the blanks; a new draft marks every value.
4. Known limit: the marks live in the app's own editor. A version that comes
   back through Word or Google Docs (a .docx) carries the text only, so from
   that version on the draft's Variables panel is empty.

What changed for people:
- Templates: the placeholders already in a template ("[Customer Name]",
  "«Effective Date»", "Fees: ____") are offered as variables, each typed and
  matched to the field it fills, when a Word file is uploaded or the builder is
  opened. Select words in a section › Make variable, here or everywhere they
  appear. A variable can name the field it fills.
- Drafts made from a template have a Variables panel: change a term there and it
  changes everywhere it appears in the document and in the field it fills, saved
  as a version saying what changed ("Changed Customer name to “Globex Industries
  Inc.” (2 places)"). Blanks still to fill in are marked in the text and
  counted; click a term in the document to change it. When someone changes such
  a field in the Fields panel, the Variables panel says the document still says
  otherwise and offers to put the new value in or keep the document's.
- The Styled view no longer starts a justified line with a space.
- Editing a document no longer loses your place: five seconds after typing
  stopped, the save made the editor start over, which dropped the cursor, and
  whatever was typed next went nowhere.

### Later — A6

1. `prisma migrate deploy` — `20260927101300_field_candidates` (a nullable
   `candidates` column on `contract_field_values`; the table's policy covers it).
2. Deploy the API, then restart the agents service. An older agents service
   sends no readings, so nothing shows; an older API doesn't read them (they
   ride in `fieldConfidence` and the metadata evidence, beside what it reads).
3. No backfill. A contract read before keeps one reading per field; reading a
   long contract again (Re-analyze) gives it its readings.

What changed for people:
- A long contract (over about 120,000 characters, as many MSAs with schedules
  are) that states a term differently in two places — a fee in the body and
  another in a schedule, a notice period a later clause changes — says so on
  the field: each reading with its words, Show in document, and Use this for
  the one that governs. The Extraction Queue lists them as "Says different
  things". Before, the first one found was used without a word.
- A long contract's yes/no terms (auto-renewal, say) are no longer read as "no"
  because the first part of the file doesn't mention them.
