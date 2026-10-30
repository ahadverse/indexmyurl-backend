import http from 'http';
import zlib from 'zlib';
import { AddressInfo } from 'net';

/** A small fake website on 127.0.0.1 that exhibits every situation the pre-flight scan reports on. */

const WORDS = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');

export const page = (head = '', body = `<p>${WORDS}</p>`): string =>
  `<!doctype html><html><head><title>Test page</title>${head}</head><body>${body}</body></html>`;

const urlset = (locs: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
    .map((l) => `  <url><loc>${l}</loc><lastmod>2026-01-01</lastmod></url>`)
    .join('\n')}\n</urlset>`;

const sitemapIndex = (locs: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
    .map((l) => `  <sitemap><loc>${l}</loc></sitemap>`)
    .join('\n')}\n</sitemapindex>`;

const xml = (res: http.ServerResponse, body: string): void => {
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(body);
};

export interface LocalSite {
  origin: string;
  /** requests received per path */
  hits: Map<string, number>;
  /** highest number of simultaneous requests seen per path */
  maxConcurrent: Map<string, number>;
  close(): Promise<void>;
}

export async function startLocalSite(): Promise<LocalSite> {
  const hits = new Map<string, number>();
  const active = new Map<string, number>();
  const maxConcurrent = new Map<string, number>();

  const html = (res: http.ServerResponse, body: string, status = 200, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const origin = `http://${req.headers.host}`;
    const self = `${origin}${path}`;

    hits.set(path, (hits.get(path) ?? 0) + 1);
    const now = (active.get(path) ?? 0) + 1;
    active.set(path, now);
    maxConcurrent.set(path, Math.max(maxConcurrent.get(path) ?? 0, now));
    res.on('close', () => active.set(path, (active.get(path) ?? 1) - 1));

    switch (path) {
      case '/robots.txt':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(
          'User-agent: *\nDisallow: /private\n\nUser-agent: Googlebot\nDisallow: /g-private\nAllow: /g-private/open$\n'
        );
        return;
      case '/ok':
      case '/private/page': // disallowed for "*", but Googlebot has its own group
      case '/g-private/open':
        return html(res, page());
      case '/g-private/secret':
        return html(res, page());
      case '/noindex-meta':
        return html(res, page('<meta name="robots" content="noindex, follow">'));
      case '/noindex-googlebot-meta':
        return html(res, page('<meta name="googlebot" content="none">'));
      case '/noindex-header':
        return html(res, page(), 200, { 'X-Robots-Tag': 'noindex' });
      case '/googlebot-header':
        return html(res, page(), 200, { 'X-Robots-Tag': 'googlebot: noindex, nofollow' });
      case '/bingbot-header':
        return html(res, page(), 200, { 'X-Robots-Tag': 'bingbot: noindex' });
      case '/404':
        return html(res, 'nope', 404);
      case '/410':
        return html(res, 'gone', 410);
      case '/401':
        return html(res, 'login', 401);
      case '/403':
        return html(res, 'forbidden', 403);
      case '/429':
        return html(res, 'slow down', 429);
      case '/500':
        return html(res, 'boom', 500);
      case '/redirect':
        res.writeHead(301, { Location: '/ok' });
        return void res.end();
      case '/redirect-chain':
        res.writeHead(302, { Location: '/redirect' });
        return void res.end();
      case '/loop-a':
        res.writeHead(302, { Location: '/loop-b' });
        return void res.end();
      case '/loop-b':
        res.writeHead(302, { Location: '/loop-a' });
        return void res.end();
      case '/canonical-other':
        return html(res, page(`<link rel="canonical" href="/ok">`));
      case '/canonical-self':
        return html(res, page(`<link rel="canonical" href="${self}">`));
      case '/canonical-relative-self':
        return html(res, page(`<link rel="canonical" href="/canonical-relative-self">`));
      case '/thin':
        return html(res, page('', '<p>Just a few words here.</p>'));
      case '/gzip':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        return void res.end(zlib.gzipSync(page()));
      case '/brotli':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' });
        return void res.end(zlib.brotliCompressSync(page()));
      case '/pdf':
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return void res.end('%PDF-1.4 ...');
      case '/jobposting':
        return html(
          res,
          page('<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"x"}</script>')
        );
      // ─── sitemaps ───
      case '/sitemap.xml':
        return xml(
          res,
          urlset([
            `${origin}/ok`,
            `${origin}/404`,
            `${origin}/a?x=1&amp;y=2`, // XML-escaped ampersand
            `<![CDATA[${origin}/cdata]]>`,
            'https://elsewhere.example/page', // another website: must be ignored
            'ftp://files.example/x', // not http(s): must be ignored
          ])
        );
      case '/sitemap-redirect.xml':
        res.writeHead(301, { Location: '/sitemap.xml' });
        return void res.end();
      case '/sitemap-index.xml':
        return xml(res, sitemapIndex([`${origin}/sitemap-a.xml`, `${origin}/sitemap-b.xml`, `${origin}/sitemap-missing.xml`]));
      case '/sitemap-a.xml':
        return xml(res, urlset([`${origin}/a1`, `${origin}/a2`, `${origin}/shared`]));
      case '/sitemap-b.xml':
        return xml(res, urlset([`${origin}/b1`, `${origin}/shared`]));
      case '/sitemap-loop.xml':
        return xml(res, sitemapIndex([`${origin}/sitemap-loop.xml`, `${origin}/sitemap-a.xml`]));
      case '/sitemap.xml.gz':
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        return void res.end(zlib.gzipSync(urlset([`${origin}/gz1`, `${origin}/gz2`])));
      case '/sitemap-broken.xml.gz':
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        return void res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]));
      case '/sitemap.txt':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return void res.end(`${origin}/t1\n${origin}/t2\n`);
      case '/sitemap-huge.xml':
        return xml(res, urlset(Array.from({ length: 700 }, (_, i) => `${origin}/p/${i}`)));
      case '/sitemap-foreign.xml':
        return xml(res, urlset(['https://elsewhere.example/1', 'https://elsewhere.example/2']));
      case '/sitemap-empty.xml':
        return xml(res, urlset([]));
      case '/delay':
        setTimeout(() => html(res, page()), 80);
        return;
      case '/slower':
        setTimeout(() => html(res, page()), 600);
        return;
      case '/hang':
        return; // never answers
      case '/big':
      case '/big-empty': {
        // far more than the scanner reads; the noindex tag sits in the part it does read
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write(
          path === '/big'
            ? '<html><head><title>Big</title><meta name="robots" content="noindex"></head><body>'
            : '<html><head><title>Big</title></head><body>'
        );
        const chunk = path === '/big' ? `<p>${'lorem '.repeat(2000)}</p>` : '<div></div>'.repeat(2000);
        let sent = 0;
        const pump = (): void => {
          while (sent < 1000) {
            if (res.destroyed) return;
            sent++;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        pump();
        return;
      }
      default:
        return html(res, 'not found', 404);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    maxConcurrent,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
