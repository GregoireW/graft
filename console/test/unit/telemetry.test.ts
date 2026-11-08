import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { traceFields } from "../../server/src/telemetry/log.js";
import { isTracedPath } from "../../server/src/telemetry/sdk.js";

const run = promisify(execFile);

function child(env: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("OTEL_")) base[k] = v;
  }
  return run(
    process.execPath,
    ["--import", "tsx", "--import", "./server/src/otel.ts", "test/helpers/otel-child.ts"],
    { env: { ...base, ...env }, timeout: 60000 },
  );
}

describe("console telemetry", () => {
  let server: Server | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("traces the API and sign-in, not the probes or the web app's files", () => {
    expect(isTracedPath("/api/changes?cursor=x")).toBe(true);
    expect(isTracedPath("/auth/callback?code=x&state=y")).toBe(true);
    expect(isTracedPath("/readyz")).toBe(false);
    expect(isTracedPath("/healthz")).toBe(false);
    expect(isTracedPath("/assets/app-1234.js")).toBe(false);
    expect(isTracedPath("/")).toBe(false);
  });

  it("puts the active span's ids on log lines, and nothing without one", () => {
    expect(traceFields()).toEqual({});
    const span = new TracerProvider().getTracer("test").startSpan("work");
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);
    expect(traceFields()).toEqual({
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
      trace_flags: "01",
    });
    span.end();
  });

  it("starts nothing and prints nothing without an endpoint", async () => {
    const { stdout, stderr } = await child({});
    expect(JSON.parse(stdout.trim())).toEqual({ running: false });
    expect(stderr).toBe("");
  });

  it("with an endpoint, exports as graft-console, through the allow-list", async () => {
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
      OTEL_METRICS_EXPORTER: "none",
    });
    expect(JSON.parse(stdout.trim())).toEqual({ running: true });
    const sent = JSON.stringify(bodies);
    expect(sent).toContain("graft-console");
    expect(sent).toContain("server.address");
    expect(sent).not.toContain("secret");
    expect(sent).not.toContain("url.full");
  });
});
