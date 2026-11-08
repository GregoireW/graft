import { basename, extname } from "node:path";

/**
 * Whether and how to start OpenTelemetry, from the standard `OTEL_*` variables only.
 *
 * Telemetry is off unless an OTLP endpoint is set (or `OTEL_TRACES_EXPORTER=console`, for local
 * debugging). `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` turn it off again; metrics
 * come with traces unless `OTEL_METRICS_EXPORTER=none`. Everything else the OTLP exporters read
 * themselves: headers, timeout, compression, certificates.
 */
export type TelemetrySettings =
  | {
      enabled: true;
      exporter: "otlp" | "console";
      protocol: OtlpProtocol;
      /** Default `service.name`; `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` override it. */
      serviceName: string;
      /** Null when metrics are off (`OTEL_METRICS_EXPORTER=none`, or OTLP without an endpoint). */
      metrics: MetricsSettings | null;
    }
  | {
      enabled: false;
      /** Set when the variables are wrong, not when telemetry is simply not configured. */
      problem?: string;
    };

export type OtlpProtocol = "http/protobuf" | "http/json" | "grpc";

export interface MetricsSettings {
  exporter: "otlp" | "console";
  protocol: OtlpProtocol;
  /** `OTEL_METRIC_EXPORT_INTERVAL`, default one minute. */
  intervalMs: number;
}

const DEFAULT_METRIC_INTERVAL_MS = 60_000;

const PROTOCOLS: readonly OtlpProtocol[] = ["http/protobuf", "http/json", "grpc"];

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

export function telemetrySettings(env: Env, argv: readonly string[]): TelemetrySettings {
  if (value(env, "OTEL_SDK_DISABLED")?.toLowerCase() === "true") return { enabled: false };

  const exporters = (value(env, "OTEL_TRACES_EXPORTER") ?? "otlp")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (exporters.includes("none")) return { enabled: false };
  if (exporters.length !== 1 || (exporters[0] !== "otlp" && exporters[0] !== "console")) {
    return {
      enabled: false,
      problem: "OTEL_TRACES_EXPORTER must be one of otlp, console or none",
    };
  }
  const exporter = exporters[0];

  if (
    exporter === "otlp" &&
    !value(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") &&
    !value(env, "OTEL_EXPORTER_OTLP_ENDPOINT")
  ) {
    return { enabled: false };
  }

  const protocol = (value(env, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL") ??
    value(env, "OTEL_EXPORTER_OTLP_PROTOCOL") ??
    "http/protobuf") as OtlpProtocol;
  if (!PROTOCOLS.includes(protocol)) {
    return {
      enabled: false,
      problem: "OTEL_EXPORTER_OTLP_PROTOCOL must be one of http/protobuf, http/json or grpc",
    };
  }

  const metrics = metricsSettings(env, exporter);
  if (typeof metrics === "string") return { enabled: false, problem: metrics };

  return { enabled: true, exporter, protocol, serviceName: defaultServiceName(argv), metrics };
}

/** Metrics follow the trace exporter unless `OTEL_METRICS_EXPORTER` says otherwise. */
function metricsSettings(
  env: Env,
  tracesExporter: "otlp" | "console",
): MetricsSettings | null | string {
  const named = value(env, "OTEL_METRICS_EXPORTER")?.toLowerCase();
  if (named === "none") return null;
  if (named !== undefined && named !== "otlp" && named !== "console") {
    return "OTEL_METRICS_EXPORTER must be one of otlp, console or none";
  }
  const exporter = named ?? tracesExporter;
  if (
    exporter === "otlp" &&
    !value(env, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") &&
    !value(env, "OTEL_EXPORTER_OTLP_ENDPOINT")
  ) {
    return null;
  }
  const protocol = (value(env, "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL") ??
    value(env, "OTEL_EXPORTER_OTLP_PROTOCOL") ??
    "http/protobuf") as OtlpProtocol;
  if (!PROTOCOLS.includes(protocol)) {
    return "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL must be one of http/protobuf, http/json or grpc";
  }
  const rawInterval = value(env, "OTEL_METRIC_EXPORT_INTERVAL");
  const intervalMs = rawInterval === undefined ? DEFAULT_METRIC_INTERVAL_MS : Number(rawInterval);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    return "OTEL_METRIC_EXPORT_INTERVAL must be a whole number of milliseconds, at least 1000";
  }
  return { exporter, protocol, intervalMs };
}

/** `graft-server` for `node dist/bin/server.js`, `graft-worker` for the worker. */
export function defaultServiceName(argv: readonly string[]): string {
  const script = argv[1];
  if (!script) return "graft";
  const name = basename(script, extname(script));
  return name ? `graft-${name}` : "graft";
}
