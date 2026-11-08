import { readFileSync } from "node:fs";
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
import { graftInstrumentations } from "./instrumentations.js";
import { RedactingSpanExporter, redactingAttributesProcessor } from "./redact.js";
import type { MetricsSettings, OtlpProtocol, TelemetrySettings } from "./settings.js";

type Enabled = Extract<TelemetrySettings, { enabled: true }>;

/** Loaded only when telemetry is on, so the SDK and its exporters cost nothing otherwise. */
export async function startTelemetry(settings: Enabled): Promise<void> {
  const exporter =
    settings.exporter === "console"
      ? new ConsoleSpanExporter()
      : await otlpTraceExporter(settings.protocol);

  const sdk = new NodeSDK({
    // Lowest priority: OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES (the env detector) win.
    resource: defaultResource().merge(
      resourceFromAttributes({
        "service.name": settings.serviceName,
        ...(version() ? { "service.version": version() } : {}),
      }),
    ),
    spanProcessors: [new BatchSpanProcessor({ exporter: new RedactingSpanExporter(exporter) })],
    metricReaders: settings.metrics ? [await metricReader(settings.metrics)] : [],
    // Every metric, Graft's and the instrumentations', through the same allow-list as spans.
    views: [{ instrumentName: "*", attributesProcessors: [redactingAttributesProcessor] }],
    // Logs stay JSON on stdout, where a log shipper already reads them.
    logRecordProcessors: [],
    instrumentations: graftInstrumentations(),
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

async function otlpMetricExporter(protocol: OtlpProtocol): Promise<PushMetricExporter> {
  switch (protocol) {
    case "grpc": {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");
      return new OTLPMetricExporter();
    }
    case "http/json": {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
      return new OTLPMetricExporter();
    }
    case "http/protobuf": {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto");
      return new OTLPMetricExporter();
    }
  }
}

/** Each exporter reads OTEL_EXPORTER_OTLP_* (endpoint, headers, timeout, compression) itself. */
async function otlpTraceExporter(protocol: OtlpProtocol): Promise<SpanExporter> {
  switch (protocol) {
    case "grpc": {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
      return new OTLPTraceExporter();
    }
    case "http/json": {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
      return new OTLPTraceExporter();
    }
    case "http/protobuf": {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
      return new OTLPTraceExporter();
    }
  }
}

let cachedVersion: string | null | undefined;

/** The `version` of the package.json next to `dist/` (copied into the image by the Dockerfile). */
function version(): string | undefined {
  if (cachedVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      cachedVersion = typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      cachedVersion = null;
    }
  }
  return cachedVersion ?? undefined;
}
