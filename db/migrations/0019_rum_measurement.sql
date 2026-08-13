-- Privacy-aware real-user performance signals in the versioned event taxonomy.

ALTER TABLE analytics_events DROP CONSTRAINT analytics_events_event_name_check;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_event_name_check CHECK (event_name IN (
  'page_view', 'catalog_viewed', 'search_completed', 'product_viewed',
  'cart_item_added', 'cart_item_removed', 'checkout_started', 'web_vital',
  'payment_initiated', 'payment_confirmed', 'payment_failed',
  'order_confirmed', 'refund_confirmed', 'shipment_status_changed'
));
