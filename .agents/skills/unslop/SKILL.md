---
name: unslop
description: Audit and refine NODEBASE UI that looks generic, over-decorated, inconsistent, or AI-generated. Use for visual redlines, spacing and typography cleanup, icon consistency, product-specific art direction, and final interface polish.
license: CC-BY-4.0
metadata:
  author: Damir Sokolovsky
  source: https://github.com/heydamir/unslop
---

# Unslop — NODEBASE project adapter

Adapted from unslop by Damir Sokolovsky (@heydamir), licensed CC BY 4.0. Keep this attribution and the source link in copies/adaptations.

## Audit before changing

Inspect the actual rendered screen when possible. Record the location of each issue: irregular spacing, inconsistent controls, color overload, hue gradients/glows, gradient text, emoji icons, excessive badges, shouty copy, weak hierarchy, decorative motion, generic filler, or inconsistent component sizing. Preserve features, content, product name, and information architecture unless asked otherwise.

## Direction for NODEBASE

- Product: a self-hosted operations workspace for managing bots, files, nodes, backups, accounts, and watch rooms.
- Character: precise, technical, dependable.
- World: a quiet control room for infrastructure and media operations.
- Moments: real host/container telemetry, clear bot/node status, and a focused Watch player.
- Signature: restrained acid-lime status/action markers, used only where state or action matters.

Keep the existing NODEBASE identity and acid-lime accent. Do not invent a replacement brand direction.

## Fix in passes

1. **Spacing:** align to a 4px rhythm; related controls share dimensions; compact navigation; consistent page gutters.
2. **Color:** neutral surfaces, three text roles, one brand accent; semantic status colors only; remove hue gradients and glows.
3. **Icons:** Lucide only, consistent size/stroke/alignment; remove decorative emoji.
4. **Copy:** specific, concise, sentence case; labels name outcomes; remove hype and unsupported claims.
5. **Type:** one interface family, a small readable scale, restrained weights, tabular figures for metrics.
6. **Layout:** make hierarchy and proportions match the job; preserve features; ensure desktop/mobile reading order.
7. **Details:** consistent nested radii, clear tables, useful empty states, visible focus, practical hover/pressed states.
8. **Visuals:** use real product information and actual interface previews; no generic blobs, fake devices, or filler art.
9. **Motion:** remove unnecessary loops/bounces; animate only state and feedback; respect reduced motion.

## Check

Render after meaningful changes. Compare against the audit. Recheck at desktop and mobile widths. Do not change a screen just to make it different: if it is already good, report only the small improvements that are justified.
