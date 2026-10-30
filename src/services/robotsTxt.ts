/**
 * robots.txt parsing and matching, following Google's rules:
 *  - the group for the crawler's own token wins; "*" only applies when there is none
 *  - rules of several groups for the same agent are merged
 *  - the longest matching pattern wins, and Allow beats Disallow on a tie
 *  - "*" matches any run of characters, a trailing "$" anchors the end
 *  - an empty Disallow allows everything
 */
interface Rule {
  allow: boolean;
  length: number;
  re: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export interface ParsedRobots {
  groups: Group[];
}

function compilePattern(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const directive = m[1].toLowerCase();
    const value = m[2].trim();

    if (directive === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (directive === 'allow' || directive === 'disallow') {
      lastWasAgent = false;
      if (!current || value === '') continue; // empty Disallow = allow all, empty Allow = no-op
      current.rules.push({ allow: directive === 'allow', length: value.length, re: compilePattern(value) });
    }
    // sitemap, crawl-delay, host, ... are ignored and do not end a group
  }
  return { groups };
}

/** May `agentToken` (e.g. "googlebot") fetch `pathAndQuery` (e.g. "/a/b?x=1")? */
export function isPathAllowed(robots: ParsedRobots, agentToken: string, pathAndQuery: string): boolean {
  const token = agentToken.toLowerCase();
  let matched = robots.groups.filter((g) => g.agents.includes(token));
  if (matched.length === 0) matched = robots.groups.filter((g) => g.agents.includes('*'));

  let best: Rule | null = null;
  for (const group of matched) {
    for (const rule of group.rules) {
      if (!rule.re.test(pathAndQuery)) continue;
      if (!best || rule.length > best.length || (rule.length === best.length && rule.allow && !best.allow)) {
        best = rule;
      }
    }
  }
  return best ? best.allow : true;
}
