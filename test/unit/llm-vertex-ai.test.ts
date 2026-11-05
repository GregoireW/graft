import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  ApiError,
  BlockedReason,
  FinishReason,
  type GenerateContentParameters,
  GenerateContentResponse,
  type GoogleGenAIOptions,
} from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../../src/core/logger.js";
import { createLlmClient, parseRegistry } from "../../src/llm/index.js";
import { DEFAULT_CAPABILITIES } from "../../src/llm/registry.js";
import { type LlmRequest, ZERO_USAGE } from "../../src/llm/types.js";
import { createVertexAiLlm, type VertexAiOptions } from "../../src/llm/vertex-ai.js";
import { testConfig } from "../helpers/config.js";
import { silentLog } from "../helpers/stubs.js";

const sdk = vi.hoisted(() => ({
  generate: vi.fn<(req: GenerateContentParameters) => Promise<GenerateContentResponse>>(),
  options: vi.fn<(options: GoogleGenAIOptions) => void>(),
}));
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent: sdk.generate };
      constructor(options: GoogleGenAIOptions) {
        sdk.options(options);
      }
    },
  };
});

const SCHEMA = { anyOf: [{ type: "object", properties: { ok: { type: "boolean" } } }] };
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  purpose: "writer",
  model: "gemini-2.5-flash",
  system: "SYSTEM_CANARY",
  user: "USER_CANARY",
  outputSchema: SCHEMA,
  maxOutputTokens: 8192,
  effort: "low",
  timeoutMs: 5000,
  ...over,
});
const response = (over: Partial<GenerateContentResponse> = {}): GenerateContentResponse =>
  Object.assign(new GenerateContentResponse(), {
    candidates: [
      {
        finishReason: FinishReason.STOP,
        content: {
          parts: [{ thought: true, text: "THOUGHT_CANARY" }, { text: '{"ok":true}' }],
        },
      },
    ],
    modelVersion: "gemini-2.5-flash-001",
    usageMetadata: {
      promptTokenCount: 1200,
      cachedContentTokenCount: 200,
      candidatesTokenCount: 80,
      thoughtsTokenCount: 20,
    },
    ...over,
  });
const client = (over: Partial<VertexAiOptions> = {}) =>
  createVertexAiLlm({
    project: "my-project",
    location: "global",
    maxRetries: 2,
    capabilities: DEFAULT_CAPABILITIES["vertex-ai"],
    log: silentLog,
    ...over,
  });

function capture(): { log: Logger; text: () => string } {
  let out = "";
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      out += String(chunk);
      cb();
    },
  });
  return { log: createLogger({ logLevel: "debug" }, stream), text: () => out };
}

