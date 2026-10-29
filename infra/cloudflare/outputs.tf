# Export ONLY this output as JSON for the offline generator:
# tofu output -json wrangler_environment > <private-environment-file>
# tsx scripts/generate-shop-config.ts --environment-file <private-environment-file>
# Do NOT export all state or `output -json` (Terraform wrappers are not this DTO).
output "wrangler_environment" {
  value = {
    environment  = var.environment
    accountId    = var.account_id
    zoneId       = var.zone_id
    publicOrigin = var.public_origin
    resources = {
      d1              = { name = cloudflare_d1_database.shop.name, id = cloudflare_d1_database.shop.id }
      kv              = { name = cloudflare_workers_kv_namespace.cache.title, id = cloudflare_workers_kv_namespace.cache.id }
      r2              = { name = cloudflare_r2_bucket.media.name, jurisdiction = "eu" }
      queue           = { name = cloudflare_queue.jobs.queue_name }
      deadLetterQueue = { name = cloudflare_queue.dead_letter.queue_name }
    }
    rateLimitNamespaceIds = var.rate_limit_namespace_ids
  }
}

output "runtime_ownership" {
  value = {
    infrastructure   = "terraform: D1, KV, R2, queues, optional domain/DNS/TLS/WAF/CDN/Turnstile"
    runtime          = "wrangler: Worker/assets/DO migrations/Workflow/Cron/queue consumer/observability/secret names"
    traffic_attached = var.attach_traffic
    queues_paused    = var.queue_delivery_paused
  }
}

# Recovery: protect current state/locking and data backups; re-generating this
# config restores neither D1 rows nor R2 objects. Wrangler migrations are forward
# only; DO tags remain immutable. Restore data and re-provision secrets through
# separately approved operations, then verify before enabling queues/traffic.
