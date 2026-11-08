import { FastifyOtelInstrumentation } from "@fastify/otel";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { setRunningTelemetry } from "./index.js";
import { RedactingSpanExporter, redactingAttributesProcessor } from "./redact.js";
import type { MetricsSettings, OtlpProtocol, TelemetrySettings } from "./settings.js";

type Enabled = Extract<TelemetrySettings, { enabled: true }>;

/** Only the console's API and sign-in are traced: not the probes, not the web app's files. */
export function isTracedPath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return path.startsWith("/api/") || path.startsWith("/auth/");
}

/**
 * The console's SDK: the same export pipeline and allow-list as Graft's (redact.ts and settings.ts
 * are copies of Graft's, kept identical by a test), with the console's requests, its read-only
 * queries and its calls to GitHub and to Graft. Loaded only when telemetry is on.
 */
export async function startTelemetry(settings: Enabled, version: string): Promise<void> {
  const exporter =
    settings.exporter === "console"
      ? new ConsoleSpanExporter()
      : await otlpTraceExporter(settings.protocol);
  const sdk = new NodeSDK({
    // Lowest priority: OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES (the env detector) win.
    resource: defaultResource().merge(
      resourceFromAttributes({ "service.name": "graft-console", "service.version": version }),
    ),
    spanProcessors: [new BatchSpanProcessor({ exporter: new RedactingSpanExporter(exporter) })],
    metricReaders: settings.metrics ? [await metricReader(settings.metrics)] : [],
    views: [{ instrumentName: "*", attributesProcessors: [redactingAttributesProcessor] }],
    logRecordProcessors: [],
    instrumentations: [
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: ({ url }) => !isTracedPath(url),
        instrumentHooks: false,
        instrumentHandler: false,
        requestHook: (span, request) => {
          const route = request.routeOptions.url;
          span.updateName(route ? `${request.method} ${route}` : request.method);
        },
      }),
      new UndiciInstrumentation(),
      new PgInstrumentation({ requireParentSpan: true, ignoreConnectSpans: true }),
    ],
  });
  sdk.start();
  setRunningTelemetry(sdk);
}

async function metricReader(m: MetricsSettings): Promise<PeriodicExportingMetricReader> {
  return new PeriodicExportingMetricReader({
    exporter:
      m.exporter === "console" ? new ConsoleMetricExporter() : await otlpMetricExporter(m.protocol),
    exportIntervalMillis: m.intervalMs,
    exportTimeoutMillis: Math.min(30_000, m.intervalMs),
  });
}

async function otlpTraceExporter(protocol: OtlpProtocol): Promise<SpanExporter> {
  switch (protocol) {
    case "grpc":
      return new (await import("@opentelemetry/exporter-trace-otlp-grpc")).OTLPTraceExporter();
    case "http/json":
      return new (await import("@opentelemetry/exporter-trace-otlp-http")).OTLPTraceExporter();
    case "http/protobuf":
      return new (await import("@opentelemetry/exporter-trace-otlp-proto")).OTLPTraceExporter();
  }
}

async function otlpMetricExporter(protocol: OtlpProtocol): Promise<PushMetricExporter> {
  switch (protocol) {
    case "grpc":
      return new (await import("@opentelemetry/exporter-metrics-otlp-grpc")).OTLPMetricExporter();
    case "http/json":
      return new (await import("@opentelemetry/exporter-metrics-otlp-http")).OTLPMetricExporter();
    case "http/protobuf":
      return new (await import("@opentelemetry/exporter-metrics-otlp-proto")).OTLPMetricExporter();
  }
}
