# Custom Domains provision DNS and managed TLS for this hostname. This resource
# must only be enabled after the independent Wrangler Worker upload; no fake
# origin IP, Worker upload via Terraform or implicit neteco.es cutover.
resource "cloudflare_workers_custom_domain" "shop" {
  count      = var.attach_traffic ? 1 : 0
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = local.hostname
  service    = local.worker_name
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zone_setting" "tls" {
  for_each   = var.tls_settings
  zone_id    = var.zone_id
  setting_id = each.key
  value      = each.value
  lifecycle {
    precondition {
      condition     = var.dedicated_zone_ownership_acknowledged
      error_message = "Zone-wide TLS changes require dedicated-zone ownership; do not alter the existing landing/shared production zone."
    }
  }
}

resource "cloudflare_ruleset" "waf" {
  count   = length(var.waf_rules) > 0 ? 1 : 0
  zone_id = var.zone_id
  name    = "${local.prefix}-waf"
  kind    = "zone"
  phase   = "http_request_firewall_custom"
  rules = [for rule in var.waf_rules : {
    ref         = rule.ref
    description = rule.description
    expression  = "(http.host eq \"${local.hostname}\") and (${rule.expression})"
    action      = rule.action
    enabled     = true
  }]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.dedicated_zone_ownership_acknowledged
      error_message = "Creating a phase entrypoint requires dedicated-zone ownership, never replacement of a shared ruleset."
    }
  }
}

resource "cloudflare_ruleset" "cache" {
  count   = length(var.cache_rules) > 0 ? 1 : 0
  zone_id = var.zone_id
  name    = "${local.prefix}-cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"
  rules = [for rule in var.cache_rules : {
    ref         = rule.ref
    description = rule.description
    expression = join(" and ", [
      "(http.host eq \"${local.hostname}\")",
      "(http.request.method in {\"GET\" \"HEAD\"})",
      "(starts_with(http.request.uri.path, \"/_nuxt/\"))",
      "(not starts_with(http.request.uri.path, \"/api\"))",
      "(not starts_with(http.request.uri.path, \"/admin\"))",
      "(not starts_with(http.request.uri.path, \"/cuenta\"))",
      "(not starts_with(http.request.uri.path, \"/pedido\"))",
      "(not starts_with(http.request.uri.path, \"/carrito\"))",
      "(not starts_with(http.request.uri.path, \"/checkout\"))",
      "(http.cookie eq \"\")",
      "(not any(http.request.headers[\"authorization\"][*] ne \"\"))",
      "(${rule.expression})"
    ])
    action            = "set_cache_settings"
    action_parameters = { cache = rule.cache }
    enabled           = true
  }]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.dedicated_zone_ownership_acknowledged
      error_message = "Creating a cache phase entrypoint requires dedicated-zone ownership."
    }
  }
}

resource "cloudflare_turnstile_widget" "shop" {
  count           = var.create_turnstile ? 1 : 0
  account_id      = var.account_id
  domains         = [local.hostname]
  name            = "${local.prefix}-support"
  mode            = "managed"
  clearance_level = "no_clearance"
  # The computed sensitive secret stays in private state, never outputs/config.
}
