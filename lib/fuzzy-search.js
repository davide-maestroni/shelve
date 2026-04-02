/**
 * Fuzzy search engine for Shelve.
 * Uses a combination of exact substring matching and trigram similarity
 * so typos and partial matches still surface results.
 */

/** Build trigrams from a string */
function trigrams(str) {
  const s = ` ${str.toLowerCase()} `;
  const t = new Set();
  for (let i = 0; i < s.length - 2; i++) t.add(s.slice(i, i + 3));
  return t;
}

/** Trigram similarity ∈ [0, 1] */
function trigramSim(a, b) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/**
 * Scores a string against a query.
 * Returns a score in [0, 1]:  0 = no match, 1 = perfect.
 */
function scoreString(str, query) {
  if (!str) return 0;
  const s = str.toLowerCase();
  const q = query.toLowerCase().trim();
  if (q === '') return 1;

  // Exact substring: highest weight
  if (s.includes(q)) return 1;

  // Word-by-word exact match bonus
  const queryWords = q.split(/\s+/);
  const strWords = s.split(/\s+/);
  let wordMatches = 0;
  for (const qw of queryWords) {
    if (strWords.some(sw => sw.startsWith(qw))) wordMatches++;
  }
  if (queryWords.length > 0) {
    const wordScore = wordMatches / queryWords.length;
    if (wordScore > 0) return 0.7 + 0.3 * wordScore;
  }

  // Trigram fallback
  return trigramSim(s, q) * 0.6;
}

/**
 * Search items against a query string.
 *
 * @param {string} query
 * @param {object[]} items
 * @param {string[]} keys  - property names to search within each item
 * @param {object}   opts
 * @param {number}   [opts.threshold=0.3]   - minimum score to include
 * @param {object}   [opts.weights]          - per-key score multiplier
 * @returns {object[]} items with an added `_score` property, sorted best-first
 */
export function search(query, items, keys, opts = {}) {
  const { threshold = 0.3, weights = {} } = opts;
  if (!query || !query.trim()) return items.map(item => ({ ...item, _score: 1 }));

  const scored = items.map(item => {
    let best = 0;
    for (const key of keys) {
      const val = getNestedValue(item, key);
      if (!val) continue;
      const w = weights[key] ?? 1;
      const s = scoreString(String(val), query) * w;
      if (s > best) best = s;
    }
    return { ...item, _score: best };
  });

  return scored
    .filter(x => x._score >= threshold)
    .sort((a, b) => b._score - a._score);
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : null), obj);
}
