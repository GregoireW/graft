# Observability (OpenTelemetry)

[Docs index](README.md) · [Configuration](configuration.md) · [Deploying](deploy/README.md)

The server and the worker can send traces and metrics to any OpenTelemetry collector or OTLP backend (an OpenTelemetry Collector, OpenObserve, Grafana Tempo, Jaeger, Honeycomb and others). It is off by default. One variable turns it on:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

## What is traced

| Source | Span | Notes |
| --- | --- | --- |
| Incoming HTTP (Fastify) | `POST /webhooks/github`, `GET /mcp`... one SERVER span per request, named after the route | `/healthz` and `/readyz` are not traced. A `traceparent` header on the request is honoured, so a caller's trace continues into Graft. |
| Outgoing HTTP (`fetch`) | `GET`, `POST`... one CLIENT span per call | GitHub (Octokit) and the model providers' APIs. The span keeps the host, method and status, never the path or query. A call that never connects (DNS failure, connection refused) has no span. |
| Postgres (`pg`) | `pg.query:SELECT graft`... | Only inside another span: the queue's polling outside any trace is not recorded. Without the query text. |
| Jobs (pg-boss) | `job intent.generate`, `job policy.evaluate`... one CONSUMER span per run | Continues the trace of whatever queued it (see below). `graft.job.outcome` is `completed`, `failed` (retried) or `failed_permanently` with `graft.job.failure_reason`; `graft.job.retry_count` counts retries. Intent and policy jobs add `graft.outcome` (`published`, `stale`, `skipped`...). |
| GitHub API (Octokit) | `github GET /repos/{owner}/{repo}/pulls/{pull_number}`... | Named by the route template, never by its values. `graft.github.rate_limit.remaining` is the rate-limit headroom after the call. The `fetch` span sits under it. |
| Model calls | `chat claude-sonnet-5-5`... one CLIENT span per call | [GenAI attributes](https://opentelemetry.io/docs/specs/semconv/gen-ai/): `gen_ai.provider.name`, the requested and the answering model, input, output and cache token counts, plus `graft.llm.purpose` (`writer`, `verifier`...) and `graft.llm.outcome` (`ok`, `rate_limited`, `refusal`...). Never the prompt or the answer. |
| Intent card | `intent.card` | The writer and verifier calls of one card: `graft.card.status`, `graft.card.risk`, `graft.card.verifier`, `graft.card.calls` and `graft.card.cost_usd`. |
| Change lock | `change.lock` | The per-PR lock every writer of the Graft comment and check runs takes. `graft.lock.wait_ms` is the time spent waiting for it; the GitHub writes made under it are its children. |

### One trace per webhook

A job carries the trace context of the code that queued it, so a webhook and everything it causes form one trace: `POST /webhooks/github` → `job github.webhook` → `job intent.generate` → the GitHub reads, the model calls, `change.lock` and the comment write → `job policy.evaluate` → ... The context travels in the job's data under `_otel` (only the W3C `traceparent` and `tracestate`), and the worker removes it before the job reads its data. Cron jobs start a trace of their own.

## Metrics

Sent every minute (`OTEL_METRIC_EXPORT_INTERVAL`) to the same endpoint, at `/v1/metrics`. Every attribute is a bounded set of values: job names, outcomes, models, routes. Never a repository, a login or a PR number.

| Metric | Type | Attributes | What it tells |
| --- | --- | --- | --- |
| `graft.job.runs` | counter | `graft.job.name`, `graft.job.outcome` | Runs per job: `completed`, `failed` (pg-boss retries it) or `failed_permanently`. |
| `graft.job.duration` | histogram (s) | same | How long runs take. |
| `graft.queue.jobs` | gauge | `messaging.destination.name`, `graft.queue.state` | Jobs `ready`, `deferred` and `active` per queue, read from pg-boss at each export. Worker only. A growing `ready` count means the workers do not keep up. |
| `graft.webhook.deliveries` | counter | `graft.webhook.event`, `graft.webhook.outcome` | Deliveries by outcome (`queued`, `duplicate`, `invalid_signature`, `account_not_allowed`...). The event is `unverified` until the signature checks out. |
| `graft.outcomes` | counter | `graft.job.name`, `graft.outcome` | What intent and policy runs ended with (`published`, `stale`, `skipped`...). |
| `graft.intent.cards` | counter | `graft.card.status`, `graft.card.risk`, `graft.card.verifier`, `graft.card.failure_reason` | Cards generated, with their risk and the verifier's verdict. |
| `graft.intent.cost` | counter (USD) | `graft.card.status` | What the cards' model calls cost, priced like the spend ledger. |
| `gen_ai.client.operation.duration` | histogram (s) | `gen_ai.provider.name`, `gen_ai.request.model`, `graft.llm.purpose`, `error.type` | Model call latency, failures included. |
| `gen_ai.client.token.usage` | histogram | same, plus `gen_ai.token.type` (`input`, `output`) | Tokens per call. |
| `graft.llm.cache_tokens` | counter | same, plus `graft.llm.cache` (`read`, `write`) | Prompt-cache use. |
| `graft.github.requests` | counter | `http.request.method`, `graft.github.route`, `http.response.status_code` | GitHub API calls by route and status. |
| `graft.github.rate_limit.remaining` | gauge | `graft.github.auth`, `graft.github.installation_id` | Rate-limit headroom per installation, as of its last response. |

The instrumentations add their own: `http.client.request.duration` for `fetch`, and `db.client.operation.duration` and the connection pool's `db.client.connection.*` (by `idle` or `used` state) for Postgres. Metric attributes go through the same allow-list as span attributes.

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
| `OTEL_METRICS_EXPORTER` | as traces | `none` turns metrics off and keeps traces; `console` prints them on stdout. `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` override the shared endpoint and protocol. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Milliseconds between two metric exports, at least `1000`. |
| `OTEL_SDK_DISABLED` | `false` | `true` turns telemetry off even with an endpoint set. |
| `OTEL_LOG_LEVEL` | unset | The SDK's own diagnostics on stderr, for example `info` while a collector does not receive anything. |

Timeouts, compression and certificates use the exporter's own `OTEL_EXPORTER_OTLP_*` variables. Logs are not exported: they stay JSON on stdout, where a log shipper already reads them, with the trace ids on each line.

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

The collector needs an `otlp` receiver and a `traces` pipeline, plus a `metrics` pipeline for the metrics. Sending straight to a backend works too: set its OTLP URL as the endpoint and its credentials in `OTEL_EXPORTER_OTLP_HEADERS`. A collector gives you retries and a disk queue when the backend is down; the SDK only buffers in memory.
