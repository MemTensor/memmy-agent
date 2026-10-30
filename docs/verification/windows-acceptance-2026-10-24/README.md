# Windows acceptance and remediation — 2026-10-24

[Acceptance report (PDF, 7 pages)](./REPORT.pdf) records the real Windows validation of fixes based on `5af599511d7236f9db6d3557cc0906046f1e1ed7`.

- The isolated Windows development runtime was verified against the final artifacts. This is not acceptance of a formal installer or a clean Windows installation without system Node.
- The follow-up passed 281 relevant automated tests and obtained passing evidence for 13 unique native cases: 12 passed initially, one was skipped for foreground conditions and passed in a targeted rerun.
- The final Notepad recording contained five events and three document observations; the production teaching renderer retained the document text. Direct GUI stop while the agent was busy responded in about 679.5 ms. Natural-language stop still depends on the model and preceding processing.
- The original business matrix remains 23 passed, two failed and one partial. The PDF tracks subsequent verification separately; the final candidate did not repeat the full original matrix.

The PDF is the acceptance snapshot generated on 2026-10-24, before these fixes were committed. Its statements about uncommitted source describe that snapshot. The accompanying `verification.json` preserves the confirmed source hashes, runtime identity and scoped results.

The independent `Jovianix/teach-mode` repository contains related plugin-side changes. Those changes and other worktrees' uncommitted work are not included in this Host repository delivery. The earlier model-driven trial used the isolated plugin development artifact described in the report.

Formal packaging, clean Windows / no-system-Node acceptance, and complete release regression remain pending.
