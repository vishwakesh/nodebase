# NODEBASE V4 foundation — debug report

## Defects fixed in this revision

1. **SMTP settings were not passed into the panel container.** The root `.env.example` documented SMTP variables, but the `panel` service in `docker-compose.yml` did not forward them. Docker Compose does not automatically inject arbitrary host `.env` values into a service. This made registration, recovery, and organization invitations report email delivery as unavailable even when SMTP values existed in the deployment environment. The panel service now explicitly receives all six SMTP settings.
2. **Email verification consumption is now transactionally single-use.** Token lookup, expiry/used checks, token consumption, and account verification now happen inside one SQLite transaction. Both conditional updates are checked for exactly one changed row. This closes the concurrent-request race where multiple confirmation POSTs could be treated as successful. A replay regression assertion was added to the API test.

## Checks performed for this debug pass

- V4 ZIP integrity: passed (`unzip -t`).
- SQLite migrations 001–004: passed against a V3-shaped in-memory database.
- Legacy administrator, session, bot, folder, file, backup, and activity rows: preserved; V3 records were assigned to the legacy personal organization.
- Compatibility triggers: verified that post-migration V3-style inserts receive the legacy organization ID.
- `PRAGMA foreign_key_check`: passed with no violations in the fixture.
- `docker-compose.yml`: SMTP variables now explicitly forwarded to the panel.
- Full TypeScript/build/API tests: **not completed**. `npm install` timed out in this environment and workspace dependencies/types are absent, so `tsc` reports missing Node/React package declarations. Those are environment blockers, not successful checks. Run the documented install/build/test commands in a network-enabled environment before staging deployment.
- No Docker image build, live database migration, GitHub push, or VPS deployment was performed.

## Remaining boundaries

This is still the account and organization foundation only. Tenant-scoped bot/file/node/backup/usage/Watch routes, the full file manager, platform admin console, and production end-to-end testing remain incomplete. Do not deploy this as a completed V4 release.
