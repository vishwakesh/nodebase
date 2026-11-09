# NODEBASE V4 Foundation — Implementation Status

This document describes the current incremental code state. It is not a production release declaration.

## Implemented in this increment

- Additive SQLite migration `004_v4_accounts_organizations.sql`.
- Existing `admin` rows retain their IDs, password hashes, session rows, and Watch ownership. They are marked as verified platform administrators because the prior setup flow was the only account-creation path.
- `admin` remains the compatibility account table in this increment; `platform_role` separates `platform_admin` from ordinary `member` accounts.
- Personal organization and owner membership are created for existing accounts during migration and for newly created accounts after first-run setup / registration.
- Tenant ownership columns and indexes are added to bots, folders, files, backups, activity, nodes, and Watch rooms. Existing records are assigned to the legacy administrator's personal organization. Temporary insert triggers keep still-admin-only V3 write routes assigning new rows to that same personal organization until each module accepts an active tenant explicitly.
- Email verification, password recovery, password changes, session revocation, SMTP delivery, and secure hash-only token storage.
- Organization creation, details, member listing, invitations, invitation acceptance, role updates, member removal, and team ownership transfer.
- Backend authorization checks organization membership and role from the authenticated identity. Organization lookup for non-members returns 404.
- New member accounts are denied access to legacy V3 resource APIs until those APIs are migrated to organization-scoped queries. This is an intentional secure rollout boundary.
- A member-facing registration/recovery screen, organization workspace, profile editing, password changes, and active-device session revocation.

## Not yet implemented

- Tenant-scoped bots and lifecycle operations.
- Tenant-scoped file manager and cloud storage operations.
- Tenant-scoped node assignments, deployments, backups, usage and audit views.
- Watch organization sharing and tenant-scoped video/file queries.
- General file manager editing/code editor.
- Platform admin console, billing, payment processing, quotas and billing enforcement.
- Full invitation acceptance journey for an invitee who must register and verify a new account before accepting the invitation.
- Production migration verification against a copied live database, full dependency-backed build, full API test suite, and end-to-end browser testing.

## Deployment safety

Do not apply migration `004` to the live database from this development snapshot. First take a verified SQLite backup, restore it into an isolated staging environment, run all migrations and regression tests there, and inspect row counts plus `PRAGMA foreign_key_check`. Production deployment requires explicit approval and a separate deployment plan.

## Email configuration

The application requires SMTP values and `FRONTEND_ORIGIN` for account registration, password recovery, and organization invitation email. Missing or failed email delivery returns an error; it is never reported as success. SMTP secrets belong in the deployment secret store, not in Git.
