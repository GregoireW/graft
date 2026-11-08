/**
 * OpenTelemetry preload for the console:
 *
 *   node --import ./dist/otel.js dist/server.js
 *
 * Built as its own entry, with the SDK in a separate chunk: with no OTLP endpoint set it only reads
 * the environment and loads no OpenTelemetry code. It never stops the console: if telemetry cannot
 * start, the console runs without it and says so once on stderr.
 */
import { telemetrySettings } from "./telemetry/settings.js";

declare const __CONSOLE_VERSION__: string;
const VERSION = typeof __CONSOLE_VERSION__ === "string" ? __CONSOLE_VERSION__ : "dev";

try {
  const settings = telemetrySettings(process.env, process.argv);
  if (settings.enabled) {
    const { startTelemetry } = await import("./telemetry/sdk.js");
    await startTelemetry(settings, VERSION);
  } else if (settings.problem) {
    console.error(`telemetry off: ${settings.problem}`);
  }
} catch (err) {
  const reason = err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : "unknown";
  console.error(`telemetry off: could not start (${reason})`);
}
