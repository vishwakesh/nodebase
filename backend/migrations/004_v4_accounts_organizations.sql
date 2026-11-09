-- NODEBASE V4 foundation. Additive only: retain the legacy admin table and all V3 rows.
ALTER TABLE admin ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'member'
  CHECK(platform_role IN ('platform_admin','member'));
ALTER TABLE admin ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
  CHECK(account_status IN ('active','suspended'));
ALTER TABLE admin ADD COLUMN email_verified_at TEXT;

-- Existing accounts were created through the guarded first-admin setup flow.
-- Preserve those accounts as verified platform administrators.
UPDATE admin SET platform_role='platform_admin', account_status='active',
  email_verified_at=COALESCE(email_verified_at, created_at);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  type TEXT NOT NULL DEFAULT 'team' CHECK(type IN ('personal','team')),
  owner_user_id TEXT NOT NULL REFERENCES admin(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX organizations_owner_idx ON organizations(owner_user_id, updated_at DESC);

CREATE TABLE organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','developer','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  joined_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,user_id)
);
CREATE INDEX organization_memberships_user_idx ON organization_memberships(user_id,status);

CREATE TABLE organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('admin','developer','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES admin(id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX organization_invitations_org_idx ON organization_invitations(organization_id,created_at DESC);
CREATE INDEX organization_invitations_expiry_idx ON organization_invitations(expires_at);

CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX email_verification_user_idx ON email_verification_tokens(user_id,created_at DESC);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens(user_id,created_at DESC);

CREATE TABLE platform_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES admin(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX platform_audit_created_idx ON platform_audit_events(created_at DESC);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity >= 0),
  unit TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX usage_events_org_created_idx ON usage_events(organization_id,created_at DESC);

-- Tenant ownership columns are introduced now and backfilled to the legacy owner's
-- personal organization. API routes remain platform-admin-only until each module's
-- query layer has organization scoping, avoiding an interim cross-tenant access gap.
ALTER TABLE bots ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE folders ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE files ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE backups ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE activity ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE nodes ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE watch_rooms ADD COLUMN organization_id TEXT REFERENCES organizations(id);

INSERT INTO organizations(id,name,slug,description,type,owner_user_id,created_at,updated_at)
SELECT 'personal-' || id, substr(display_name || ' Workspace',1,80),
       'personal-' || lower(replace(id,'-','')), '', 'personal', id, created_at, created_at
FROM admin;

INSERT INTO organization_memberships(organization_id,user_id,role,status,joined_at,created_at,updated_at)
SELECT id,owner_user_id,'owner','active',created_at,created_at,updated_at FROM organizations;

UPDATE bots SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE organization_id IS NULL;
UPDATE folders SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE organization_id IS NULL;
UPDATE files SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE organization_id IS NULL;
UPDATE backups SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE organization_id IS NULL;
UPDATE activity SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE organization_id IS NULL;
UPDATE nodes SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE organization_id IS NULL;
UPDATE watch_rooms SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE organization_id IS NULL;

CREATE INDEX bots_org_idx ON bots(organization_id,updated_at DESC);
CREATE INDEX folders_org_idx ON folders(organization_id,parent_id);
CREATE INDEX files_org_idx ON files(organization_id,updated_at DESC);
CREATE INDEX backups_org_idx ON backups(organization_id,created_at DESC);
CREATE INDEX activity_org_idx ON activity(organization_id,created_at DESC);
CREATE INDEX nodes_org_idx ON nodes(organization_id,status);
CREATE INDEX watch_rooms_org_idx ON watch_rooms(organization_id,updated_at DESC);

-- Temporary compatibility for the still-platform-admin-only V3 write APIs.
-- Until each resource module accepts an explicit active organization, new rows
-- created through those legacy routes are assigned to the original admin's
-- personal organization instead of being left tenantless.
CREATE TRIGGER bots_default_organization AFTER INSERT ON bots
WHEN NEW.organization_id IS NULL
BEGIN
  UPDATE bots SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE id=NEW.id;
END;
CREATE TRIGGER folders_default_organization AFTER INSERT ON folders
WHEN NEW.organization_id IS NULL
BEGIN
  UPDATE folders SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE id=NEW.id;
END;
CREATE TRIGGER files_default_organization AFTER INSERT ON files
WHEN NEW.organization_id IS NULL
BEGIN
  UPDATE files SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE id=NEW.id;
END;
CREATE TRIGGER backups_default_organization AFTER INSERT ON backups
WHEN NEW.organization_id IS NULL
BEGIN
  UPDATE backups SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE id=NEW.id;
END;
CREATE TRIGGER activity_default_organization AFTER INSERT ON activity
WHEN NEW.organization_id IS NULL
BEGIN
  UPDATE activity SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE id=NEW.id;
END;
CREATE TRIGGER nodes_default_organization AFTER INSERT ON nodes
WHEN NEW.organization_id IS NULL
BEGIN
  UPDATE nodes SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE id=NEW.id;
END;
CREATE TRIGGER watch_rooms_default_organization AFTER INSERT ON watch_rooms
WHEN NEW.organization_id IS NULL
BEGIN
  UPDATE watch_rooms SET organization_id=(SELECT id FROM organizations WHERE owner_user_id=(SELECT id FROM admin ORDER BY created_at,id LIMIT 1)) WHERE id=NEW.id;
END;
