locals {
  prefix      = "neteco-iac-${var.environment}"
  worker_name = "${local.prefix}-shop"
  hostname    = trimprefix(var.public_origin, "https://")
}

# Fresh names only: no import/data lookup of the populated demo/preprod database.
resource "cloudflare_d1_database" "shop" {
  account_id   = var.account_id
  name         = "${local.prefix}-db"
  jurisdiction = "eu"
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_kv_namespace" "cache" {
  account_id = var.account_id
  title      = "${local.prefix}-cache"
}

resource "cloudflare_r2_bucket" "media" {
  account_id   = var.account_id
  name         = "${local.prefix}-media"
  jurisdiction = "eu"
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "jobs" {
  account_id = var.account_id
  queue_name = "${local.prefix}-jobs"
  settings = {
    delivery_paused = var.queue_delivery_paused
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "dead_letter" {
  account_id = var.account_id
  queue_name = "${local.prefix}-jobs-dlq"
  lifecycle {
    prevent_destroy = true
  }
}

# Wrangler alone owns the Worker/assets, three DO classes and migration tags,
# Workflow class/binding, Cron triggers, queue consumer/DLQ connection, runtime
# variables, Images/email bindings and observability from wrangler.canary.jsonc.
# Do not add workers_script/worker_version/deployment/workflow/consumer/cron TF
# resources here: that would create two controllers for the same runtime objects.
