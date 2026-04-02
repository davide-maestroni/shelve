/**
 * Tab Classification Module — K-Means with TF-IDF
 *
 * ════════════════════════════════════════════════════════════
 *  SWAP POINT — AI-Based Classification
 * ════════════════════════════════════════════════════════════
 * To replace with an AI classifier, export a different object
 * that implements the same interface:
 *
 *   export const Classifier = {
 *     async classify(tabs, existingShelves) { ... },
 *     async assignNewTab(newTab, allTabs, existingShelves) { ... },
 *     async computeFitScores(allTabs, existingShelves) { ... },
 *   };
 * ════════════════════════════════════════════════════════════
 */

import { tokenize, STOP_WORDS, generateId } from './utils.js';
import { Summarizer } from './summarizer.js';

// ─── TF-IDF (sparse Map representation) ──────────────────────────────────────

/** Extracts meaningful tokens from a URL: hostname (minus TLD) + path segments. */
function urlTokens(url) {
  if (!url) return [];
  try {
    const u = new URL(url);
    const hostParts = u.hostname.replace(/^www\./, '').split('.');
    // drop the TLD (last part) unless it's the only part
    const host = hostParts.length > 1 ? hostParts.slice(0, -1) : hostParts;
    const path = u.pathname.split(/[/\-_.]+/).filter(p => p.length > 2);
    return [...host, ...path]
      .map(s => s.toLowerCase())
      .filter(w => !STOP_WORDS.has(w) && w.length > 2);
  } catch {
    return [];
  }
}

function buildCorpus(tabs) {
  return tabs.map(tab => {
    const title   = tokenize(tab.title       || '').filter(w => !STOP_WORDS.has(w) && w.length > 2);
    const url     = urlTokens(tab.url || tab.normalizedUrl || '');
    const favicon = urlTokens(tab.favIconUrl || '');
    const desc    = tokenize(tab.description || '').filter(w => !STOP_WORDS.has(w) && w.length > 2);
    const content = tokenize(tab.content     || '').filter(w => !STOP_WORDS.has(w) && w.length > 2);

    // Weight: title ×4, url ×3, favicon domain ×2, description ×1, content ×1
    return [
      ...title, ...title, ...title, ...title,
      ...url, ...url, ...url,
      ...favicon, ...favicon,
      ...desc,
      ...content,
    ];
  });
}

function computeTfIdf(corpus) {
  const n = corpus.length;
  const df = new Map();
  for (const doc of corpus) {
    for (const word of new Set(doc)) df.set(word, (df.get(word) || 0) + 1);
  }
  return corpus.map(doc => {
    const tf = new Map();
    for (const word of doc) tf.set(word, (tf.get(word) || 0) + 1);
    const vec = new Map();
    for (const [word, count] of tf) {
      const idf = Math.log((n + 1) / ((df.get(word) || 0) + 1));
      vec.set(word, (count / doc.length) * idf);
    }
    return vec;
  });
}

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (const [w, v] of a) { normA += v * v; if (b.has(w)) dot += v * b.get(w); }
  for (const [, v] of b) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Sparse centroid: average of a list of sparse Map vectors. */
function sparseCentroid(vecs) {
  if (vecs.length === 0) return new Map();
  const sum = new Map();
  for (const vec of vecs) {
    for (const [w, v] of vec) sum.set(w, (sum.get(w) || 0) + v);
  }
  const c = new Map();
  for (const [w, v] of sum) c.set(w, v / vecs.length);
  return c;
}

// ─── Cosine K-Means (sparse, with restarts) ───────────────────────────────────

/**
 * K-Means++ on sparse TF-IDF vectors using cosine similarity.
 * Runs `restarts` times and returns the assignment with the lowest inertia.
 */
