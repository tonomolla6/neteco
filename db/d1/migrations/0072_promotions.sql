-- No campaign is activated by migration. Existing contractual amounts survive
-- byte-for-byte; the new zero-default field records only an explicit coupon.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE promotion_rules (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
 code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 1 AND 64 AND code=upper(code)
   AND substr(code,1,1) GLOB '[A-Z0-9]' AND code NOT GLOB '*[^A-Z0-9_-]*'),
 current_version INTEGER NOT NULL CHECK(current_version>=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at)
) STRICT;
CREATE TRIGGER promotion_rule_identity_immutable BEFORE UPDATE ON promotion_rules
WHEN NEW.id IS NOT OLD.id OR NEW.code IS NOT OLD.code OR NEW.created_at IS NOT OLD.created_at
 OR NEW.current_version<>OLD.current_version+1 OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'promotion_identity_immutable'); END;
CREATE TRIGGER promotion_rules_no_delete BEFORE DELETE ON promotion_rules
BEGIN SELECT RAISE(ABORT,'promotion_identity_immutable'); END;
CREATE TRIGGER promotion_rules_no_replace BEFORE INSERT ON promotion_rules
WHEN EXISTS(SELECT 1 FROM promotion_rules WHERE id=NEW.id OR code=NEW.code)
BEGIN SELECT RAISE(ABORT,'promotion_identity_immutable'); END;

CREATE TABLE promotion_rule_versions (
 rule_id TEXT NOT NULL REFERENCES promotion_rules(id),
 version INTEGER NOT NULL CHECK(version>=1),
 rule_json TEXT NOT NULL CHECK(length(rule_json)<=65536 AND json_valid(rule_json)
   AND json_type(rule_json)='object' AND COALESCE(json_extract(rule_json,'$.id')=rule_id,0)
   AND COALESCE(json_extract(rule_json,'$.version')=version,0)),
 rule_hash TEXT NOT NULL CHECK(length(rule_hash)=64 AND rule_hash NOT GLOB '*[^0-9a-f]*'),
 created_by TEXT NOT NULL REFERENCES identities(id),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 PRIMARY KEY(rule_id,version)
) STRICT;
CREATE TRIGGER promotion_versions_no_update BEFORE UPDATE ON promotion_rule_versions
BEGIN SELECT RAISE(ABORT,'promotion_version_immutable'); END;
CREATE TRIGGER promotion_versions_no_delete BEFORE DELETE ON promotion_rule_versions
BEGIN SELECT RAISE(ABORT,'promotion_version_immutable'); END;
CREATE TRIGGER promotion_versions_no_replace BEFORE INSERT ON promotion_rule_versions
WHEN EXISTS(SELECT 1 FROM promotion_rule_versions WHERE rule_id=NEW.rule_id AND version=NEW.version)
BEGIN SELECT RAISE(ABORT,'promotion_version_immutable'); END;

