-- Keep the contact and B2B/delivery data submitted at checkout in the
-- immutable order contract. Existing orders remain readable with NULL details.
ALTER TABLE orders ADD COLUMN contact_name TEXT
  CHECK (contact_name IS NULL OR length(trim(contact_name)) BETWEEN 2 AND 120);
ALTER TABLE orders ADD COLUMN contact_phone TEXT
  CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 6 AND 24);
ALTER TABLE orders ADD COLUMN buyer_company_name TEXT
  CHECK (buyer_company_name IS NULL OR length(trim(buyer_company_name)) BETWEEN 2 AND 160);
ALTER TABLE orders ADD COLUMN buyer_tax_id TEXT
  CHECK (buyer_tax_id IS NULL OR length(buyer_tax_id) BETWEEN 6 AND 20);

ALTER TABLE order_shipping_address ADD COLUMN company_name TEXT
  CHECK (company_name IS NULL OR length(trim(company_name)) BETWEEN 2 AND 160);
ALTER TABLE order_shipping_address ADD COLUMN tax_id TEXT
  CHECK (tax_id IS NULL OR length(tax_id) BETWEEN 6 AND 20);
ALTER TABLE order_shipping_address ADD COLUMN instructions TEXT
  CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 500);

ALTER TABLE order_billing_address ADD COLUMN company_name TEXT
  CHECK (company_name IS NULL OR length(trim(company_name)) BETWEEN 2 AND 160);
ALTER TABLE order_billing_address ADD COLUMN instructions TEXT
  CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 500);

CREATE TRIGGER orders_contact_contract_immutable BEFORE UPDATE OF
  contact_name, contact_phone, buyer_company_name, buyer_tax_id ON orders
WHEN OLD.contact_name IS NOT NEW.contact_name
  OR OLD.contact_phone IS NOT NEW.contact_phone
  OR OLD.buyer_company_name IS NOT NEW.buyer_company_name
  OR OLD.buyer_tax_id IS NOT NEW.buyer_tax_id
BEGIN
  SELECT RAISE(ABORT, 'order contractual fields are immutable');
END;
