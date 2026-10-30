# NODEBASE V2 foundation — debug report

## Fixed in this revision

The node heartbeat handler now re-checks the SHA-256 hash of the bearer credential in the SQL `UPDATE` itself and excludes revoked records. This prevents an in-flight heartbeat from changing a node back to `online` after an administrator revokes its credential. The update also uses a SQL `CASE` expression to preserve `draining` if a heartbeat overlaps an administrator's drain action.

A backend API regression test now verifies that a node remains `draining` while heartbeats continue.

## Checks performed in this workspace

- `git diff --check`: passed.
- TypeScript/TSX parser pass across 15 source and test files: passed with no syntax diagnostics. This is not a full typecheck.
- Node agent strict TypeScript check: passed using the globally available TypeScript compiler and Node type declarations; the missing `dotenv/config` declaration was supplied as a temporary local type shim, not committed.
- Node agent config tests: 3 passed, 0 failed.
- SQLite migration smoke test: `001_initial.sql` and `002_nodes.sql` both applied successfully.
- SQLite heartbeat regression smoke test: verified that a draining status stays draining and a revoked credential cannot update the node.
- `npm run typecheck`, `npm run build`, and `npm test`: could not complete because this environment has no installed workspace dependencies. `npm install` could not resolve `registry.npmjs.org` (`EAI_AGAIN`). Reported missing `react`, Node type definitions, and `tsx` therefore reflect unavailable dependencies, not confirmed source defects.
- Docker image build: not run in this workspace.

Run the complete workspace checks in Termux only if your environment can install native dependencies successfully, or preferably in GitHub Actions / the VPS build environment with npm registry access:

```bash
npm install --no-audit --no-fund
npm run typecheck
npm run build
npm test
```

Do not deploy the branch until those checks pass in a dependency-enabled environment.

## Current implementation boundary

This branch implements the first multi-node registration and telemetry foundation: one-time enrollment, per-node hashed credentials, outbound HTTPS heartbeats, node freshness state, and admin drain/revoke actions. It does **not** yet implement remote bot deployment, command delivery/acknowledgement, workload scheduling, remote logs, or PostgreSQL migration. The single-host V1 runner remains the only bot lifecycle executor.