-- Rebuild only the two line tables whose original gross=unit*quantity CHECK
-- otherwise forbids a real, non-unit-divisible discount. Child FKs stay enabled.
CREATE TABLE checkout_quote_lines_discounted (
 quote_id TEXT NOT NULL REFERENCES checkout_quotes(id) ON DELETE CASCADE,
 line_index INTEGER NOT NULL CHECK(line_index>=0),
 variant_id TEXT NOT NULL REFERENCES variants(id), sku TEXT NOT NULL, name TEXT NOT NULL,
 format TEXT NOT NULL, unit_label TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999),
 unit_gross_cents INTEGER NOT NULL CHECK(unit_gross_cents>0),
 net_cents INTEGER NOT NULL CHECK(net_cents>=0), tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
 gross_cents INTEGER NOT NULL CHECK(gross_cents>=0),
 tax_rate_basis_points INTEGER NOT NULL CHECK(tax_rate_basis_points BETWEEN 0 AND 10000),
 price_version_id TEXT NOT NULL,
 available_quantity INTEGER NOT NULL CHECK(available_quantity>=0),
 backorder_allowed INTEGER NOT NULL CHECK(backorder_allowed IN(0,1)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 discount_gross_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_gross_cents>=0),
 CHECK(gross_cents=net_cents+tax_cents),
 CHECK(gross_cents=unit_gross_cents*quantity-discount_gross_cents),
 PRIMARY KEY(quote_id,line_index)
) STRICT;
INSERT INTO checkout_quote_lines_discounted SELECT *,0 FROM checkout_quote_lines;
DROP TABLE checkout_quote_lines;
ALTER TABLE checkout_quote_lines_discounted RENAME TO checkout_quote_lines;
CREATE TRIGGER checkout_quote_lines_immutable_update BEFORE UPDATE ON checkout_quote_lines
BEGIN SELECT RAISE(ABORT,'checkout quote line snapshots are immutable'); END;
CREATE TRIGGER checkout_quote_lines_immutable_delete BEFORE DELETE ON checkout_quote_lines
BEGIN SELECT RAISE(ABORT,'checkout quote line snapshots are immutable'); END;
CREATE TRIGGER checkout_quote_lines_no_update BEFORE UPDATE ON checkout_quote_lines
BEGIN SELECT RAISE(ABORT,'quote lines are immutable snapshots'); END;
CREATE TRIGGER checkout_quote_lines_no_delete BEFORE DELETE ON checkout_quote_lines
BEGIN SELECT RAISE(ABORT,'quote lines are immutable snapshots'); END;
CREATE TRIGGER checkout_quote_lines_no_replace BEFORE INSERT ON checkout_quote_lines
WHEN EXISTS(SELECT 1 FROM checkout_quote_lines WHERE quote_id=NEW.quote_id AND line_index=NEW.line_index)
BEGIN SELECT RAISE(ABORT,'quote lines are immutable snapshots'); END;

CREATE TABLE order_lines_discounted (
 order_id TEXT NOT NULL REFERENCES orders(id), line_index INTEGER NOT NULL CHECK(line_index>=0),
 variant_id TEXT NOT NULL REFERENCES variants(id), sku TEXT NOT NULL, name TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999),
 unit_gross_cents INTEGER NOT NULL CHECK(unit_gross_cents>0),
 net_cents INTEGER NOT NULL CHECK(net_cents>=0), tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
 gross_cents INTEGER NOT NULL CHECK(gross_cents>=0),
 tax_rate_basis_points INTEGER NOT NULL CHECK(tax_rate_basis_points BETWEEN 0 AND 10000),
 price_version_id TEXT NOT NULL, location_id TEXT NOT NULL REFERENCES inventory_locations(id),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 discount_gross_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_gross_cents>=0),
 CONSTRAINT gross_matches_line CHECK(gross_cents=net_cents+tax_cents),
 CONSTRAINT gross_matches_units CHECK(gross_cents=unit_gross_cents*quantity-discount_gross_cents),
 PRIMARY KEY(order_id,line_index)
) STRICT;
INSERT INTO order_lines_discounted SELECT *,0 FROM order_lines;
DROP TRIGGER order_return_lines_insert_budget;
DROP TRIGGER order_return_lines_update_budget;
DROP TRIGGER order_return_commands_transition;
DROP TRIGGER refund_allocation_line_budget;
DROP TABLE order_lines;
ALTER TABLE order_lines_discounted RENAME TO order_lines;
CREATE TRIGGER order_lines_no_update BEFORE UPDATE ON order_lines
BEGIN SELECT RAISE(ABORT,'order lines are contractual snapshots'); END;
CREATE TRIGGER order_lines_no_delete BEFORE DELETE ON order_lines
BEGIN SELECT RAISE(ABORT,'order lines are contractual snapshots'); END;
CREATE TRIGGER order_lines_no_replace BEFORE INSERT ON order_lines
WHEN EXISTS(SELECT 1 FROM order_lines WHERE order_id=NEW.order_id AND line_index=NEW.line_index)
BEGIN SELECT RAISE(ABORT,'order lines are immutable contractual snapshots'); END;
CREATE TRIGGER order_return_lines_insert_budget BEFORE INSERT ON order_return_lines
WHEN NEW.claimed_quantity+COALESCE((SELECT SUM(claimed_quantity) FROM order_return_lines
  WHERE order_id=NEW.order_id AND line_index=NEW.line_index),0)>
  COALESCE((SELECT quantity FROM order_lines WHERE order_id=NEW.order_id AND line_index=NEW.line_index),-1)
