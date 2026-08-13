INSERT INTO permissions (code, resource, action, description)
VALUES ('reconciliation.manage', 'reconciliation', 'manage', 'Reconcile bank movements with orders')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('finance', 'reconciliation.manage'),
  ('admin', 'reconciliation.manage')
ON CONFLICT (role_code, permission_code) DO NOTHING;
