# NODEBASE WATCH — Product Requirements

**Parent product:** NODEBASE V3
**Feature branch:** `feat/nodebase-watch`
**Tagline:** Watch together. Stay connected.
**Scope:** Uploaded, authorized videos; synchronized watch parties; private rooms; optional discoverable-private listings.

## Product definition

NODEBASE WATCH is a private video library and shared-viewing experience integrated with NODEBASE Cloud. Each participant receives an independently authorized media response while room state is coordinated by NODEBASE. Watch rooms are private by default. A discoverable-private room can appear in a directory, but discovery never grants entry; admission still requires a valid invitation or host approval.

## Users and core journeys

- **Host:** selects a Cloud video, creates a room, controls playback, invites people, moderates participants, manages queue/chat, and ends the room.
- **Invited guest:** opens a room-scoped invite, chooses a display name, joins or waits for approval, watches the authorized video, and uses room-scoped chat.
- **Discovering member:** sees only metadata the host has made discoverable; requests/access controls remain host-governed.

### Host journey

1. Open Watch.
2. Select an MP4 or WebM asset already stored in Cloud.
3. Create a private or discoverable-private room.
4. Set participant limit, approval requirement, and chat setting.
5. Create a time-limited invitation.
6. Share the invite URL.
7. Control shared playback and manage the room.

### Guest journey

1. Open the invitation URL.
2. The server validates expiry, revocation, use limit, and room capacity.
3. Guest chooses a display name.
4. The server issues a room-scoped, HttpOnly guest cookie.
5. Guest joins or waits for host approval.
6. Media is requested through a room-authorized endpoint.
7. Guest reconnects to a current playback snapshot after interruption.

## Product requirements

### Video library

- Show only videos in the signed-in user's NODEBASE Cloud that are supported by the current playback alpha.
- Show file name, size, MIME type, and upload date.
- Do not fabricate thumbnails, duration, resolution, processing progress, or analytics.
- The current alpha supports progressive MP4/WebM delivery from existing Cloud blobs. HLS processing is not yet implemented.

### Watch rooms

- Create, inspect, and end rooms.
- Visibility: `private` or `discoverable_private`; private is default.
- Controls: title, description, category, participant limit, approval requirement, chat enabled, viewer playback control enabled.
- States: waiting, playing, paused, ended, expired.
- Display live/polled participant and room state from persisted data.

### Invitations

- Tokens are cryptographically random and only token hashes are persisted.
- Expiry, max uses, revocation, rate limiting, and room capacity are enforced server-side.
- Guest cookie is scoped to a single room API path and grants no account-level access.
- Revoking/ending a room invalidates outstanding invites and room sessions.

### Playback

- Server stores state, position, playback rate, sequence number, and timestamp.
- Host is authoritative by default.
- Play, pause, seek, and end update the sequence transactionally.
- Clients reconcile against server snapshots and correct significant drift without repeatedly seeking during buffering.
- The initial alpha uses short-interval HTTP polling as a fallback. WebSocket transport is planned, not claimed complete.

### Chat and queue

- Messages are room-scoped, validated, rate-limited by the platform, and visible only to authorized room members.
- Queue items must refer to supported Cloud video assets.
- Host controls queue mutation in the current alpha.

## Explicit exclusions

- Live broadcasting.
- Camera/microphone calls.
- DRM circumvention.
- Unauthorized extraction from streaming services.
- Public unauthenticated access to Cloud files.

## Acceptance criteria

The first complete Watch release must prove: upload/selection of an authorized video; room creation; invite validation; guest admission; independent media requests; synchronized play/pause/seek; reconnect snapshot; invite revocation; and rejection of unauthorized media access.

## Current implementation boundary

See [IMPLEMENTATION-STATUS.md](./IMPLEMENTATION-STATUS.md). The current repository increment implements room metadata, invitation lifecycle, guest-scoped sessions, progressive MP4/WebM range delivery, server playback state, room chat, and a queue foundation. It does **not** yet implement HLS transcoding, segmented delivery, adaptive bitrate, resumable chunk uploads, live WebSockets, analytics instrumentation, or a full discoverable-room join-request flow.
