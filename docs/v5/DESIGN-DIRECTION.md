# NODEBASE V5 — Frontend Design Direction

## Product intent

NODEBASE is a self-hosted operations workspace for managing Discord bots, files, infrastructure nodes, backups, accounts, and shared Watch rooms.

## Visual direction

- **Character:** precise, technical, dependable, quietly capable.
- **World:** an operations control room, not a generic futuristic SaaS landing page.
- **Surfaces:** neutral graphite/ink ramp with clear surface elevation and hairline borders.
- **Accent:** preserve NODEBASE's existing acid-lime identity; use it for primary actions, selected navigation, and meaningful live states only.
- **Signature:** concise live status markers tied to actual bot, node, storage, and Watch state.

## Design principles

1. Task-first pages: each route has one primary job and a clear next action.
2. Real product proof: use real service state, real metrics, and useful previews instead of decorative dashboard filler.
3. Consistent system: reuse the existing light/dark semantic token model; no parallel token set.
4. Dense but readable: operational information can be compact, but small text, tap targets, and line wrapping must remain usable.
5. Honest states: loading, empty, offline, buffering, error, permission denied, and success must be explicit.
6. Mobile parity: every core action must remain reachable on phone; no desktop-only hover controls.

## Implementation constraints

- Preserve the current React + Vite + TypeScript + Tailwind v4 stack.
- Preserve API contracts and database behavior while changing presentation.
- Keep Watch streaming work isolated from UI-only changes.
- Do not change production compose files, Coolify, Caddy, runner configuration, or live data as part of this local rebuild.
