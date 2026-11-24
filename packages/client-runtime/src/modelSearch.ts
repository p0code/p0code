import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

export type ModelPickerSearchableModel = {
  driverKind: string;
  providerDisplayName: string;
  name: string;
  slug?: string;
  shortName?: string;
  subProvider?: string;
  isFavorite?: boolean;
};

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;
const MODEL_PICKER_EXACT_NAME_SCORE = -1000;

/**
 * Normalizes model search text so separators (`-`, `_`, `.`, `/`, `:`) and
 * whitespace are interchangeable: "claude-sonnet-4.5", "claude:sonnet 4.5" and
 * "Claude Sonnet 4.5" all collapse to the same space-separated tokens.
 */
function normalizeModelSearchText(input: string): string {
  return normalizeSearchQuery(input)
    .replace(/[-_./:+]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  return normalizeModelSearchText(
    [model.name, model.shortName, model.slug, model.subProvider]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

/**
 * Driver kinds and provider display names are identities ("opencode"), so a
 * query token may only match them at a prefix or word boundary. A bare
 * subsequence such as "code" or "ode" must never surface every OpenCode model.
 */
function scoreIdentityFieldToken(field: string, token: string, fieldBase: number): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    ignorePosition: true,
  });
}

function scoreModelPickerSearchToken(
  field: string,
  token: string,
  fieldBase: number,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
    ignorePosition: true,
  });
}

/**
 * Fields are ordered by weight: name and slug rank highest, driver kind and
 * provider display name only rank below every real model text.
 */
function getModelPickerSearchFields(model: ModelPickerSearchableModel): Array<{
  text: string;
  base: number;
  identity: boolean;
}> {
  const fields: Array<{ text: string; base: number; identity: boolean }> = [
    { text: normalizeModelSearchText(model.name), base: 0, identity: false },
    ...(model.slug
      ? [{ text: normalizeModelSearchText(model.slug), base: 10, identity: false }]
      : []),
    ...(model.shortName
      ? [{ text: normalizeModelSearchText(model.shortName), base: 20, identity: false }]
      : []),
    ...(model.subProvider
      ? [{ text: normalizeModelSearchText(model.subProvider), base: 30, identity: false }]
      : []),
    { text: buildModelPickerSearchText(model), base: 40, identity: false },
    { text: normalizeModelSearchText(model.driverKind), base: 50, identity: true },
    { text: normalizeModelSearchText(model.providerDisplayName), base: 60, identity: true },
  ];
  return fields;
}

export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  query: string,
): number | null {
  const tokens = normalizeModelSearchText(query)
    .split(" ")
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return 0;
  }

  const normalizedQuery = tokens.join(" ");
  if (
    normalizedQuery === normalizeModelSearchText(model.name) ||
    (model.shortName !== undefined && normalizedQuery === normalizeModelSearchText(model.shortName))
  ) {
    return MODEL_PICKER_EXACT_NAME_SCORE;
  }

  const fields = getModelPickerSearchFields(model);
  let score = 0;

  for (const token of tokens) {
    let bestTokenScore: number | null = null;
    for (const field of fields) {
      const fieldScore = field.identity
        ? scoreIdentityFieldToken(field.text, token, field.base)
        : scoreModelPickerSearchToken(field.text, token, field.base);
      if (fieldScore !== null && (bestTokenScore === null || fieldScore < bestTokenScore)) {
        bestTokenScore = fieldScore;
      }
    }

    if (bestTokenScore === null) {
      return null;
    }

    score += bestTokenScore;
  }

  return model.isFavorite ? score - MODEL_PICKER_FAVORITE_SCORE_BOOST : score;
}

export function rankModelPickerSearch<T>(
  items: ReadonlyArray<T>,

  query: string,
  toSearchable: (item: T) => ModelPickerSearchableModel,
): T[] {
  const ranked: Array<{
    item: T;
    score: number;
    isFavorite: boolean;
    order: number;
  }> = [];
  items.forEach((item, order) => {
    const searchable = toSearchable(item);
    const score = scoreModelPickerSearch(searchable, query);
    if (score !== null) {
      ranked.push({
        item,
        score,
        isFavorite: searchable.isFavorite === true,
        order,
      });
    }
  });
  return ranked
    .sort(
      (a, b) =>
        a.score - b.score || Number(b.isFavorite) - Number(a.isFavorite) || a.order - b.order,
    )
    .map((entry) => entry.item);
}