BEGIN SELECT RAISE(ABORT,'order_return_quantity_unavailable'); END;
CREATE TRIGGER order_return_lines_update_budget BEFORE UPDATE ON order_return_lines
WHEN NEW.claimed_quantity+COALESCE((SELECT SUM(claimed_quantity) FROM order_return_lines
  WHERE order_id=NEW.order_id AND line_index=NEW.line_index AND return_id<>NEW.return_id),0)>
  COALESCE((SELECT quantity FROM order_lines WHERE order_id=NEW.order_id AND line_index=NEW.line_index),-1)
BEGIN SELECT RAISE(ABORT,'order_return_quantity_unavailable'); END;
CREATE TRIGGER order_return_commands_transition BEFORE INSERT ON order_return_commands
WHEN NEW.expected_order_version<>(SELECT count(*) FROM order_return_commands WHERE order_id=NEW.order_id)
  OR (NEW.action='requested' AND (EXISTS(SELECT 1 FROM order_returns WHERE id=NEW.return_id OR public_ref=NEW.public_ref)
    OR COALESCE(json_type(NEW.input,'$.lines'),'')<>'array' OR json_array_length(NEW.input,'$.lines') NOT BETWEEN 1 AND 100
    OR (SELECT count(DISTINCT json_extract(value,'$.lineIndex')) FROM json_each(NEW.input,'$.lines'))<>json_array_length(NEW.input,'$.lines')
    OR EXISTS(SELECT 1 FROM json_each(NEW.input,'$.lines') line WHERE
      COALESCE(json_type(line.value,'$.quantity'),'')<>'integer' OR json_extract(line.value,'$.quantity') NOT BETWEEN 1 AND 999
      OR COALESCE(json_type(line.value,'$.lineIndex'),'')<>'integer'
      OR NOT EXISTS(SELECT 1 FROM order_lines WHERE order_id=NEW.order_id AND line_index=json_extract(line.value,'$.lineIndex')))))
  OR (NEW.action<>'requested' AND NOT EXISTS(SELECT 1 FROM order_returns r
    WHERE r.id=NEW.return_id AND r.public_ref=NEW.public_ref AND r.order_id=NEW.order_id AND r.location_id=NEW.location_id
      AND r.state=NEW.from_state AND r.version=NEW.expected_version
      AND ((r.state='requested' AND NEW.action IN ('approved','rejected'))
        OR (r.state IN ('approved','received') AND NEW.action='received'
          AND EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=r.id AND received_quantity<authorized_quantity))
        OR (r.state IN ('received','inspected') AND NEW.action='inspected'
          AND NOT EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=r.id AND received_quantity<>authorized_quantity)
          AND EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=r.id AND inspected_quantity<received_quantity))
        OR (r.state='inspected' AND NEW.action='resolution_ready'
          AND NOT EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=r.id
            AND (received_quantity<>authorized_quantity OR inspected_quantity<>received_quantity))))))
