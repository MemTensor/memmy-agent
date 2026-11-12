# Release source inclusion

Before validating a release candidate, explicitly fetch and review its source branch, record both exact SHAs, then run:

```sh
node scripts/check-release-source.mjs --remote upstream \
  --release-branch release/v1.2.6 --source-sha <reviewed-v1.2.6-sha> \
  --candidate-sha <release-candidate-sha>
```

`release/vX.Y.Z` maps to `vX.Y.Z`. The check requires a clean candidate containing the pinned source, verifies the canonical MemTensor remote's current source with `ls-remote` before and after, and rejects candidate HEAD changes. JSON records both source observations, candidate SHAs and up to ten missing pinned-source commits. It does not fetch, merge or approve changes. A moved source requires an explicit fetch, review, merge decision and new pin. Run the same command again after regression to bind the result to the same source and candidate.

The independent `Release source inclusion` workflow checks release pushes and corresponding source pushes. Source pushes select the associated **release HEAD**, so testing the source branch against itself cannot produce a false pass. Manual dispatch can check one pair or all remote `release/vX.Y.Z` pairs. Checks and evidence are read-only; they do not configure repository protection rules.

GitHub push workflows only run where the workflow file has been adopted. Initially adding this file only to a release branch covers that branch's pushes; source-push automation requires the same workflow and guard/test files to enter the source branch through its normal review process. The definition also supports manual dispatch once GitHub makes the workflow available for dispatch. Until adoption is complete, execute the independent pre/post check explicitly. This check is separate from the pinned private Harness Full profile; it is not an additional claimed Harness core command.

The final CI check has the stable name `Release source inclusion`. A repository maintainer can make it required in the relevant Ruleset after the workflow is adopted. Adding the workflow alone does not change branch protection or grant release approval.

Behavior regression uses only Node and Git:

```sh
node --test tests/check-release-source.node.mjs
```
