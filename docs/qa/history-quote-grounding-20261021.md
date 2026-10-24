# History observation quote recovery — 2026-10-21

## Scope

Repair the History → meaningful memory → dependent Skill path on the formal 1.2.3 source baseline. Memory is versioned 2.1.7 for package/runtime identification. This task does not build, install, sign, or push a desktop package; the integration agent owns packaging and the user owns GUI acceptance.

## Behavior

- Resolve permitted display differences to a continuous literal span of retained source content; save that original span rather than model-modified text.
- Keep NFKC/whitespace compatibility. Restrict Markdown tolerance to clearly marked presentation, leaving code, operators, identifiers, numbers and dates intact.
- Keep the existing bounded single-line ellipsis compatibility. Reject cross-line ellipsis, different product subtrees and retained-fragment joins; use bounded correction to request a continuous original quotation instead of guessing list/entity scope.
- Remove generated metadata summaries from model input; keep them in provenance. Require quotes from the displayed body.
- Include a fixed item ordinal and validation reason in persisted failures and the one bounded corrective generation. Do not echo failed quotes, source IDs or private text into feedback/logs.
- Existing startup/config-reload recovery requeues exhausted retryable observations. Regression tests cover five sources, their six-hour aggregate and Skill resumption without manual retries.

## Evidence

The five persisted failure inputs were replayed in isolation using the actual Windows package’s configured summary client, the new prepared input/validator and the same generation settings (temperature 0, max_tokens 2400, thinking disabled). The Windows application and original database were not replaced or mutated.

| Source window (UTC, 2026-10-19) | Model calls | Final result |
| --- | ---: | --- |
| 06:20 | 1 | valid |
| 06:30 | 1 | valid |
| 06:10 | 1 | valid |
| 05:40 | 1 | valid |
| 05:30 | 2 | valid after bounded correction |

All six HTTP responses succeeded. Feeding the captured responses through the repaired full MemoryService in temporary databases produced five ready/processed, recallable observations. Every saved evidence_quote is a literal substring of its original source. These are isolated replay results, not installed-app or GUI acceptance.

Sensitive original inputs and model responses remain outside the repository under the local diagnostic directory. Committed tests use synthetic sources, not copied personal paths or recordings.

## Validation

- Final formal-1.2.3 baseline: 411 relevant tests passed (298 Memory, 113 Desktop), plus Memory typecheck and project version consistency.
- Memory evidence/recovery, source filtering and LLM JSON retry suites.
- Memory typecheck, version consistency and runtime build/installer tests.
- Desktop packaged-runtime boundary and Memory runtime upgrade tests (Node subprocess fixtures only; no GUI).
- Regression boundaries include variable exponent operators, code/escaped Markdown, changed quantity/date/negation/product ID, cross-product list roots, fragment joins and Unicode source offsets.

## User acceptance after integration/package

Install the combined test package normally while retaining existing data. Check Memory 2.1.7 activates, the five sources finish processing, their aggregate/Skill stops reporting source retry required, and new History/WeChat sources remain readable. Then rehearse the actual A17 context → live Excel → Dolibarr draft flow. Source/CLI checks do not establish these GUI results.
