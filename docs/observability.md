# Observability (OpenTelemetry)

[Docs index](README.md) · [Configuration](configuration.md) · [Deploying](deploy/README.md)

The server and the worker can send traces to any OpenTelemetry collector or OTLP backend (an OpenTelemetry Collector, OpenObserve, Grafana Tempo, Jaeger, Honeycomb and others). It is off by default. One variable turns it on:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

!!! note "Work in progress"
    Requests, outgoing calls and database queries are traced. Spans for Graft's own work (jobs, intent and policy stages, model calls with their token counts) and metrics come in the next releases.

## What is traced

| Source | Span | Notes |
| --- | --- | --- |
| Incoming HTTP (Fastify) | `POST /webhooks/github`, `GET /mcp`... one SERVER span per request, named after the route | `/healthz` and `/readyz` are not traced. A `traceparent` header on the request is honoured, so a caller's trace continues into Graft. |
| Outgoing HTTP (`fetch`) | `GET`, `POST`... one CLIENT span per call | GitHub (Octokit) and the model providers' APIs. The span keeps the host, method and status, never the path or query. A call that never connects (DNS failure, connection refused) has no span. |
| Postgres (`pg`) | `pg.query:SELECT graft`... | Only inside another span: the queue's polling outside any trace is not recorded. Without the query text. |

On the worker, jobs are not spans yet, so its GitHub and model calls each start a trace of their own and its queries are not recorded.

## Logs and traces

While a span is active, every log line carries its ids, so a log backend can link a line to its trace:

```json
{"level":30,"msg":"...","trace_id":"e974af16fd2f4a98e4f359e1f991e9c0","span_id":"9ec7d28cb20f33eb","trace_flags":"01"}
```

Without telemetry the lines are unchanged.

## How it is loaded

Instrumentation has to start before the app's modules load, so the processes run with a preload:

```sh
node --import ./dist/bin/otel.js dist/bin/server.js
node --import ./dist/bin/otel.js dist/bin/worker.js
```

The image's default command, `compose.coolify.yaml`, `deploy/fly.toml.example` and `pnpm start:*` / `pnpm dev:*` already do this. Without an endpoint the preload only reads the environment: no OpenTelemetry SDK code is loaded. A process started without `--import` (an older custom command, for example) simply has no telemetry. `migrate`, `graft` and `eval` are never instrumented.

Telemetry never stops Graft. If the SDK cannot start, the process logs one `telemetry off: ...` line on stderr and runs without it; an unreachable collector delays a shutdown by at most 5 seconds.

## Variables

Graft reads the standard [OpenTelemetry variables](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/). There are no Graft-specific ones.

| Variable | Default | Use |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (telemetry off) | Base URL of the collector. For HTTP, `/v1/traces` is appended: `http://otel-collector:4318`. For gRPC, `http://otel-collector:4317`. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (the full URL) also works. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `http/protobuf`, `http/json` or `grpc`. `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` wins over it. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Headers for every export, as `key=value` pairs separated by commas, for example `Authorization=Basic%20...,stream-name=graft` (values URL-encoded). Treat it as a secret. |
| `OTEL_SERVICE_NAME` | `graft-server` or `graft-worker` | Taken from the entry script when unset. |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Extra resource attributes, for example `deployment.environment.name=production`. `service.version` is Graft's version. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_always_on` | Keep every trace by default. `parentbased_traceidratio` with `0.1` keeps one in ten. |
| `OTEL_TRACES_EXPORTER` | `otlp` | `console` prints spans on stdout instead (no endpoint needed), `none` turns telemetry off. |
| `OTEL_SDK_DISABLED` | `false` | `true` turns telemetry off even with an endpoint set. |
| `OTEL_LOG_LEVEL` | unset | The SDK's own diagnostics on stderr, for example `info` while a collector does not receive anything. |

Timeouts, compression and certificates use the exporter's own `OTEL_EXPORTER_OTLP_*` variables. Only traces are exported for now: Graft's logs stay JSON on stdout, where a log shipper already reads them.

## What leaves Graft

The [architecture contracts](architecture.md#llm-contract-step-3) hold for telemetry too: no prompt, diff, PR title or body, issue text, model output, login or branch name. Graft's own spans carry metadata only (ids, numbers, SHAs, models, durations, outcomes), and every span goes through a filter before the exporter:

- Only attributes on an allow-list (`src/telemetry/redact.ts`) are exported: HTTP method, status and route, server address, error and exception types, database system and operation, queue names, model names and token counts, and Graft's own `graft.*` attributes. Full URLs (which hold owner and repository names), query text, exception messages and stack traces are dropped.
- A span's status keeps its code and loses its message.

The resource attributes (service, version, host and process) are sent as they are.

## With a collector on Docker

On the same Docker network as the collector, point Graft at the collector's service name:

```yaml
environment:
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
```

The collector needs an `otlp` receiver and a `traces` pipeline. Sending straight to a backend works too: set its OTLP URL as the endpoint and its credentials in `OTEL_EXPORTER_OTLP_HEADERS`. A collector gives you retries and a disk queue when the backend is down; the SDK only buffers in memory.
