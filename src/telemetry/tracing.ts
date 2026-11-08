import {
  type Attributes,
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

/**
 * Graft's own spans. Without the SDK (telemetry off) the API hands out no-op spans, so these
 * helpers cost a function call and nothing else.
 *
 * Attribute values must be metadata only (ids, numbers, SHAs, models, outcomes): the exporter's
 * allow-list keeps `graft.*` keys as they are.
 */
const tracer = () => trace.getTracer("graft");

/** The span's error: its type only. Messages can hold PR text or response bodies. */
export function errorType(err: unknown): string {
  if (err instanceof Error) return err.constructor?.name || err.name || "Error";
  return typeof err;
}

/**
 * Runs `fn` in a new active span. A throw marks the span as an error with the error's type, then
 * propagates.
 */
export async function withSpan<T>(
  name: string,
  opts: { attributes?: Attributes; kind?: SpanKind; parent?: Context },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = opts.parent ?? context.active();
  return tracer().startActiveSpan(
    name,
    {
      ...(opts.attributes ? { attributes: opts.attributes } : {}),
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        // `fn` may have marked it already with the original error, before rethrowing a
        // sanitized copy: keep the original's type.
        if (!marked.has(span)) markError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

const marked = new WeakSet<Span>();

/** Marks a span failed with the error's type, never its message. */
export function markError(span: Span, err: unknown): void {
  marked.add(span);
  const type = errorType(err);
  span.recordException({ name: type });
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Adds metadata to the active span (a job's outcome, for example). No-op without one. */
export function annotate(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** W3C trace context of the active span, as a job carries it. */
export interface TraceCarrier {
  traceparent: string;
  tracestate?: string;
}

/** The key a job's data carries its trace context under. Stripped before the job's schema. */
export const TRACE_KEY = "_otel";

/** The active trace context, or null when nothing is traced (no SDK, no active span). */
export function currentTraceCarrier(): TraceCarrier | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (typeof carrier.traceparent !== "string") return null;
  return {
    traceparent: carrier.traceparent,
    ...(typeof carrier.tracestate === "string" ? { tracestate: carrier.tracestate } : {}),
  };
}

/** The context a job's carrier names; the root context for anything else. */
export function contextFromCarrier(carrier: unknown): Context {
  const root = ROOT_CONTEXT;
  if (typeof carrier !== "object" || carrier === null) return root;
  const c = carrier as Record<string, unknown>;
  if (typeof c.traceparent !== "string") return root;
  return propagation.extract(root, {
    traceparent: c.traceparent,
    ...(typeof c.tracestate === "string" ? { tracestate: c.tracestate } : {}),
  });
}

/** Adds the active trace context to job data; returns the data unchanged when nothing is traced. */
export function withTraceCarrier<T>(data: T): T {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
  const carrier = currentTraceCarrier();
  return carrier ? ({ ...data, [TRACE_KEY]: carrier } as T) : data;
}

/** Splits job data into the trace carrier and what the job's schema reads. */
export function takeTraceCarrier(data: unknown): { carrier: unknown; data: unknown } {
  if (typeof data !== "object" || data === null || Array.isArray(data) || !(TRACE_KEY in data)) {
    return { carrier: undefined, data };
  }
  const { [TRACE_KEY]: carrier, ...rest } = data as Record<string, unknown>;
  return { carrier, data: rest };
}
