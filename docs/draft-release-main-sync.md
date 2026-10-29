# Synchronize main after a Draft Release

After the Draft Release workflow uploads all installers and metadata, it verifies
the Release, source SHA and asset inventory, then publishes a synchronization request
artifact. The Release does not need to be published. Upload failures retain the
existing cleanup behavior; a later request failure preserves the completed Draft.

The existing cloud CodingAgent GitHub webhook receives `workflow_run.completed`
notifications. Notifications only wake the Scheduler. It re-reads the exact workflow
run attempt, original artifact and digest, Release, main history and target configuration
before admitting a task for each maintained branch. Actions does not run the repair
agent or require a separate model credential.

## Maintained branches and PRs

Maintained targets are listed in `.github/main-sync.json`: `v1.2.5`, `v1.2.6` and
`v1.2.7`. Add or retire maintained branches by updating this list through code review.
Historical v branches are not enrolled automatically.

For each target, CodingAgent uses `sync/main-to-<target>` and creates or reuses the
corresponding Draft PR. It merges both histories, preserves human commits and pushes
only the managed synchronization branch. It never directly updates main or the target,
force-pushes, merges a PR or publishes a Release.

Validation failures resume the same CodingAgent task, branch and PR. A changed PR head
or target tip invalidates old results and requires fresh integration and validation.
Review readiness requires successful Linux public suites, type checks, lint, builds,
smoke plan tests and native Windows validation for the current head/base, plus the
remaining GitHub checks. `Main Sync / Full` is a CI status, not Project Harness or
maintainer approval.

Defaults are six repair rounds, two consecutive rounds without progress and 180 minutes
total. When a limit is reached, the loop stops and preserves the workspace and PR for
a maintainer. These limits are configured in the same JSON file. Closing the PR stops
management.

## Deployment and activation

Merge the Memmy workflow changes into main. Deploy the matching Scheduler and
code-runner builds from `cloud-coding-agent`, and apply the database migration.
The cloud repository's `docs/main-sync.md` contains the full configuration.
Subscribe the existing signed GitHub repository webhook to **Workflow runs**, and
enable `main_sync.enabled` in the registered Memmy repository configuration.
The feature is disabled by default.

Reuse the existing model configuration, bot push/fork registration and repository
allowlists. The GitHub token needs contents push, pull-request write, Actions
read/write, checks read and commit-status write permissions. Keep credentials in
secret management, not request artifacts or the repository. Source changes alone
do not update live deployments, configuration or webhooks.

## Recovery

If the Draft is complete but its synchronization request failed, run the recovery
workflow on main. Set `RELEASE_ID` to the existing Release's numeric GitHub ID and
`SOURCE_SHA` to its exact 40-character hexadecimal main commit SHA:

```sh
gh workflow run main-sync.yml --repo MemTensor/memmy-agent --ref main \
  -f release_id="$RELEASE_ID" -f source_sha="$SOURCE_SHA"
```

Recovery re-reads the actual Release and source; branch names cannot replace SHAs.
Repeated repository/release/source/target requests reuse the existing synchronization
request rather than create duplicate coding tasks. Published stable Releases are
supported if their tag resolves to the exact source.

Diagnose failures using the request workflow, original cloud task and specific
`main-sync-validation.yml` run. A queued workflow, model completion claim or green
result for an older commit does not establish readiness.
