import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JobContext } from "../../src/core/context.js";
import { forToken } from "../../src/github/client-factory.js";
import { githubRoute, knownRouteWords, traceGitHub } from "../../src/github/tracing.js";
import { tracedLlm } from "../../src/llm/traced.js";
import { type LlmClient, type LlmRequest, ZERO_USAGE } from "../../src/llm/types.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import type { JobDefinition } from "../../src/queue/job.js";
import { createPgBossQueue } from "../../src/queue/queue.js";
import { startWorker } from "../../src/queue/worker.js";
import { RedactingSpanExporter } from "../../src/telemetry/redact.js";
import { TRACE_KEY, withSpan } from "../../src/telemetry/tracing.js";
import { createRegistry } from "../../src/webhooks/registry.js";
import { silentLog } from "../helpers/stubs.js";

// A real SDK in this process: spans go through the same redaction as in production.
const memory = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter: new RedactingSpanExporter(memory) })],
});

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
});
afterAll(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});
beforeEach(() => memory.reset());

const spans = () => memory.getFinishedSpans();
const named = (name: string): ReadableSpan => {
  const s = spans().find((x) => x.name === name);
  if (!s) throw new Error(`no span ${name}: ${spans().map((x) => x.name)}`);
  return s;
};

/** A queue over a stub pg-boss that keeps what was sent and the worker's handlers. */
function stubQueue(jobs: JobDefinition<unknown>[]) {
  const sent: { name: string; data: Record<string, unknown> }[] = [];
  const handlers = new Map<string, (jobs: object[]) => Promise<void>>();
  const boss = {
    on: vi.fn(),
    send: vi.fn(async (name: string, data: Record<string, unknown>) => {
      sent.push({ name, data });
      return "job-1";
    }),
    work: vi.fn(
      async (name: string, _opts: unknown, handler: (jobs: object[]) => Promise<void>) => {
        handlers.set(name, handler);
      },
    ),
  };
  const registry = createRegistry({ webhookHandlers: [], jobs });
  const queue = createPgBossQueue({
    connectionString: "postgres://x/y",
    schema: "pgboss",
    registry,
    log: silentLog,
    supervise: true,
    boss: boss as unknown as PgBoss,
  });
  return { queue, registry, sent, handlers };
}

const ctx = { log: silentLog } as unknown as JobContext;
const delivery = (id: string, data: object) => ({ id, data, retryCount: 0, retryLimit: 5 });

describe("jobs carry the trace", () => {
  it("U-OTEL-11 a job sent inside a span continues its trace; the carrier never reaches the schema", async () => {
    const received: unknown[] = [];
    const job: JobDefinition<{ prNumber: number }> = {
      name: "test.strict",
      // Strict: an unexpected `_otel` key would fail the parse.
      schema: z.object({ prNumber: z.number() }).strict(),
      async handle(data) {
        received.push(data);
      },
    };
    const { queue, registry, sent, handlers } = stubQueue([job as JobDefinition<unknown>]);
    await startWorker(queue, registry, ctx, { concurrency: 1 });

    // Outside any span: the data is sent as it is.
    await queue.send(job, { prNumber: 7 });
    expect(sent[0]?.data).toEqual({ prNumber: 7 });

    // Inside a span: the W3C trace context rides along.
    const sender = await withSpan("webhook", {}, async (span) => {
      await queue.send(job, { prNumber: 7 });
      return span.spanContext();
    });
    const carried = sent[1]?.data;
    expect(carried?.[TRACE_KEY]).toEqual({
      traceparent: `00-${sender.traceId}-${sender.spanId}-01`,
    });

    await handlers.get(job.name)?.([delivery("job-2", carried as object)]);
    expect(received).toEqual([{ prNumber: 7 }]);

    const span = named("job test.strict");
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.spanContext().traceId).toBe(sender.traceId);
    expect(span.parentSpanContext?.spanId).toBe(sender.spanId);
    expect(span.attributes).toMatchObject({
      "messaging.system": "pg-boss",
      "messaging.operation.type": "process",
      "messaging.destination.name": "test.strict",
      "messaging.message.id": "job-2",
      "graft.job.name": "test.strict",
      "graft.job.retry_count": 0,
      "graft.job.outcome": "completed",
    });
  });

  it("U-OTEL-12 a failing job records its outcome and its error type, never its message", async () => {
    class GitHubBoom extends Error {}
    let mode: "permanent" | "retry" = "permanent";
    const job: JobDefinition<{ n: number }> = {
      name: "test.fail",
      schema: z.object({ n: z.number() }),
      async handle() {
        if (mode === "permanent") throw new PermanentJobError("PR title: secret", "repo_mismatch");
        throw new GitHubBoom("response body: secret");
      },
    };
    const { queue, registry, handlers } = stubQueue([job as JobDefinition<unknown>]);
    await startWorker(queue, registry, ctx, { concurrency: 1 });
    const run = handlers.get(job.name);

    // Permanent: completed by pg-boss (no throw), the span says why.
    await run?.([delivery("p", { n: 1 })]);
    const permanent = named("job test.fail");
    expect(permanent.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(permanent.attributes).toMatchObject({
      "graft.job.outcome": "failed_permanently",
      "graft.job.failure_reason": "repo_mismatch",
      "error.type": "PermanentJobError",
    });

    // Retryable: rethrown for pg-boss; the span keeps the original type, not the sanitized copy's.
    memory.reset();
    mode = "retry";
    await expect(run?.([delivery("r", { n: 1 })])).rejects.toThrow();
    const failed = named("job test.fail");
    expect(failed.attributes).toMatchObject({
      "graft.job.outcome": "failed",
      "error.type": "GitHubBoom",
    });
    expect(failed.events.map((e) => e.attributes)).toEqual([{ "exception.type": "GitHubBoom" }]);
    expect(JSON.stringify(spans())).not.toContain("secret");
  });
});

