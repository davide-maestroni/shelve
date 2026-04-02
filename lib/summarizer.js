/**
 * Text Summarization Module — TextRank (extractive)
 *
 * ════════════════════════════════════════════════════════════
 *  SWAP POINT — AI-Based Summarization
 * ════════════════════════════════════════════════════════════
 * To replace with an AI summarizer, export a different object
 * from this file that implements the same interface:
 *
 *   export const Summarizer = {
 *     async summarize(text, numSentences = 3) {
 *       const res = await fetch('https://api.anthropic.com/v1/messages', {
 *         method: 'POST',
 *         headers: {
 *           'x-api-key': await getApiKey(),
 *           'anthropic-version': '2023-06-01',
 *           'content-type': 'application/json',
 *         },
 *         body: JSON.stringify({
 *           model: 'claude-haiku-4-5-20251001',
 *           max_tokens: 150,
 *           messages: [{
 *             role: 'user',
 *             content: `Summarize in ${numSentences} sentences:\n\n${text.slice(0, 4000)}`
 *           }]
 *         })
 *       });
 *       const data = await res.json();
 *       return data.content[0].text;
 *     }
 *   };
 * ════════════════════════════════════════════════════════════
 */

import { splitSentences } from './utils.js';

function tokenizeForSim(sentence) {
  return new Set(
    sentence.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * TextRank extractive summarizer.
 * @param {string} text
 * @param {number} numSentences
 * @returns {string}
 */
function summarize(text, numSentences = 3) {
  if (!text || text.trim().length < 50) return (text || '').trim();

  const sentences = splitSentences(text);
  if (sentences.length === 0) return '';
  if (sentences.length <= numSentences) return sentences.join(' ');

  const tokenSets = sentences.map(tokenizeForSim);
  const n = sentences.length;

  // Build similarity matrix
  const matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? 0 : jaccardSimilarity(tokenSets[i], tokenSets[j])
    )
  );

  // Row-normalize
  for (let i = 0; i < n; i++) {
    const sum = matrix[i].reduce((a, b) => a + b, 0);
    if (sum > 0) matrix[i] = matrix[i].map(v => v / sum);
  }

  // PageRank
  const d = 0.85;
  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < 30; iter++) {
    const next = new Array(n).fill((1 - d) / n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        next[i] += d * matrix[j][i] * scores[j];
      }
    }
    scores = next;
  }

  // Select top-N by score, output in original order
  const top = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .slice(0, numSentences)
    .map(x => x.i)
    .sort((a, b) => a - b);

  return top.map(i => sentences[i]).join(' ');
}

export const Summarizer = { summarize };
