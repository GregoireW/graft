import { readFileSync } from "node:fs";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { setRunningTelemetry } from "./index.js";
import { graftInstrumentations } from "./instrumentations.js";
import { RedactingSpanExporter } from "./redact.js";
import type { OtlpProtocol, TelemetrySettings } from "./settings.js";

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
    // Traces only for now. Metrics come with Graft's own instruments; logs already reach stdout.
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations: graftInstrumentations(),
  });
  sdk.start();
  setRunningTelemetry(sdk);
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
