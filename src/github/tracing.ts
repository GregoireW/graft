import { SpanKind } from "@opentelemetry/api";
import { withSpan } from "../telemetry/tracing.js";
import type { GitHubClient } from "./client-factory.js";

/**
 * A route template safe to export: `GET /repos/{owner}/{repo}/pulls/{pull_number}`. The values
 * stay in Octokit's parameters, never in the template, except where a caller wrote one in (a
 * revert branch, for example): any literal segment holding a digit becomes `{value}`, and a
 * query string is dropped.
 */
export function githubRoute(url: string): string {
  const path = url.split("?", 1)[0] ?? "";
  return path
    .split("/")
    .map((seg) => (/^\{[^}]*\}$/.test(seg) || !/[0-9]/.test(seg) ? seg : "{value}"))
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
  octokit.hook.wrap("request", async (request, options) => {
    const method = String(options.method).toUpperCase();
    const route = githubRoute(String(options.url));
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
          return res;
        } catch (err) {
          const e = err as { status?: unknown; response?: { headers?: unknown } };
          if (typeof e.status === "number")
            span.setAttribute("http.response.status_code", e.status);
          const remaining = rateLimitRemaining(e.response?.headers);
          if (remaining !== null) span.setAttribute("graft.github.rate_limit.remaining", remaining);
          throw err;
        }
      },
    );
  });
}
