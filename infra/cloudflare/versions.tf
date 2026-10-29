terraform {
  required_version = ">= 1.6.0, < 2.0.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.25.0"
    }
  }
  # Configure an isolated, access-controlled, encrypted endpoint and lock/unlock
  # endpoints via TF_HTTP_* at authorized init time. Never use a public state URL.
  # Turnstile's computed secret is sensitive but still lives in private state.
  backend "http" {}
}

# Credentials only through CLOUDFLARE_API_TOKEN in the approved execution context.
provider "cloudflare" {}
