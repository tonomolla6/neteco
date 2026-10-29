-- Variant-specific commercial consent is independent of newsletter consent.
-- No provider, price mutation, stock reservation or delivery is enabled here.
CREATE TABLE product_watch_requests (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  variant_legacy_id INTEGER NOT NULL CHECK(variant_legacy_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('back_in_stock','price_drop')),
  recipient TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  text_hash TEXT NOT NULL CHECK(length(text_hash)=64 AND text_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  confirmation_expires_at TEXT NOT NULL CHECK(confirmation_expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',confirmation_expires_at),'') AND confirmation_expires_at>created_at)
) STRICT;
CREATE TABLE product_watch_commands (
  actor_id TEXT NOT NULL REFERENCES identities(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  command_id TEXT NOT NULL,
  watch_id TEXT NOT NULL REFERENCES product_watch_requests(id),
  action TEXT NOT NULL CHECK(action IN ('create','confirm','cancel')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  applied_version INTEGER NOT NULL CHECK(applied_version>=1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(actor_id,command_id),
  UNIQUE(watch_id,applied_version)
) STRICT;
CREATE TABLE product_watches (
  id TEXT PRIMARY KEY REFERENCES product_watch_requests(id),
  version INTEGER NOT NULL CHECK(version>=1),
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','cancelled')),
  baseline_gross_cents INTEGER CHECK(baseline_gross_cents>=0),
  baseline_available INTEGER CHECK(baseline_available IN (0,1)),
  confirmed_at TEXT,
  cancelled_at TEXT,
  command_actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  FOREIGN KEY(command_actor_id,command_id) REFERENCES product_watch_commands(actor_id,command_id),
  CHECK((status='pending' AND confirmed_at IS NULL AND cancelled_at IS NULL AND baseline_gross_cents IS NULL AND baseline_available IS NULL)
    OR (status='confirmed' AND confirmed_at IS NOT NULL AND cancelled_at IS NULL AND baseline_gross_cents IS NOT NULL AND baseline_available IS NOT NULL)
    OR (status='cancelled' AND cancelled_at IS NOT NULL))
) STRICT;
CREATE TABLE product_watch_observations (
  watch_id TEXT NOT NULL REFERENCES product_watch_requests(id),
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  available INTEGER NOT NULL CHECK(available IN (0,1)),
  gross_cents INTEGER NOT NULL CHECK(gross_cents>=0),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(watch_id,sequence)
) STRICT;
CREATE TABLE product_watch_deliveries (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES product_watch_requests(id),
  kind TEXT NOT NULL CHECK(kind IN ('confirmation','back_in_stock','price_drop')),
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','skipped','manual_review')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  claimed_at TEXT,
  finished_at TEXT,
  provider_message_id TEXT,
  UNIQUE(watch_id,kind,source_hash)
) STRICT;
CREATE INDEX product_watch_owner ON product_watch_requests(customer_id,created_at,id);
CREATE INDEX product_watch_delivery_pending ON product_watch_deliveries(status,created_at,id);
CREATE TRIGGER product_watch_request_no_update BEFORE UPDATE ON product_watch_requests BEGIN SELECT RAISE(ABORT,'immutable_product_watch_request'); END;
CREATE TRIGGER product_watch_request_no_delete BEFORE DELETE ON product_watch_requests BEGIN SELECT RAISE(ABORT,'immutable_product_watch_request'); END;
CREATE TRIGGER product_watch_request_no_replace BEFORE INSERT ON product_watch_requests WHEN EXISTS(SELECT 1 FROM product_watch_requests WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable_product_watch_request'); END;
CREATE TRIGGER product_watch_command_no_update BEFORE UPDATE ON product_watch_commands BEGIN SELECT RAISE(ABORT,'immutable_product_watch_command'); END;
CREATE TRIGGER product_watch_command_no_delete BEFORE DELETE ON product_watch_commands BEGIN SELECT RAISE(ABORT,'immutable_product_watch_command'); END;
CREATE TRIGGER product_watch_command_no_replace BEFORE INSERT ON product_watch_commands WHEN EXISTS(SELECT 1 FROM product_watch_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id OR watch_id=NEW.watch_id AND applied_version=NEW.applied_version) BEGIN SELECT RAISE(ABORT,'immutable_product_watch_command'); END;
CREATE TRIGGER product_watch_observation_no_update BEFORE UPDATE ON product_watch_observations BEGIN SELECT RAISE(ABORT,'immutable_product_watch_observation'); END;
CREATE TRIGGER product_watch_observation_no_delete BEFORE DELETE ON product_watch_observations BEGIN SELECT RAISE(ABORT,'immutable_product_watch_observation'); END;
CREATE TRIGGER product_watch_observation_no_replace BEFORE INSERT ON product_watch_observations WHEN EXISTS(SELECT 1 FROM product_watch_observations WHERE watch_id=NEW.watch_id AND sequence=NEW.sequence) BEGIN SELECT RAISE(ABORT,'immutable_product_watch_observation'); END;
CREATE TRIGGER product_watch_projection_guard_insert BEFORE INSERT ON product_watches WHEN NOT EXISTS(
 SELECT 1 FROM product_watch_commands c WHERE c.watch_id=NEW.id AND c.applied_version=NEW.version AND c.actor_id=NEW.command_actor_id AND c.command_id=NEW.command_id AND c.action='create' AND NEW.version=1 AND NEW.status='pending'
) BEGIN SELECT RAISE(ABORT,'unconfirmed_product_watch_projection'); END;
CREATE TRIGGER product_watch_projection_guard_update BEFORE UPDATE ON product_watches WHEN NEW.id<>OLD.id OR NEW.version<>OLD.version+1 OR NOT EXISTS(
 SELECT 1 FROM product_watch_commands c WHERE c.watch_id=NEW.id AND c.applied_version=NEW.version AND c.actor_id=NEW.command_actor_id AND c.command_id=NEW.command_id
 AND json_extract(c.snapshot_json,'$.status')=NEW.status
 AND json_extract(c.snapshot_json,'$.baselineGrossCents') IS NEW.baseline_gross_cents
 AND json_extract(c.snapshot_json,'$.baselineAvailable') IS NEW.baseline_available
 AND json_extract(c.snapshot_json,'$.confirmedAt') IS NEW.confirmed_at
 AND json_extract(c.snapshot_json,'$.cancelledAt') IS NEW.cancelled_at
 AND ((c.action='confirm' AND OLD.status='pending' AND NEW.status='confirmed') OR(c.action='cancel' AND OLD.status IN ('pending','confirmed') AND NEW.status='cancelled'))
) BEGIN SELECT RAISE(ABORT,'unconfirmed_product_watch_projection'); END;
CREATE TRIGGER product_watch_projection_no_replace BEFORE INSERT ON product_watches WHEN EXISTS(SELECT 1 FROM product_watches WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'unconfirmed_product_watch_projection'); END;
CREATE TRIGGER product_watch_projection_no_delete BEFORE DELETE ON product_watches BEGIN SELECT RAISE(ABORT,'immutable_product_watch_projection'); END;
CREATE TRIGGER product_watch_project_command AFTER INSERT ON product_watch_commands BEGIN
 INSERT INTO product_watches(id,version,status,command_actor_id,command_id)
 SELECT NEW.watch_id,1,'pending',NEW.actor_id,NEW.command_id WHERE NEW.action='create';
 UPDATE product_watches SET version=NEW.applied_version,status=json_extract(NEW.snapshot_json,'$.status'),
 baseline_gross_cents=json_extract(NEW.snapshot_json,'$.baselineGrossCents'),baseline_available=json_extract(NEW.snapshot_json,'$.baselineAvailable'),
 confirmed_at=json_extract(NEW.snapshot_json,'$.confirmedAt'),cancelled_at=json_extract(NEW.snapshot_json,'$.cancelledAt'),
 command_actor_id=NEW.actor_id,command_id=NEW.command_id
 WHERE id=NEW.watch_id AND NEW.action IN ('confirm','cancel');
END;
CREATE TRIGGER product_watch_delivery_identity BEFORE UPDATE ON product_watch_deliveries WHEN NEW.id<>OLD.id OR NEW.watch_id<>OLD.watch_id OR NEW.kind<>OLD.kind OR NEW.source_hash<>OLD.source_hash OR NEW.created_at<>OLD.created_at
 OR NOT((OLD.status='pending' AND NEW.status IN ('sending','skipped')) OR(OLD.status='sending' AND NEW.status IN ('sent','manual_review')))
 BEGIN SELECT RAISE(ABORT,'immutable_product_watch_delivery'); END;
CREATE TRIGGER product_watch_delivery_no_replace BEFORE INSERT ON product_watch_deliveries WHEN EXISTS(SELECT 1 FROM product_watch_deliveries WHERE id=NEW.id OR(watch_id=NEW.watch_id AND kind=NEW.kind AND source_hash=NEW.source_hash)) BEGIN SELECT RAISE(ABORT,'immutable_product_watch_delivery'); END;
CREATE TRIGGER product_watch_delivery_no_delete BEFORE DELETE ON product_watch_deliveries BEGIN SELECT RAISE(ABORT,'immutable_product_watch_delivery'); END;
CREATE TABLE product_watch_atomic_guard(value INTEGER NOT NULL CHECK(value=1)) STRICT;
-- A single bounded scheduled sweep rotates through all watches. Manual pages
-- and command recovery do not move this cursor or refresh consent.
CREATE TABLE product_watch_evaluation_cursor(id INTEGER PRIMARY KEY CHECK(id=1),last_id TEXT NOT NULL) STRICT;
INSERT INTO product_watch_evaluation_cursor(id,last_id) VALUES(1,'');
