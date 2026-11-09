# NODEBASE WATCH — Implementation Status

**Increment:** Watch alpha foundation (not production-ready streaming)

## Implemented in this increment

- Watch navigation entry inside NODEBASE V3.
- Watch home/library reads real MP4/WebM files from the existing private Cloud database.
- Room creation with private or discoverable-private visibility and server-side participant limits.
- Room metadata persisted through migration `003_watch.sql`.
- Owner/host membership record.
- Time-limited invitation creation; raw token is returned once and only its SHA-256 hash is stored. Invite tokens are placed in URL fragments and exchanged in POST bodies so tokens are not sent in HTTP request paths.
- Invitation preview and use-limited guest join. Bearer tokens travel in the URL fragment and are exchanged in POST bodies so they are not sent in request paths/logs.
- Room-scoped HttpOnly guest session cookie; guest routes validate the persisted hash and never grant account-wide access. Guests can leave to revoke their room session.
- Optional host approval and participant removal/revocation. Authenticated room members and guests can leave; the host must end the room.
- Direct MP4/WebM delivery with validated single byte-range support so browser seeking works against private Cloud blobs.
- Server-authoritative play/pause/seek/end state, sequence numbers and event history. Per-viewer permissions distinguish host, co-host and viewer controls. Guests can start local browser playback without being allowed to change the host-controlled room timeline; autoplay restrictions expose a manual start action.
- Room-scoped chat and queue foundations. Host UI supports approving/removing participants and revoking the just-created invitation link.
- Responsive Watch library, room, invitation join, guest player and chat UI.
- Reference design boards stored under `docs/watch/assets/`.

## Not implemented yet — do not advertise as complete

- Resumable chunk/multipart video uploads. Current video ingestion uses the existing single-request Cloud upload.
- Isolated FFmpeg media-processing worker.
- HLS master/variant playlists and segment generation.
- Adaptive bitrate selection and subtitle pipeline.
- Authenticated HLS manifest/segment delivery.
- WebSocket room transport; the current client uses HTTP polling for playback reconciliation.
- Fine-grained drift correction, buffering-aware correction and deterministic multi-client event ordering.
- Queue advance/host next-video control and full queue reorder.
- Dedicated room settings screen, reactions, queue advance/reorder, discovery search/filter, persistent invitation-list management and complete room history.
- Streaming analytics and bandwidth accounting.
- Production hardening for large-media workloads and CDN delivery.

## Current media behavior

The alpha supports progressive browser playback for MP4 and WebM Cloud files using authenticated/room-scoped HTTP range requests. Other video MIME types are rejected. This is a functional first media path, but it is not HLS. HLS and the isolated media worker remain the next core milestone.

## Tests

API tests have been added for room creation, hashed invitation persistence, guest join, playback state, range requests and unauthorized media access. They must be run in an environment with the repository dependencies installed before this increment is declared verified.


## Verification performed in this workspace

- `git diff --check`: passed.
- TypeScript `transpileModule` syntax checks for the changed backend server, backend API tests, main React entry and Watch React module: passed. This is a syntax pass, not a full typecheck.
- CSS structural brace/string/comment sanity check: passed.
- SQLite migrations `001_initial.sql`, `002_nodes.sql`, and `003_watch.sql`: applied successfully to an in-memory database.
- SQLite Watch smoke: room, host, guest participant session, invitation, message, queue item and playback event inserts passed; `PRAGMA foreign_key_check` returned no violations.
- Full npm dependency installation did not complete in this environment (registry fetch timed out). Consequently the full TypeScript workspace typecheck, production build and API test suite have **not** been run and must be run before deployment.
