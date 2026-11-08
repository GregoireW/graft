import { buildServer } from "../http/server.js";
import { shutdownTelemetry } from "../telemetry/index.js";
import { bootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  const deps = await bootstrap({ supervise: false, migrate: true });
  const app = await buildServer(deps);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    deps.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await deps.queue.stop();
      await deps.db.destroy();
      await shutdownTelemetry();
      process.exit(0);
    } catch (err) {
      deps.log.error({ err }, "error during shutdown");
      await shutdownTelemetry();
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: deps.config.host, port: deps.config.port });
}

main().catch(async (err: unknown) => {
  console.error(err);
  await shutdownTelemetry();
  process.exit(1);
});
