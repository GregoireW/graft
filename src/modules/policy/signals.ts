/**
 * The CI and AI review results of a pull request head, for the review summary. Read from the API
 * (never from a webhook payload) by the policy job, outside the change lock.
 *
 * Graft's own checks never count. A check named in `report.ai_reviews` is an AI review, not CI.
 * When several runs share a name, the latest one per name and app is kept (`filter: "latest"`),
 * which is what GitHub's merge box shows.
 */
import type { GitHubClient } from "../../github/client-factory.js";
import { classifyGitHubError, toJobError } from "../../github/errors.js";
import type { AiReviewCheck } from "../../policy/schema.js";

const RUN_PAGES = 3;
const MAX_NAMES = 5;

export type SignalState = "passed" | "failed" | "pending" | "other";

export interface CiSignal {
  passed: number;
  failed: number;
  pending: number;
  /** At most MAX_NAMES names of failing checks, as GitHub shows them. */
  failing: string[];
  /** Not every check could be read: the counts are a lower bound, never "all green". */
  incomplete: boolean;
}

export interface AiReviewSignal {
  check: string;
  model: string;
  trustConclusion: boolean;
  state: SignalState;
}

export interface HeadSignals {
  headSha: string;
  ci: CiSignal;
  /** One entry per configured AI review that has a result on this head, in config order. */
  aiReviews: AiReviewSignal[];
}

function runState(status: string | null | undefined, conclusion: string | null | undefined) {
  if (status !== "completed") return "pending";
  return conclusionState(conclusion);
}

function conclusionState(conclusion: string | null | undefined): SignalState {
  switch (conclusion) {
    case "success":
      return "passed";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failed";
    default:
      // neutral, skipped, cancelled, stale and anything unknown.
      return "other";
  }
}

function statusState(state: string | null | undefined): SignalState {
  switch (state) {
    case "success":
      return "passed";
    case "failure":
    case "error":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "other";
  }
}

export async function readHeadSignals(
  octokit: GitHubClient,
  o: {
    owner: string;
    repo: string;
    headSha: string;
    appId: number;
    aiReviews: readonly AiReviewCheck[];
    statusesRead: boolean;
  },
): Promise<HeadSignals> {
  const results: { name: string; state: SignalState }[] = [];
  let incomplete = false;
  for (let page = 1; ; page++) {
    let data: Awaited<ReturnType<GitHubClient["rest"]["checks"]["listForRef"]>>["data"];
    try {
      data = (
        await octokit.rest.checks.listForRef({
          owner: o.owner,
          repo: o.repo,
          ref: o.headSha,
          filter: "latest",
          per_page: 100,
          page,
        })
      ).data;
    } catch (err) {
      throw toJobError(err, "checks.listForRef");
    }
    for (const run of data.check_runs) {
      if (run.app?.id === o.appId || run.head_sha !== o.headSha) continue;
      results.push({ name: run.name, state: runState(run.status, run.conclusion) });
    }
    if (data.check_runs.length < 100 || page * 100 >= data.total_count) break;
    if (page >= RUN_PAGES) {
      incomplete = true;
      break;
    }
  }
  if (o.statusesRead) {
    try {
      const { data } = await octokit.rest.repos.getCombinedStatusForRef({
        owner: o.owner,
        repo: o.repo,
        ref: o.headSha,
        per_page: 100,
      });
      // Newest first: the first status of a context is its current state.
      const seen = new Set<string>();
      for (const s of data.statuses) {
        if (seen.has(s.context)) continue;
        seen.add(s.context);
        results.push({ name: s.context, state: statusState(s.state) });
      }
      if (data.total_count > data.statuses.length) incomplete = true;
    } catch (err) {
      if (classifyGitHubError(err) !== "not_found") throw toJobError(err, "combined status");
    }
  }
  return summarizeSignals(o.headSha, results, o.aiReviews, incomplete);
}

/** Pure: split results into CI and AI reviews. Exported for tests. */
export function summarizeSignals(
  headSha: string,
  results: readonly { name: string; state: SignalState }[],
  aiReviews: readonly AiReviewCheck[],
  incomplete: boolean,
): HeadSignals {
  const reviewByName = new Map(aiReviews.map((r) => [r.check, r] as const));
  const reviewState = new Map<string, SignalState>();
  const ci: CiSignal = { passed: 0, failed: 0, pending: 0, failing: [], incomplete };
  for (const r of results) {
    if (reviewByName.has(r.name)) {
      // Two results with one name (a check run and a status): a failure or a pending run wins.
      const prev = reviewState.get(r.name);
      if (prev === undefined || rank(r.state) > rank(prev)) reviewState.set(r.name, r.state);
      continue;
    }
    if (r.state === "passed") ci.passed++;
    else if (r.state === "pending") ci.pending++;
    else if (r.state === "failed") {
      ci.failed++;
      if (ci.failing.length < MAX_NAMES && !ci.failing.includes(r.name)) ci.failing.push(r.name);
    }
  }
  return {
    headSha,
    ci,
    aiReviews: aiReviews.flatMap((r) => {
      const state = reviewState.get(r.check);
      return state === undefined ? [] : [{ ...r, state }];
    }),
  };
}

const rank = (s: SignalState): number =>
  s === "failed" ? 3 : s === "pending" ? 2 : s === "passed" ? 1 : 0;

/** A review by the same model family as the author is not independent. */
export function sameFamily(review: { model: string }, authorModel: string | null): boolean {
  return authorModel?.toLowerCase().includes(review.model) ?? false;
}
