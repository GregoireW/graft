import type { Attributes } from "@opentelemetry/api";
import type { IAttributesProcessor } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace";

/**
 * The last line of the "no prompt, diff, PR text, login or branch name leaves Graft" rule
 * (docs/architecture.md, LLM contract) for spans. Graft's own code keeps that data out of span
 * attributes in the first place; this wrapper makes sure nothing an instrumentation adds on its own
 * reaches the collector either:
 *
 * - span, event and link attributes are kept only when their key is on the allow-list below, so a
 *   new instrumentation's attributes are dropped until someone reviews and lists them (full URLs
 *   carry owner and repository names; exception messages and stack traces can carry anything);
 * - the span status keeps its code and loses its message, which is often a raw error message.
 *
 * Span names, timing, ids, links and the resource pass through unchanged.
 */

/** Keys kept as they are. */
const ALLOWED_KEYS = new Set<string>([
  // HTTP, both directions. Never url.full, url.path or url.query.
  "http.request.method",
  "http.request.method_original",
  "http.response.status_code",
  "http.route",
  "url.scheme",
  "server.address",
  "server.port",
  "network.protocol.name",
  "network.protocol.version",
  "network.peer.address",
  "network.peer.port",
  "user_agent.original",
  // Errors: the type only, never exception.message or exception.stacktrace.
  "error.type",
  "exception.type",
  // Databases, without the query text or parameters.
  "db.system",
  "db.system.name",
  "db.namespace",
  "db.operation.name",
  "db.collection.name",
  "db.response.status_code",
  "db.client.connection.state",
  // Queues.
  "messaging.system",
  "messaging.operation.name",
  "messaging.operation.type",
  "messaging.destination.name",
  "messaging.message.id",
  // Model calls: model, provider and usage. Never gen_ai.input.*, gen_ai.output.* or prompts.
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.request.max_tokens",
  "gen_ai.response.model",
  "gen_ai.response.finish_reasons",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens",
  "gen_ai.token.type",
]);

/** Prefixes kept as they are: Graft's own attributes, which Graft code writes and reviews. */
const ALLOWED_PREFIXES = ["graft."];

export function isAllowedAttribute(key: string): boolean {
  return ALLOWED_KEYS.has(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

export function redactAttributes(attributes: Attributes): Attributes {
  const kept: Attributes = {};
  for (const [key, val] of Object.entries(attributes)) {
    if (isAllowedAttribute(key)) kept[key] = val;
  }
  return kept;
}

function redactEvent(event: TimedEvent): TimedEvent {
  return event.attributes ? { ...event, attributes: redactAttributes(event.attributes) } : event;
}

export function redactSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes: redactAttributes(span.attributes),
    links: span.links.map((link) =>
      link.attributes ? { ...link, attributes: redactAttributes(link.attributes) } : link,
    ),
    events: span.events.map(redactEvent),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Wraps any exporter so that it only ever sees redacted spans. */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** The allow-list for metric data points: a View's attributes processor. */
export const redactingAttributesProcessor: IAttributesProcessor = {
  process: (incoming) => redactAttributes(incoming),
};