function cosineKMeans(vecs, k, { iterations = 50, restarts = 5 } = {}) {
  if (vecs.length === 0 || k <= 0) return [];
  k = Math.min(k, vecs.length);

  let bestAssignments = null;
  let bestInertia = Infinity;

  for (let r = 0; r < restarts; r++) {
    // K-Means++ seeding
    const centers = [vecs[Math.floor(Math.random() * vecs.length)]];
    while (centers.length < k) {
      const dists = vecs.map(v => Math.min(...centers.map(c => 1 - cosineSim(v, c))));
      const total  = dists.reduce((a, b) => a + b, 0);
      if (total === 0) { centers.push(vecs[centers.length % vecs.length]); continue; }
      let rnd = Math.random() * total;
      let chosen = vecs.length - 1;
      for (let i = 0; i < vecs.length; i++) { rnd -= dists[i]; if (rnd <= 0) { chosen = i; break; } }
      centers.push(vecs[chosen]);
    }

    let assignments = new Array(vecs.length).fill(0);
    for (let iter = 0; iter < iterations; iter++) {
      // Assign each vector to the nearest centroid (highest cosine similarity)
      const next = vecs.map(v => {
        let best = 0, bestSim = -1;
        for (let c = 0; c < centers.length; c++) {
          const s = cosineSim(v, centers[c]);
          if (s > bestSim) { bestSim = s; best = c; }
        }
        return best;
      });
      // Update centroids (sparse average)
      for (let c = 0; c < centers.length; c++) {
        const members = vecs.filter((_, i) => next[i] === c);
        if (members.length > 0) centers[c] = sparseCentroid(members);
      }
      if (next.every((a, i) => a === assignments[i])) break;
      assignments = next;
    }

    // Inertia = sum of cosine distances to assigned centroid
    const inertia = vecs.reduce((sum, v, i) => sum + (1 - cosineSim(v, centers[assignments[i]])), 0);
    if (inertia < bestInertia) { bestInertia = inertia; bestAssignments = assignments; }
  }

  return bestAssignments;
}

/**
 * Runs cosineKMeans for k values in [kMin, kMax] and returns the assignments
 * with the best (lowest) normalised inertia, avoiding over-splitting.
 */
function bestKMeans(vecs, kHint) {
  if (vecs.length <= 2) return cosineKMeans(vecs, vecs.length);
  const kMin = Math.max(1, kHint - 1);
  const kMax = Math.min(vecs.length, kHint + 2);
  let best = null, bestScore = Infinity;
  for (let k = kMin; k <= kMax; k++) {
    const assignments = cosineKMeans(vecs, k);
    // Normalise inertia by k to penalise trivial over-splitting
    const inertia = vecs.reduce((sum, v, i) => {
      const members = vecs.filter((_, j) => assignments[j] === assignments[i]);
      return sum + (1 - cosineSim(v, sparseCentroid(members)));
    }, 0) / k;
    if (inertia < bestScore) { bestScore = inertia; best = assignments; }
  }
  return best;
}

// ─── Collection title ─────────────────────────────────────────────────────────

function clusterTitle(tabs, tfidfVecs) {
  const termScores = new Map();
  for (const vec of tfidfVecs) {
    for (const [w, v] of vec) termScores.set(w, (termScores.get(w) || 0) + v);
  }
  const topTerms = [...termScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  if (topTerms.length > 0) {
    return topTerms.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' / ');
  }
  const titles = tabs.map(t => t.title).join('. ');
  return Summarizer.summarize(titles, 1) || 'Shelf';
}

// ─── Fit score thresholds ─────────────────────────────────────────────────────

/** A tab is considered "mismatched" when its fit score is below this value. */
export const MISMATCH_THRESHOLD = 0.22;

/**
 * A tab's suggested alternative is shown when another collection's similarity
 * exceeds the current fit by this factor AND exceeds an absolute minimum.
 */
const SUGGEST_FACTOR   = 1.4;
const SUGGEST_MIN_SIM  = 0.15;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Full initial classification via K-Means.
 * Used on first run. After that, use assignNewTab for incremental assignment.
 */
