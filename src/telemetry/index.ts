/**
 * The running OpenTelemetry SDK, if any. `src/bin/otel.ts` starts it before the app loads (through
 * `node --import`); the entry points call `shutdownTelemetry()` on their way out so the last spans
 * are exported before `process.exit`. Without the preload, or with telemetry off, every call here
 * is a no-op and no SDK code is loaded.
 */

interface Running {
  shutdown(): Promise<void>;
}

let running: Running | undefined;

export function setRunningTelemetry(sdk: Running): void {
  running = sdk;
}

export function telemetryRunning(): boolean {
  return running !== undefined;
}

/**
 * Flushes and stops the SDK, waiting at most `timeoutMs`. Never throws: an unreachable collector
 * must not turn a clean shutdown into a failed one.
 */
export async function shutdownTelemetry(timeoutMs = 5000): Promise<void> {
  const sdk = running;
  if (!sdk) return;
  running = undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([sdk.shutdown().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
