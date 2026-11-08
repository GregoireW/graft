import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { traceFields } from "../../src/core/logger.js";
import {
  setRunningTelemetry,
  shutdownTelemetry,
  telemetryRunning,
} from "../../src/telemetry/index.js";
import { isAllowedAttribute, RedactingSpanExporter } from "../../src/telemetry/redact.js";
import { defaultServiceName, telemetrySettings } from "../../src/telemetry/settings.js";

const run = promisify(execFile);
const ARGV = ["/usr/local/bin/node", "/app/dist/bin/worker.js"];

describe("telemetry settings", () => {
  it("U-OTEL-1 off unless an OTLP endpoint is set, and the standard switches turn it off again", () => {
    expect(telemetrySettings({}, ARGV)).toEqual({ enabled: false });
    expect(telemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " }, ARGV)).toEqual({
      enabled: false,
    });
    expect(
      telemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" }, ARGV),
    ).toEqual({
      enabled: true,
      exporter: "otlp",
      protocol: "http/protobuf",
      serviceName: "graft-worker",
    });
    expect(
      telemetrySettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces" }, ARGV)
        .enabled,
    ).toBe(true);
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" };
    expect(telemetrySettings({ ...endpoint, OTEL_SDK_DISABLED: "true" }, ARGV)).toEqual({
      enabled: false,
    });
    expect(telemetrySettings({ ...endpoint, OTEL_TRACES_EXPORTER: "none" }, ARGV)).toEqual({
      enabled: false,
    });
  });

  it("U-OTEL-2 console needs no endpoint; protocols are read per signal first; bad values are reported", () => {
    expect(telemetrySettings({ OTEL_TRACES_EXPORTER: "console" }, ARGV)).toMatchObject({
      enabled: true,
      exporter: "console",
    });
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317" };
    expect(
      telemetrySettings(
        {
          ...endpoint,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc",
        },
        ARGV,
      ),
    ).toMatchObject({ enabled: true, protocol: "grpc" });
    expect(telemetrySettings({ ...endpoint, OTEL_TRACES_EXPORTER: "zipkin" }, ARGV)).toEqual({
      enabled: false,
      problem: "OTEL_TRACES_EXPORTER must be one of otlp, console or none",
    });
    expect(
      telemetrySettings({ ...endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "carrier-pigeon" }, ARGV),
    ).toEqual({
      enabled: false,
      problem: "OTEL_EXPORTER_OTLP_PROTOCOL must be one of http/protobuf, http/json or grpc",
    });
  });

  it("U-OTEL-3 the default service name comes from the entry script", () => {
    expect(defaultServiceName(["node", "dist/bin/server.js"])).toBe("graft-server");
    expect(defaultServiceName(["node", "/app/src/bin/worker.ts"])).toBe("graft-worker");
    expect(defaultServiceName(["node"])).toBe("graft");
  });
});

describe("span redaction", () => {
  it("U-OTEL-4 only allow-listed attributes, exception types and status codes reach the exporter", async () => {
    const memory = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: new RedactingSpanExporter(memory) })],
    });
    const span = provider.getTracer("test").startSpan("github.request", {
      attributes: {
        "url.full": "https://api.github.com/repos/acme/secret-repo/pulls/7",
        "url.path": "/repos/acme/secret-repo/pulls/7",
        "http.request.method": "GET",
        "http.response.status_code": 404,
        "graft.job.name": "intent.generate",
        "gen_ai.request.model": "claude-sonnet-5-5",
        "gen_ai.input.messages": "the diff",
        "db.query.text": "select * from changes where title = 'secret'",
      },
      links: [],
    });
    span.addLink({
      context: span.spanContext(),
      attributes: { "graft.delivery_id": "d-1", "vcs.ref.head.name": "feature/secret-branch" },
    });
    span.recordException(new Error("PR body: secret"));
    span.setStatus({ code: SpanStatusCode.ERROR, message: "raw response body" });
    span.end();
    await provider.forceFlush();

    const [out] = memory.getFinishedSpans();
    expect(out?.name).toBe("github.request");
    expect(out?.attributes).toEqual({
      "http.request.method": "GET",
      "http.response.status_code": 404,
      "graft.job.name": "intent.generate",
      "gen_ai.request.model": "claude-sonnet-5-5",
    });
    expect(out?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(out?.events.map((e) => [e.name, e.attributes])).toEqual([
      ["exception", { "exception.type": "Error" }],
    ]);
    expect(out?.links.map((l) => l.attributes)).toEqual([{ "graft.delivery_id": "d-1" }]);
    expect(out?.spanContext()).toEqual(span.spanContext());
    expect(JSON.stringify(out?.attributes)).not.toContain("secret");
    await provider.shutdown();
  });

  it("U-OTEL-5 the allow-list never admits content-bearing keys", () => {
    for (const key of [
      "url.full",
      "url.path",
      "url.query",
      "exception.message",
      "exception.stacktrace",
      "db.query.text",
      "db.statement",
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
      "http.request.header.authorization",
      "vcs.ref.head.name",
      "enduser.id",
    ]) {
      expect(isAllowedAttribute(key), key).toBe(false);
    }
  });
});

