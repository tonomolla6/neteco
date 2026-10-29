variable "environment" {
  type        = string
  description = "Required explicit environment; use a separate backend/state per environment. No workspace/default inference."
  validation {
    condition     = contains(["preprod", "production"], var.environment)
    error_message = "environment must be explicitly preprod or production."
  }
}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id)) && var.account_id != "00000000000000000000000000000000"
    error_message = "An explicit Cloudflare account ID is required."
  }
}

variable "zone_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.zone_id)) && var.zone_id != "00000000000000000000000000000000"
    error_message = "An explicit Cloudflare zone ID is required."
  }
}

variable "public_origin" {
  type = string
  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.public_origin))
    error_message = "Provide an explicit HTTPS DNS origin without path, credentials, port, query or fragment."
  }
}

variable "rate_limit_namespace_ids" {
  type = object({
    AUTH_EDGE_LIMIT      = string
    ADMIN_EDGE_LIMIT     = string
    CART_EDGE_LIMIT      = string
    ANALYTICS_EDGE_LIMIT = string
  })
  description = "Account-unique reserved IDs, independently allocated for each environment; not locally guessed placeholders."
  validation {
    condition = (
      length(distinct(values(var.rate_limit_namespace_ids))) == 4 &&
      alltrue([for id in values(var.rate_limit_namespace_ids) : can(regex("^[1-9][0-9]{0,9}$", id))])
    )
    error_message = "Four distinct account-unique numeric rate-limit namespaces are required."
  }
}

variable "queue_delivery_paused" {
  type        = bool
  default     = true
  description = "Keep asynchronous execution paused until the separate runtime/provider activation gates are approved."
}

variable "attach_traffic" {
  type        = bool
  default     = false
  description = "Separate explicit approval, only after the Wrangler shop deployment, secrets, data and HTTPS acceptance. Never adopt an existing hostname."
}

variable "dedicated_zone_ownership_acknowledged" {
  type        = bool
  default     = false
  description = "Required before zone-wide TLS or phase-entrypoint rules. Shared production zones/rules must not be overwritten."
}

variable "tls_settings" {
  type        = map(string)
  default     = {}
  description = "Explicit reviewed zone-wide values; empty means do not modify existing TLS settings."
  validation {
    condition = alltrue([
      for name, value in var.tls_settings :
      (name == "ssl" && contains(["strict"], value)) ||
      (name == "min_tls_version" && contains(["1.2", "1.3"], value)) ||
      (name == "always_use_https" && value == "on")
    ])
    error_message = "Only reviewed strict TLS, minimum TLS and HTTPS redirect settings are accepted."
  }
}

variable "waf_rules" {
  type        = list(object({ ref = string, expression = string, action = string, description = string }))
  default     = []
  description = "Reviewed host-scoped rules only; no managed/paid ruleset or guessed business policy."
  validation {
    condition = length(var.waf_rules) <= 20 && length(distinct([for rule in var.waf_rules : rule.ref])) == length(var.waf_rules) && alltrue([
      for rule in var.waf_rules : contains(["block", "managed_challenge"], rule.action) && length(rule.expression) > 0
    ])
    error_message = "At most 20 uniquely referenced explicit block/challenge rules are allowed."
  }
}

variable "cache_rules" {
  type        = list(object({ ref = string, expression = string, cache = bool, description = string }))
  default     = []
  description = "Explicit host-scoped immutable /_nuxt/ asset cache eligibility only; never authenticated/private/API paths. No fabricated TTLs."
  validation {
    condition     = length(var.cache_rules) <= 20 && length(distinct([for rule in var.cache_rules : rule.ref])) == length(var.cache_rules)
    error_message = "At most 20 uniquely referenced cache rules are allowed."
  }
}

variable "create_turnstile" {
  type        = bool
  default     = false
  description = "Explicit optional isolated widget creation; runtime support and verification remain disabled until separately approved."
}
