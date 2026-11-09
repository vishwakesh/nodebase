# NODEBASE V3 Design System

**Brand:** Obsidian + Acid Lime  
**Density:** Balanced Modern Workspace  
**Theme preference:** System by default, with Light and Dark overrides.

## Brand palette

| Token | Value | Role |
|---|---|---|
| Obsidian Deep | `#0B0F0C` | Dark application background |
| Obsidian | `#111411` | Main dark surface |
| Graphite | `#202820` | Elevated dark surface |
| Graphite Soft | `#29352A` | Strong separators and muted surfaces |
| Acid Lime | `#B6F36B` | Primary action and active brand accent |
| Lime Hover | `#A5E651` | Primary action hover |
| Lime Pressed | `#8FCB3E` | Primary action active |
| Lime Tint | `#EFF8DF` | Light active navigation surface |
| Sage | `#78C8A0` | Secondary positive accent |
| Warm Ivory | `#E8D9B5` | Rare decorative highlight |

## Semantic light theme

| Token | Value |
|---|---|
| Background | `#F6F8F3` |
| Surface | `#FFFFFF` |
| Secondary surface | `#EDF1E9` |
| Elevated surface | `#FFFFFF` |
| Primary text | `#172016` |
| Secondary text | `#596653` |
| Muted text | `#75816F` |
| Border | `#DFE6D8` |
| Strong border | `#C9D4C0` |
| Primary action | `#B6F36B` |
| Action text | `#172016` |
| Focus | `#648E35` |

## Semantic dark theme

| Token | Value |
|---|---|
| Background | `#0B0F0C` |
| Surface | `#111411` |
| Secondary surface | `#182019` |
| Elevated surface | `#202820` |
| Primary text | `#F5F7F2` |
| Secondary text | `#C1CCBB` |
| Muted text | `#91A08D` |
| Border | `#2C382D` |
| Strong border | `#3D4C3C` |
| Primary action | `#B6F36B` |
| Action text | `#172016` |
| Focus | `#B6F36B` |

## Status colors

Status colors are independent from Acid Lime. Success, warning, danger, information and offline states must include a text label or icon; color alone is insufficient.

## Theme behavior

- First visit defaults to `system`.
- `system` resolves from `prefers-color-scheme` and listens for OS preference changes.
- `light` and `dark` are explicit overrides.
- The explicit preference is cached in `localStorage` for first paint and persisted to the server when account preferences are saved.
- A same-origin CSP-compatible bootstrap at `frontend/public/theme-bootstrap.js` applies the cached preference before React mounts to reduce theme flash.
- The code editor and video player may keep a dedicated dark work surface while the surrounding application follows the selected theme.

## Balanced workspace layout

- Desktop sidebar: 248px; collapsed: 76px.
- Desktop header: 64px.
- Mobile header: 56px.
- Main content max width: 1440px.
- Desktop content inset: 28–32px; mobile inset: 16px.
- 4px base spacing scale.
- 7/10/12/16/20px corner-radius scale.
- 44px minimum target for primary touch actions.

## Component rules

- Primary buttons use Acid Lime with Obsidian text.
- Secondary buttons use surface and border tokens.
- Active navigation uses a lime-tinted surface; do not use a full lime block for every item.
- Inputs use semantic border/surface/text tokens and a visible focus ring.
- Cards use subtle borders and restrained shadows; avoid nested card overload.
- Status badges use dedicated semantic status colors.
- Code and media workspaces may use specialized dark surfaces in both themes.
- All components must support keyboard navigation, visible focus, disabled and loading states, and reduced motion.
- On mobile, adapt information architecture instead of shrinking desktop tables and multi-column layouts.

## Implementation location

Tokens and semantic aliases live in `frontend/src/design-system/tokens.css`. The existing V2 stylesheet imports these tokens and retains compatibility aliases while screens are migrated incrementally. This avoids a risky all-at-once visual rewrite.
