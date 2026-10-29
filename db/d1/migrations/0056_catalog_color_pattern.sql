-- D1 caps LIKE/GLOB patterns at 50 bytes. The historical six repeated
-- character classes total 67 bytes, preventing valid nonnull color writes.
-- Preserve every variant and dependent row: do not rebuild/drop variants or
-- disable foreign keys. This ordinary backup exists only during this migration.
CREATE TABLE catalog_color_migration_0056_backup (
  id TEXT PRIMARY KEY,
  color TEXT
) STRICT;

INSERT INTO catalog_color_migration_0056_backup(id,color)
SELECT id,color FROM variants;

ALTER TABLE variants DROP COLUMN color;
ALTER TABLE variants ADD COLUMN color TEXT CHECK (
  color IS NULL OR (
    length(color)=7
    -- SQLite length()/GLOB stop at NUL; the byte length rejects hidden suffixes.
    AND length(CAST(color AS BLOB))=7
    AND substr(color,1,1)='#'
    AND substr(color,2) NOT GLOB '*[^0-9A-Fa-f]*'
  )
);

UPDATE variants SET color=(
  SELECT saved.color FROM catalog_color_migration_0056_backup saved WHERE saved.id=variants.id
);

DROP TABLE catalog_color_migration_0056_backup;
