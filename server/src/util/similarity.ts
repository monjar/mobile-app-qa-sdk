/**
 * "Similar tickets": a cheap score for how likely two reports describe the
 * same problem, computed on read over a few hundred recent open tickets. No
 * index, no model: word overlap plus where the reports came from.
 *
 *   0.6 × Jaccard of title + description words
 *   0.2 same screen (both known)
 *   0.1 same platform, app version and build
 *   0.05 same platform
 *   0.05 same report type
 */

export interface SimilarityInput {
  title: string;
  description: string;
  screen: string | null;
  platform: string;
  appVersion: string;
  appBuild: string;
  type: string;
}

export interface SimilarityScore {
  /** 0–1, rounded to two decimals. */
  score: number;
  reasons: string[];
}

export const SIMILAR_MIN_SCORE = 0.35;
export const SIMILAR_LIMIT = 5;
/** Word overlap from which "similar description" is worth saying. */
const DESCRIPTION_REASON_MIN = 0.2;

const STOPWORDS = new Set(
  (
    'the and for are but not you all any can had her was one our out has have him his how its may now see who did get got ' +
    'let say she too use that with this from they will would there their what about which when where while then than them ' +
    'these those been were into your some could should also after before just only very more most other such because over ' +
    'under again once here does doing being each both few off own same why yes able'
  ).split(' '),
);

/** Lowercased words of at least 3 letters or digits, minus stopwords. */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) if (!STOPWORDS.has(m[0])) out.add(m[0]);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Scores `b` against `a`. `aWords` lets a caller tokenize the ticket being compared once. */
export function similarity(a: SimilarityInput, b: SimilarityInput, aWords = words(`${a.title} ${a.description}`)): SimilarityScore {
  const text = jaccard(aWords, words(`${b.title} ${b.description}`));
  const sameScreen = a.screen !== null && b.screen !== null && a.screen === b.screen;
  const samePlatform = a.platform === b.platform;
  const sameBuild = samePlatform && a.appVersion === b.appVersion && a.appBuild === b.appBuild;
  const sameType = a.type === b.type;
  const score = 0.6 * text + (sameScreen ? 0.2 : 0) + (sameBuild ? 0.1 : 0) + (samePlatform ? 0.05 : 0) + (sameType ? 0.05 : 0);
  const reasons: string[] = [];
  if (text >= DESCRIPTION_REASON_MIN) reasons.push('similar description');
  if (sameScreen) reasons.push('same screen');
  if (sameBuild) reasons.push('same build');
  else if (samePlatform) reasons.push('same platform');
  if (sameType) reasons.push('same type');
  return { score: Math.round(score * 100) / 100, reasons };
}

/** The best matches for `target` among `candidates`: score ≥ 0.35, best first, at most five. */
export function rankSimilar<T extends SimilarityInput>(target: SimilarityInput, candidates: T[]): (SimilarityScore & { item: T })[] {
  const targetWords = words(`${target.title} ${target.description}`);
  return candidates
    .map((item) => ({ item, ...similarity(target, item, targetWords) }))
    .filter((m) => m.score >= SIMILAR_MIN_SCORE)
    .sort((x, y) => y.score - x.score)
    .slice(0, SIMILAR_LIMIT);
}
