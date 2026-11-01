# NODEBASE WATCH — UI Design Prompt

Act as a senior streaming product designer and mobile-first interaction architect. Design NODEBASE WATCH as an integrated module within NODEBASE V3.

## Visual identity

- Obsidian + Acid Lime.
- Obsidian Deep `#0B0F0C`, Obsidian `#111411`, Graphite `#202820`, Graphite Soft `#29352A`.
- Acid Lime `#B6F36B`, hover `#A5E651`, pressed `#8FCB3E`, tint `#EFF8DF`, Sage `#78C8A0`, Warm Ivory `#E8D9B5`.
- Light theme: `#F6F8F3`, `#FFFFFF`, `#EDF1E9`, `#172016`, `#596653`, `#75816F`, `#DFE6D8`.
- Dark theme: `#0B0F0C`, `#111411`, `#182019`, `#202820`, `#F5F7F2`, `#C1CCBB`, `#91A08D`, `#2C382D`.
- System theme is default; Light and Dark overrides are supported.
- Balanced Modern Workspace density; mobile-first; no generic blue SaaS treatment.

## Reference boards

- `assets/watch-desktop-design-reference.png`
- `assets/watch-mobile-design-reference.png`

Use these as layout and visual guidance only. Do not lift the embedded anime frame or other copyrighted media into product assets. Use neutral placeholders or content uploaded by the user.

## Required screen inventory

1. Watch home.
2. Video library.
3. Video details.
4. Upload manager.
5. Processing status.
6. Create room.
7. Privacy configuration.
8. Discoverable room directory.
9. Invitation join screen.
10. Waiting lobby.
11. Watch player.
12. Participant drawer.
13. Room chat.
14. Watch queue.
15. Host moderation.
16. Room settings.
17. Watch history.
18. Collections.
19. Streaming analytics.
20. Empty, loading, offline, expired-invite, unauthorized and processing-failure states.

## Desktop composition

Use a large player, room header, participant area, queue and chat panel. The player is the primary surface. Keep the player dark in both application themes.

## Mobile composition

Use a compact Watch header and bottom navigation consistent with NODEBASE V3. Provide an immersive player, landscape playback, and bottom sheets/drawers for chat, queue and participants. Room creation should use a full-screen or bottom-sheet form. Touch targets should be at least 44px.

## Product behavior

- Private is the default visibility.
- Discoverable-private only lists metadata explicitly approved by the host and does not bypass room admission.
- Distinguish upload progress from processing progress.
- Do not invent video duration, resolution, thumbnails, viewer counts or analytics.
- Show actual connection and processing states.
- Only show media actions supported by the backend.
- Do not put chat/reactions over essential player controls.
- Provide accessible labels, focus states and reduced-motion support.

Deliver responsive layouts, component states, interaction diagrams and implementation notes. Clearly label any data or behavior that is not connected to the backend.
