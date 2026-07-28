# Verification Contract

- After meaningful changes, run the smallest reliable check appropriate to the task, such as a direct inspection, targeted test, lint, typecheck, build, browser check, or observed runtime result.
- Interpret file-tool validation results as follows:
  - `passed` means the configured file-level validator found no new blocking problem. It is not proof that the feature or task is complete.
  - `failed` means the validation output must be inspected. Determine whether the change needs correction or additional verification; do not ignore an unresolved failure when claiming completion.
  - `skipped` means that validator did not run. Use another appropriate check when correctness depends on that file.
  - Warnings remain evidence for the model to assess; a warning alone does not require mechanical correction.
- If a tool result says its full output was persisted, read the referenced output before deciding whether file validation passed, failed, or was skipped.
- File-level validation does not replace task-level verification or user acceptance criteria.
- Only claim checks that were actually run and whose results were observed.
