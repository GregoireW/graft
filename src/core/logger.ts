import { isSpanContextValid, trace } from "@opentelemetry/api";
import { type DestinationStream, type Logger, pino } from "pino";
import type { Config } from "../config/index.js";

export type { Logger };

export const REDACT_PATHS = [
  'req.headers["x-hub-signature-256"]',
  "req.headers.authorization",
  "*.privateKey",
  "*.webhookSecret",
  "*.githubAppPrivateKey",
  "*.githubWebhookSecret",
  "*.databaseUrl",
  "*.token",
  "*.anthropicApiKey",
  "*.anthropicAuthToken",
  "*.apiKey",
  "*.authToken",
  // Federation: everything but the rule ID, which is logged on purpose.
  "*.anthropicFederation",
  "*.federation",
  "*.organizationId",
  "*.serviceAccountId",
  "*.identityTokenFile",
  "*.identityToken",
  "*.assertion",
  "*.access_token",
  'req.headers["x-api-key"]',
];

/**
 * The active span's ids on every log line, so a log shipper can link a line to its trace.
 * Without telemetry there is never an active span and lines stay as they were.
 */
export function traceFields(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (span === undefined) return {};
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return {};
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    trace_flags: `0${ctx.traceFlags.toString(16)}`.slice(-2),
  };
}

export function createLogger(
  config: Pick<Config, "logLevel">,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      mixin: traceFields,
    },
    destination,
  );
}
