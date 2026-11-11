---
name: ui-ux-pro-max
description: Apply structured UI/UX design intelligence to NODEBASE frontend architecture, responsive layouts, accessibility, visual systems, interaction patterns, forms, charts, and state design.
license: MIT
metadata:
  source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
  mode: project-guide-adaptation
---

# UI/UX Pro Max — Project Guide

This project-local guide adapts the upstream UI/UX Pro Max workflow. The upstream CLI's searchable catalog, scripts, and CSV datasets are not bundled in this offline workspace; do not claim that catalogue searches have run or fabricate search results. Use the documented priorities below as the verified fallback until the full upstream installer can be run in a network-enabled development environment.

## Priority order

1. Accessibility: text contrast, alt text, keyboard navigation, visible focus, accessible names.
2. Touch and interaction: usable tap targets, clear spacing, loading feedback, no hover-only actions.
3. Performance: lazy-load heavy content, reserve media dimensions, avoid layout shifts and main-thread work.
4. Style selection: consistent components and iconography; no emoji UI icons.
5. Responsive layout: mobile-first breakpoints, no horizontal scroll, no fixed-width panels.
6. Typography and color: readable base text, line-height, semantic tokens, adequate contrast.
7. Animation: meaningful motion, reduced-motion support, no decorative loops.
8. Forms and feedback: visible labels, inline validation, helper copy, recoverable errors.
9. Navigation: predictable hierarchy, back behavior, deep links where appropriate.
10. Charts and data: clear legends/tooltips, accessible color, no decoration posing as insight.

## Workflow

- Detect the actual stack by inspecting workspace package manifests and current components. NODEBASE uses React, Vite, Tailwind CSS v4, TypeScript, and Lucide React.
- For new screens or a system-wide redesign, define one coherent design system before touching components. For a targeted bug, focus only on the affected UX domain.
- Search with one clear intent and 2–5 useful terms if the full upstream dataset is later installed. Retry one narrower query if no result; never invent a match.
- Reuse existing semantic theme tokens. Add missing semantic roles rather than scattering literal hex values through components.
- Design real data, long names, missing values, zero results, slow requests, failed requests, limited permissions, and narrow viewports.
- Persist project-wide tokens in `docs/v5/DESIGN-DIRECTION.md`; use page-specific overrides only when necessary.

## NODEBASE UI requirements

- Preserve existing product behavior and routes while refreshing presentation.
- Support light and dark themes using the existing semantic token model.
- Distinguish primary, secondary, tertiary, and destructive actions.
- Keep bot, node, upload, backup, and streaming states legible without color alone.
- Treat media playback as a first-class user task: show loading, buffering, recoverable error, and reconnect states; never hide playback errors behind a spinner.
- Keep Watch player controls usable on touch screens and do not force timeline seeks while media is buffering.

## Final review

Check contrast, labels, keyboard behavior, focus, reduced motion, 44px practical touch targets, mobile safe areas, text overflow, no horizontal scrolling, loading/empty/error/success states, and consistency across light/dark themes.
