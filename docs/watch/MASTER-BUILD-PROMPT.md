# MASTER BUILD PROMPT — NODEBASE WATCH

## Synchronized Private Video Streaming Platform

### ROLE

Act as the lead software architect, senior full-stack streaming engineer, media infrastructure engineer, backend developer, frontend developer, security engineer and product designer responsible for building NODEBASE WATCH inside NODEBASE V3.

This is not a static watch-party mockup. Build the real video upload pipeline, media processing, HLS streaming, private room system, synchronized playback, invitations, chat, queue and responsive UI. Every feature must work with real backend state or be explicitly labelled incomplete.

### 1. PROJECT CONTEXT

- Product: NODEBASE WATCH.
- Parent: NODEBASE V3.
- Repository: `https://github.com/vishwakesh/nodebase.git`.
- V3 base: `feat/nodebase-v3-workspace`.
- Feature branch: `feat/nodebase-watch`.
- Design: Obsidian + Acid Lime; Balanced Modern Workspace; System theme default; mobile first.
- Scope: uploaded authorized videos, synchronized watch parties, private rooms, optional discoverable-private listings and secure invitation links.
- Exclude: live broadcasting, camera/microphone calls, DRM circumvention and unauthorized external-stream extraction.

### 2. VERSION AND INFRASTRUCTURE SAFETY

Inspect Git state, V3 branch, frontend, backend, schema, storage, auth, Docker and deployment before editing. Work on `feat/nodebase-watch`, based on the approved V3 foundation. Never modify live V1/V2, their persistent directories, Coolify, Traefik or unrelated services. Use isolated Watch migrations, media storage and worker configuration. Preserve all existing NODEBASE modules.

### 3. ARCHITECTURE

Separate responsibilities into:

- Frontend: video library, uploads, rooms, player, chat, queue, participants, invitations and analytics.
- Control plane: authentication, room authorization, invitations, playback state, participants, queue, chat and processing jobs.
- Media worker: file inspection, metadata, thumbnails, validation, FFmpeg processing, HLS generation and retries.
- Private media storage: originals, manifests, segments, thumbnails and subtitles.
- Real-time room service: authenticated room connections, playback, chat, queue, presence and reconnect snapshots.

Never transfer video segments over WebSockets.

### 4. VIDEO INGESTION

Implement lifecycle: initiated → uploading → uploaded → validating → processing → ready. Include failed, cancelled and deleting states. Add resumable multipart uploads, checksum verification, ownership, maximum size/duration, safe storage, expiry, retry and abort. Never trust MIME or extension alone. Make chunk finalization idempotent.

### 5. MEDIA PROCESSING

Use FFmpeg in an isolated worker. Inspect source codecs/container, extract duration and dimensions, generate thumbnails, select output profiles, generate HLS only when required, verify outputs and persist metadata. Support subtitles where implemented. Bound CPU, memory, processes, timeouts, disk and output size. Do not unnecessarily transcode compatible streams. Do not expose the worker publicly or allow arbitrary user shell commands.

### 6. STREAM DELIVERY

Use HTTPS HLS manifests and segments. Support master playlist, variants, audio, optional subtitles, seeking and quality switching. Protect manifests and segments with room membership and short-lived session-bound authorization. Do not expose raw storage paths or original URLs. Revoke media access when a room session is revoked. Do not claim HLS prevents screen recording.

### 7. WATCH ROOMS

Implement create/get/update/delete/start/end/lock/unlock/join/leave/remove. Visibility is `private` or `discoverable_private`; private is default. Discovery must never grant entry. Room settings include title, description, category, selected video, limit, join policy, password, expiry, chat setting and viewer-control permission. States: waiting, playing, paused, buffering, ended, expired.

### 8. INVITATIONS

Generate unpredictable tokens and store hashes. Support create, validate, revoke, expiry, use limits, host approval, optional password and capacity enforcement. Tokens are room-scoped and rate-limited. Never use an invite token as a universal user credential.

### 9. PLAYBACK SYNCHRONIZATION

Maintain authoritative server state: room, video, state, position, rate, monotonic sequence, server timestamp, host and update time. Only host/co-host commands mutate the shared timeline by default. Implement duplicate protection, event ordering, late-join snapshot, reconnection recovery, periodic synchronization, drift measurement and gentle correction. Do not seek repeatedly during buffering. Recover room state after backend restart.

### 10. REAL-TIME EVENTS

Document `room.join`, `room.leave`, `room.snapshot`, participant events, `room.play`, `room.pause`, `room.seek`, `room.playback.sync`, `room.buffering`, `room.reconnected`, queue changes, video changes, chat, reactions, lock and end events. Validate auth, membership, permissions, schema, rate and idempotency. Do not broadcast arbitrary client events.

