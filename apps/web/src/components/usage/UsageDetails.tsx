import type {
  EnvironmentId,
  UsageDetails as UsageDetailsResult,
  UsageDetailsInput,
  UsageDetailsRow,
  UsageSummaryInput,
} from "@t3tools/contracts";
import { UsageDay } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { msg, T, useGT, useLocale, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  primarySeparatingAccountProfileSettingsAtom,
  profileSeparatingSettingsAtom,
  resolveEffectiveProfileSettings,
} from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { usageDetailsInActiveProfile } from "./usageDetailsProfile";

const FIGURE_COLUMNS = [
  ["input", msg("Uncached input")],
  ["output", msg("Output tokens")],
  ["cacheRead", msg("Cache read")],
  ["cacheWrite", msg("Cache write")],
  ["reasoning", msg("Reasoning tokens")],
  ["records", msg("Records")],
  ["cost", msg("Cost")],
] as const;
const COLUMNS = [
  ["day", msg("Date (UTC)")],
  ["title", msg("Thread")],
  ["project", msg("Project")],
  ["provider", msg("Provider / account")],
  ["model", msg("Model")],
  ...FIGURE_COLUMNS,
] as const;

export function UsageDetails({
  environments,
  window,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly window: UsageSummaryInput;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState({
    project: "",
    provider: "",
    model: "",
    sinceDay: String(window.sinceDay),
    untilDay: String(window.untilDay),
  });
  const [filters, setFilters] = useState<Filters>({
    ...draft,
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
  });
  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        <T>
          Recorded chat usage, priced at model list rates. Dates are UTC. Provider history outside
          these chats appears in the overview.
        </T>
      </p>
      <form
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({
            ...draft,
            sinceDay: UsageDay.make(draft.sinceDay),
            untilDay: UsageDay.make(draft.untilDay),
          });
        }}
      >
        <label>
          <span className="text-xs">
            <T>Project</T>
          </span>
          <Input
            value={draft.project}
            onChange={(e) => setDraft({ ...draft, project: e.target.value })}
          />
        </label>
        <label>
          <span className="text-xs">
            <T>Provider / account</T>
          </span>
          <Input
            value={draft.provider}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
          />
        </label>
        <label>
          <span className="text-xs">
            <T>Model</T>
          </span>
          <Input
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
        </label>
        <label>
          <span className="text-xs">
            <T>From (UTC)</T>
          </span>
          <Input
            type="date"
            required
            value={draft.sinceDay}
            max={draft.untilDay}
            onChange={(e) => setDraft({ ...draft, sinceDay: e.target.value })}
          />
        </label>
        <label>
          <span className="text-xs">
            <T>Through (UTC)</T>
          </span>
          <Input
            type="date"
            required
            value={draft.untilDay}
            min={draft.sinceDay}
            onChange={(e) => setDraft({ ...draft, untilDay: e.target.value })}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm">
            <T>Apply filters</T>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const next = {
                project: "",
                provider: "",
                model: "",
                sinceDay: window.sinceDay,
                untilDay: window.untilDay,
              };
              setDraft(next);
              setFilters(next);
            }}
          >
            <T>Reset filters</T>
          </Button>
        </div>
      </form>
      {environments
        .filter((environment) => environment.canReadDiagnostics)
        .map((environment) => (
          <div key={environment.environmentId} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{environment.label}</h2>
            <UsageDetailsQuery
              key={JSON.stringify(filters)}
              environmentId={environment.environmentId}
              filters={filters}
            />
          </div>
        ))}
      {environments.every((environment) => !environment.canReadDiagnostics) ? (
        <p>{gt("Usage details are unavailable for these environments.")}</p>
      ) : null}
    </section>
  );
}

type Filters = Pick<
  UsageDetailsInput,
  "sinceDay" | "untilDay" | "project" | "provider" | "model" | "threadId"
>;