async function classify(tabs, existingShelves = {}) {
  if (tabs.length === 0) return { shelves: [], tabShelfMap: new Map() };

  const corpus    = buildCorpus(tabs);
  const tfidfVecs = computeTfIdf(corpus);

  const hasContent = tfidfVecs.some(v => v.size > 0);
  if (!hasContent) return _fallbackSingleCluster(tabs, existingShelves);

  const k           = Math.max(1, Math.min(10, Math.round(Math.sqrt(tabs.length / 2))));
  const assignments = bestKMeans(tfidfVecs, k);

  const clusters = new Map();
  for (let i = 0; i < tabs.length; i++) {
    const c = assignments[i] ?? 0;
    if (!clusters.has(c)) clusters.set(c, { tabs: [], vecs: [] });
    clusters.get(c).tabs.push(tabs[i]);
    clusters.get(c).vecs.push(tfidfVecs[i]);
  }

  const uncategorized = [];
  const tabShelfMap = new Map();
  const existingTitles = Object.values(existingShelves)
    .filter(s => !s.isUncategorized)
    .map(s => ({ id: s.id, title: (s.customTitle || s.title).toLowerCase() }));

  const newShelves = [];
  for (const [, { tabs: clusterTabs, vecs }] of clusters) {
    const title = clusterTitle(clusterTabs, vecs);
    let matchId = null;
    for (const ex of existingTitles) {
      if (_titleSimilar(ex.title, title.toLowerCase())) { matchId = ex.id; break; }
    }
    const id       = matchId || generateId();
    const existing = existingShelves[id];

    // Outlier detection using cosine distance from cluster centroid
    const centroid  = sparseCentroid(vecs);
    const sims      = vecs.map(v => cosineSim(v, centroid));
    const meanSim   = sims.reduce((a, b) => a + b, 0) / sims.length;
    const threshold = Math.max(0, meanSim - 0.35);
    const kept = [];
    for (let i = 0; i < clusterTabs.length; i++) {
      if (clusterTabs.length > 3 && sims[i] < threshold) uncategorized.push(clusterTabs[i]);
      else kept.push(clusterTabs[i]);
    }
    if (kept.length === 0) { uncategorized.push(...clusterTabs); continue; }
    for (const t of kept) tabShelfMap.set(t.normalizedUrl, id);
    newShelves.push({
      id,
      title,
      customTitle:  existing?.customTitle  ?? null,
      color:        existing?.color        ?? _randomColor(),
      order:        existing?.order        ?? newShelves.length,
      isUncategorized: false,
    });
  }

  const uncatId       = Object.values(existingShelves).find(s => s.isUncategorized)?.id || 'uncategorized';
  const uncatExisting = existingShelves[uncatId];
  for (const t of uncategorized) tabShelfMap.set(t.normalizedUrl, uncatId);
  newShelves.push({
    id: uncatId, title: 'Unshelved', customTitle: null,
    color: uncatExisting?.color ?? '#94a3b8', order: 9999, isUncategorized: true,
  });
  for (const t of tabs) {
    if (!tabShelfMap.has(t.normalizedUrl)) tabShelfMap.set(t.normalizedUrl, uncatId);
  }
  return { shelves: newShelves, tabShelfMap };
}

/**
 * Assigns a single newly archived tab to an existing shelf without
 * disturbing the assignments of any other tab.
 *
 * @param {object}   newTab          - The tab being assigned (already has content/description)
 * @param {object[]} allTabs         - All tabs including the new one
 * @param {object}   existingShelves - Shelf map (id → shelf)
 * @returns {{ shelfId: string, isNewShelf: boolean, fitScore: number }}
 */
async function assignNewTab(newTab, allTabs, existingShelves) {
  const ASSIGN_THRESHOLD = 0.25;

  // Need the whole corpus to get proper IDF weights
  const corpus    = buildCorpus(allTabs);
  const tfidfVecs = computeTfIdf(corpus);
  const newTabIdx = allTabs.findIndex(t => t.normalizedUrl === newTab.normalizedUrl);
  if (newTabIdx === -1) return _fallbackAssignment(existingShelves);

  const newTabVec = tfidfVecs[newTabIdx];

  // Build a sparse centroid for each existing non-uncategorized shelf
  const nonUncatShelves = Object.values(existingShelves).filter(s => !s.isUncategorized);
  const shelfCentroids = new Map(); // shelfId → sparse centroid Map

  for (const shelf of nonUncatShelves) {
    const memberIdxs = allTabs
      .map((t, i) => (t.shelfId === shelf.id ? i : -1))
      .filter(i => i !== -1);
    if (memberIdxs.length === 0) continue;
    shelfCentroids.set(shelf.id, sparseCentroid(memberIdxs.map(i => tfidfVecs[i])));
  }

  if (shelfCentroids.size === 0) {
    // No existing shelves with members — create a new one
    return _createNewShelf(newTab, newTabVec, existingShelves, 1.0);
  }

  // Find best matching shelf
  let bestShelfId = null;
  let bestSim     = -1;
  for (const [shelfId, centroid] of shelfCentroids) {
    const sim = cosineSim(newTabVec, centroid);
    if (sim > bestSim) { bestSim = sim; bestShelfId = shelfId; }
  }

  if (bestSim >= ASSIGN_THRESHOLD) {
    return { shelfId: bestShelfId, isNewShelf: false, fitScore: bestSim, suggestedShelfId: null, newShelf: null };
  }

  // Weak match — check if it's strong enough to justify a new shelf
  // or if it should just go to Uncategorized
  const uncatId = Object.values(existingShelves).find(s => s.isUncategorized)?.id || 'uncategorized';
  if (bestSim < 0.08) {
    // Truly novel — create a new shelf
    return _createNewShelf(newTab, newTabVec, existingShelves, bestSim);
  }
  // Weak similarity — Uncategorized, but record the closest shelf as suggestion
  return { shelfId: uncatId, isNewShelf: false, fitScore: bestSim, suggestedShelfId: bestShelfId, newShelf: null };
}

