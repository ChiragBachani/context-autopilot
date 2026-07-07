/**
 * Signal extraction heuristics: which human messages are corrections, and
 * which transcript content is harness noise rather than a human speaking.
 */

/** Strong openers: the message starts by pushing back. */
const CORRECTION_OPENERS =
  /^(no+[,.! ]|nope\b|stop\b|wait\b|wrong\b|hold on\b|not (that|this|what)\b|that'?s (not|wrong)\b|undo\b|revert\b|why (did|are|would) you\b)/i;

/** Softer signals anywhere in the message; require agent activity before it. */
const CORRECTION_PHRASES =
  /\b(don'?t|do not|never|instead of|rather than|i (already )?(said|told|asked)|as i (said|mentioned)|put (it|that|them) back|you (didn'?t|ignored|missed|broke|removed|deleted|changed)|that broke|still (broken|wrong|not working)|not what i (asked|meant|wanted)|go back to)\b/i;

export interface CorrectionContext {
  followsAgentActivity: boolean;
  followsInterrupt: boolean;
}

export function classifyCorrection(text: string, ctx: CorrectionContext): boolean {
  // A correction only makes sense as a reaction to something the agent did.
  // Interrupting the agent counts as activity, but the message itself must
  // still read as a correction — users often interrupt just to queue new work.
  if (!ctx.followsAgentActivity && !ctx.followsInterrupt) return false;
  const head = text.slice(0, 400);
  return CORRECTION_OPENERS.test(head) || CORRECTION_PHRASES.test(head);
}

/**
 * Filter out transcript content that isn't a human speaking: slash-command
 * expansions, system caveats, pasted attachments, and other harness noise.
 */
export function looksLikeInjectedContent(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<') || // <command-name>, <system-reminder>, <task-notification>…
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted') ||
    t.startsWith('API Error') ||
    t.startsWith('Error:')
  );
}

/**
 * Normalize a message for similarity comparison: lowercase, strip code
 * blocks/URLs/punctuation, collapse whitespace, drop stopwords.
 */
const STOPWORDS = new Set(
  ('a an and are as at be but by can could do does for from has have i in is it its just me my of on ' +
    'or our please that the their them then there these this to us was we what when which will with would you your').split(' '),
);

export function normalizeForSimilarity(text: string): string[] {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ');
  return stripped
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Jaccard similarity over word-bigram sets. */
export function similarity(aWords: string[], bWords: string[]): number {
  if (aWords.length < 2 || bWords.length < 2) {
    // Fall back to unigram overlap for very short messages.
    const a = new Set(aWords);
    const b = new Set(bWords);
    return jaccard(a, b);
  }
  return jaccard(bigrams(aWords), bigrams(bWords));
}

function bigrams(words: string[]): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) grams.add(words[i] + ' ' + words[i + 1]);
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}
