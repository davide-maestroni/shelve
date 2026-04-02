/**
 * Shared utility functions for Shelve
 */

/**
 * Normalizes a URL for deduplication.
 * Strips common tracking parameters, trailing slashes, and www prefix.
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    const trackingParams = [
      'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
      'fbclid','gclid','msclkid','_ga','mc_cid','mc_eid','ref','referrer'
    ];
    trackingParams.forEach(p => parsed.searchParams.delete(p));
    let hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    // Sort remaining query params for consistency
    parsed.searchParams.sort();
    const search = parsed.searchParams.toString() ? `?${parsed.searchParams}` : '';
    return `${parsed.protocol}//${hostname}${pathname}${search}`;
  } catch {
    return url.toLowerCase().trim();
  }
}

/**
 * Simple hash of a string → short alphanumeric key suitable as a storage key.
 */
export function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Splits text into sentences.
 */
export function splitSentences(text) {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20 && s.split(/\s+/).length >= 4);
}

/**
 * Tokenizes text into lowercase words, removing punctuation and stop words.
 */
export function tokenize(text, removeStops = false) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
  return removeStops ? words.filter(w => !STOP_WORDS.has(w)) : words;
}

/** Generates a short unique ID. */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Truncates text to maxLength at a word boundary. */
export function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text || '';
  const t = text.slice(0, maxLength);
  const last = t.lastIndexOf(' ');
  return (last > maxLength * 0.7 ? t.slice(0, last) : t) + '…';
}

/** Formats a timestamp as a readable relative string. */
export function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','being','have','has','had','do',
  'does','did','will','would','could','should','may','might','must','can',
  'shall','this','that','these','those','i','you','he','she','it','we','they',
  'what','which','who','when','where','why','how','all','each','every','both',
  'few','more','most','other','some','such','no','not','only','own','same',
  'so','than','too','very','just','because','as','until','while','about',
  'against','between','into','through','during','before','after','above',
  'below','up','down','out','off','over','under','again','then','here',
  'there','once','any','our','your','their','my','its','if','also','get',
  'got','via','per','new','one','two','use','used','using','make','made',
  'take','taken','know','known','like','just','now','even','well','back',
  'way','still','think','come','since','without','need','want','find',
  'give','look','see','say','said','tell','told','go','going','gone','been'
]);