/**
 * Computes a fit score for every tab in allTabs relative to its current shelf,
 * and identifies a suggested alternative shelf when the tab is a poor fit.
 *
 * @param {object[]} allTabs
 * @param {object}   existingShelves
 * @returns {Map<string, { fitScore: number, suggestedShelfId: string|null }>}
 */
async function computeFitScores(allTabs, existingShelves) {
  const result = new Map();
  if (allTabs.length === 0) return result;

  const corpus    = buildCorpus(allTabs);
  const tfidfVecs = computeTfIdf(corpus);

  // Build sparse centroid per shelf
  const shelfCentroids = new Map();
  for (const shelf of Object.values(existingShelves)) {
    const memberIdxs = allTabs
      .map((t, i) => (t.shelfId === shelf.id ? i : -1))
      .filter(i => i !== -1);
    if (memberIdxs.length === 0) continue;
    shelfCentroids.set(shelf.id, sparseCentroid(memberIdxs.map(i => tfidfVecs[i])));
  }

  for (let i = 0; i < allTabs.length; i++) {
    const tab = allTabs[i];
    const vec = tfidfVecs[i];
    const currentCentroid = shelfCentroids.get(tab.shelfId);
    const fitScore = currentCentroid ? cosineSim(vec, currentCentroid) : 0;

    // Find best alternative
    let bestAltId  = null;
    let bestAltSim = fitScore;
    for (const [shelfId, centroid] of shelfCentroids) {
      if (shelfId === tab.shelfId) continue;
      const shelf = existingShelves[shelfId];
      if (shelf?.isUncategorized) continue;
      const sim = cosineSim(vec, centroid);
      if (sim > bestAltSim) { bestAltSim = sim; bestAltId = shelfId; }
    }

    const isMismatched = fitScore < MISMATCH_THRESHOLD;
    const hasBetterFit = bestAltId && bestAltSim > fitScore * SUGGEST_FACTOR && bestAltSim > SUGGEST_MIN_SIM;

    result.set(tab.normalizedUrl, {
      fitScore,
      suggestedShelfId: (isMismatched || hasBetterFit) ? bestAltId : null,
    });
  }
  return result;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * @typedef {{ shelfId: string, isNewShelf: boolean, fitScore: number,
 *             suggestedShelfId: string|null, newShelf: object|null }} AssignResult
 */

/** @returns {AssignResult} */
function _createNewShelf(tab, tabVec, existingShelves, fitScore) {
  const id    = generateId();
  const title = tab.customTitle || tab.title || 'New Shelf';
  return {
    shelfId: id,
    isNewShelf: true,
    fitScore,
    suggestedShelfId: null,
    newShelf: {
      id, title, customTitle: null, color: _randomColor(),
      order: Object.keys(existingShelves).length, isUncategorized: false,
    },
  };
}

/** @returns {AssignResult} */
function _fallbackAssignment(existingShelves) {
  const uncatId = Object.values(existingShelves).find(s => s.isUncategorized)?.id || 'uncategorized';
  return { shelfId: uncatId, isNewShelf: false, fitScore: 0, suggestedShelfId: null, newShelf: null };
}

function _fallbackSingleCluster(tabs, existingShelves) {
  const id  = Object.values(existingShelves).find(s => s.isUncategorized)?.id || 'uncategorized';
  const map = new Map();
  for (const t of tabs) map.set(t.normalizedUrl, id);
  return { shelves: [{
    id, title: 'Unshelved', customTitle: null,
    color: '#94a3b8', order: 9999, isUncategorized: true,
  }], tabShelfMap: map };
}

function _titleSimilar(a, b) {
  const wa = new Set(a.split(/\s+/));
  const wb = new Set(b.split(/\s+/));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size) > 0.5;
}

const PALETTE = [
  '#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316',
  '#f59e0b','#10b981','#06b6d4','#3b82f6','#84cc16',
];
let _palIdx = 0;
function _randomColor() { return PALETTE[_palIdx++ % PALETTE.length]; }

export const Classifier = { classify, assignNewTab, computeFitScores };
