/**
 * OpenTelemetry preload for the server and the worker:
 *
 *   node --import ./dist/bin/otel.js dist/bin/server.js
 *
 * It runs before the app is imported, which instrumentations need. With no OTLP endpoint set it
 * only reads the environment and returns. It never stops the process: if telemetry cannot start,
 * Graft runs without it and says so once on stderr (the logger does not exist yet).
 */
import { telemetrySettings } from "../telemetry/settings.js";
import { loadDotEnv } from "./env.js";

try {
  // The entry point loads .env too; doing it here as well lets .env turn telemetry on in dev.
  loadDotEnv();
  const settings = telemetrySettings(process.env, process.argv);
  if (settings.enabled) {
    const { startTelemetry } = await import("../telemetry/sdk.js");
    await startTelemetry(settings);
  } else if (settings.problem) {
    console.error(`telemetry off: ${settings.problem}`);
  }
} catch (err) {
  const reason = err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : "unknown";
  console.error(`telemetry off: could not start (${reason})`);
}
