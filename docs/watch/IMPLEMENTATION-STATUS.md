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
- Direct MP4/WebM delivery with validated single byte-range support (bounded, open-ended and suffix ranges) so browser seeking works against private Cloud blobs. Full responses, partial responses, `If-Range` fallback and invalid-range responses are covered by regression assertions.
- Server-authoritative play/pause/seek/end state, sequence numbers and event history. Per-viewer permissions distinguish host, co-host and viewer controls. Guests can start local browser playback without being allowed to change the host-controlled room timeline; autoplay restrictions expose a manual start action. Host and guest clients now avoid drift seeks while buffering and use a conservative large-drift correction threshold.
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
- Low-latency drift correction and deterministic multi-client event ordering. Current HTTP polling remains coarse (5-second reconciliation, hard correction only after more than 10 seconds of drift); buffering-aware seek suppression is implemented but still needs real-device verification.
- Queue advance/host next-video control and full queue reorder.
- Dedicated room settings screen, reactions, queue advance/reorder, discovery search/filter, persistent invitation-list management and complete room history.
- Streaming analytics and bandwidth accounting.
- Production hardening for large-media workloads and CDN delivery.

## Current media behavior

The alpha supports progressive browser playback for MP4 and WebM Cloud files using authenticated/room-scoped HTTP range requests. Responses include range metadata, Last-Modified, no-store cache policy, and disabled proxy buffering hints. The player uses automatic preload, visible loading/buffering/error states, and skips routine seek corrections until enough media is buffered. Other video MIME types are rejected. This is a functional first media path, but it is not HLS. HLS and the isolated media worker remain the next core milestone.

## Tests

API tests have been added for room creation, hashed invitation persistence, guest join, playback state, range requests and unauthorized media access. They must be run in an environment with the repository dependencies installed before this increment is declared verified.

## V5 local stabilization notes

- Host and guest playback polling is non-overlapping and runs every five seconds. Timeline reconciliation does not seek while the player is buffering or below `HAVE_FUTURE_DATA`; hard drift correction is reserved for drift greater than ten seconds.
- Both player surfaces expose loading, buffering and media error states. Both request `preload="auto"`.
- Media delivery validates single byte ranges, supports start/end, open-ended and suffix requests, clamps the end to the stored object, returns `416` with `Content-Range` for unsupported/unsatisfied requests, and falls back to the full `200` representation when an `If-Range` validator cannot be honored.
- Stream cleanup now aborts disk I/O only when the HTTP response closes before it has finished. Fastify's stream pipeline remains responsible for handling stream failures.
- Regression assertions cover full-body delivery, authenticated host streaming, guest streaming, room-scoped guest-cookie isolation, partial ranges, open-ended ranges, suffix ranges, end clamping, stale `If-Range`, multiple ranges, zero-length suffixes, out-of-bounds ranges and reversed ranges.
- Full build and integration tests are **not yet verified** in this workspace. Installing dependencies timed out while reaching the package registry; no deployment or live-server changes were made.
