# NODEBASE V3 Build Charter

## Product promise

NODEBASE V3 is a self-hosted developer workspace combining AI-assisted software work, multi-node hosting, personal files, notes, and private synchronized viewing. Its tagline is **Build. Debug. Deploy. Organize. Connect.**

## Product modules

1. **AI Builder** — project-aware coding assistance that proposes reviewable file changes.
2. **Bug Hunter** — evidence-backed analysis of type checks, builds, tests, dependencies and runtime logs.
3. **Auto Fixer** — scoped patch generation with human approval, verification and rollback.
4. **Prompt Library** — user-managed prompt templates and versioned module defaults.
5. **AI Auto Setup** — infrastructure diagnostics and approval-gated configuration operations.
6. **NVIDIA AI Provider** — server-side configurable NVIDIA inference integration with encrypted credentials and model capability validation.
7. **Hosting** — authenticated multi-node agents, bot lifecycle, deployments, logs and resource telemetry.
8. **Cloud** — private file/folder management, quotas, sharing permissions and protected downloads.
9. **Notes** — private notes, checklists, labels, search, autosave and conflict handling.
10. **Watch Together** — invite-only rooms, authorized media, HLS segmented delivery, synchronized playback and scoped guest sessions.

## Non-negotiable engineering boundaries

- V1 and V2 data and deployments remain isolated and recoverable.
- No API keys or other credentials enter frontend bundles, browser storage or logs.
- AI tools only access explicitly authorized project context.
- AI changes are proposed as diffs; applying them requires user approval.
- AI never receives unrestricted root, host-shell or Docker-socket access.
- Node agents authenticate outbound to the control plane; management endpoints and databases remain private.
- Uploaded project code and media are untrusted and processed in constrained workers.
- Watch invite links are scoped, expiring/revocable credentials; room guests do not inherit Cloud access.
- No dashboard metric or feature is represented as real until backed by actual state and tested behavior.

## First vertical slice

Create a project → configure an AI provider → start a scoped AI session → inspect selected files → propose a patch → review the diff → approve → run checks → report the actual result.

## Watch vertical slice

Upload authorized video → validate and process → create invite-only room → join from a second browser → synchronize play/pause/seek → late-join and reconnect → revoke invite and close room.

## Rollout policy

Develop on `feat/nodebase-v3-workspace`. Do not deploy this branch onto the V1/V2 directories or production database. Promote to an isolated V3 environment only after dependency installation, full typechecking, production builds, tests, and security review pass.
