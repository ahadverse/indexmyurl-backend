const DOMAIN_PREFIX = 'sc-domain:';

/**
 * The Search Console property that covers `url`, or null when none does.
 *
 * Two kinds of property exist, and the URL Inspection API needs the exact identifier:
 *  - Domain property  `sc-domain:example.com`: every protocol and every subdomain
 *  - URL-prefix property  `https://example.com/blog/`: only URLs that start with it, so
 *    `http://` vs `https://`, `www` vs bare and a path are all different properties
 *
 * Matching is by the real URL, never by substring: `sc-domain:notexample.com` must not
 * count for `example.com`. A domain property wins over a URL-prefix one (it is the
 * broadest and survives protocol/subdomain changes); among prefixes the longest wins.
 */
export function matchProperty(properties: readonly string[], url: string): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const host = target.hostname.toLowerCase();

  let domainMatch: string | null = null;
  let domainLength = -1;
  let prefixMatch: string | null = null;
  let prefixLength = -1;

  for (const property of properties) {
    if (property.startsWith(DOMAIN_PREFIX)) {
      const domain = property.slice(DOMAIN_PREFIX.length).toLowerCase();
      if (!domain) continue;
      if ((host === domain || host.endsWith(`.${domain}`)) && domain.length > domainLength) {
        domainMatch = property;
        domainLength = domain.length;
      }
      continue;
    }

    let prefix: string;
    try {
      prefix = new URL(property).href;
    } catch {
      continue; // not a property we understand
    }
    if (target.href.startsWith(prefix) && prefix.length > prefixLength) {
      prefixMatch = property;
      prefixLength = prefix.length;
    }
  }

  return domainMatch ?? prefixMatch;
}
