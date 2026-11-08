import { useEffect, useState } from "preact/hooks";
import type { RepositoriesResponse, RepositorySearchResponse } from "../../shared/repositories.js";
import { postJson, qs, useApi } from "./api.js";
import { Empty, Failure, Loading } from "./components.js";
import { when } from "./format.js";

export function Repositories() {
  const [after, setAfter] = useState(0);
  const list = useApi<RepositoriesResponse>(`/api/repositories${qs({ after })}`);
  const [account, setAccount] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ account: string; query: string; page: number } | null>(
    null,
  );
  const results = useApi<RepositorySearchResponse>(
    search ? `/api/repositories/search${qs(search)}` : null,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!account && list.data?.accounts[0]) setAccount(list.data.accounts[0]);
  }, [account, list.data]);

  const change = async (repository: string, enabled: boolean) => {
    if (
      !enabled &&
      !window.confirm(
        `Disable Graft on ${repository}?\n\nWhen repository filtering is on, future reviews and queued repository jobs will be skipped. Existing comments and required checks are not removed.`,
      )
    )
      return;
    setPending(repository);
    setError(null);
    setNotice("");
    try {
      const result = await postJson<{ enabled: boolean; filtering: boolean }>(
        "/api/repositories/activation",
        {
          repository,
          enabled,
          ...(!enabled ? { confirmation: repository } : {}),
        },
      );
      setNotice(
        `${repository} ${enabled ? "added to" : "removed from"} the enabled list.${result.filtering ? "" : " Filtering is off, so all installed repositories still run."}`,
      );
      list.reload();
      results.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setPending(null);
    }
  };

  return (
    <div class="register-wrap repo-settings">
      <h1>Repositories</h1>
      <p>
        Choose where Graft runs. Anyone with console access can view the enabled list; only a
        repository administrator can change it.
      </p>
      {list.error ? <Failure error={list.error} retry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data ? (
        <>
          <div class="repo-settings__scope" role="status">
            <strong>Repository filtering is {list.data.filtering ? "on" : "off"}.</strong>
            <p>
              {list.data.filtering
                ? "Only repositories on the enabled list are processed. New repositories are disabled by default."
                : "Graft processes every installed repository. This list takes effect when GRAFT_REPOSITORY_FILTER=on is set on the server and workers."}
            </p>
          </div>
          <section aria-labelledby="enabled-heading">
            <h2 id="enabled-heading">Enabled list</h2>
            {list.data.repositories.length ? (
              <ul class="repo-settings__list" aria-busy={list.loading}>
                {list.data.repositories.map((r) => (
                  <li key={r.id}>
                    <div>
                      <strong>{r.fullName}</strong>
                      <small>
                        Added by {r.enabledBy} · {when(r.enabledAt)}
                      </small>
                    </div>
                    {r.canAdmin ? (
                      <button
                        class="btn btn--ghost"
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void change(r.fullName, false)}
                      >
                        {pending === r.fullName ? "Saving…" : "Disable"}
                      </button>
                    ) : (
                      <span class="repo-settings__permission">Repository admin required</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title={after ? "No more enabled repositories" : "No repositories enabled yet"}>
                <p>
                  {list.data.filtering
                    ? "Graft is not processing repositories on this page. Search below to enable one."
                    : "Add repositories below to prepare your filter before switching it on."}
                </p>
              </Empty>
            )}
            <div class="repo-settings__paging">
              {after ? (
                <button
                  class="btn btn--ghost"
                  type="button"
                  disabled={list.loading}
                  onClick={() => setAfter(0)}
                >
                  First page
                </button>
              ) : null}
              {list.data.next !== null ? (
                <button
                  class="btn btn--ghost"
                  type="button"
                  disabled={list.loading}
                  onClick={() => setAfter(list.data?.next ?? 0)}
                >
                  Next page
                </button>
              ) : null}
            </div>
          </section>
          <section aria-labelledby="add-heading">
            <h2 id="add-heading">Add a repository</h2>
            <p>
              Search by name within a Graft installation. Results include only repositories the App
              can access; adding one requires repository-admin permission.
            </p>
            {list.data.accounts.length ? (
              <form
                class="repo-settings__search"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  setSearch({ account, query: query.trim(), page: 1 });
                }}
              >
                <label class="field" for="repo-account">
                  Account
                  <select
                    id="repo-account"
                    value={account}
                    onChange={(ev) => setAccount(ev.currentTarget.value)}
                  >
                    {list.data.accounts.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
                <label class="field repo-settings__query" for="repo-query">
                  Repository name
                  <input
                    id="repo-query"
                    type="search"
                    required
                    minLength={2}
                    maxLength={100}
                    pattern="[A-Za-z0-9_.\-]{2,100}"
                    placeholder="e.g. payments"
                    value={query}
                    onInput={(ev) => setQuery(ev.currentTarget.value)}
                  />
                </label>
                <button
                  type="submit"
                  class="btn btn--primary"
                  disabled={results.loading || pending !== null}
                >
                  Search
                </button>
              </form>
            ) : (
              <p>
                No active installations are available. Install Graft on an allowed account first.
              </p>
            )}
            {results.loading ? <Loading label="Searching GitHub repositories" /> : null}
            {results.error ? <Failure error={results.error} retry={results.reload} /> : null}
            {search && results.data && !results.loading ? (
              <div>
                <h3>
                  Results for “{search.query}” in {search.account}
                </h3>
                {results.data.incomplete ? (
                  <p role="status">
                    GitHub returned partial results. Refine your search or try again.
                  </p>
                ) : null}
                {results.data.repositories.length ? (
                  <ul class="repo-settings__list">
                    {results.data.repositories.map((r) => (
                      <li key={r.id}>
                        <strong>{r.fullName}</strong>
                        {r.enabled ? (
                          <span class="repo-settings__permission">Already enabled</span>
                        ) : r.canAdmin ? (
                          <button
                            type="button"
                            class="btn btn--primary"
                            disabled={pending !== null}
                            onClick={() => void change(r.fullName, true)}
                          >
                            {pending === r.fullName ? "Saving…" : "Enable"}
                          </button>
                        ) : (
                          <span class="repo-settings__permission">Repository admin required</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    No accessible repositories on this results page. Try another name or the next
                    page.
                  </p>
                )}
                <div class="repo-settings__paging">
                  {search.page > 1 ? (
                    <button
                      class="btn btn--ghost"
                      type="button"
                      onClick={() => setSearch({ ...search, page: search.page - 1 })}
                    >
                      Previous results
                    </button>
                  ) : null}
                  {results.data.next !== null ? (
                    <button
                      class="btn btn--ghost"
                      type="button"
                      onClick={() => setSearch({ ...search, page: results.data?.next ?? 1 })}
                    >
                      Next results
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
      {error ? (
        <p class="repo-settings__error" role="alert">
          {error.message}
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {notice}
      </p>
    </div>
  );
}
