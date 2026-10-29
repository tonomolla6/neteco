-- Single-warehouse manual inventory governance. No locations, balances, stock,
-- identities or permissions are invented. Historical ledger actors stay unknown.
CREATE TABLE inventory_admin_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('receipt','count_propose','count_approve')),
  target TEXT NOT NULL CHECK(json_valid(target) AND json_type(target)='object'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  legacy_variant_id INTEGER NOT NULL CHECK(legacy_variant_id BETWEEN 1 AND 9007199254740991),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 1 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK(result_version=expected_version+(action<>'count_propose') AND result_version<=9007199254740991),
  physical_before INTEGER NOT NULL CHECK(physical_before BETWEEN 0 AND 9007199254740991),
  physical_after INTEGER NOT NULL CHECK(physical_after BETWEEN 0 AND 9007199254740991),
  physical_delta INTEGER NOT NULL CHECK(physical_delta=physical_after-physical_before),
  proposed_delta INTEGER CHECK(proposed_delta BETWEEN -9007199254740991 AND 9007199254740991 AND proposed_delta<>0),
  proposal_id TEXT CHECK(proposal_id IS NULL OR length(proposal_id)=36),
  movement_id TEXT UNIQUE CHECK(movement_id IS NULL OR length(movement_id)=36),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500 AND json_extract(input,'$.reason')=reason),
  reference TEXT CHECK(reference IS NULL OR length(trim(reference)) BETWEEN 3 AND 200),
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state)='object'),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.commandId')=id,0)
    AND COALESCE(json_extract(response,'$.variantId')=legacy_variant_id,0)
    AND COALESCE(json_extract(response,'$.variantUuid')=variant_id,0)
    AND COALESCE(json_extract(response,'$.warehouseId')=location_id,0)
    AND COALESCE(json_extract(response,'$.balanceVersion')=result_version,0)
    AND COALESCE(json_extract(response,'$.physicalQuantity')=physical_after,0)
    AND COALESCE(json_extract(response,'$.physicalDelta')=physical_delta,0)
    AND json_extract(response,'$.proposedPhysicalDelta') IS proposed_delta
    AND json_extract(response,'$.proposalId') IS proposal_id
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key),
  FOREIGN KEY(variant_id,location_id) REFERENCES inventory_balances(variant_id,location_id),
  CHECK((action='count_propose' AND physical_delta=0 AND proposed_delta IS NOT NULL AND proposal_id IS NOT NULL AND movement_id IS NULL AND reference IS NOT NULL)
    OR (action='receipt' AND physical_delta>0 AND physical_delta=COALESCE(json_extract(input,'$.quantity'),-1)
      AND proposed_delta IS NULL AND proposal_id IS NULL AND movement_id IS NOT NULL AND reference IS NOT NULL)
    OR (action='count_approve' AND physical_delta<>0 AND proposed_delta IS NULL AND proposal_id IS NOT NULL AND movement_id IS NOT NULL AND reference IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX inventory_admin_commands_version ON inventory_admin_commands(variant_id,location_id,result_version) WHERE action<>'count_propose';
CREATE TRIGGER inventory_admin_commands_duplicate BEFORE INSERT ON inventory_admin_commands
WHEN EXISTS(SELECT 1 FROM inventory_admin_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key)
  OR (NEW.movement_id IS NOT NULL AND movement_id=NEW.movement_id)
  OR (NEW.action<>'count_propose' AND action<>'count_propose' AND variant_id=NEW.variant_id AND location_id=NEW.location_id AND result_version=NEW.result_version))
BEGIN SELECT RAISE(ABORT,'inventory_admin_commands_immutable'); END;
CREATE TRIGGER inventory_admin_commands_no_update BEFORE UPDATE ON inventory_admin_commands
BEGIN SELECT RAISE(ABORT,'inventory_admin_commands_immutable'); END;
CREATE TRIGGER inventory_admin_commands_no_delete BEFORE DELETE ON inventory_admin_commands
BEGIN SELECT RAISE(ABORT,'inventory_admin_commands_immutable'); END;

CREATE TABLE inventory_count_proposals (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  command_id TEXT NOT NULL UNIQUE REFERENCES inventory_admin_commands(id),
  variant_id TEXT NOT NULL REFERENCES variants(id), location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 1 AND 9007199254740990),
  counted_quantity INTEGER NOT NULL CHECK(counted_quantity BETWEEN 0 AND 9007199254740991),
  physical_delta INTEGER NOT NULL CHECK(physical_delta BETWEEN -9007199254740991 AND 9007199254740991 AND physical_delta<>0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
  reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 3 AND 200),
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state)='object'),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  FOREIGN KEY(variant_id,location_id) REFERENCES inventory_balances(variant_id,location_id)
) STRICT;
CREATE INDEX inventory_count_proposals_target ON inventory_count_proposals(variant_id,location_id,created_at DESC,id DESC);
CREATE TRIGGER inventory_count_proposals_duplicate BEFORE INSERT ON inventory_count_proposals
WHEN EXISTS(SELECT 1 FROM inventory_count_proposals WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'inventory_count_proposals_immutable'); END;
CREATE TRIGGER inventory_count_proposals_command BEFORE INSERT ON inventory_count_proposals
WHEN NOT EXISTS(SELECT 1 FROM inventory_admin_commands c WHERE c.id=NEW.command_id AND c.action='count_propose'
  AND c.proposal_id=NEW.id AND c.variant_id=NEW.variant_id AND c.location_id=NEW.location_id AND c.actor_id=NEW.actor_id
  AND c.expected_version=NEW.expected_version AND c.proposed_delta=NEW.physical_delta
  AND json_extract(c.input,'$.countedPhysicalQuantity')=NEW.counted_quantity
  AND c.reason=NEW.reason AND c.reference=NEW.reference AND c.before_state=NEW.before_state AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'inventory_count_proposals_command'); END;
