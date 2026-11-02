# Shared Agent source readers

This workspace compiles the existing files in `Memory/src/agent-source/adapters`
and `agent-paths.ts`. It contains no second reader implementation or scan runtime.

`App/backend` imports `@memmy/agent-source-readers/adapters/*` for source discovery,
onboarding insight sampling, and shared types. Historical scan tasks are sent to
the Memory service; they must not be executed by the desktop backend.

Build from the repository root with `npm run build -w @memmy/agent-source-readers`.
Reader behavior tests live in `Memory/tests/agent-source-adapters`. The desktop
package scripts build this workspace before type checking or packaging.
