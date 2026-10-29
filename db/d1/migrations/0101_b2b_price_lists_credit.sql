-- Contractual price lists and company assignments. Credit belongs to migration 0105.
CREATE TABLE b2b_price_lists (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK(length(trim(code)) BETWEEN 1 AND 80 AND code=trim(code)),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200 AND name=trim(name)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  version INTEGER NOT NULL CHECK(version>=1),
  valid_from TEXT NOT NULL CHECK(valid_from=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',valid_from),'')),
  valid_until TEXT CHECK(valid_until IS NULL OR (valid_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',valid_until),'') AND valid_until>valid_from)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at)
) STRICT;
CREATE TRIGGER b2b_list_version BEFORE UPDATE ON b2b_price_lists
WHEN NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'b2b_version_conflict'); END;

CREATE TABLE b2b_variant_rules (
  price_list_id TEXT NOT NULL REFERENCES b2b_price_lists(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  unit_gross_cents INTEGER NOT NULL CHECK(unit_gross_cents>0 AND unit_gross_cents<=9007199254740991),
  PRIMARY KEY(price_list_id,variant_id)
) STRICT;
CREATE TABLE b2b_category_rules (
  price_list_id TEXT NOT NULL REFERENCES b2b_price_lists(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  discount_basis_points INTEGER NOT NULL CHECK(discount_basis_points BETWEEN 0 AND 9500),
  PRIMARY KEY(price_list_id,category_id)
) STRICT;
CREATE TABLE b2b_company_assignments (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  price_list_id TEXT NOT NULL REFERENCES b2b_price_lists(id),
  version INTEGER NOT NULL CHECK(version>=1),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  valid_from TEXT NOT NULL CHECK(valid_from=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',valid_from),'')),
  valid_until TEXT CHECK(valid_until IS NULL OR (valid_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',valid_until),'') AND valid_until>valid_from)),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;
CREATE TRIGGER b2b_assignment_approved BEFORE INSERT ON b2b_company_assignments
WHEN NOT EXISTS(SELECT 1 FROM companies c JOIN customers customer ON customer.id=c.customer_id WHERE c.id=NEW.company_id AND c.status='approved' AND customer.status='active')
BEGIN SELECT RAISE(ABORT,'b2b_company_not_approved'); END;
CREATE TRIGGER b2b_assignment_update BEFORE UPDATE ON b2b_company_assignments
WHEN NEW.company_id<>OLD.company_id OR NEW.version<>OLD.version+1 OR (NEW.active=1 AND NOT EXISTS(SELECT 1 FROM companies c JOIN customers customer ON customer.id=c.customer_id WHERE c.id=NEW.company_id AND c.status='approved' AND customer.status='active'))
BEGIN SELECT RAISE(ABORT,'b2b_assignment_conflict'); END;

-- Once a list is assigned, every rule mutation advances its version in the
-- same SQL statement. Quotes and orders can therefore detect a stale rule.
CREATE TRIGGER b2b_variant_rule_insert_version AFTER INSERT ON b2b_variant_rules
WHEN EXISTS(SELECT 1 FROM b2b_company_assignments WHERE price_list_id=NEW.price_list_id)
BEGIN UPDATE b2b_price_lists SET version=version+1 WHERE id=NEW.price_list_id; END;
CREATE TRIGGER b2b_variant_rule_update_version AFTER UPDATE ON b2b_variant_rules
BEGIN
 SELECT CASE WHEN NEW.price_list_id<>OLD.price_list_id OR NEW.variant_id<>OLD.variant_id THEN RAISE(ABORT,'b2b_rule_identity_immutable') END;
 UPDATE b2b_price_lists SET version=version+1 WHERE id=OLD.price_list_id;
END;
CREATE TRIGGER b2b_variant_rule_delete_version AFTER DELETE ON b2b_variant_rules
BEGIN UPDATE b2b_price_lists SET version=version+1 WHERE id=OLD.price_list_id; END;
CREATE TRIGGER b2b_category_rule_insert_version AFTER INSERT ON b2b_category_rules
WHEN EXISTS(SELECT 1 FROM b2b_company_assignments WHERE price_list_id=NEW.price_list_id)
BEGIN UPDATE b2b_price_lists SET version=version+1 WHERE id=NEW.price_list_id; END;
CREATE TRIGGER b2b_category_rule_update_version AFTER UPDATE ON b2b_category_rules
BEGIN
 SELECT CASE WHEN NEW.price_list_id<>OLD.price_list_id OR NEW.category_id<>OLD.category_id THEN RAISE(ABORT,'b2b_rule_identity_immutable') END;
 UPDATE b2b_price_lists SET version=version+1 WHERE id=OLD.price_list_id;
END;
CREATE TRIGGER b2b_category_rule_delete_version AFTER DELETE ON b2b_category_rules
BEGIN UPDATE b2b_price_lists SET version=version+1 WHERE id=OLD.price_list_id; END;

CREATE TABLE b2b_pricing_commands (
  actor_id TEXT NOT NULL REFERENCES identities(id), command_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL CHECK(session_version>=1),
  action TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(actor_id,command_id)
) STRICT;
CREATE TRIGGER b2b_commands_no_update BEFORE UPDATE ON b2b_pricing_commands BEGIN SELECT RAISE(ABORT,'b2b_pricing_immutable'); END;
CREATE TRIGGER b2b_commands_no_delete BEFORE DELETE ON b2b_pricing_commands BEGIN SELECT RAISE(ABORT,'b2b_pricing_immutable'); END;
CREATE TABLE b2b_pricing_guards(id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
CREATE TRIGGER b2b_commands_no_replace BEFORE INSERT ON b2b_pricing_commands
WHEN EXISTS(SELECT 1 FROM b2b_pricing_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'b2b_pricing_immutable'); END;
CREATE TRIGGER b2b_commands_authority BEFORE INSERT ON b2b_pricing_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=NEW.created_at AND s.mfa_verified=1 AND s.revoked_at IS NULL
 AND s.created_at<=NEW.created_at AND s.expires_at>NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND (r.expires_at IS NULL OR r.expires_at>NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'b2b_authorization_changed'); END;
-- Once governed through a command, later changes must belong to a new,
-- authorized, not-yet-applied command in the same atomic D1 batch.
CREATE TABLE b2b_managed_lists(price_list_id TEXT PRIMARY KEY REFERENCES b2b_price_lists(id)) STRICT;
CREATE TABLE b2b_managed_assignments(company_id TEXT PRIMARY KEY REFERENCES companies(id)) STRICT;
CREATE TABLE b2b_pricing_applied(actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
  PRIMARY KEY(actor_id,command_id), FOREIGN KEY(actor_id,command_id) REFERENCES b2b_pricing_commands(actor_id,command_id)) STRICT;
CREATE TABLE b2b_pricing_write_context(actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
  price_list_id TEXT NOT NULL, company_id TEXT,
  PRIMARY KEY(actor_id,command_id), FOREIGN KEY(actor_id,command_id) REFERENCES b2b_pricing_commands(actor_id,command_id)) STRICT;
CREATE TRIGGER b2b_context_authority BEFORE INSERT ON b2b_pricing_write_context
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_commands c WHERE c.actor_id=NEW.actor_id AND c.command_id=NEW.command_id
 AND json_extract(c.receipt_json,'$.priceListId')=NEW.price_list_id
 AND json_extract(c.receipt_json,'$.companyId') IS NEW.company_id
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_applied a WHERE a.actor_id=c.actor_id AND a.command_id=c.command_id))
BEGIN SELECT RAISE(ABORT,'b2b_context_invalid'); END;
CREATE TRIGGER b2b_managed_list_no_delete BEFORE DELETE ON b2b_managed_lists BEGIN SELECT RAISE(ABORT,'b2b_managed_immutable'); END;
CREATE TRIGGER b2b_managed_assignment_no_delete BEFORE DELETE ON b2b_managed_assignments BEGIN SELECT RAISE(ABORT,'b2b_managed_immutable'); END;
CREATE TRIGGER b2b_applied_no_update BEFORE UPDATE ON b2b_pricing_applied BEGIN SELECT RAISE(ABORT,'b2b_pricing_immutable'); END;
CREATE TRIGGER b2b_applied_no_delete BEFORE DELETE ON b2b_pricing_applied BEGIN SELECT RAISE(ABORT,'b2b_pricing_immutable'); END;
CREATE TRIGGER b2b_list_managed_update BEFORE UPDATE ON b2b_price_lists
WHEN EXISTS(SELECT 1 FROM b2b_managed_lists WHERE price_list_id=OLD.id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_list_managed_delete BEFORE DELETE ON b2b_price_lists
WHEN EXISTS(SELECT 1 FROM b2b_managed_lists WHERE price_list_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_variant_managed_insert BEFORE INSERT ON b2b_variant_rules
WHEN EXISTS(SELECT 1 FROM b2b_managed_lists WHERE price_list_id=NEW.price_list_id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=NEW.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_variant_managed_update BEFORE UPDATE ON b2b_variant_rules
WHEN EXISTS(SELECT 1 FROM b2b_managed_lists WHERE price_list_id=OLD.price_list_id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_variant_managed_delete BEFORE DELETE ON b2b_variant_rules
WHEN EXISTS(SELECT 1 FROM b2b_managed_lists WHERE price_list_id=OLD.price_list_id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_category_managed_insert BEFORE INSERT ON b2b_category_rules
WHEN EXISTS(SELECT 1 FROM b2b_managed_lists WHERE price_list_id=NEW.price_list_id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=NEW.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_category_managed_update BEFORE UPDATE ON b2b_category_rules
WHEN EXISTS(SELECT 1 FROM b2b_managed_lists WHERE price_list_id=OLD.price_list_id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_category_managed_delete BEFORE DELETE ON b2b_category_rules
WHEN EXISTS(SELECT 1 FROM b2b_managed_lists WHERE price_list_id=OLD.price_list_id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_assignment_managed_update BEFORE UPDATE ON b2b_company_assignments
WHEN EXISTS(SELECT 1 FROM b2b_managed_assignments WHERE company_id=OLD.company_id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE company_id=OLD.company_id AND price_list_id=NEW.price_list_id)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_assignment_managed_delete BEFORE DELETE ON b2b_company_assignments
WHEN EXISTS(SELECT 1 FROM b2b_managed_assignments WHERE company_id=OLD.company_id)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_assignment_managed_insert BEFORE INSERT ON b2b_company_assignments
WHEN EXISTS(SELECT 1 FROM b2b_managed_assignments WHERE company_id=NEW.company_id)
 AND NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE company_id=NEW.company_id AND price_list_id=NEW.price_list_id)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_applied_no_replace BEFORE INSERT ON b2b_pricing_applied
WHEN EXISTS(SELECT 1 FROM b2b_pricing_applied WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'b2b_pricing_immutable'); END;
CREATE TRIGGER b2b_list_command_insert BEFORE INSERT ON b2b_price_lists
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=NEW.id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_list_command_update BEFORE UPDATE ON b2b_price_lists
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_variant_command_insert BEFORE INSERT ON b2b_variant_rules
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=NEW.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_variant_command_update BEFORE UPDATE ON b2b_variant_rules
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_variant_command_delete BEFORE DELETE ON b2b_variant_rules
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_category_command_insert BEFORE INSERT ON b2b_category_rules
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=NEW.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_category_command_update BEFORE UPDATE ON b2b_category_rules
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_category_command_delete BEFORE DELETE ON b2b_category_rules
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE price_list_id=OLD.price_list_id AND company_id IS NULL)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_assignment_command_insert BEFORE INSERT ON b2b_company_assignments
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE company_id=NEW.company_id AND price_list_id=NEW.price_list_id)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_assignment_command_update BEFORE UPDATE ON b2b_company_assignments
WHEN NOT EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE company_id=OLD.company_id AND price_list_id=NEW.price_list_id)
BEGIN SELECT RAISE(ABORT,'b2b_command_required'); END;
CREATE TRIGGER b2b_context_no_update BEFORE UPDATE ON b2b_pricing_write_context
BEGIN SELECT RAISE(ABORT,'b2b_context_immutable'); END;
CREATE TRIGGER b2b_context_no_replace BEFORE INSERT ON b2b_pricing_write_context
WHEN EXISTS(SELECT 1 FROM b2b_pricing_write_context WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'b2b_context_immutable'); END;
