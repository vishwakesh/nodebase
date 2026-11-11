---
name: frontend-design
description: Design, build, review, or refine NODEBASE SaaS dashboard, account, cloud, hosting, and Watch interfaces. Use when the work affects layout, navigation, typography, colors, accessibility, states, responsive behavior, or frontend usability.
---

# Frontend Design

Design the shortest clear path from arrival to a useful result. Visual polish follows from clear product decisions, not decoration.

## Start with the user's job

For every screen identify the user, their immediate goal, the main action or information, what they need to act confidently, and what can be removed. Give each screen one primary intent. Reuse existing routes and business behavior unless the task explicitly changes them.

## Design contract

Before implementation, record: primary job, hierarchy, palette, typography, spacing, radii, action hierarchy, icon family, responsive behavior, and vocabulary. Follow the current NODEBASE V5 design contract in `docs/v5/DESIGN-DIRECTION.md`.

## Interface rules

- Use a restrained neutral foundation and the existing NODEBASE acid-lime accent for meaningful actions and status, not decoration.
- Use semantic tokens for surfaces, text, borders, focus, success, warning, and danger. Do not add a second parallel theme system.
- Keep typography, spacing, control heights, icons, border weights, and radii consistent. Prefer the existing Lucide icon set; do not use emoji as interface icons.
- Use tables/lists for dense comparable data. Use cards only when they create useful grouping. Put infrequent row actions in an overflow menu.
- Name buttons by their outcomes: `Save changes`, `Start bot`, `Retry upload`. Keep one term for the same action throughout the product.
- Keep navigation and chrome quiet. Color should communicate action or meaning; data and product content can carry richer color.
- Avoid arbitrary glass, glows, gradients, oversized pills, decorative blobs, excessive badges, and animation without a clear job.

## Design the full state model

For every asynchronous or consequential flow, handle the relevant initial, loading/progress, empty, partial/disabled, error-with-recovery, success, and destructive-confirmation states. Show evidence that work is happening. Explain errors next to the affected control and offer a recovery path. Use confirmation proportional to risk; preserve undo where practical.

## Responsive and accessible behavior

- Build mobile-first and test narrow screens; avoid horizontal overflow and fixed-width content panels.
- Use keyboard-accessible controls, visible focus, associated labels, useful accessible names, and semantic status text.
- Aim for 4.5:1 contrast for normal text. Do not rely on color alone to communicate state.
- Touch targets should be comfortably usable (about 44px where practical). Respect safe-area insets and `prefers-reduced-motion`.
- Motion should communicate progress, cause/effect, or state. Avoid decorative loops and layout animation.

## Verification

1. Build the main path and realistic content.
2. Add loading, empty, error, success, and permission states.
3. Inspect desktop and mobile renderings.
4. Check alignment, density, overflow, contrast, focus, keyboard usage, and reduced motion.
5. Remove interface material that does not help a user understand, decide, or finish.
