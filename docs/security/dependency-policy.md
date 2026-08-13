# Dependency and build supply-chain policy

The lockfile is mandatory and CI installs it with `npm ci`. Pull requests fail on high or critical npm advisories, secret findings, or high/critical container findings. Production dependencies are also scanned in the built image, because a source-only audit does not cover the base operating system.

Install scripts are allowlisted by exact package version in `package.json`. The current entries were reviewed for these purposes:

- `esbuild`: installs and validates its platform binary.
- `unrs-resolver`: installs its platform-specific native resolver.
- `vue-demi`: selects the installed Vue compatibility target.

Updates must refresh the lockfile, rerun `npm audit`, review any changed lifecycle scripts, and update the pinned allowlist deliberately. GitHub Actions are pinned to immutable commit SHAs; Dependabot may propose newer tags, but the resulting SHA change remains reviewable.

Every CI run publishes application and container SBOM evidence. The container scan blocks high or critical fixed vulnerabilities; ignored/unfixed findings require a dated risk decision before release, never a silent rule change.