function UsageDetailsQuery({
  environmentId,
  filters,
}: {
  readonly environmentId: EnvironmentId;
  readonly filters: Filters;
}) {
  const [paging, setPaging] = useState({
    offset: 0,
    sort: "day" as UsageDetailsInput["sort"],
    descending: true,
  });
  const [selected, setSelected] = useState<UsageDetailsRow | null>(null);
  const separatingSettings = useAtomValue(profileSeparatingSettingsAtom);
  const primarySeparating = useAtomValue(primarySeparatingAccountProfileSettingsAtom);
  const query = useEnvironmentQuery(
    serverEnvironment.usageDetails({ environmentId, input: { ...filters, ...paging, limit: 50 } }),
  );
  const data =
    query.data === null
      ? null
      : usageDetailsInActiveProfile(
          query.data,
          resolveEffectiveProfileSettings(environmentId, separatingSettings, primarySeparating) ??
            null,
        );
  return (
    <>
      {query.error ? (
        <p role="alert">{query.error}</p>
      ) : data === null ? (
        <p role="status">
          <T>Loading usage details…</T>
        </p>
      ) : (
        <>
          {filters.threadId ? (
            <ThreadUsageSummary data={data} environmentId={environmentId} />
          ) : (
            <UsageDetailsTable
              data={data}
              environmentId={environmentId}
              sort={paging.sort}
              descending={paging.descending}
              onSort={(sort) =>
                setPaging({
                  offset: 0,
                  sort,
                  descending: sort === paging.sort ? !paging.descending : true,
                })
              }
              onSelect={setSelected}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={paging.offset === 0}
              onClick={() => setPaging({ ...paging, offset: Math.max(0, paging.offset - 50) })}
            >
              <T>Previous page</T>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={paging.offset + 50 >= data.totalRows}
              onClick={() => setPaging({ ...paging, offset: paging.offset + 50 })}
            >
              <T>Next page</T>
            </Button>
            <Button size="sm" variant="ghost" onClick={query.refresh}>
              <T>Refresh usage</T>
            </Button>
          </div>
        </>
      )}
      {filters.threadId === undefined ? (
        <Sheet
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <SheetPopup layer="dialog">
            <SheetHeader>
              <SheetTitle>{selected?.title}</SheetTitle>
              <SheetDescription>
                <T>Thread usage for the selected dates, across all models and accounts.</T>
              </SheetDescription>
            </SheetHeader>
            <div className="overflow-auto p-4">
              {selected ? (
                <UsageDetailsQuery
                  key={selected.threadId}
                  environmentId={environmentId}
                  filters={{
                    sinceDay: filters.sinceDay,
                    untilDay: filters.untilDay,
                    threadId: selected.threadId,
                  }}
                />
              ) : null}
            </div>
          </SheetPopup>
        </Sheet>
      ) : null}
    </>
  );
}

function UsageDetailsTable({
  data,
  environmentId,
  sort,
  descending,
  onSort,
  onSelect,
}: {
  readonly data: UsageDetailsResult;
  readonly environmentId: EnvironmentId;
  readonly sort: UsageDetailsInput["sort"];
  readonly descending: boolean;
  readonly onSort: (sort: UsageDetailsInput["sort"]) => void;
  readonly onSelect: (row: UsageDetailsRow) => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const numbers = (row: UsageDetailsResult["totals"]) => (
    <>
      {(
        [
          "uncachedInputTokens",
          "outputTokens",
          "cachedInputTokens",
          "cacheCreationTokens",
          "reasoningTokens",
        ] as const
      ).map((key) => (
        <td key={key} className="px-3 py-2 text-right tabular-nums">
          {formatTokens(row[key])}
        </td>
      ))}
      <td className="px-3 py-2 text-right tabular-nums">{formatCount(row.records, locale)}</td>
      <td className="sticky end-0 bg-background px-3 py-2 text-right tabular-nums">
        {row.unpricedRecords === row.records && row.records > 0
          ? gt("Unpriced")
          : formatUsd(row.costUsd, locale)}
        {row.unpricedRecords > 0 && row.unpricedRecords < row.records ? " +" : ""}
      </td>
    </>
  );
  return (
    <div className="overflow-x-auto" role="region" aria-label={gt("Usage details")} tabIndex={0}>
      <table className="w-full text-sm whitespace-nowrap">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {COLUMNS.map(([key, label]) => (
              <th
                key={key}
                className={key === "cost" ? "sticky end-0 bg-background" : undefined}
                aria-sort={sort === key ? (descending ? "descending" : "ascending") : "none"}
              >
                <Button size="sm" variant="ghost" onClick={() => onSort(key)}>
                  {m(label)}
                  {sort === key ? (descending ? " ↓" : " ↑") : ""}
                </Button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.length === 0 ? (
            <tr>
              <td colSpan={12} className="px-3 py-8 text-left text-muted-foreground">
                <span>
                  <T>No usage is recorded for this filter.</T>
                </span>
              </td>
            </tr>
          ) : (
            data.rows.map((row) => (
              <tr
                key={JSON.stringify([row.day, row.threadId, row.provider, row.account, row.model])}
                className="border-b hover:bg-muted/50"
                onClick={() => onSelect(row)}
              >
                <td className="px-3 py-2">{row.day}</td>
                <td className="max-w-64 truncate px-3 py-2">
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: row.threadId }}
                    onClick={(event) => event.stopPropagation()}
                    className="underline"
                  >
                    {row.title}
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={gt("Inspect thread usage")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(row);
                    }}
                  >
                    <T>Details</T>
                  </Button>
                </td>
                <td className="px-3 py-2">{row.project}</td>
                <td className="px-3 py-2">
                  {row.provider} / {row.account}
                </td>
                <td className="px-3 py-2">{row.model}</td>
                {numbers(row)}
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="border-t font-medium">
            <th colSpan={5} className="px-3 py-3 text-left">
              <T>Filtered totals</T> ({formatCount(data.totalRows, locale)})
            </th>
            {numbers(data.totals)}
          </tr>
        </tfoot>
      </table>
      {data.totals.unpricedRecords > 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          <T>Totals exclude unpriced records. Reasoning tokens are already included in output.</T>
        </p>
      ) : null}
    </div>
  );
}

function ThreadUsageSummary({
  data,
  environmentId,
}: {
  readonly data: UsageDetailsResult;
  readonly environmentId: EnvironmentId;
}) {
  const locale = useLocale();
  const m = useMessages();
  const gt = useGT();
  const figures = (row: UsageDetailsResult["totals"]) => (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {FIGURE_COLUMNS.map(([key, label]) => {
        const values = {
          input: row.uncachedInputTokens,
          output: row.outputTokens,
          cacheRead: row.cachedInputTokens,
          cacheWrite: row.cacheCreationTokens,
          reasoning: row.reasoningTokens,
          records: row.records,
          cost: row.costUsd,
        };
        const value = values[key];
        return (
          <div key={key}>
            <dt className="text-xs text-muted-foreground">{m(label)}</dt>
            <dd className="tabular-nums">
              {key === "cost"
                ? row.unpricedRecords === row.records && row.records > 0
                  ? gt("Unpriced")
                  : formatUsd(value, locale)
                : key === "records"
                  ? formatCount(value, locale)
                  : formatTokens(value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">
          <T>Filtered totals</T>
        </h3>
        {figures(data.totals)}
      </section>
      {data.rows.map((row) => (
        <article
          key={JSON.stringify([row.day, row.provider, row.account, row.model])}
          className="flex flex-col gap-2 border-t pt-3"
        >
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: row.threadId }}
            className="text-sm underline"
          >
            {row.title}
          </Link>
          <p className="text-xs text-muted-foreground">
            {row.day} · {row.project} · {row.provider} / {row.account} · {row.model}
          </p>
          {figures(row)}
        </article>
      ))}
      <p className="text-xs text-muted-foreground">
        <T>Totals exclude unpriced records. Reasoning tokens are already included in output.</T>
      </p>
    </div>
  );
}
