WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY provider, provider_event_id
           ORDER BY received_at, id
         ) AS occurrence
  FROM webhook_inbox
  WHERE provider_event_id IS NOT NULL
)
DELETE FROM webhook_inbox inbox
USING ranked
WHERE inbox.id = ranked.id AND ranked.occurrence > 1;

CREATE UNIQUE INDEX webhook_inbox_provider_event_unique
  ON webhook_inbox (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