beforeEach(() => {
  sdk.options.mockClear();
  sdk.generate.mockReset().mockResolvedValue(response());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Vertex AI client", () => {
  it("uses Vertex AI with explicit project/location and no API key or embedded credentials", () => {
    client();
    expect(sdk.options).toHaveBeenLastCalledWith({
      vertexai: true,
      project: "my-project",
      location: "global",
      apiVersion: "v1",
      httpOptions: { baseUrl: "https://aiplatform.googleapis.com" },
    });
    client({ location: "europe-west4" });
    expect(sdk.options).toHaveBeenLastCalledWith(
      expect.objectContaining({
        httpOptions: { baseUrl: "https://europe-west4-aiplatform.googleapis.com" },
      }),
    );
    client({ location: "eu" });
    expect(sdk.options).toHaveBeenLastCalledWith(
      expect.objectContaining({
        httpOptions: { baseUrl: "https://aiplatform.eu.rep.googleapis.com" },
      }),
    );
  });

  it("authenticates through real ADC workload federation and sends the access token to Vertex AI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graft-vertex-adc-"));
    let tokenExchanges = 0;
    let tokenStatus = 200;
    const server = createServer((_req, res) => {
      tokenExchanges++;
      res.writeHead(tokenStatus, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          tokenStatus === 200
            ? {
                access_token: "ADC_TOKEN_CANARY",
                token_type: "Bearer",
                expires_in: 3600,
              }
            : { error: "access_denied", error_description: "AUTH_ERROR_CANARY" },
        ),
      );
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP listener");
      const tokenFile = path.join(dir, "subject-token");
      const adcFile = path.join(dir, "adc.json");
      await writeFile(tokenFile, "SUBJECT_TOKEN_CANARY");
      await writeFile(
        adcFile,
        JSON.stringify({
          type: "external_account",
          audience:
            "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/test/providers/test",
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          token_url: `http://127.0.0.1:${address.port}/token`,
          credential_source: { file: tokenFile },
        }),
      );
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", adcFile);
      vi.stubEnv("GOOGLE_CLOUD_PROJECT", "my-project");
      vi.stubEnv("GEMINI_API_KEY", "API_KEY_CANARY");
      vi.stubEnv("GOOGLE_API_KEY", "");
      vi.stubEnv("GOOGLE_VERTEX_BASE_URL", "https://unexpected.test");
      const c = capture();
      const sdkFetch = vi.fn<typeof fetch>(async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer ADC_TOKEN_CANARY");
        expect(headers.has("x-goog-api-key")).toBe(false);
        return new Response(JSON.stringify(response()), {
          headers: { "content-type": "application/json" },
        });
      });
      const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
      const wireSdk = () => {
        const options = sdk.options.mock.lastCall?.[0];
        if (!options) throw new Error("expected SDK options");
        const real = new actual.GoogleGenAI({
          ...options,
          httpOptions: { ...options.httpOptions, fetch: sdkFetch },
        });
        sdk.generate.mockImplementation((p) => real.models.generateContent(p));
      };
      const llm = client({ log: c.log, maxRetries: 0 });
      wireSdk();
      expect(await llm.complete(req())).toMatchObject({ ok: true, value: { ok: true } });
      expect(tokenExchanges).toBe(1);
      expect(sdkFetch.mock.lastCall?.[0]).toBe(
        "https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent",
      );
      const body = JSON.parse(String(sdkFetch.mock.lastCall?.[1]?.body));
      expect(body.generationConfig.responseJsonSchema).toEqual(SCHEMA);
      expect(body.generationConfig.maxOutputTokens).toBe(8192);

      // A new client forces another exchange instead of reading the cached access token.
      tokenStatus = 400;
      const denied = client({ log: c.log, maxRetries: 0 });
      wireSdk();
      expect(await denied.complete(req())).toMatchObject({ ok: false, failure: "auth" });
      expect(sdkFetch).toHaveBeenCalledTimes(1);

      await writeFile(adcFile, "not JSON");
      const invalid = client({ log: c.log, maxRetries: 0 });
      wireSdk();
      expect(await invalid.complete(req())).toMatchObject({ ok: false, failure: "auth" });
      for (const canary of ["ADC_TOKEN_CANARY", "SUBJECT_TOKEN_CANARY", "AUTH_ERROR_CANARY"]) {
        expect(c.text()).not.toContain(canary);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends the schema, prompts, token limit, timeouts and retry count without agent tools", async () => {
    await client().complete(req({ deadlineMs: 10_000, userCachePrefix: "USER" }));
    expect(sdk.generate).toHaveBeenCalledWith({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "USER_CANARY" }] }],
      config: {
        systemInstruction: "SYSTEM_CANARY",
        maxOutputTokens: 8192,
        automaticContinuation: false,
        responseMimeType: "application/json",
        responseJsonSchema: SCHEMA,
        abortSignal: expect.any(AbortSignal),
        httpOptions: { timeout: 5000, retryOptions: { attempts: 3 } },
      },
    });
    await client({
      maxRetries: 0,
      capabilities: { ...DEFAULT_CAPABILITIES["vertex-ai"], nativeSchema: false },
    }).complete(req());
    const config = sdk.generate.mock.lastCall?.[0].config;
    expect(config).not.toHaveProperty("responseJsonSchema");
    expect(config).not.toHaveProperty("responseMimeType");
    expect(config?.httpOptions?.retryOptions?.attempts).toBe(1);
  });

  it("parses only answer text and counts cached and thinking tokens without double counting", async () => {
    expect(await client().complete(req())).toMatchObject({
      ok: true,
      value: { ok: true },
      model: "gemini-2.5-flash-001",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0 },
    });
    sdk.generate.mockResolvedValue(response({ usageMetadata: undefined, modelVersion: undefined }));
    expect(await client().complete(req())).toMatchObject({
      ok: true,
      model: "gemini-2.5-flash",
      usage: ZERO_USAGE,
    });
    expect(
      (
        await client({
          capabilities: { ...DEFAULT_CAPABILITIES["vertex-ai"], reportsUsage: false },
        }).complete(req())
      ).usage,
    ).toEqual(ZERO_USAGE);
  });

  it("recognizes safety refusals, token limits, malformed JSON and empty responses", async () => {
    for (const reason of [
      FinishReason.SAFETY,
      FinishReason.RECITATION,
      FinishReason.BLOCKLIST,
      FinishReason.PROHIBITED_CONTENT,
      FinishReason.SPII,
      FinishReason.MAX_TOKENS,
    ]) {
      sdk.generate.mockResolvedValue(response({ candidates: [{ finishReason: reason }] }));
      expect(await client().complete(req())).toMatchObject({
        ok: false,
        failure: reason === FinishReason.MAX_TOKENS ? "max_tokens" : "refusal",
        usage: { outputTokens: 100 },
      });
    }
    sdk.generate.mockResolvedValue(
      response({ candidates: [], promptFeedback: { blockReason: BlockedReason.SAFETY } }),
    );
    expect(await client().complete(req())).toMatchObject({ failure: "refusal" });
    for (const candidates of [
      [],
      [{ content: { parts: [{ text: "not JSON" }] } }],
      [{ content: { parts: [{ thought: true, text: '{"ok":true}' }] } }],
    ]) {
      sdk.generate.mockResolvedValue(response({ candidates }));
      expect(await client().complete(req())).toMatchObject({ failure: "invalid_json" });
    }
  });

  it("maps API, ADC and transport failures without swallowing programmer errors", async () => {
    for (const [status, failure] of [
      [400, "bad_request"],
      [401, "auth"],
      [403, "auth"],
      [404, "bad_request"],
      [408, "timeout"],
      [429, "rate_limited"],
      [500, "unavailable"],
      [503, "unavailable"],
      [504, "timeout"],
    ] as const) {
      sdk.generate.mockRejectedValue(new ApiError({ status, message: "ERROR_CANARY" }));
      expect(await client().complete(req())).toMatchObject({
        ok: false,
        failure,
        usage: ZERO_USAGE,
      });
    }
    for (const [error, failure] of [
      [new Error("Could not load the default credentials."), "auth"],
      [Object.assign(new Error("PATH_CANARY"), { code: "ENOENT" }), "auth"],
      [new TypeError("fetch failed"), "unavailable"],
      [new DOMException("aborted", "AbortError"), "timeout"],
      [Object.assign(new Error("ERROR_CANARY"), { response: { status: 400 } }), "auth"],
    ] as const) {
      sdk.generate.mockRejectedValue(error);
      expect(await client().complete(req())).toMatchObject({ failure, usage: ZERO_USAGE });
    }
    sdk.generate.mockRejectedValue(new TypeError("programmer error"));
    await expect(client().complete(req())).rejects.toThrow("programmer error");
  });

  it("bounds the whole SDK call, including credential discovery and retry backoff", async () => {
    vi.useFakeTimers();
    sdk.generate.mockImplementation(() => new Promise(() => {}));
    const pending = client().complete(req({ timeoutMs: 5000, deadlineMs: 20 }));
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ failure: "timeout", usage: ZERO_USAGE });
    expect(sdk.generate.mock.lastCall?.[0].config?.abortSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid cache prefixes before making a call", async () => {
    for (const prefix of ["", "not a prefix"]) {
      await expect(client().complete(req({ userCachePrefix: prefix }))).rejects.toThrow(
        "userCachePrefix must be a non-empty prefix of user",
      );
    }
    expect(sdk.generate).not.toHaveBeenCalled();
  });

  it("logs metadata only, never prompts, thoughts, answers or SDK error bodies", async () => {
    const c = capture();
    sdk.generate.mockResolvedValue(
      response({ candidates: [{ content: { parts: [{ text: '{"secret":"ANSWER_CANARY"}' }] } }] }),
    );
    await client({ log: c.log }).complete(req());
    sdk.generate.mockRejectedValue(new ApiError({ status: 403, message: "ERROR_CANARY" }));
    await client({ log: c.log }).complete(req());
    expect(c.text()).toContain('"inputTokens":1000');
    expect(c.text()).toContain('"failure":"auth"');
    for (const canary of [
      "SYSTEM_CANARY",
      "USER_CANARY",
      "THOUGHT_CANARY",
      "ANSWER_CANARY",
      "ERROR_CANARY",
    ]) {
      expect(c.text()).not.toContain(canary);
    }
  });
});