CREATE TRIGGER inventory_count_proposals_no_update BEFORE UPDATE ON inventory_count_proposals
BEGIN SELECT RAISE(ABORT,'inventory_count_proposals_immutable'); END;
CREATE TRIGGER inventory_count_proposals_no_delete BEFORE DELETE ON inventory_count_proposals
BEGIN SELECT RAISE(ABORT,'inventory_count_proposals_immutable'); END;

CREATE TABLE inventory_count_approvals (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES inventory_count_proposals(id),
  command_id TEXT NOT NULL UNIQUE REFERENCES inventory_admin_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER inventory_count_approvals_duplicate BEFORE INSERT ON inventory_count_approvals
WHEN EXISTS(SELECT 1 FROM inventory_count_approvals WHERE id=NEW.id OR proposal_id=NEW.proposal_id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'inventory_count_approvals_immutable'); END;
CREATE TRIGGER inventory_count_approvals_command BEFORE INSERT ON inventory_count_approvals
WHEN NOT EXISTS(SELECT 1 FROM inventory_admin_commands c JOIN inventory_count_proposals p ON p.id=c.proposal_id
  WHERE c.id=NEW.command_id AND c.action='count_approve' AND c.proposal_id=NEW.proposal_id
    AND c.actor_id=NEW.actor_id AND c.actor_id<>p.actor_id AND c.reason=NEW.reason AND c.created_at=NEW.created_at
    AND c.variant_id=p.variant_id AND c.location_id=p.location_id AND c.expected_version=p.expected_version
    AND c.before_state=p.before_state AND c.physical_after=p.counted_quantity AND c.physical_delta=p.physical_delta)
BEGIN SELECT RAISE(ABORT,'inventory_count_approvals_command'); END;
CREATE TRIGGER inventory_count_approvals_no_update BEFORE UPDATE ON inventory_count_approvals
BEGIN SELECT RAISE(ABORT,'inventory_count_approvals_immutable'); END;
CREATE TRIGGER inventory_count_approvals_no_delete BEFORE DELETE ON inventory_count_approvals
BEGIN SELECT RAISE(ABORT,'inventory_count_approvals_immutable'); END;

CREATE TABLE inventory_admin_audit (
  id TEXT PRIMARY KEY CHECK(length(id)=36), command_id TEXT NOT NULL UNIQUE REFERENCES inventory_admin_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id), action TEXT NOT NULL,target TEXT NOT NULL,input TEXT NOT NULL,
  variant_id TEXT NOT NULL REFERENCES variants(id),legacy_variant_id INTEGER NOT NULL,location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  expected_version INTEGER NOT NULL,result_version INTEGER NOT NULL,physical_before INTEGER NOT NULL,physical_after INTEGER NOT NULL,
  physical_delta INTEGER NOT NULL,proposed_delta INTEGER,proposal_id TEXT,movement_id TEXT REFERENCES inventory_movements(id),
  reason TEXT NOT NULL,reference TEXT,before_state TEXT NOT NULL,after_state TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
CREATE INDEX inventory_admin_audit_target ON inventory_admin_audit(variant_id,location_id,created_at DESC,id DESC);
CREATE TRIGGER inventory_admin_audit_duplicate BEFORE INSERT ON inventory_admin_audit
WHEN EXISTS(SELECT 1 FROM inventory_admin_audit WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'inventory_admin_audit_immutable'); END;
CREATE TRIGGER inventory_admin_audit_command BEFORE INSERT ON inventory_admin_audit
WHEN NOT EXISTS(SELECT 1 FROM inventory_admin_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.actor_id
  AND c.action=NEW.action AND c.target=NEW.target AND c.input=NEW.input AND c.variant_id=NEW.variant_id AND c.legacy_variant_id=NEW.legacy_variant_id
  AND c.location_id=NEW.location_id AND c.expected_version=NEW.expected_version AND c.result_version=NEW.result_version
  AND c.physical_before=NEW.physical_before AND c.physical_after=NEW.physical_after AND c.physical_delta=NEW.physical_delta
  AND c.proposed_delta IS NEW.proposed_delta AND c.proposal_id IS NEW.proposal_id AND c.movement_id IS NEW.movement_id
  AND c.reason=NEW.reason AND c.reference IS NEW.reference AND c.before_state=NEW.before_state AND c.after_state=NEW.after_state
  AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'inventory_admin_audit_command'); END;
CREATE TRIGGER inventory_admin_audit_no_update BEFORE UPDATE ON inventory_admin_audit
BEGIN SELECT RAISE(ABORT,'inventory_admin_audit_immutable'); END;
CREATE TRIGGER inventory_admin_audit_no_delete BEFORE DELETE ON inventory_admin_audit
BEGIN SELECT RAISE(ABORT,'inventory_admin_audit_immutable'); END;

-- Protect only newly governed manual movements. Existing reservation ledger
-- ON CONFLICT replays and legacy rows retain their established contract.
CREATE TRIGGER inventory_admin_movement_no_update BEFORE UPDATE ON inventory_movements
WHEN EXISTS(SELECT 1 FROM inventory_admin_commands WHERE movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'inventory_admin_movement_immutable'); END;
CREATE TRIGGER inventory_admin_movement_no_delete BEFORE DELETE ON inventory_movements
WHEN EXISTS(SELECT 1 FROM inventory_admin_commands WHERE movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'inventory_admin_movement_immutable'); END;
CREATE TRIGGER inventory_admin_movement_no_replace BEFORE INSERT ON inventory_movements
WHEN EXISTS(SELECT 1 FROM inventory_movements m JOIN inventory_admin_commands c ON c.movement_id=m.id
  WHERE m.id=NEW.id OR m.idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'inventory_admin_movement_immutable'); END;
CREATE TABLE inventory_admin_guards (
  id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CONSTRAINT inventory_admin_atomic_guard CHECK(satisfied=1)
) STRICT;
