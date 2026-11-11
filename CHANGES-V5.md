# NODEBASE V5 — local stabilization increment

This development snapshot is based on the supplied debugged V4 foundation archive. It is not a production deployment and does not contain live VPS data or secrets.

## Included

- Project-local UI/design guides: `frontend-design`, `unslop`, and a condensed `ui-ux-pro-max` guide under `.agents/skills/`.
- V5 visual direction and implementation status under `docs/v5/`.
- Shared application shell and Overview first-pass cleanup in `frontend/src/main.tsx`.
- Theme-token alignment and shared responsive/data-surface overrides in `frontend/src/design-system/tokens.css` and `frontend/src/styles.css`.
- Removed fabricated dashboard sparklines and static “completed” checklist indicators; the Overview now uses API data where completion can be inferred.
- Watch buffering-aware host/guest synchronization, non-overlapping host playback polling, player loading/buffering/error UI, retry action, and automatic preload.
- Private MP4/WebM HTTP byte-range validation and response header improvements in `backend/src/server.ts`.
- Expanded Watch API regression assertions in `backend/test/api.test.ts`, including authenticated host delivery, room-scoped guest-cookie isolation, out-of-bounds and reversed ranges.

## Verification status

- TypeScript/TSX syntax transpilation: passed for the edited backend, test, frontend shell, and Watch files.
- JSON syntax checks: passed for all workspace package manifests.
- CSS delimiter/structure check: passed for `styles.css` and `tokens.css`.
- Full TypeScript typecheck, production build, and backend integration tests: **not run successfully**. `npm install` timed out reaching the npm registry; offline installation then reported that `concurrently` was not cached.
- Browser visual QA and real network streaming tests: pending. Added regression cases have not been executed because workspace dependencies are unavailable.

## Streaming scope

This increment improves the existing progressive MP4/WebM path. It does not add HLS, adaptive bitrate, FFmpeg transcoding, resumable media uploads, or WebSocket playback synchronization. A real end-to-end stream test is still required to confirm whether the reported stalls are resolved under the target VPS and client network conditions.

## Deployment boundary

Nothing in this archive has been deployed. Do not apply database migrations or replace the production panel/runner from this snapshot without a separate backup, isolated test, explicit approval, and a rollback plan. Coolify, Caddy, production containers, live data, and unrelated services have not been changed.
