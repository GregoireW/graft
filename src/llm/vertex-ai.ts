import { ApiError, FinishReason, type GenerateContentResponse, GoogleGenAI } from "@google/genai";
import type { Logger } from "../core/logger.js";
import { parseJsonAnswer } from "./openai-compatible.js";
import {
  type LlmCapabilities,
  type LlmClient,
  type LlmFailure,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ZERO_USAGE,
} from "./types.js";

export interface VertexAiOptions {
  project: string;
  location: string;
  maxRetries: number;
  capabilities: LlmCapabilities;
  log: Logger;
}

function classify(err: unknown): LlmFailure {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
    if (err instanceof ApiError) {
      if (err.status === 408 || err.status === 504) return "timeout";
      if (err.status === 429) return "rate_limited";
      if (err.status >= 500) return "unavailable";
      if (err.status === 401 || err.status === 403) return "auth";
      return "bad_request";
    }
    // ADC discovery and token refresh happen before the SDK's HTTP request.
    if (
      /Could not load the default credentials|Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS|invalid_grant|invalid_client/.test(
        err.message,
      ) ||
      ("code" in err && (err.code === "ENOENT" || err.code === "EACCES"))
    ) {
      return "auth";
    }
    // Google Auth can wrap its HTTP errors in plain Errors, preserving response/config.
    if ("response" in err) {
      const response = err.response;
      const status =
        typeof response === "object" && response !== null && "status" in response
          ? response.status
          : undefined;
      if (status === 429) return "rate_limited";
      if (status === 408 || status === 504) return "timeout";
      if (typeof status === "number") return status >= 500 ? "unavailable" : "auth";
      if ("config" in err) return "unavailable";
    }
    if (err instanceof TypeError && err.message === "fetch failed") return "unavailable";
  }
  throw err;
}

const REFUSALS = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

export function vertexAiHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (location === "us" || location === "eu") return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

export function createVertexAiLlm(o: VertexAiOptions): LlmClient {
  const client = new GoogleGenAI({
    vertexai: true,
    project: o.project,
    location: o.location,
    apiVersion: "v1",
    // Explicit project/location select ADC, even if a Gemini API key exists in the environment.
    // Pin the host as well: GOOGLE_VERTEX_BASE_URL must not redirect PR data or ADC tokens.
    httpOptions: { baseUrl: `https://${vertexAiHost(o.location)}` },
  });
  const caps = o.capabilities;

  return {
    capabilities: () => caps,
    async complete(req: LlmRequest): Promise<LlmResult> {
      const started = Date.now();
      const finish = (
        r: { ok: true; value: unknown } | { ok: false; failure: LlmFailure },
        usage: LlmUsage,
        model: string,
      ): LlmResult => {
        const durationMs = Date.now() - started;
        o.log.info(
          {
            purpose: req.purpose,
            model,
            ok: r.ok,
            ...(r.ok ? {} : { failure: r.failure }),
            ...usage,
            durationMs,
          },
          "llm call",
        );
        return { ...r, usage, model, durationMs };
      };

      const prefix = req.userCachePrefix;
      if (prefix !== undefined && (prefix === "" || !req.user.startsWith(prefix))) {
        throw new Error("userCachePrefix must be a non-empty prefix of user");
      }

      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      let res: GenerateContentResponse;
      try {
        // The SDK's per-attempt timeout does not cover ADC discovery or retry backoff.
        res = await Promise.race([
          client.models.generateContent({
            model: req.model,
            contents: [{ role: "user", parts: [{ text: req.user }] }],
            config: {
              systemInstruction: req.system,
              maxOutputTokens: req.maxOutputTokens,
              automaticContinuation: false,
              ...(caps.nativeSchema
                ? { responseMimeType: "application/json", responseJsonSchema: req.outputSchema }
                : {}),
              abortSignal: controller.signal,
              httpOptions: {
                timeout: req.timeoutMs,
                retryOptions: { attempts: o.maxRetries + 1 },
              },
            },
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => {
                const error = new DOMException("LLM deadline exceeded", "TimeoutError");
                controller.abort(error);
                reject(error);
              },
              Math.max(1, Math.floor(req.deadlineMs ?? req.timeoutMs)),
            );
          }),
        ]);
      } catch (err) {
        const failure = classify(err);
        o.log.warn({ purpose: req.purpose, model: req.model, failure }, "llm call failed");
        return finish({ ok: false, failure }, ZERO_USAGE, req.model);
      } finally {
        clearTimeout(timer);
      }

      const cached = res.usageMetadata?.cachedContentTokenCount ?? 0;
      const usage: LlmUsage = caps.reportsUsage
        ? {
            inputTokens: Math.max(0, (res.usageMetadata?.promptTokenCount ?? 0) - cached),
            outputTokens:
              (res.usageMetadata?.candidatesTokenCount ?? 0) +
              (res.usageMetadata?.thoughtsTokenCount ?? 0),
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          }
        : ZERO_USAGE;
      const model = res.modelVersion || req.model;
      const candidate = res.candidates?.[0];
      if (
        (res.promptFeedback?.blockReason &&
          res.promptFeedback.blockReason !== "BLOCKED_REASON_UNSPECIFIED") ||
        (candidate?.finishReason && REFUSALS.has(candidate.finishReason))
      ) {
        return finish({ ok: false, failure: "refusal" }, usage, model);
      }
      if (candidate?.finishReason === FinishReason.MAX_TOKENS) {
        return finish({ ok: false, failure: "max_tokens" }, usage, model);
      }
      const text = (candidate?.content?.parts ?? [])
        .filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("");
      const parsed = parseJsonAnswer(text);
      return finish(
        parsed.ok ? { ok: true, value: parsed.value } : { ok: false, failure: "invalid_json" },
        usage,
        model,
      );
    },
  };
}
