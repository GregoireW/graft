// Run by test/unit/telemetry.test.ts in a child process, behind the real preload:
//   node --import tsx --import ./src/bin/otel.ts test/helpers/otel-auto-child.ts
// It exercises the automatic instrumentations (Fastify, undici, pg), then prints what it logged.
import { Writable } from "node:stream";
import Fastify from "fastify";
import pg from "pg";
import { createLogger } from "../../src/core/logger.js";
import { shutdownTelemetry } from "../../src/telemetry/index.js";

const lines: Record<string, unknown>[] = [];
const sink = new Writable({
  write(chunk, _enc, done) {
    for (const line of String(chunk).split("\n")) if (line) lines.push(JSON.parse(line));
    done();
  },
});
const log = createLogger({ logLevel: "info" }, sink);

// Nothing listens on port 1: each query fails fast, but pg still opens (and ends) a span.
async function query(): Promise<void> {
  const client = new pg.Client({ host: "127.0.0.1", port: 1, connectionTimeoutMillis: 500 });
  await client.connect().then(
    () => client.query("select title from changes where id = $1", ["secret"]),
    () => client.query("select 1").catch(() => undefined),
  );
  await client.end().catch(() => undefined);
}

const app = Fastify({ loggerInstance: log });
app.get("/healthz", async () => ({ status: "ok" }));
app.get("/changes/:id", async (req) => {
  req.log.info("handling a change");
  await query();
  // Outgoing fetch: a CLIENT span under this request.
  await fetch(`http://127.0.0.1:${port()}/healthz?token=secret`).then((r) => r.text());
  return { ok: true };
});
await app.listen({ host: "127.0.0.1", port: 0 });
const port = () => (app.server.address() as { port: number }).port;

// Outside any trace: neither the query nor the log line may carry a trace.
await query();
log.info("outside a request");

await fetch(`http://127.0.0.1:${port()}/changes/secret-repo?q=secret`).then((r) => r.text());
await fetch(`http://127.0.0.1:${port()}/healthz`).then((r) => r.text());

await app.close();
console.log(JSON.stringify({ lines }));
await shutdownTelemetry();
