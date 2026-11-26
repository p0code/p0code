import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderCredentialStatus,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveProviderInstanceDisplayName(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? humanizeSlug(snapshot.driver);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) return trimmedSnapshotName;
  if (snapshot.instanceId !== defaultInstanceIdForDriver(snapshot.driver)) {
    const humanized = humanizeSlug(snapshot.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

// Hermes lacks Intl.Segmenter, and web and mobile must count the same way: a base character
// keeps its marks, skin tones and ZWJ-joined parts, and a flag is its two regional indicators.
const GRAPHEME_PATTERN =
  /\p{Regional_Indicator}{2}|\P{M}(?:\p{M}|\p{Emoji_Modifier}|\u200d\P{M}(?:\p{M}|\p{Emoji_Modifier})*)*|\p{M}+/gu;

const graphemes = (text: string): ReadonlyArray<string> => text.match(GRAPHEME_PATTERN) ?? [];

export const PROVIDER_INSTANCE_BADGE_MAX_LENGTH = 3;

export function providerInstanceBadgeLength(value: string): number {
  return graphemes(value.trim()).length;
}

export function normalizeProviderInstanceBadge(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return graphemes(trimmed).slice(0, PROVIDER_INSTANCE_BADGE_MAX_LENGTH).join("");
}

function labelWords(label: string): ReadonlyArray<string> {
  // Punctuation separates words so "Codex (hub)" reads CH, not C(. An apostrophe
  // inside a word stays ("Theo's Codex" is TC); a quoting one does not
  // ("Codex 'hub'" is CH). A single camel-case word splits at its humps, so
  // "ClaudeProx" is CP, but "ClaudeProx Work" keeps its own words and is CW.
  const toWords = (text: string) =>
    text
      .split(/\s+/u)
      .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
      .filter(Boolean);
  const words = toWords(label.replace(/[^\P{P}'’]+/gu, " "));
  return words.length === 1 ? toWords(words[0]!.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")) : words;
}

const firstGrapheme = (word: string) => graphemes(word)[0]?.toUpperCase() ?? "";

export function providerInstanceInitials(label: string): string {
  const words = labelWords(label);
  if (words.length === 0) return "";
  if (words.length === 1) return graphemes(words[0]!).slice(0, 2).join("").toUpperCase();
  return words.slice(0, 2).map(firstGrapheme).join("");
}

interface BadgeCandidate {
  readonly instanceId: string;
  readonly isDefault: boolean;
  readonly words: ReadonlyArray<string>;
  readonly initials: string;
}

/** The leading letters before the first word that sets this name apart, then that word's mark. */
function distinguishingBadge(
  candidate: BadgeCandidate,
  rivals: ReadonlyArray<BadgeCandidate>,
): string | undefined {
  const sameWord = (a: string | undefined, b: string | undefined) =>
    a?.toLocaleLowerCase() === b?.toLocaleLowerCase();
  const index = candidate.words.findIndex((word, i) =>
    rivals.some((rival) => !sameWord(word, rival.words[i])),
  );
  if (index < 0) return undefined;
  const word = candidate.words[index]!;
  const digits = word.match(/\p{N}+/u)?.[0];
  const prefix = candidate.words.slice(0, index).map(firstGrapheme);
  if (digits !== undefined) {
    const lead = prefix.length > 0 ? prefix : [firstGrapheme(word)];
    const room = Math.max(1, PROVIDER_INSTANCE_BADGE_MAX_LENGTH - Array.from(digits).length);
    return graphemes([...lead.slice(0, room), digits].join(""))
      .slice(0, PROVIDER_INSTANCE_BADGE_MAX_LENGTH)
      .join("");
  }
  // The first word alone repeats the initials' letters, so it cannot tell two names apart.
  if (index === 0) return undefined;
  return [...prefix.slice(0, PROVIDER_INSTANCE_BADGE_MAX_LENGTH - 1), firstGrapheme(word)].join("");
}

/**
 * The badge each instance shows: the one set in its settings, otherwise its initials, made
 * distinct from every other instance of the same driver ("Claude Work Business" is CWB and
 * "Claude Work 2" is CW2).
 */
export function resolveProviderInstanceBadges(
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "instanceBadge">
  >,
): ReadonlyMap<string, string> {
  const badges = new Map<string, string>();
  const byDriver = new Map<ProviderDriverKind, typeof providers>();
  for (const provider of providers) {
    byDriver.set(provider.driver, [...(byDriver.get(provider.driver) ?? []), provider]);
  }
  for (const group of byDriver.values()) {
    const used = new Set<string>();
    const pending: BadgeCandidate[] = [];
    for (const provider of group) {
      const custom = normalizeProviderInstanceBadge(provider.instanceBadge);
      if (custom !== undefined) {
        badges.set(provider.instanceId, custom);
        used.add(custom);
        continue;
      }
      const name = resolveProviderInstanceDisplayName(provider);
      pending.push({
        instanceId: provider.instanceId,
        isDefault: provider.instanceId === defaultInstanceIdForDriver(provider.driver),
        words: labelWords(name),
        initials: providerInstanceInitials(name),
      });
    }
    const assignUnique = (
      entries: ReadonlyArray<readonly [BadgeCandidate, string | undefined]>,
    ) => {
      const counts = new Map<string, number>();
      for (const [, badge] of entries) {
        if (badge) counts.set(badge, (counts.get(badge) ?? 0) + 1);
      }
      const unassigned: BadgeCandidate[] = [];
      for (const [candidate, badge] of entries) {
        if (badge && counts.get(badge) === 1 && !used.has(badge)) {
          badges.set(candidate.instanceId, badge);
          used.add(badge);
        } else {
          unassigned.push(candidate);
        }
      }
      return unassigned;
    };
    const collided = assignUnique(pending.map((candidate) => [candidate, candidate.initials]));
    const ambiguous = assignUnique(
      collided.map((candidate) => [
        candidate,
        distinguishingBadge(
          candidate,
          collided.filter((rival) => rival !== candidate && rival.initials === candidate.initials),
        ),
      ]),
    );
    ambiguous.sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) || a.instanceId.localeCompare(b.instanceId),
    );
    for (const candidate of ambiguous) {
      let badge = candidate.initials && !used.has(candidate.initials) ? candidate.initials : "";
      const lead = graphemes(candidate.initials)[0] ?? "#";
      for (let n = 2; !badge; n++) {
        if (!used.has(`${lead}${n}`)) badge = `${lead}${n}`;
      }
      badges.set(candidate.instanceId, badge);
      used.add(badge);
    }
  }
  return badges;
}

const EXPIRING_SOON_MS = 24 * 60 * 60 * 1_000;

/** Saved sign-in health, preferring a known expiry over the server's last report. */
export function providerCredentialStatus(
  auth: Pick<ServerProvider["auth"], "credentialStatus" | "expiresAt"> | undefined,
  now: number,
): ProviderCredentialStatus {
  const expiresAt = auth?.expiresAt;
  if (expiresAt) {
    const expiry = Date.parse(expiresAt);
    if (Number.isFinite(expiry)) {
      if (expiry <= now) return "expired";
      return expiry - now <= EXPIRING_SOON_MS ? "expiring" : "valid";
    }
  }
  return auth?.credentialStatus ?? "unknown";
}

/** Who the instance is signed in as, for tooltips that name the account. */
export function providerInstanceAccountDetail(
  auth: Pick<ServerProvider["auth"], "email" | "label"> | undefined,
  credentialStatus: string | undefined = undefined,
): string | undefined {
  const parts = [auth?.email, auth?.label, credentialStatus].filter((part): part is string =>
    Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

export function providerAccentForegroundColor(accentColor: string) {
  const linearChannel = (offset: number) => {
    const value = Number.parseInt(accentColor.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

export function shouldShowInstanceBadge(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly accentColor?: string | undefined;
    readonly instanceBadge?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  },
  entries: Iterable<{
    readonly driverKind: ProviderDriverKind;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  }>,
): boolean {
  if (normalizeProviderAccentColor(entry.accentColor)) return true;
  if (normalizeProviderInstanceBadge(entry.instanceBadge)) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    // Historical threads still need to distinguish accounts that are all disabled.
    if (entry.enabled && !candidate.enabled) continue;
    if (
      entry.driverKind === "acpRegistry" &&
      candidate.acpRegistryAgentId !== entry.acpRegistryAgentId
    ) {
      continue;
    }
    if (++sharedProviderCount > 1) return true;
  }
  return false;
}
