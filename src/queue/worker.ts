import { SpanKind } from "@opentelemetry/api";
import type { JobWithMetadata } from "pg-boss";
import type { JobContext } from "../core/context.js";
import { observeQueueDepth, recordJobRun } from "../telemetry/metrics.js";
import { contextFromCarrier, markError, takeTraceCarrier, withSpan } from "../telemetry/tracing.js";
import type { Registry } from "../webhooks/registry.js";
import { PermanentJobError, sanitizeError } from "./errors.js";
import type { PgBossJobQueue } from "./queue.js";

export async function startWorker(
  queue: PgBossJobQueue,
  registry: Pick<Registry, "jobs">,
  ctx: JobContext,
  opts: { concurrency: number; pollingIntervalSeconds?: number },
): Promise<void> {
  observeQueueDepth(() => queue.boss.getQueues());
  for (const job of registry.jobs) {
    await queue.boss.work(
      job.name,
      {
        localConcurrency: opts.concurrency,
        batchSize: 1,
        // The job's own `retryLimit`: pg-boss copies it onto the job when it is inserted, so a job
        // queued before a deploy that changed the definition keeps the old one (step 3 review 2,
        // nit 4).
        includeMetadata: true,
        // Tests lower the idle poll (pg-boss minimum 0.5 s); production keeps the default.
        ...(opts.pollingIntervalSeconds
          ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
          : {}),
      },
      async (jobs: JobWithMetadata<object>[]) => {
        for (const j of jobs) {
          const log = ctx.log.child({ job: job.name, jobId: j.id });
          // The sender's trace context, if it had one: the job continues that trace.
          const { carrier, data: raw } = takeTraceCarrier(j.data);
          await withSpan(
            `job ${job.name}`,
            {
              kind: SpanKind.CONSUMER,
              parent: contextFromCarrier(carrier),
              attributes: {
                "messaging.system": "pg-boss",
                "messaging.operation.type": "process",
                "messaging.destination.name": job.name,
                "messaging.message.id": j.id,
                "graft.job.name": job.name,
                "graft.job.retry_count": j.retryCount,
              },
            },
            async (span) => {
              const startedAt = performance.now();
              let outcome = "failed";
              try {
                const data = job.schema.parse(raw);
                await job.handle(data, {
                  ...ctx,
                  log,
                  attempt: { retryCount: j.retryCount, retryLimit: j.retryLimit },
                });
                outcome = "completed";
                span.setAttribute("graft.job.outcome", outcome);
              } catch (thrown) {
                // Octokit/SDK errors carry request and response bodies (possibly model output), and
                // both pino and pg-boss serialize them: only the sanitized error leaves this block.
                const err = sanitizeError(thrown);
                if (thrown instanceof PermanentJobError) {
                  // Retrying cannot help: log and return so pg-boss completes the job.
                  outcome = "failed_permanently";
                  span.setAttributes({
                    "graft.job.outcome": outcome,
                    "graft.job.failure_reason": thrown.reason,
                  });
                  markError(span, thrown);
                  log.error(
                    { err, permanent: true, reason: thrown.reason },
                    "job failed permanently",
                  );
                  return;
                }
                // Rethrow: pg-boss fails the job and retries per the queue's options.
                span.setAttribute("graft.job.outcome", "failed");
                markError(span, thrown);
                log.error({ err }, "job failed");
                throw err;
              } finally {
                recordJobRun(job.name, outcome, (performance.now() - startedAt) / 1000);
              }
            },
          );
        }
      },
    );
  }
}
