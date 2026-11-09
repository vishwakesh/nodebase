# Apply this V4 foundation to the repository

This source snapshot is based on `feat/nodebase-watch`. The supplied source ZIP did not contain `.git` metadata, and the connected GitHub integration rejected branch creation with HTTP 403. Therefore this work has **not** been pushed and no remote branch has been changed.

From a trusted development machine with GitHub write access:

```bash
git clone https://github.com/vishwakesh/nodebase.git
cd nodebase
git fetch origin
git switch -c feat/nodebase-v4-foundation origin/feat/nodebase-watch
```

Extract the snapshot into a temporary directory, then overlay its contents onto this checkout (the archive contains a top-level `nodebase-v4-foundation/` folder). Preserve `.git/` and any local files; review every replacement. Example:

```bash
unzip /path/to/nodebase-v4-foundation.zip -d /tmp/nodebase-v4-snapshot
rsync -a --exclude='.git/' /tmp/nodebase-v4-snapshot/nodebase-v4-foundation/ ./
```

Then:

```bash
npm install
npm run typecheck
npm run build
npm test
git status --short
git diff --check
git diff --stat
```

Review the complete diff, particularly `backend/migrations/004_v4_accounts_organizations.sql`, before committing. Test the migration against a copy of the V3/Watch database in staging. Never apply it directly to the production SQLite file without a verified backup and explicit approval.

When checks pass:

```bash
git add -A
git commit -m "feat(v4): add account and organization foundation"
git push -u origin feat/nodebase-v4-foundation
```

Do not merge or deploy this branch as a complete V4 release. Tenant-scoped bot, file, node, backup, usage, and Watch handlers are still follow-up milestones.
