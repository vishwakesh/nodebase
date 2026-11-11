# NODEBASE V5 — Work Status

## Baseline

V5 is being prepared from the debugged V4 foundation snapshot. The V4 source archive and patch supplied by the owner remain unchanged. The project is being built in this separate working directory.

## Current local increment — Watch stabilization

- [x] Add project-local frontend design guides under `.agents/skills/`.
- [x] Refresh shared shell and Overview styling, align the theme-color metadata, and remove generated dashboard decoration.
- [x] Make Overview next-step indicators reflect available API data instead of always showing completed states.
- [x] Normalize bot avatars to the neutral product icon treatment.
- [x] Record an initial V5 visual direction in `docs/v5/DESIGN-DIRECTION.md`.
- [x] Prevent recurring host/guest timeline corrections while the player is buffering.
- [x] Increase routine playback polling interval and avoid overlapping `setInterval` requests.
- [x] Add host and guest loading, buffering and error status overlays.
- [x] Use automatic media preload for both room and guest players.
- [x] Harden private MP4/WebM byte-range parsing and response headers.
- [x] Expand API regression assertions for full/partial/open-ended/suffix/clamped ranges, stale validators, invalid ranges, host streaming and room-scoped guest authorization.
- [ ] Install full UI UX Pro Max upstream data/scripts when a network-enabled environment is available. Current project-local file is a condensed guide, not the upstream catalog package.
- [ ] Run backend integration tests, all workspace typechecks, production build and frontend visual checks with dependencies installed (blocked so far by registry access and an empty npm cache).
- [ ] Verify streaming on real desktop/mobile networks with representative video files and reverse-proxy logs.

## Known limitations

- Watch is still progressive MP4/WebM. No HLS, adaptive bitrate, isolated FFmpeg worker, resumable media upload or WebSocket synchronization has been implemented.
- HTTP polling still provides coarse synchronization; a future WebSocket control channel is needed for lower-latency multi-client coordination.
- The current local edits are not deployed. Production containers, databases, storage, Coolify, Caddy and unrelated VPS services have not been touched.

## Next frontend phases

1. Audit all routes, shared shell, theme tokens and responsive breakpoints.
2. Rebuild the shared application shell and navigation without changing API behavior.
3. Rebuild core workspace pages in cohesive batches, starting with Overview, Bots, Files and Watch.
4. Rebuild Nodes, Backups, Organization, Account, Settings and admin surfaces.
5. Verify every route at desktop and mobile widths, with real loading/empty/error/permission states.
