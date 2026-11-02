# Review summary

The top of the Graft comment answers three questions before anything else:

- **Matches the intent?** Does the change do what was asked?
- **Safe to merge?** What risk, what CI and AI reviews say, how much of the diff Graft read.
- **Human review:** what the policy asks for, and how many approvals there are.

Then come up to three **Where to look** points: what the human reviewer should check, and why. Everything Graft knows in detail follows, folded: what was asked against what was done, the behavior changes, how the card was made, provenance and the policy rules.

An example, for a pull request that adds file uploads to a chat:

```markdown
### ⚠️ Needs human review · 3 points to check

- **Matches the intent?** ✅ **Yes.** Does what issue #342 asks. 1 change not in the description. 1 item left for later on purpose.
- **Safe to merge?** ⚠️ **Not without a human review.** Risk `sensitive`: Adds a public upload endpoint that writes files to disk. **CI:** 15 of 16 passed, 1 still running. **AI review `claude-review`** on `34290fb`: ran (its check does not say whether it found issues); same model family as the author. **Graft:** 10 of 10 claims supported, 3 files not read in full.
- **Human review:** **2 approvals needed** · 0 so far · *report mode: Graft blocks nothing*

**Where to look**

1. **Not read in full by Graft** · `scripts/arc_chat.py`, `scripts/arc_chat_upload.py`, `tests/install/test_chat_attachments.py`: check these files yourself.
2. **Also changed, not in the description** · Uploaded files are never purged and there is no total disk quota.
3. **Sensitive files** · configured sensitive path (`scripts/arc_chat.py`, `scripts/arc_serve.py`)
```

## Matches the intent?

Since `intent-v6`, the card's writer lists what was asked (from the linked issue, or the PR description when there is none) and marks each item `done`, `partial`, `missing` or `deferred` (the issue or the description says it is left for later). It judges from the diff, never from what the description claims. The verifier then checks every item marked `done` against the diff, like any other claim: an item it cannot find makes the card wrong.

| Shown | When |
| --- | --- |
| ✅ Yes | Everything asked is done, apart from deferred items |
| ⚠️ Partly | Some items are partial or missing |
| ❌ No | The diff does something else, or the card does not match the diff |
| ❔ Unknown | Neither an issue nor the description says what was wanted, or the card is unavailable |
| ➖ Not checked | A card written before `intent-v6` |

The line also counts files out of scope, changes the description leaves out (the verifier's **Also changed**) and items left for later on purpose. The folded **What was asked vs what was done** list shows each one.

## Safe to merge?

Graft checks that the card matches the diff and applies the policy. It does not hunt for bugs, so it never calls a change safe because of what it did not find:

| Shown | When |
| --- | --- |
| ❌ Don't merge yet | CI fails, an AI review found issues, the card does not match the diff, the PR text addresses AI reviewers, the change does something other than what was asked, or the policy blocks it |
| ⚠️ Not without a human review | Risk `sensitive`, the card is unavailable or unverified, part of what was asked is missing, or a file is out of scope |
| 🟡 Needs a normal review | Risk `logic` without a clean independent AI review, CI still running, or checks not read |
| 🟢 Low risk | Risk `logic`, CI green, and an independent AI review that reports no issues |
| 🟢 Safe to merge | Risk `trivial` and CI green |

A `sensitive` change always needs a human, whatever CI and AI reviews say. The line never changes what the policy requires: approvals stay the policy's decision.

**CI** counts every check run and commit status on the head except Graft's own and the AI review checks: passed, failing (with names) and still running.

**AI reviews** are the checks listed in `report.ai_reviews` in `graft.yaml`:

```yaml
report:
  ai_reviews:
    - check: claude-review      # the check run or status name
      model: claude             # the reviewer's model family
      trust_conclusion: true    # the check fails when the review finds issues
```

- `model` is matched against the author's model from provenance (`Graft-Model`). A review whose family appears in it (`claude` in `claude-sonnet-5-5`) is from the same family as the author and is not independent: their blind spots overlap. When the author's model is unknown, independence cannot be shown either. A human author's PR has independent reviews.
- `trust_conclusion: true` says the check concludes `failure` when the review finds issues, so a `success` means "no issues". Without it (the default), a successful check only means the review ran: most AI review workflows succeed whatever they find, and say so in a comment Graft does not read.

Only a review with `trust_conclusion: true`, a `success` on the current head and an independent model makes a `logic` change "low risk".

## Human review

The policy's requirement, from the same verdict as the `graft/policy` check: approvals needed (with team names as code spans, so no team is notified) and approvals so far, or "none required", "blocked", "no graft.yaml". In report mode it adds that Graft blocks nothing.

## Where to look

At most three points, in this order, and a count of the rest:

1. The card is wrong (the first contradicted or unsupported claim).
2. The PR text addresses AI reviewers.
3. Failing CI checks.
4. AI reviews that found issues or failed.
5. Requested items that are missing or partly done.
6. Files Graft did not read in full.
7. Out-of-scope files.
8. Changes the verifier found that the description leaves out.
9. Sensitive files that set the risk floor.

## When it updates

The policy job writes the summary together with the `policy` section, so it updates whenever the verdict does: on a push, a review, a new intent card or provenance, a change of `graft.yaml`, and, for the summary, when a check suite or a commit status on the head completes. Results of one head are gathered for 30 seconds into one update. While the card for the current head is not ready, the summary says Graft is still reviewing.
