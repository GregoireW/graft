import { SpanKind } from "@opentelemetry/api";
import { recordGitHubRequest } from "../telemetry/metrics.js";
import { withSpan } from "../telemetry/tracing.js";
import type { GitHubClient } from "./client-factory.js";

/**
 * The fixed words of GitHub's REST routes (`repos`, `pulls`, `check-runs`...), read once from the
 * route templates Octokit's methods carry. Anything else in a URL is a value.
 */
let routeWords: ReadonlySet<string> | undefined;

export function knownRouteWords(octokit: GitHubClient): ReadonlySet<string> {
  if (routeWords) return routeWords;
  const words = new Set<string>();
  for (const scope of Object.values(octokit.rest)) {
    for (const method of Object.values(scope as Record<string, unknown>)) {
      const url = (method as { endpoint?: { DEFAULTS?: { url?: unknown } } })?.endpoint?.DEFAULTS
        ?.url;
      if (typeof url !== "string") continue;
      for (const seg of url.split("{?", 1)[0]?.split("/") ?? []) {
        if (seg && !seg.includes("{")) words.add(seg);
      }
    }
  }
  routeWords = words;
  return words;
}

/**
 * A route safe to export: `/repos/{owner}/{repo}/pulls/{pull_number}`. Octokit hands the hook the
 * caller's template, which is usually all placeholders and fixed words; but a caller can write a
 * value into it (a branch), and a paginated request passes the absolute `next` URL. So the host,
 * the query and any `{?...}` part are dropped, and every segment that is neither a `{placeholder}`
 * nor a fixed word of some GitHub route becomes `{value}`.
 */
export function githubRoute(url: string, words: ReadonlySet<string>): string {
  let path = url.split("{?", 1)[0] ?? "";
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return "{value}";
    }
  }
  path = path.split("?", 1)[0] ?? "";
  return path
    .split("/")
    .map((seg) => (seg === "" || /^\{[^}]*\}$/.test(seg) || words.has(seg) ? seg : "{value}"))
    .join("/");
}

/** Remaining requests in the rate-limit window, from the response headers; null without one. */
function rateLimitRemaining(headers: unknown): number | null {
  const raw = (headers as Record<string, unknown> | undefined)?.["x-ratelimit-remaining"];
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * One CLIENT span per GitHub API request, named `github <METHOD> <route template>`. The fetch
 * span under it keeps the host and status. A failed request records its status and rethrows.
 */
export function traceGitHub(octokit: GitHubClient, o: { installationId: number | null }): void {
  const words = knownRouteWords(octokit);
  const rateLimitOf = (remaining: number | null) =>
    remaining === null ? null : { remaining, installationId: o.installationId };
  octokit.hook.wrap("request", async (request, options) => {
    const method = String(options.method).toUpperCase();
    const route = githubRoute(String(options.url), words);
    return withSpan(
      `github ${method} ${route}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "http.request.method": method,
          "graft.github.route": route,
          ...(o.installationId !== null
            ? { "graft.github.installation_id": o.installationId }
            : {}),
        },
      },
      async (span) => {
        try {
          const res = await request(options);
          span.setAttribute("http.response.status_code", res.status);
          const remaining = rateLimitRemaining(res.headers);
          if (remaining !== null) span.setAttribute("graft.github.rate_limit.remaining", remaining);
          recordGitHubRequest(method, route, res.status, rateLimitOf(remaining));
          return res;
        } catch (err) {
          const e = err as { status?: unknown; response?: { headers?: unknown } };
          if (typeof e.status === "number")
            span.setAttribute("http.response.status_code", e.status);
          const remaining = rateLimitRemaining(e.response?.headers);
          if (remaining !== null) span.setAttribute("graft.github.rate_limit.remaining", remaining);
          recordGitHubRequest(
            method,
            route,
            typeof e.status === "number" ? e.status : null,
            rateLimitOf(remaining),
          );
          throw err;
        }
      },
    );
  });
}
