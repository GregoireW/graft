import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it } from "vitest";
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

  function child(env: Record<string, string>) {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("OTEL_")) base[k] = v;
    }
    return run(
      process.execPath,
      ["--import", "tsx", "--import", "./src/bin/otel.ts", "test/helpers/otel-child.ts"],
      { env: { ...base, ...env }, timeout: 60000 },
    );
  }

  it("U-OTEL-7 with no endpoint the preload starts nothing and prints nothing", async () => {
    const { stdout, stderr } = await child({});
    expect(JSON.parse(stdout.trim())).toEqual({ running: false });
    expect(stderr).toBe("");
  });

  it("U-OTEL-8 with an endpoint, redacted spans reach the collector before the process exits", async () => {
    const bodies: unknown[] = [];
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

    const { stdout } = await child({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
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
});