BEGIN SELECT RAISE(ABORT,'order_return_transition_invalid'); END;
CREATE TRIGGER refund_allocation_line_budget BEFORE INSERT ON refund_allocations
WHEN NEW.component='line' AND (
 NOT EXISTS(SELECT 1 FROM refund_contracts c JOIN order_lines line ON line.order_id=c.order_id AND line.line_index=NEW.line_index
 JOIN order_return_lines returned ON returned.return_id=c.return_id AND returned.line_index=NEW.line_index
 WHERE c.id=NEW.refund_id AND NEW.unit_offset+NEW.quantity<=line.quantity
 AND returned.inspected_quantity>=NEW.quantity+(SELECT COALESCE(sum(a.quantity),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id
 JOIN refund_work work ON work.refund_id=other.id WHERE other.return_id=c.return_id AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled')
 AND line.gross_cents>=NEW.gross_cents+(SELECT COALESCE(sum(a.gross_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work work ON work.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled')
 AND line.net_cents>=NEW.net_cents+(SELECT COALESCE(sum(a.net_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work work ON work.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled')
 AND line.tax_cents>=NEW.tax_cents+(SELECT COALESCE(sum(a.tax_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work work ON work.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled'))
 OR EXISTS(SELECT 1 FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work work ON work.refund_id=other.id
 WHERE other.order_id=(SELECT order_id FROM refund_contracts WHERE id=NEW.refund_id) AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled'
 AND NEW.unit_offset<a.unit_offset+a.quantity AND a.unit_offset<NEW.unit_offset+NEW.quantity))
BEGIN SELECT RAISE(ABORT,'refund_line_budget_exceeded'); END;

CREATE TABLE checkout_quote_promotions (
 quote_id TEXT PRIMARY KEY REFERENCES checkout_quotes(id),
 rule_id TEXT NOT NULL,
 rule_version INTEGER NOT NULL,
 rule_json TEXT NOT NULL CHECK(json_valid(rule_json) AND json_type(rule_json)='object'
   AND COALESCE(json_extract(rule_json,'$.id')=rule_id,0)
   AND COALESCE(json_extract(rule_json,'$.version')=rule_version,0)),
 rule_hash TEXT NOT NULL CHECK(length(rule_hash)=64 AND rule_hash NOT GLOB '*[^0-9a-f]*'),
 customer_id TEXT REFERENCES customers(id),
 discount_gross_cents INTEGER NOT NULL CHECK(discount_gross_cents>0),
 FOREIGN KEY(rule_id,rule_version) REFERENCES promotion_rule_versions(rule_id,version)
) STRICT;
CREATE TRIGGER quote_promotion_no_update BEFORE UPDATE ON checkout_quote_promotions
BEGIN SELECT RAISE(ABORT,'quote_promotion_immutable'); END;
CREATE TRIGGER quote_promotion_no_delete BEFORE DELETE ON checkout_quote_promotions
BEGIN SELECT RAISE(ABORT,'quote_promotion_immutable'); END;
CREATE TRIGGER quote_promotion_no_replace BEFORE INSERT ON checkout_quote_promotions
WHEN EXISTS(SELECT 1 FROM checkout_quote_promotions WHERE quote_id=NEW.quote_id)
BEGIN SELECT RAISE(ABORT,'quote_promotion_immutable'); END;

CREATE TABLE promotion_redemptions (
 rule_id TEXT NOT NULL REFERENCES promotion_rules(id),
 order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), customer_id TEXT REFERENCES customers(id),
 rule_version INTEGER NOT NULL,
 discount_gross_cents INTEGER NOT NULL CHECK(discount_gross_cents>0),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 PRIMARY KEY(rule_id,order_id),
 FOREIGN KEY(rule_id,rule_version) REFERENCES promotion_rule_versions(rule_id,version)
) STRICT;
CREATE INDEX promotion_redemptions_customer ON promotion_redemptions(rule_id,customer_id);
CREATE TRIGGER promotion_redemptions_no_update BEFORE UPDATE ON promotion_redemptions
BEGIN SELECT RAISE(ABORT,'promotion_redemption_immutable'); END;
CREATE TRIGGER promotion_redemptions_no_delete BEFORE DELETE ON promotion_redemptions
BEGIN SELECT RAISE(ABORT,'promotion_redemption_immutable'); END;
CREATE TRIGGER promotion_redemptions_no_replace BEFORE INSERT ON promotion_redemptions
WHEN EXISTS(SELECT 1 FROM promotion_redemptions WHERE order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'promotion_redemption_immutable'); END;
CREATE TABLE promotion_guards (
 id TEXT PRIMARY KEY,
 valid INTEGER NOT NULL CONSTRAINT promotion_atomic_guard CHECK(valid=1)
) STRICT;
-- Validate real final child relationships before clearing deferred bookkeeping
-- from replaced parent b-trees. Any actual orphan aborts the entire migration.
INSERT INTO promotion_guards(id,valid)
SELECT 'migration-0072-foreign-keys',CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DELETE FROM promotion_guards WHERE id='migration-0072-foreign-keys';
PRAGMA defer_foreign_keys = OFF;
