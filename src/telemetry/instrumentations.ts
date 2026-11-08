import { FastifyOtelInstrumentation } from "@fastify/otel";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

/** Probes that answer every few seconds and carry nothing worth a trace. */
export const UNTRACED_PATHS: readonly string[] = ["/healthz", "/readyz"];

export function isUntracedPath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return UNTRACED_PATHS.includes(path);
}

/**
 * The libraries Graft traces automatically. None of them needs an ESM loader hook:
 * Fastify and undici publish on diagnostics_channel, and pg is CommonJS (a require hook).
 * Every attribute they set still goes through the allow-list in redact.ts.
 */
export function graftInstrumentations(): Instrumentation[] {
  return [
    // Incoming HTTP: one SERVER span per request, named "<METHOD> <route>".
    new FastifyOtelInstrumentation({
      registerOnInitialization: true,
      ignorePaths: ({ url }) => isUntracedPath(url),
      // A span per hook and per handler would double every request span without telling more.
      instrumentHooks: false,
      instrumentHandler: false,
      requestHook: (span, request) => {
        const route = request.routeOptions.url;
        span.updateName(route ? `${request.method} ${route}` : request.method);
      },
    }),
    // Outgoing HTTP through fetch: GitHub (Octokit) and the model providers' SDKs.
    new UndiciInstrumentation(),
    // Postgres, only inside a trace: pg-boss polls every few seconds with no parent span,
    // and pool checkouts add a span per query without telling anything new.
    new PgInstrumentation({ requireParentSpan: true, ignoreConnectSpans: true }),
  ];
}
