/**
 * Content script injected into pages to extract clean, readable text.
 * Uses a simplified Readability-style algorithm to strip navigation, ads, footers, etc.
 */

(function () {
  // Score element for content likelihood (higher = more likely main content)
  function scoreElement(el) {
    const tag = el.tagName.toLowerCase();
    const cls = (el.className + ' ' + el.id).toLowerCase();
    let score = 0;

    // Tag-based scoring
    const positive = { article: 30, main: 25, section: 15, div: 5, p: 3, td: 3 };
    const negative = { nav: -30, header: -20, footer: -25, aside: -20, form: -20, menu: -15 };
    score += positive[tag] || 0;
    score += negative[tag] || 0;

    // Class/ID-based scoring
    const positiveWords = /article|content|body|text|post|story|blog|main|entry|page/;
    const negativeWords = /nav|menu|sidebar|footer|header|comment|promo|sponsor|banner|advert|social|share|widget|related|subscribe|cookie|popup|modal|overlay/;
    if (positiveWords.test(cls)) score += 20;
    if (negativeWords.test(cls)) score -= 30;

    // Text density: ratio of text to total content
    const text = el.innerText || '';
    const textLen = text.trim().length;
    const linkDensity = getLinkDensity(el);
    score += Math.min(textLen / 100, 15);
    if (linkDensity > 0.5) score -= 20;

    // Paragraph density
    const paragraphs = el.querySelectorAll('p');
    score += Math.min(paragraphs.length * 2, 20);

    return score;
  }

  function getLinkDensity(el) {
    const text = (el.innerText || '').length;
    if (text === 0) return 0;
    let linkText = 0;
    el.querySelectorAll('a').forEach(a => linkText += (a.innerText || '').length);
    return linkText / text;
  }

  function findMainContent() {
    // Try semantic elements first
    const semanticCandidates = ['main', 'article', '[role="main"]', '#content', '.content', '#main', '.main', '.post', '.article', '.entry'];
    for (const sel of semanticCandidates) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').trim().length > 200) return el;
    }

    // Score all block-level containers
    const candidates = Array.from(document.querySelectorAll('div, section, article, main, td'))
      .filter(el => {
        const text = (el.innerText || '').trim();
        return text.length > 100 && el.querySelectorAll('p').length >= 1;
      })
      .map(el => ({ el, score: scoreElement(el) }))
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.el || document.body;
  }

  function cleanNode(node) {
    // Tags to strip entirely
    const stripTags = new Set(['script','style','noscript','iframe','embed','object',
      'nav','header','footer','aside','form','button','input','select','textarea',
      'figure','figcaption']);
    // Class/ID patterns to strip
    const stripPattern = /nav|menu|sidebar|footer|header|advert|promo|banner|social|share|widget|cookie|popup|modal|overlay|comment|subscribe|related|recommend|newsletter/i;

    let clone;
    try {
      clone = node.cloneNode(true);
    } catch (e) {
      // Some nodes (shadow DOM, certain iframes) can't be cloned — skip cleaning
      return node;
    }

    // Remove unwanted elements
    clone.querySelectorAll('*').forEach(el => {
      const tag = el.tagName.toLowerCase();
      const identity = (el.className || '') + ' ' + (el.id || '');
      if (stripTags.has(tag) || stripPattern.test(identity)) {
        el.remove();
      }
    });

    return clone;
  }

  function extractText(el) {
    // Query block-level elements in document order. Using querySelectorAll avoids
    // the double-visit problem of TreeWalker (element + its child text nodes).
    const blocks = el.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, td');
    const seen = new Set();
    const lines = [];

    for (const node of blocks) {
      const text = node.textContent?.trim();
      if (text && text.length > 1 && !seen.has(text)) {
        seen.add(text);
        lines.push(text);
      }
    }

    // Fallback: no block elements found, use full element text
    if (lines.length === 0) {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    return lines.join(' ').replace(/\s+/g, ' ').trim();
  }

  // Scroll to top to ensure thumbnail captures the beginning of the page
  window.scrollTo(0, 0);

  const mainEl = findMainContent();
  const cleaned = cleanNode(mainEl);
  const content = extractText(cleaned);

  // Return structured data to the service worker
  return {
    title: document.title || '',
    content: content.slice(0, 50000), // cap at 50k chars
    metaDescription: (
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      ''
    ).trim(),
    url: location.href,
    success: true,
  };
})();
