/*
 * MIT License
 * Copyright (c) 2026 p0code
 * Ported from https://github.com/p0code/deploy-cloudflare (v0.3.0)
 */

/**
 * Redacts raw API tokens and Bearer headers so credentials never appear in errors,
 * action outputs, status banners, or diagnostic messages.
 */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const AUTH_HEADER_PATTERN =
  /(authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{6,}/gi;

export function redactSecrets(text: string, secrets: ReadonlyArray<string> = []): string {
  let sanitized = text
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(AUTH_HEADER_PATTERN, "$1[REDACTED]");
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 4) {
      sanitized = sanitized.split(trimmed).join("[REDACTED]");
    }
  }
  return sanitized;
}

export function safeErrorMessage(cause: unknown, secrets: ReadonlyArray<string> = []): string {
  if (typeof cause === "string") {
    return redactSecrets(cause, secrets);
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return redactSecrets(cause.message, secrets);
  }
  return redactSecrets(String(cause), secrets);
}
