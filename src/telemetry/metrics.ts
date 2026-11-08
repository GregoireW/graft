import { type Attributes, type Meter, metrics, ValueType } from "@opentelemetry/api";

/**
 * Graft's own instruments. Without the SDK (telemetry off, or `OTEL_METRICS_EXPORTER=none`) the API
 * hands out no-op instruments. They are built on first use, after the preload has registered the
 * SDK's meter provider.
 *
 * Every attribute is a bounded set of metadata values (job names, outcomes, models, routes): never
 * a repository, a login or a PR number, which would multiply the series without end.
 */
const meter = (): Meter => metrics.getMeter("graft");

function lazy<T>(make: () => T): () => T {
  let made: T | undefined;
  return () => {
    made ??= make();
    return made;
  };
}

const instruments = lazy(() => {
  const m = meter();
  return {
    jobRuns: m.createCounter("graft.job.runs", {
      description: "Job runs, by job and outcome (completed, failed, failed_permanently).",
      unit: "{run}",
    }),
    jobDuration: m.createHistogram("graft.job.duration", {
      description: "How long a job run took, by job and outcome.",
      unit: "s",
      advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] },
    }),
    webhookDeliveries: m.createCounter("graft.webhook.deliveries", {
      description: "GitHub webhook deliveries, by event and outcome.",
      unit: "{delivery}",
    }),
    llmDuration: m.createHistogram("gen_ai.client.operation.duration", {
      description: "Model call duration.",
      unit: "s",
      advice: { explicitBucketBoundaries: [0.5, 1, 2.5, 5, 10, 20, 40, 60, 120, 240] },
    }),
    llmTokens: m.createHistogram("gen_ai.client.token.usage", {
      description: "Tokens per model call, by token type (input, output).",
      unit: "{token}",
      valueType: ValueType.INT,
      advice: {
        explicitBucketBoundaries: [1, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304],
      },
    }),
    llmCacheTokens: m.createCounter("graft.llm.cache_tokens", {
      description: "Prompt-cache tokens, by type (read, write), provider and model.",
      unit: "{token}",
      valueType: ValueType.INT,
    }),
    cards: m.createCounter("graft.intent.cards", {
      description: "Intent cards generated, by status, risk and verifier status.",
      unit: "{card}",
    }),
    cardCost: m.createCounter("graft.intent.cost", {
      description:
        "What the model calls of intent cards cost, in USD, priced like the spend ledger.",
      unit: "USD",
      valueType: ValueType.DOUBLE,
    }),
    outcomes: m.createCounter("graft.outcomes", {
      description: "What intent and policy runs ended with (published, stale, skipped...).",
      unit: "{run}",
    }),
    githubRequests: m.createCounter("graft.github.requests", {
      description: "GitHub API requests, by method, route and status.",
      unit: "{request}",
    }),
    githubRateLimit: m.createGauge("graft.github.rate_limit.remaining", {
      description: "Requests left in the GitHub rate-limit window, as of the last response.",
      unit: "{request}",
      valueType: ValueType.INT,
    }),
  };
});

export function recordJobRun(name: string, outcome: string, seconds: number): void {
  const attrs = { "graft.job.name": name, "graft.job.outcome": outcome };
  instruments().jobRuns.add(1, attrs);
  instruments().jobDuration.record(seconds, attrs);
}

const EVENT_NAME = /^[a-z_]{1,40}$/;

/**
 * One webhook delivery. `event` is null before the signature is verified: until then the header is
 * anybody's, and its values are unbounded.
 */
export function recordWebhookDelivery(event: string | null, outcome: string): void {
  instruments().webhookDeliveries.add(1, {
    "graft.webhook.event": event === null ? "unverified" : EVENT_NAME.test(event) ? event : "other",
    "graft.webhook.outcome": outcome,
  });
}

export function recordLlmCall(
  base: Attributes,
  o: {
    seconds: number;
    failure: string | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
  },
): void {
  const i = instruments();
  i.llmDuration.record(o.seconds, o.failure ? { ...base, "error.type": o.failure } : base);
  if (o.usage.inputTokens > 0) {
    i.llmTokens.record(o.usage.inputTokens, { ...base, "gen_ai.token.type": "input" });
  }
  if (o.usage.outputTokens > 0) {
    i.llmTokens.record(o.usage.outputTokens, { ...base, "gen_ai.token.type": "output" });
  }
  if (o.usage.cacheReadTokens > 0) {
    i.llmCacheTokens.add(o.usage.cacheReadTokens, { ...base, "graft.llm.cache": "read" });
  }
  if (o.usage.cacheWriteTokens > 0) {
    i.llmCacheTokens.add(o.usage.cacheWriteTokens, { ...base, "graft.llm.cache": "write" });
  }
}

export function recordCard(attrs: Attributes, costUsd: number | null | undefined): void {
  instruments().cards.add(1, attrs);
  if (typeof costUsd === "number" && costUsd > 0) {
    instruments().cardCost.add(costUsd, { "graft.card.status": attrs["graft.card.status"] });
  }
}

export function recordOutcome(job: string, outcome: string): void {
  instruments().outcomes.add(1, { "graft.job.name": job, "graft.outcome": outcome });
}

export function recordGitHubRequest(
  method: string,
  route: string,
  status: number | null,
  rateLimit: { remaining: number; installationId: number | null } | null,
): void {
  instruments().githubRequests.add(1, {
    "http.request.method": method,
    "graft.github.route": route,
    ...(status !== null ? { "http.response.status_code": status } : {}),
  });
  if (rateLimit) {
    instruments().githubRateLimit.record(
      rateLimit.remaining,
      rateLimit.installationId === null
        ? { "graft.github.auth": "app" }
        : {
            "graft.github.auth": "installation",
            "graft.github.installation_id": rateLimit.installationId,
          },
    );
  }
}

/** Jobs waiting and running per queue, read from pg-boss at each export. Worker only. */
export function observeQueueDepth(
  getQueues: () => Promise<
    { name: string; readyCount: number; deferredCount: number; activeCount: number }[]
  >,
): void {
  const gauge = meter().createObservableGauge("graft.queue.jobs", {
    description: "Jobs in pg-boss per queue and state (ready, deferred, active).",
    unit: "{job}",
    valueType: ValueType.INT,
  });
  gauge.addCallback(async (result) => {
    let queues: Awaited<ReturnType<typeof getQueues>>;
    try {
      queues = await getQueues();
    } catch {
      return; // The database is away: no point this time, the next export tries again.
    }
    for (const q of queues) {
      const at = (state: string) => ({
        "messaging.destination.name": q.name,
        "graft.queue.state": state,
      });
      result.observe(q.readyCount, at("ready"));
      result.observe(q.deferredCount, at("deferred"));
      result.observe(q.activeCount, at("active"));
    }
  });
}
