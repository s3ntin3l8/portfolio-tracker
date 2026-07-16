# DKB — CSV & PDF import

DKB (Deutsche Kreditbank) has no live-sync API, so — like Parqet and Portfolio
Performance — the tracker imports its own export documents: two CSV formats and a family
of single-document securities PDFs. Everything DKB books is EUR.

## How it works

1. Export a CSV and/or download PDF documents from DKB online banking (see below).
2. Upload the file(s) on the app's **Import** page (accepts `.csv`, `.pdf`, and images —
   the same dropzone every import source uses).
3. The format is auto-detected from the file content — you don't need to pick "DKB"
   manually. Detected drafts go through the normal import review screen for confirmation.
4. Confirmed drafts become transactions, subject to the general import dedup rules
   (file-level, within-source, and cross-source economic fingerprinting — see
   [`CLAUDE.md`](../CLAUDE.md#conventions)).

---

## Supported formats

### 1. Depot positions snapshot (CSV)

A point-in-time snapshot of your holdings, one row per security — export this from your
DKB Depot's position/holdings view. Detected by the header `Datum der Erstellung;…`.

Each row becomes a synthetic **buy**, so cost basis is reproduced from the snapshot's own
average entry price; the export date is used as the (editable) acquisition date. This is
a one-time way to seed a depot's starting positions, not a transaction history.

| Column                  | Used for                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `Wertpapierbezeichnung` | Instrument name                                                                                         |
| `ISIN`                  | Primary instrument resolver                                                                             |
| `WKN`                   | Secondary instrument resolver                                                                           |
| `Einstiegskurs`         | Average entry price                                                                                     |
| `Stückzahl`             | Quantity                                                                                                |
| `Assetklasse`           | Asset class (`Aktien`→equity, `ETF`→etf, `Fonds`→mutual_fund, `Anleihe`/`Renten`→bond, `Krypto`→crypto) |
| `Datum der Erstellung`  | Snapshot date (used as acquisition date)                                                                |
| `Depotnummer`           | Account number (shown in the review screen)                                                             |

### 2. Girokonto Umsatzliste (CSV)

The real transaction history of the cash account that funds a DKB savings plan (Sparplan)
— export this from your DKB Girokonto's transaction/Umsatzliste view. Detected by a header
row containing both `Buchungsdatum` and `Verwendungszweck`.

Security data (ISIN, WKN, price, quantity) is embedded as free text inside the
`Verwendungszweck` (purpose) field — DKB doesn't give it its own columns — so the parser
pattern-matches specific German phrasings within that text. Each row is classified into
one of three shapes:

| `Verwendungszweck` contains      | Becomes                                        | Notes                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Wertp.Abrechn.`                 | `savings_plan` / `sell` / `buy`                | A recurring Sparplan execution or one-off market trade. One-off buys/sells often omit the `Preis` token; the price is then backed out from `Stück`/settlement amount instead. |
| `Wertpapierertrag`               | `dividend`                                     | Distribution paid into the cash account.                                                                                                                                      |
| (anything else, non-zero amount) | `deposit` (positive) / `withdrawal` (negative) | Pure cash movement; the counterparty name is used as the transaction label.                                                                                                   |
| (zero amount)                    | skipped                                        | e.g. periodic "Abrechnung" summary rows that carry no cash movement.                                                                                                          |

**Sparplan label matching:** DKB renamed the savings-plan label from `Fondssparplan` to
`Wertpapier-Sparplan` around mid-2025. The parser matches **both** labels, so older and
newer statements are classified the same way.

A row's provision (fee) is backed out by comparing `price × quantity` against the
settlement amount — DKB doesn't print a separate fee line on Sparplan executions, so
fee-free rows correctly resolve to `0`.

Both CSVs use `;` as the delimiter, `"`-quoted fields, and German number/date locale:
decimal comma with dot-grouped thousands (`"1.674,43 €"` → `1674.43`), `€` suffixes, and
`DD.MM.YYYY` / `DD.MM.YY` dates. Code: `services/api/src/services/parsers/dkb.ts`.

### 3. Securities PDFs (deterministic, no LLM)

Single-document settlement notes downloaded from DKB's online postbox — these are text
PDFs, so (unlike screenshots) they parse **exactly**, with no LLM call, no billing, and no
data leaving the server. The PDF's text layer is extracted via `unpdf`
(`services/api/src/services/parsers/pdf-text.ts`); a DKB-specific signature
(`BYLADEM1001` / DKB's BLZ `120 300 00`) plus a recognised document-type phrase gates
whether the deterministic parser applies at all.

| Document type                                                   | Becomes                                | Key fields extracted                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wertpapier Abrechnung (Kauf/Ausgabe/Verkauf/Rücknahme)          | `buy` / `sell` / `savings_plan`        | `Ausführungskurs`→price, `Provision`→fees, `Ausmachender Betrag`→total, `Stückzinsen` (bond accrued interest, informational).                                                                                                                                                                                                                         |
| Dividendengutschrift / Ausschüttung Investmentfonds             | `dividend`                             | NET `Ausmachender Betrag`→price (drives cash flow); withheld tax (Quellensteuer/Kapitalertragsteuer/Soli/Kirchensteuer) summed into `tax` + a per-component breakdown; gross = net + tax; a foreign `Devisenkurs`→`fxRate`.                                                                                                                           |
| Kapitalmaßnahme confirmation (Fondsverschmelzung / ISIN change) | paired `sell` + `buy`, `kind:"merger"` | Both legs (`Ausbuchung`/`Einbuchung`) priced at the document's `Kurswert` (deemed market value); flows through the fund-merger pipeline, contributions-neutral. Only the **confirmation** letter matches — the earlier announcement (no `Ausbuchung`/`Einbuchung`/`Kurswert`) is deliberately skipped, since it can't produce the merged-in quantity. |

Code: `services/api/src/services/parsers/dkb-pdf.ts`.

**Known limitation:** dividend tax-component extraction relies on matching specific German
tax-line phrasings (`Kapitalertragsteuer`, `Solidaritätszuschlag`, `Kirchensteuer`,
`Einbehaltene Quellensteuer`). If a PDF's wording deviates, the informational `tax` field
under-reports the withheld amount — but the NET `price` (and therefore the cash flow) is
always read directly from `Ausmachender Betrag` and stays correct regardless.

### PDF fallback: vision LLM

If a PDF isn't a recognised DKB (or Trade Republic) document — e.g. it has no extractable
text layer (a scanned/image-only PDF) or doesn't match the DKB signature — the import
falls through to the vision-LLM screenshot parser instead. This only applies when the
admin-configured import strategy is `parser_first` (the default); an admin can force
`vision_only` to skip the deterministic fast-path entirely and send every PDF/image
straight to the vision LLM (`/admin` → import settings,
`services/api/src/services/import-settings.ts`).

---

## Troubleshooting

| Symptom                                                                    | Likely cause                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV import returns "unrecognised DKB CSV format"                           | Neither the depot-snapshot header (`Datum der Erstellung;…`) nor the Umsatzliste header (`Buchungsdatum` + `Verwendungszweck`) matched — the file may not be a DKB export, or DKB changed its column headers. |
| A cash-account row reports "unparseable Betrag"                            | The `Betrag (€)` column didn't parse as a German-locale number — check the export wasn't re-saved/re-encoded by another program (e.g. Excel re-exporting with a different locale).                            |
| A Sparplan execution isn't classified as `savings_plan`                    | The `Verwendungszweck` text doesn't contain `Wertpapier-Sparplan` or the legacy `Fondssparplan` label — this can happen if DKB introduces a third label wording; file an issue with a redacted sample.        |
| A securities PDF falls back to vision instead of parsing deterministically | The PDF has no text layer (scanned/photographed) or doesn't carry DKB's signature/document-type phrase — this is expected fallback behavior, not a bug. Check the import's parser tag in the review screen.   |
| A Kapitalmaßnahme (fund merger) PDF produces an "incomplete" error         | You uploaded the earlier _announcement_ letter, not the _confirmation_ — only the confirmation (with both `Ausbuchung`/`Einbuchung` legs and a `Kurswert`) is deterministically parseable.                    |
| Dividend tax looks wrong but the cash amount is right                      | Expected — see "Known limitation" above; the net cash amount is always correct, only the informational tax breakdown can be incomplete.                                                                       |
