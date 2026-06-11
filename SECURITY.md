# Security Policy

This plugin reads your Claude OAuth **access token** to query a usage endpoint. Its
security posture (opaque token holder, frozen endpoint URL, allowlist cache validation,
allowlist debug logging, fail-open error handling) is documented in the
[Threat model & security](./README.md#threat-model--security) section of the README and
enforced by the test suite.

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems — especially anything that
could leak the OAuth token.

Instead, use [GitHub private vulnerability reporting](https://github.com/Vrakoss/claude-usage-guard/security/advisories/new)
on this repository.

You can expect an initial response within 7 days. If the report is confirmed, a fix will
be released as soon as practical and credited to you (unless you prefer otherwise).

## Scope notes

- The guard **fails open** by design. "The guard did not block me" is expected behavior
  under any error condition and is not a vulnerability.
- The usage endpoint is undocumented and may change; breakage is not a vulnerability.
- The local cache lives in `~/.claude/`, the same directory as the credentials file.
  Its integrity is therefore bounded by filesystem trust in that directory: a local
  process that can tamper with the cache could already read the credentials, which is
  strictly worse. Cache-tampering reports without a stronger primitive are out of scope.
- Reports about the token leaking into output, cache, logs, error messages, or being sent
  to any host other than the hardcoded `api.anthropic.com` endpoint are **always** in
  scope and taken seriously.
