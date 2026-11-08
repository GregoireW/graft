// Run by test/unit/telemetry.test.ts in a child process, behind the console's preload:
//   node --import tsx --import ./server/src/otel.ts test/helpers/otel-child.ts
// It makes one fetch carrying a query string that must not leave, then flushes.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { shutdownTelemetry, telemetryRunning } from "../../server/src/telemetry/index.js";

const upstream = createServer((_req, res) => res.end("ok"));
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const { port } = upstream.address() as AddressInfo;
await fetch(`http://127.0.0.1:${port}/login/oauth/access_token?code=secret`).then((r) => r.text());
upstream.close();

console.log(JSON.stringify({ running: telemetryRunning() }));
await shutdownTelemetry();