describe("model calls", () => {
  const req: LlmRequest = {
    purpose: "writer",
    model: "claude-sonnet-5-5",
    system: "system prompt: secret",
    user: "diff: secret",
    outputSchema: {},
    maxOutputTokens: 4000,
    effort: "medium",
    timeoutMs: 1000,
  };

  it("U-OTEL-13 each call is a GenAI span with models and token counts; a failure is an error", async () => {
    const usage = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
    };
    let ok = true;
    const inner: LlmClient = {
      async complete() {
        return ok
          ? {
              ok: true,
              value: { goal: "secret" },
              usage,
              model: "claude-sonnet-5-5-20261001",
              durationMs: 5,
            }
          : {
              ok: false,
              failure: "rate_limited",
              usage: ZERO_USAGE,
              model: "claude-sonnet-5-5",
              durationMs: 1,
            };
      },
      costOf: () => 0.42,
    };
    const llm = tracedLlm(inner, { kind: "openai-compatible", id: "openrouter" });
    // Optional methods: kept when the client has them, absent otherwise.
    expect(llm.costOf?.(usage, "m")).toBe(0.42);
    expect(llm.capabilities).toBeUndefined();
    expect(llm.serverRefusalFallback).toBeUndefined();

    expect((await llm.complete(req)).ok).toBe(true);
    const span = named("chat claude-sonnet-5-5");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "claude-sonnet-5-5",
      "gen_ai.request.max_tokens": 4000,
      "gen_ai.response.model": "claude-sonnet-5-5-20261001",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 300,
      "gen_ai.usage.cache_read.input_tokens": 1000,
      "gen_ai.usage.cache_creation.input_tokens": 0,
      "graft.llm.purpose": "writer",
      "graft.llm.effort": "medium",
      "graft.llm.provider_id": "openrouter",
      "graft.llm.outcome": "ok",
    });

    memory.reset();
    ok = false;
    expect((await llm.complete(req)).ok).toBe(false);
    const failed = named("chat claude-sonnet-5-5");
    expect(failed.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(failed.attributes).toMatchObject({
      "graft.llm.outcome": "rate_limited",
      "error.type": "rate_limited",
    });
    expect(JSON.stringify(spans())).not.toContain("secret");
  });
});

describe("GitHub calls", () => {
  it("U-OTEL-14 a route keeps placeholders and GitHub's own words; every value is masked", () => {
    const words = knownRouteWords(forToken("t"));
    expect(githubRoute("/repos/{owner}/{repo}/pulls/{pull_number}", words)).toBe(
      "/repos/{owner}/{repo}/pulls/{pull_number}",
    );
    // A value written into the template: a revert branch, or any branch without a digit.
    expect(
      githubRoute(
        "/repos/{owner}/{repo}/git/refs/heads/graft-revert/0b6f1c2e-4d5a-4b7c-9e8f-1a2b3c4d5e6f",
        words,
      ),
    ).toBe("/repos/{owner}/{repo}/git/refs/{value}/{value}/{value}");
    expect(githubRoute("/repos/{owner}/{repo}/git/refs/heads/feature-secret", words)).toBe(
      "/repos/{owner}/{repo}/git/refs/{value}/{value}",
    );
    // Pagination hands over the absolute `next` URL, names included.
    expect(
      githubRoute("https://api.github.com/repos/acme/secret-repo/pulls?state=all&page=2", words),
    ).toBe("/repos/{value}/{value}/pulls");
    expect(
      githubRoute("/app/installations/{installation_id}/access_tokens{?per_page}", words),
    ).toBe("/app/installations/{installation_id}/access_tokens");
    expect(githubRoute("https://[broken/repos/acme", words)).toBe("{value}");
  });

  it("U-OTEL-15 each request is a span named by its route, with status and rate-limit headroom", async () => {
    const fetchStub = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/pulls/404")) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "4998" },
        });
      }
      return new Response(JSON.stringify({ number: 7, title: "secret plans" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
      });
    });
    const gh = forToken("t", {
      baseUrl: "https://api.github.test",
      fetch: fetchStub as typeof fetch,
    });
    traceGitHub(gh, { installationId: 42 });

    await gh.rest.pulls.get({ owner: "acme", repo: "secret-repo", pull_number: 7 });
    const ok = named("github GET /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(ok.kind).toBe(SpanKind.CLIENT);
    expect(ok.attributes).toEqual({
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "graft.github.route": "/repos/{owner}/{repo}/pulls/{pull_number}",
      "graft.github.installation_id": 42,
      "graft.github.rate_limit.remaining": 4999,
    });

    memory.reset();
    await expect(
      gh.rest.pulls.get({ owner: "acme", repo: "secret-repo", pull_number: 404 }),
    ).rejects.toThrow();
    const missing = named("github GET /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(missing.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(missing.attributes).toMatchObject({
      "http.response.status_code": 404,
      "graft.github.rate_limit.remaining": 4998,
    });
    expect(JSON.stringify(spans())).not.toMatch(/secret|acme/);
  });
});