const REGISTRY = `
providers:
  - id: gemini
    kind: vertex-ai
    project: my-project
    location: global
    prices:
      gemini-2.5-flash: { input: 0.3, output: 2.5, cacheRead: 0.03 }
roles:
  fast: gemini/gemini-2.5-flash
  strong: gemini/gemini-2.5-pro
`;

describe("Vertex AI provider registry", () => {
  it("works without Anthropic credentials, including hosted routing, capabilities and pricing", async () => {
    const cfg = testConfig({
      GRAFT_DEPLOYMENT: "hosted",
      GRAFT_LLM_PROVIDERS: REGISTRY,
    });
    expect(cfg.llmRegistry?.providers[0]).toMatchObject({
      kind: "vertex-ai",
      project: "my-project",
      location: "global",
      capabilities: DEFAULT_CAPABILITIES["vertex-ai"],
    });
    const c = capture();
    const llm = createLlmClient(cfg, c.log);
    expect(c.text()).toContain('"auth":"adc"');
    expect(c.text()).toContain('"host":"aiplatform.googleapis.com"');
    expect(llm.capabilities?.(cfg.llmModelFast)).toEqual(DEFAULT_CAPABILITIES["vertex-ai"]);
    expect(llm.serverRefusalFallback?.(cfg.llmModelFast)).toBe(false);
    expect(llm.costOf?.({ ...ZERO_USAGE, inputTokens: 1_000_000 }, cfg.llmModelFast)).toBe(0.3);
    expect(llm.costOf?.(ZERO_USAGE, cfg.llmModelStrong)).toBeNull();
    expect(await llm.complete(req({ model: cfg.llmModelFast }))).toMatchObject({
      ok: true,
      model: "gemini/gemini-2.5-flash-001",
    });
    expect(sdk.generate.mock.lastCall?.[0].model).toBe("gemini-2.5-flash");
  });

  it("requires safe project/location fields and refuses API-key or endpoint overrides", () => {
    for (const [entry, field] of [
      ["", "project"],
      ["project: my-project", "location"],
      ["project: 'https://bad.test', location: global", "project"],
      ["project: my-project, location: 'global/../../bad'", "location"],
      ["project: my-project, location: global, apiKeyEnv: KEY", "providers[0]"],
      ["project: my-project, location: global, baseUrl: 'https://bad.test'", "providers[0]"],
    ]) {
      const parsed = parseRegistry(
        "SRC",
        `providers: [{id: g, kind: vertex-ai, ${entry}}]\nroles: {fast: g/gemini-2.5-flash, strong: g/gemini-2.5-pro}`,
        {},
        { credential: null, baseUrl: undefined },
      );
      expect(parsed.registry).toBeUndefined();
      expect(parsed.problems.join("\n")).toContain(field);
    }
  });
});
