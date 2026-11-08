// Run by test/unit/telemetry.test.ts in a child process, behind the real preload:
//   node --import tsx --import ./src/bin/otel.ts test/helpers/otel-child.ts
// It ends one span carrying data that must not leave Graft, prints whether the SDK runs, flushes.
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { shutdownTelemetry, telemetryRunning } from "../../src/telemetry/index.js";
import { recordJobRun } from "../../src/telemetry/metrics.js";

const span = trace.getTracer("otel-child").startSpan("child.work", {
  attributes: {
    "url.full": "https://api.github.com/repos/acme/secret-repo/pulls/7",
    "http.request.method": "GET",
    "graft.job.name": "intent.generate",
  },
});
span.recordException(new Error("diff --git a/secret.txt"));
span.setStatus({ code: SpanStatusCode.ERROR, message: "PR title: secret plans" });
span.end();

// A metric, plus an attribute no allow-list admits.
recordJobRun("intent.generate", "completed", 0.5);
metrics.getMeter("otel-child").createCounter("child.requests").add(1, {
  "url.full": "https://api.github.com/repos/acme/secret-repo",
  "http.request.method": "GET",
});

console.log(JSON.stringify({ running: telemetryRunning() }));
await shutdownTelemetry();
