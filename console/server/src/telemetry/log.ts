import { isSpanContextValid, trace } from "@opentelemetry/api";

/** The active span's ids on every log line (a pino mixin); empty without one, as when it is off. */
export function traceFields(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (span === undefined) return {};
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return {};
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    trace_flags: `0${ctx.traceFlags.toString(16)}`.slice(-2),
  };
}
