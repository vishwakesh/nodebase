# NODEBASE WATCH — Architecture

## System boundaries

1. **NODEBASE frontend:** Watch library, room creation, player, invitations, chat, queue and mobile layout.
2. **Control plane:** room lifecycle, invite validation, participant access, playback sequence, chat and queue state.
3. **Cloud storage:** reuses existing private Cloud file blobs; Watch does not create public storage paths.
4. **Media worker (next phase):** isolated FFmpeg worker for metadata, thumbnails, HLS VOD manifests and segments.
5. **Real-time transport (next phase):** authenticated WebSocket room events. Until that milestone, clients reconcile using HTTP polling.

## Current alpha data flow

- Host selects an existing Cloud `files` row whose MIME type is `video/mp4` or `video/webm`.
- `watch_rooms.current_video_file_id` references that file with `ON DELETE RESTRICT`.
- Guest invitation token is hashed before persistence.
- Guest join creates a participant row and a per-room HttpOnly cookie; the hash of its value is persisted.
- Media endpoints validate owner/participant access and support HTTP byte ranges for browser seeking.
- The player receives independent range responses. WebSockets do not carry video bytes.
- Playback updates are authorized and stored with an incrementing sequence number and server timestamp.

## Security boundaries

- Private Cloud blob names and absolute storage paths are never returned to clients.
- Guest cookies are scoped to `/api/watch/guest/<room-id>` and stored as hashes in SQLite.
- Invitation tokens are one-use/limited-use credentials with expiry and revocation.
- Public guest endpoints bypass account-session middleware only; each route separately validates the room-scoped session.
- Mutating routes still require the existing CSRF cookie/header pair.
- The media endpoint rejects non-MP4/WebM files and validates the room session before opening a blob.
- Guest sessions never authorize access to unrelated Cloud, Projects, Notes, Hosting, or account endpoints.

## HLS target architecture (not yet implemented)

- Resumable upload service records chunk IDs, offsets/checksums, upload expiry and finalization state.
- Media worker runs separately with bounded CPU, memory, process count, runtime and output quotas.
- Worker inspects source container/codecs, extracts metadata, generates thumbnails and produces only needed HLS profiles. Compatible inputs should be remuxed rather than unnecessarily re-encoded.
- Original, manifests, variants, segments and subtitles remain in private storage.
- Authorized manifest/segment delivery requires an active room media session. Short-lived authorization must not rely on an unguessable URL alone.
- Worker is not exposed publicly and has no unrestricted host-shell or unrelated-secret access.

## Scale and deployment

- Keep Watch APIs in the existing NODEBASE control plane.
- Keep media processing out of the request process.
- Start with a low worker concurrency limit on small VPS hardware.
- Move media processing to a separate node when resource telemetry justifies it.
- Keep V1/V2 data roots, networks, Compose projects and services untouched.
- Production domain should be the configured NODEBASE V3 origin; never hardcode an ngrok URL.
