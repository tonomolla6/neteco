-- Governed typed values reuse the existing catalog_draft_commands ledger.
-- Historical commands/audits remain byte-for-byte unchanged. No product
-- projection, additional ledger or grants are introduced by this migration.
DROP TRIGGER catalog_draft_commands_shape;
CREATE TRIGGER catalog_draft_commands_shape BEFORE INSERT ON catalog_draft_commands
WHEN NOT EXISTS (SELECT 1 FROM json_each(NEW.patch)) OR EXISTS (
  SELECT 1 FROM json_each(NEW.patch) WHERE key NOT IN (
    'name', 'categoryId', 'shortDesc', 'description', 'usage', 'series', 'featured', 'badges', 'visual', 'attrs', 'typed'
  )
)
BEGIN SELECT RAISE(ABORT, 'catalog_draft_commands_shape'); END;

-- Bind typed receipts to the accepted full replacement and exact versioned
-- audit snapshot. Kind/config/current authority is checked in the live batch,
-- not in a product trigger that would reinterpret historical imported JSON.
CREATE TRIGGER catalog_draft_commands_typed_shape BEFORE INSERT ON catalog_draft_commands
WHEN json_type(NEW.patch,'$.typed') IS NOT NULL AND COALESCE((
  json_type(NEW.patch,'$.typed')='object'
  AND json_type(NEW.patch,'$.typed.version')='integer' AND json_extract(NEW.patch,'$.typed.version')=1
  AND json_type(NEW.patch,'$.typed.values')='array' AND json_array_length(NEW.patch,'$.typed.values')<=32
  AND (SELECT count(*) FROM json_each(NEW.patch,'$.typed'))=2
  AND NOT EXISTS(SELECT 1 FROM json_each(NEW.patch,'$.typed') WHERE key NOT IN ('version','values'))
  AND json_type(NEW.before_metadata,'$.typed') IS NOT NULL
  AND json_type(NEW.before_metadata,'$.typedPresent') IN ('true','false')
  AND (json_type(NEW.before_metadata,'$.typedPresent')='true' OR json_type(NEW.before_metadata,'$.typed')='null')
  AND json_type(NEW.after_metadata,'$.typed')='object'
  AND json_type(NEW.after_metadata,'$.typedPresent')='true'
  AND json_extract(NEW.after_metadata,'$.typed') IS json_extract(NEW.patch,'$.typed')
  AND json_extract(NEW.response,'$.action') IS 'update_values'
  AND json_extract(NEW.response,'$.commandId') IS NEW.id
  AND json_extract(NEW.response,'$.typed') IS json_extract(NEW.patch,'$.typed')
  AND (SELECT count(*) FROM json_each(NEW.response))=8
),0)<>1
BEGIN SELECT RAISE(ABORT,'catalog_draft_commands_typed_shape'); END;
