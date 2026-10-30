/**
 * Indexing-relevant signals pulled out of the first part of an HTML document.
 * Pure string work (no DOM), so it is cheap enough to run on every scanned URL.
 */
export interface HtmlSignals {
  title: string | null;
  /** a robots/googlebot meta tag says noindex (or none) */
  metaNoindex: boolean;
  /** raw href of <link rel="canonical">, if any */
  canonical: string | null;
  /** visible words in the part of the document that was read */
  wordCount: number;
  /** schema.org @type values found in JSON-LD blocks (e.g. JobPosting, BroadcastEvent) */
  jsonLdTypes: string[];
}

const VALUE_DIRECTIVES = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);

/**
 * Does a robots directive string (X-Robots-Tag header value or meta content) tell Google
 * not to index? Handles "noindex", "none", lists, and a leading "googlebot:" agent prefix;
 * a directive addressed to another crawler (e.g. "bingbot: noindex") does not count.
 */
export function robotsValueBlocksIndexing(value: string, botToken = 'googlebot'): boolean {
  let v = value.trim().toLowerCase();
  if (!v) return false;
  const prefixed = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(v);
  if (prefixed && !VALUE_DIRECTIVES.has(prefixed[1])) {
    if (prefixed[1] !== botToken) return false;
    v = prefixed[2];
  }
  return v.split(',').some((token) => {
    const directive = token.trim();
    return directive === 'noindex' || directive === 'none';
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function collectTypes(node: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || into.size >= 30 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, into, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  for (const t of Array.isArray(type) ? type : [type]) {
    if (typeof t === 'string') into.add(t.replace(/^.*[/#]/, ''));
  }
  for (const value of Object.values(obj)) collectTypes(value, into, depth + 1);
}

export function extractHtmlSignals(html: string): HtmlSignals {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const headEnd = noComments.search(/<\/head\s*>/i);
  const head = headEnd >= 0 ? noComments.slice(0, headEnd) : noComments;

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;

  let metaNoindex = false;
  let canonical: string | null = null;
  const tagRe = /<(meta|link)\b([^>]*)>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(head))) {
    const attrs = parseAttributes(tag[2]);
    if (tag[1].toLowerCase() === 'meta') {
      const name = (attrs.name ?? '').toLowerCase();
      if ((name === 'robots' || name === 'googlebot') && robotsValueBlocksIndexing(attrs.content ?? '')) {
        metaNoindex = true;
      }
    } else if (canonical === null && (attrs.rel ?? '').toLowerCase().split(/\s+/).includes('canonical') && attrs.href) {
      canonical = attrs.href.trim();
    }
  }

  const types = new Set<string>();
  const ldRe = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let ld: RegExpExecArray | null;
  while ((ld = ldRe.exec(noComments))) {
    try {
      collectTypes(JSON.parse(ld[1]), types);
    } catch {
      /* malformed JSON-LD: ignore */
    }
  }

  const bodyStart = noComments.search(/<body\b/i);
  const text = (bodyStart >= 0 ? noComments.slice(bodyStart) : noComments.slice(headEnd >= 0 ? headEnd : 0))
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  const wordCount = decodeEntities(text)
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

  return { title, metaNoindex, canonical, wordCount, jsonLdTypes: [...types] };
}