### 11. QUEUE

Implement add, remove, reorder, current item, next item and persisted snapshots. Only authorized ready videos may be queued. Host controls mutation by default. Recover queue after restart.

### 12. CHAT AND REACTIONS

Implement room-scoped messages, timestamps, author, reactions, moderation, rate limits, reporting and chat-disable. Guests cannot access unrelated user data.

### 13. FRONTEND SCREENS

Watch home, video library, details, upload manager, processing details, create/edit room, discovery, invitation join, lobby, player, participants, chat, queue, moderation, history, collections, analytics, empty and error states. Use actual API data; no fake counts or decorative controls.

### 14. PLAYER

Use native HLS where supported and a maintained JS HLS fallback otherwise. Provide play/pause/seek/volume/fullscreen/quality/subtitles/speed if supported, buffering, error recovery and session expiry. Do not cover key controls with chat or reactions.

### 15. DESIGN

Use NODEBASE V3 tokens: Obsidian Deep `#0B0F0C`, Obsidian `#111411`, Graphite `#202820`, Graphite Soft `#29352A`, Acid Lime `#B6F36B`, hover `#A5E651`, pressed `#8FCB3E`, tint `#EFF8DF`, Sage `#78C8A0`. Light surfaces `#F6F8F3`, `#FFFFFF`, `#EDF1E9`; dark surfaces `#0B0F0C`, `#111411`, `#182019`, `#202820`. System theme default; Light/Dark overrides. Keep player dark in both themes. Use balanced spacing and touch targets.

### 16. MOBILE

Test Android and desktop; portrait/landscape, fullscreen, mobile uploads, touch seeking, chat, participant and queue drawers, settings, reconnect states and no horizontal overflow. Picture-in-picture only where supported by browser/platform.

### 17. DISCOVERY

Only explicitly discoverable rooms appear. Show search, categories, title, description, host display name where permitted, participant count and request-access state. Never return media path or invite token. Host can revert to private immediately.

### 18. DATABASE

Add migrations for rooms, participants, invitations, videos/assets, upload sessions, processing jobs, variants, queue, playback snapshots/events, chat, reactions, access sessions and usage. Use foreign keys, indexes, ownership, retention and proper constraints. Reuse existing NODEBASE migration conventions.

### 19. MONITORING

Track active rooms, connected participants, processing jobs/failures, storage, bandwidth, playback errors, room duration and upload failures. Never invent values; distinguish stale and live samples. Logs must not contain secrets.

### 20. TESTING

Test upload/resume/interruption/invalid/oversized/expired/duplicate/path traversal; media validation/FFmpeg failure/missing segment/retry/timeout/resource limits; private/discoverable room, unauthorized join, revoked/expired invites, participant limit, host removal, expiry; playback actions, duplicate/stale events, late join, reconnect, drift and buffering; manifest/segment authorization, expiry, revocation, cross-user access; frontend mobile/fullscreen/player/chat/queue/invitations/themes. Never claim a test passed unless executed.

### 21. DEPLOYMENT

Add isolated Watch configuration within V3. Do not modify V1/V2/Coolify. Use persistent original/HLS storage, migrations, background worker, health checks, restart policies, secure HTTPS and environment validation. Keep worker, database and storage private. Do not hardcode ngrok. Document storage, environment, database, worker, reverse proxy, TLS and backup/restore.

### 22. PHASES

A audit and branch isolation. B schema and room access. C uploads and metadata. D isolated HLS worker. E protected delivery. F player. G synchronized rooms. H invites/discovery. I chat/reactions/queue. J mobile. K security/testing. L production docs. Complete one vertical path before expanding.

### 23. FIRST ACCEPTANCE MILESTONE

Owner uploads authorized video; processing completes; video becomes ready; owner creates private room; invitation sent; friend joins; each browser fetches authorized segments independently; host plays, pauses and seeks; guest receives synchronized state; guest disconnects/reconnects; invite is revoked; unauthorized re-entry is rejected.

### 24. CODING AGENT RULES

Inspect before editing. Preserve V3. Work on `feat/nodebase-watch`. Never modify V1/V2. Do not delete data, expose storage or workers, use uncontrolled FFmpeg, trust filenames/metadata, fake progress or metrics, circumvent DRM, allow unrestricted guests, expose secrets or claim tests without execution. Keep architecture maintainable and document incomplete work.

### REQUIRED FINAL REPORT

Provide audit, architecture, migrations, storage design, upload status, HLS status, room/invite/playback implementation, mobile UI, actual test results, security review, environment variables, startup, Docker, domain setup and remaining limitations.

Start by auditing V3, then implement upload-to-synchronized-playback as the first complete vertical workflow.