describe("telemetry shutdown", () => {
  afterEach(async () => {
    await shutdownTelemetry(10);
  });

  it("U-OTEL-6 shutdown is a no-op without an SDK, runs once, and never throws or hangs", async () => {
    expect(telemetryRunning()).toBe(false);
    await shutdownTelemetry();

    let calls = 0;
    setRunningTelemetry({
      shutdown: async () => {
        calls += 1;
        throw new Error("collector unreachable");
      },
    });
    await shutdownTelemetry();
    await shutdownTelemetry();
    expect(calls).toBe(1);
    expect(telemetryRunning()).toBe(false);

    setRunningTelemetry({ shutdown: () => new Promise<void>(() => {}) });
    const started = Date.now();
    await shutdownTelemetry(50);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("telemetry preload", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  function child(env: Record<string, string>, script = "test/helpers/otel-child.ts") {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("OTEL_")) base[k] = v;
    }
    return run(process.execPath, ["--import", "tsx", "--import", "./src/bin/otel.ts", script], {
      env: { ...base, ...env },
      timeout: 60000,
    });
  }

  /** A local OTLP/HTTP JSON receiver; returns the endpoint and every span it received. */
  async function receiver() {
    const bodies: OtlpBody[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += String(chunk);
      });
      req.on("end", () => {
        if (req.url === "/v1/traces") bodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const spans = () =>
      bodies.flatMap((b) =>
        b.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)),
      );
    return { endpoint: `http://127.0.0.1:${port}`, bodies, spans };
  }

  it("U-OTEL-7 with no endpoint the preload starts nothing and prints nothing", async () => {
    const { stdout, stderr } = await child({});
    expect(JSON.parse(stdout.trim())).toEqual({ running: false });
    expect(stderr).toBe("");
  });

  it("U-OTEL-8 with an endpoint, redacted spans reach the collector before the process exits", async () => {
    const { endpoint, bodies } = await receiver();
    const { stdout } = await child({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=test",
    });
    expect(JSON.parse(stdout.trim())).toEqual({ running: true });

    const sent = JSON.stringify(bodies);
    expect(sent).toContain("child.work");
    expect(sent).toContain("graft-otel-child");
    expect(sent).toContain("deployment.environment.name");
    expect(sent).toContain("graft.job.name");
    expect(sent).not.toContain("secret");
    expect(sent).not.toContain("url.full");
  });

  it("U-OTEL-9 Fastify, fetch and pg spans join one trace; probes and parentless queries are not traced", async () => {
    const { endpoint, bodies, spans: received } = await receiver();
    const { stdout } = await child(
      { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" },
      "test/helpers/otel-auto-child.ts",
    );
    const { lines } = JSON.parse(stdout.trim()) as { lines: Record<string, unknown>[] };
    const spans = received();

    // The request's SERVER span, named after the route, under the caller's fetch.
    const request = spans.find((s) => s.name === "GET /changes/:id");
    expect(request?.kind).toBe(2); // SERVER in OTLP's numbering
    const trace = spans.filter((s) => s.traceId === request?.traceId);
    const caller = trace.find((s) => s.spanId === request?.parentSpanId);
    expect(caller?.name).toBe("GET");
    expect(caller?.kind).toBe(3); // CLIENT

    // Inside the request: the query and the outgoing fetch, as children of the request span.
    const children = trace.filter((s) => s.parentSpanId === request?.spanId);
    expect(children.map((s) => s.name).sort()).toEqual([
      "GET",
      expect.stringMatching(/^pg\.query/),
    ]);

    // Only the request's own query is traced (requireParentSpan), and no probe has a span.
    expect(spans.filter((s) => s.name.startsWith("pg."))).toHaveLength(1);
    expect(spans.filter((s) => s.name.startsWith("GET /healthz"))).toHaveLength(0);
    expect(spans.filter((s) => s.kind === 2)).toHaveLength(1);

    // Paths, query strings and SQL never leave.
    const sent = JSON.stringify(bodies);
    expect(sent).not.toContain("secret");
    expect(sent).not.toContain("url.path");
    expect(sent).not.toContain("db.query.text");
    expect(sent).toContain('"http.route"');

    // Log lines in the request carry its trace; the line outside it does not.
    const handling = lines.find((l) => l.msg === "handling a change");
    expect(handling?.trace_id).toBe(request?.traceId);
    expect(handling?.span_id).toBe(request?.spanId);
    expect(handling?.trace_flags).toBe("01");
    expect(lines.find((l) => l.msg === "outside a request")).not.toHaveProperty("trace_id");
  });
});

describe("log correlation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("U-OTEL-10 traceFields is empty without an active span and names the active one", () => {
    expect(traceFields()).toEqual({});

    const span = new TracerProvider().getTracer("test").startSpan("work");
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);
    expect(traceFields()).toEqual({
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
      trace_flags: "01",
    });
    span.end();

    // An invalid (all-zero) context is never logged.
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(
      trace.wrapSpanContext({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
    );
    expect(traceFields()).toEqual({});
  });
});

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
}
interface OtlpBody {
  resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
}
