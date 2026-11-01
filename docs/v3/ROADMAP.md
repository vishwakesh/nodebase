# NODEBASE V3 roadmap

## Release principles

- Preserve V2 behavior while migrating.
- Complete vertical workflows rather than adding disconnected screens.
- Build mobile interactions as first-class layouts.
- Keep AI tool access scoped, auditable and approval-gated.
- Treat video processing and delivery as a separate resource-intensive subsystem.

## Suggested sequence

1. Design foundation and system theme.
2. V3 workspace shell, navigation, dashboard, projects and global search.
3. NVIDIA provider adapter, credential encryption, model configuration and prompt library.
4. AI Builder: scoped context, proposed patches, diff review, explicit approval and checks.
5. Bug Hunter and Auto Fixer: evidence-based findings, patch records, rollback and verification.
6. AI Auto Setup: read-only diagnostics first; approval-gated low/high-impact operations.
7. Cloud enhancements and Notes with autosave/conflict handling.
8. Hosting integration and end-to-end node-to-bot workflows.
9. NODEBASE Watch: first progressive MP4/WebM room alpha is implemented on `feat/nodebase-watch`; next add resumable uploads, isolated HLS processing, authenticated segment delivery and WebSocket playback synchronization.
10. Security review, mobile testing, production database migration and isolated deployment.

## First V3 vertical slice

Create project → configure AI provider → start AI session → inspect selected project files → propose a patch → review diff → approve patch → run checks → report the real result.

## First Watch vertical slice

Upload authorized media → verify processing → create private room → issue invite → join from a second browser → synchronize play/pause/seek → reconnect and resynchronize → revoke invite and close room.
