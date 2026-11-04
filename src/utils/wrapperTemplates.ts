import crypto from 'crypto';

/**
 * Wrapper page templates.
 *
 * A wrapper is the small public page Googlebot fetches after the Indexing API is notified. There are
 * two kinds, matching the two page types the Indexing API accepts:
 *   - "job"        announced with JobPosting markup
 *   - "livestream" announced with VideoObject + BroadcastEvent markup
 *
 * Every template produces a complete, well-formed page (semantic landmarks, meta description,
 * canonical, Open Graph, JSON-LD, responsive CSS) with its own structure, copy and colour scheme, so
 * the wrappers of one URL — and of different URLs — are not copies of each other.
 *
 * All text is built here as plain strings and escaped once, by the renderer in htmlGenerator.ts.
 * Nothing user-controlled is ever concatenated into markup by a template.
 */

export type WrapperKind = 'job' | 'livestream';

/** Wrappers announced as a JobPosting. */
export const JOB_TEMPLATE_IDS = ['listing', 'bulletin', 'profile', 'digest', 'notice'] as const;
/** Wrappers announced as a livestream. */
export const LIVE_TEMPLATE_IDS = [
  'live-now',
  'live-session',
  'live-event',
  'live-schedule',
  'live-premiere',
  'live-studio',
  'live-roundtable',
  'live-briefing',
] as const;

export const WRAPPER_TEMPLATE_IDS = [...JOB_TEMPLATE_IDS, ...LIVE_TEMPLATE_IDS] as const;
export type WrapperTemplateId = (typeof WRAPPER_TEMPLATE_IDS)[number];

export function isWrapperTemplateId(value: unknown): value is WrapperTemplateId {
  return typeof value === 'string' && (WRAPPER_TEMPLATE_IDS as readonly string[]).includes(value);
}

export function kindOfTemplate(id: WrapperTemplateId): WrapperKind {
  return (LIVE_TEMPLATE_IDS as readonly string[]).includes(id) ? 'livestream' : 'job';
}

/** Stable template for a seed (same seed → same template). Used when nothing else is known. */
export function pickTemplateId(seed: string, offset = 0): WrapperTemplateId {
  const n = crypto.createHash('sha1').update(seed).digest().readUInt32BE(0);
  return WRAPPER_TEMPLATE_IDS[(n + Math.max(0, offset)) % WRAPPER_TEMPLATE_IDS.length];
}

/**
 * Random template for a job's next wrapper (its first, an extra, or the new one a retry makes).
 *
 *  - never one the job already used, until all of them have been used (then anything but the last);
 *  - the first wrapper is a job posting or a livestream with equal chance;
 *  - after that, 70% of the time the other kind than the previous wrapper, so a job's wrappers mix
 *    both kinds instead of showing Google the same shape again and again.
 *
 * `used` holds the templates of the job's earlier wrappers, oldest first. `rng` is injectable for tests.
 */
export function chooseTemplateId(
  used: readonly string[] = [],
  rng: () => number = Math.random
): WrapperTemplateId {
  const known = used.filter(isWrapperTemplateId);
  const usedSet = new Set<string>(known);
  const last = known.length > 0 ? known[known.length - 1] : undefined;
  const other = (k: WrapperKind): WrapperKind => (k === 'job' ? 'livestream' : 'job');
  const unusedOfKind = (k: WrapperKind): WrapperTemplateId[] =>
    WRAPPER_TEMPLATE_IDS.filter((id) => kindOfTemplate(id) === k && !usedSet.has(id));

  let kind: WrapperKind = rng() < 0.5 ? 'job' : 'livestream';
  if (last) kind = rng() < 0.7 ? other(kindOfTemplate(last)) : kindOfTemplate(last);

  let candidates = unusedOfKind(kind);
  if (candidates.length === 0) candidates = unusedOfKind(other(kind)); // that kind is used up
  if (candidates.length === 0) candidates = WRAPPER_TEMPLATE_IDS.filter((id) => id !== last);
  return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
}

// ─── Content model ────────────────────────────────────────────────────

/** A piece of paragraph text: plain, or a link to the original page / the site root. */
export type Seg = string | { link: 'original' | 'site'; text: string };

export type Block =
  | { type: 'p'; segs: Seg[] }
  | { type: 'list'; items: Seg[][]; ordered?: boolean }
  | { type: 'facts'; rows: Array<[label: string, value: Seg[]]> };

export interface Section {
  heading: string;
  blocks: Block[];
}

export interface TemplateContent {
  title: string;
  kicker: string;
  h1: string;
  /** Paragraphs under the heading */
  lede: Seg[][];
  sections: Section[];
  /** The JobPosting's title and description, or the livestream's name and description */
  data: { title: string; description: string };
}

export interface TemplateContext {
  /** Hostname without "www." — plain text, escaped by the renderer */
  org: string;
  /** Readable name of the page taken from its URL path, or '' */
  label: string;
  /** Which refresh of the page this is (0 = first). Rotates the opening paragraph. */
  revision: number;
  postedHuman: string;
  modifiedHuman: string;
  /** "November 4, 2026, 10:00–11:30 UTC": the broadcast window of a livestream wrapper */
  windowHuman: string;
}

type Layout = 'card' | 'banner' | 'split' | 'plain' | 'leftbar';
export type Theme = 'indigo' | 'slate' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky' | 'teal';

export interface TemplateDef {
  id: WrapperTemplateId;
  kind: WrapperKind;
  layout: Layout;
  theme: Theme;
  /** Livestreams only: length of the broadcast window that starts when the wrapper is published */
  durationMinutes?: number;
  build(ctx: TemplateContext): TemplateContent;
}

export const THEMES: Record<Theme, { accent: string; soft: string; dark: string }> = {
  indigo: { accent: '#4f46e5', soft: '#eef2ff', dark: '#312e81' },
  slate: { accent: '#334155', soft: '#f1f5f9', dark: '#0f172a' },
  emerald: { accent: '#047857', soft: '#ecfdf5', dark: '#064e3b' },
  amber: { accent: '#b45309', soft: '#fffbeb', dark: '#78350f' },
  rose: { accent: '#be123c', soft: '#fff1f2', dark: '#881337' },
  violet: { accent: '#7c3aed', soft: '#f5f3ff', dark: '#4c1d95' },
  sky: { accent: '#0369a1', soft: '#f0f9ff', dark: '#0c4a6e' },
  teal: { accent: '#0f766e', soft: '#f0fdfa', dark: '#134e4a' },
};

// ─── Shared copy helpers ──────────────────────────────────────────────

const pick = <T>(options: readonly T[], revision: number): T => options[revision % options.length];

const original = (text: string): Seg => ({ link: 'original', text });
const site = (text: string): Seg => ({ link: 'site', text });
const para = (...segs: Seg[]): Block => ({ type: 'p', segs });

/** The facts a job wrapper shows; they match the JobPosting markup. */
function jobFacts(ctx: TemplateContext): Array<[string, Seg[]]> {
  return [
    ['Organization', [site(ctx.org)]],
    ['Employment type', ['Full-time']],
    ['Location', ['United States']],
    ['Listed', [ctx.postedHuman]],
    ['Last updated', [ctx.modifiedHuman]],
  ];
}

/** The facts a livestream wrapper shows; they match the BroadcastEvent markup. */
function liveFacts(ctx: TemplateContext): Array<[string, Seg[]]> {
  return [
    ['Broadcaster', [site(ctx.org)]],
    ['Format', ['Live broadcast']],
    ['Broadcast window', [ctx.windowHuman]],
    ['Language', ['English']],
    ['Last updated', [ctx.modifiedHuman]],
  ];
}

const about = (ctx: TemplateContext): string =>
  ctx.label
    ? `The listing, “${ctx.label}”, is published on the organization’s own website.`
    : 'The listing is published on the organization’s own website.';

const topic = (ctx: TemplateContext): string => (ctx.label ? ` about “${ctx.label}”` : '');
const withLabel = (ctx: TemplateContext, text: string): string => (ctx.label ? `${ctx.label} — ${text}` : text);

// ─── Job templates (JobPosting) ───────────────────────────────────────

const JOB_TEMPLATES: Record<(typeof JOB_TEMPLATE_IDS)[number], TemplateDef> = {
  listing: {
    id: 'listing',
    kind: 'job',
    layout: 'card',
    theme: 'indigo',
    build: (ctx) => ({
      title: ctx.label ? `${ctx.label} — Opportunity at ${ctx.org}` : `Opportunity at ${ctx.org}`,
      kicker: 'Featured listing',
      h1: `Opportunity at ${ctx.org}`,
      lede: [
        pick(
          [
            [`${ctx.org} has published a new opportunity. The full description, requirements and contact details are on the `, original('original page'), '.'],
            [`This listing from ${ctx.org} has been refreshed. The `, original('original page'), ' remains the most complete and current source for every detail.'],
          ],
          ctx.revision
        ),
      ],
      sections: [
        { heading: 'At a glance', blocks: [{ type: 'facts', rows: jobFacts(ctx) }] },
        {
          heading: 'About this opportunity',
          blocks: [para(`${ctx.org} is growing its team. ${about(ctx)} This page summarizes it; the original page carries the authoritative details.`)],
        },
        {
          heading: 'Read the full details',
          blocks: [para('Open the ', original(`complete listing at ${ctx.org}`), '. Details can change there at any time.')],
        },
      ],
      data: {
        title: 'Professional Opportunity',
        description: `${ctx.org} has published a new opportunity. The full description, requirements and contact details are available on the original listing page.`,
      },
    }),
  },

  bulletin: {
    id: 'bulletin',
    kind: 'job',
    layout: 'banner',
    theme: 'slate',
    build: (ctx) => ({
      title: `Listing update${ctx.label ? `: ${ctx.label}` : ''} | ${ctx.org}`,
      kicker: 'Listing update',
      h1: ctx.label ? `${ctx.label}: a listing update from ${ctx.org}` : `A listing update from ${ctx.org}`,
      lede: [
        pick(
          [
            [`${ctx.org} has posted an update to one of its listings. Here is a short summary, with a link to the `, original('source page'), '.'],
            [`There is fresh activity on a listing from ${ctx.org}. The `, original('source page'), ' has the complete and current information.'],
          ],
          ctx.revision
        ),
      ],
      sections: [
        {
          heading: 'What’s new',
          blocks: [
            {
              type: 'list',
              items: [
                [`${ctx.org} published or refreshed a listing`],
                ['Employment type: full-time'],
                ['Location: United States'],
                [`Updated ${ctx.modifiedHuman}`],
              ],
            },
          ],
        },
        {
          heading: 'Where to read more',
          blocks: [para(about(ctx), ' Continue to the ', original('original listing'), ' for the full text.')],
        },
      ],
      data: {
        title: 'Career Opportunity',
        description: `${ctx.org} has posted an update to one of its listings. The source page has the complete and current information.`,
      },
    }),
  },

  profile: {
    id: 'profile',
    kind: 'job',
    layout: 'split',
    theme: 'emerald',
    build: (ctx) => ({
      title: `${ctx.org} — Careers and open opportunities`,
      kicker: 'Organization profile',
      h1: `${ctx.org}: careers and opportunities`,
      lede: [
        pick(
          [
            [`A quick profile of ${ctx.org} and its current opportunity, with everything you need to continue to the `, original('original listing'), '.'],
            [`${ctx.org} is hiring. This profile gives the essentials; the `, original('original listing'), ' has the rest.'],
          ],
          ctx.revision
        ),
      ],
      sections: [
        {
          heading: `About ${ctx.org}`,
          blocks: [para(`${ctx.org} publishes its opportunities on `, site('its own website'), '. This page is a short summary of the latest one.')],
        },
        { heading: 'Quick facts', blocks: [{ type: 'facts', rows: jobFacts(ctx) }] },
        {
          heading: 'Current opportunity',
          blocks: [para(about(ctx), ' Requirements and how to get in touch are on the ', original('listing page'), '.')],
        },
        {
          heading: 'Continue to the source',
          blocks: [para('For the authoritative version, go to the ', original(`page at ${ctx.org}`), '.')],
        },
      ],
      data: {
        title: 'Team Opportunity',
        description: `${ctx.org} is hiring. This profile summarizes its current opportunity; the original listing has the full description and requirements.`,
      },
    }),
  },

  digest: {
    id: 'digest',
    kind: 'job',
    layout: 'plain',
    theme: 'amber',
    build: (ctx) => ({
      title: `Opportunity digest: ${ctx.org}${ctx.label ? ` · ${ctx.label}` : ''}`,
      kicker: 'Opportunity digest',
      h1: `Opportunity digest — ${ctx.org}`,
      lede: [
        pick(
          [
            [`One listing from ${ctx.org}, summarized in a few lines. The `, original('source page'), ' is the place for the full text.'],
            [`The latest from ${ctx.org} in brief. Follow the link to the `, original('source page'), ' for everything else.'],
          ],
          ctx.revision
        ),
      ],
      sections: [
        {
          heading: 'Highlights',
          blocks: [
            {
              type: 'list',
              ordered: true,
              items: [
                [`${ctx.org} has a new listing.`],
                [about(ctx)],
                ['The position is full-time and based in the United States.'],
              ],
            },
          ],
        },
        { heading: 'Details', blocks: [{ type: 'facts', rows: jobFacts(ctx) }] },
        {
          heading: 'Next step',
          blocks: [para('Read the ', original('original listing'), ' to see the description and requirements in full.')],
        },
      ],
      data: {
        title: 'Open Position',
        description: `One listing from ${ctx.org}, summarized. The source page has the full text, requirements and contact details.`,
      },
    }),
  },

  notice: {
    id: 'notice',
    kind: 'job',
    layout: 'leftbar',
    theme: 'rose',
    build: (ctx) => ({
      title: `Position notice — ${ctx.org}${ctx.label ? ` (${ctx.label})` : ''}`,
      kicker: 'Position notice',
      h1: `Position notice from ${ctx.org}`,
      lede: [
        pick(
          [
            [`${ctx.org} has issued a position notice. The summary below links to the `, original('full notice'), '.'],
            [`This position notice from ${ctx.org} was recently updated; the `, original('full notice'), ' is the authoritative version.'],
          ],
          ctx.revision
        ),
      ],
      sections: [
        { heading: 'Summary', blocks: [para(`${ctx.org} is looking for a new team member. ${about(ctx)}`)] },
        { heading: 'Key details', blocks: [{ type: 'facts', rows: jobFacts(ctx) }] },
        {
          heading: 'Source',
          blocks: [para('This notice is a summary. Please use the ', original('original page'), ' for the complete text.')],
        },
      ],
      data: {
        title: 'Featured Position',
        description: `${ctx.org} has issued a position notice. The original page has the complete text, requirements and contact details.`,
      },
    }),
  },
};

// ─── Livestream templates (VideoObject + BroadcastEvent) ──────────────

interface LiveSpec {
  id: WrapperTemplateId;
  layout: Layout;
  theme: Theme;
  minutes: number;
  kicker: string;
  h1: (c: TemplateContext) => string;
  title: (c: TemplateContext) => string;
  ledes: [(c: TemplateContext) => Seg[], (c: TemplateContext) => Seg[]];
  /** Section 2 must be the facts block: the split layout places it in a side column */
  sections: (c: TemplateContext) => Section[];
  name: (c: TemplateContext) => string;
  description: (c: TemplateContext) => string;
}

function live(spec: LiveSpec): TemplateDef {
  return {
    id: spec.id,
    kind: 'livestream',
    layout: spec.layout,
    theme: spec.theme,
    durationMinutes: spec.minutes,
    build: (ctx) => ({
      title: spec.title(ctx),
      kicker: spec.kicker,
      h1: spec.h1(ctx),
      lede: [pick(spec.ledes, ctx.revision)(ctx)],
      sections: spec.sections(ctx),
      data: { title: spec.name(ctx), description: spec.description(ctx) },
    }),
  };
}

const factsBlock = (ctx: TemplateContext): Block => ({ type: 'facts', rows: liveFacts(ctx) });

const LIVE_TEMPLATES: Record<(typeof LIVE_TEMPLATE_IDS)[number], TemplateDef> = {
  'live-now': live({
    id: 'live-now', layout: 'banner', theme: 'rose', minutes: 90, kicker: 'Live broadcast',
    h1: (c) => `Live from ${c.org}`,
    title: (c) => withLabel(c, `Live from ${c.org}`),
    ledes: [
      (c) => [`${c.org} is on air. Watch the broadcast, and find the schedule and every detail, on the `, original('original page'), '.'],
      (c) => [`${c.org} is streaming live. The `, original('original page'), ' has the player, the schedule and everything else.'],
    ],
    sections: (c) => [
      { heading: 'Broadcast details', blocks: [factsBlock(c)] },
      { heading: 'What to expect', blocks: [para(`A live broadcast from ${c.org}${topic(c)}. Replays, updates and the full programme are published on the organization’s own website.`)] },
      { heading: 'Watch live', blocks: [para('Open the ', original(`broadcast page at ${c.org}`), ' to join the stream.')] },
    ],
    name: (c) => `Live from ${c.org}`,
    description: (c) => `${c.org} is broadcasting live. The original page has the stream, the schedule and full details.`,
  }),

  'live-session': live({
    id: 'live-session', layout: 'card', theme: 'violet', minutes: 60, kicker: 'Live session',
    h1: (c) => `Live session with ${c.org}`,
    title: (c) => withLabel(c, `Live session with ${c.org}`),
    ledes: [
      (c) => [`Join ${c.org} for a live session. The session page has the stream and the details; start from the `, original('original page'), '.'],
      (c) => [`${c.org} is hosting a live session. Everything about it is on the `, original('original page'), '.'],
    ],
    sections: (c) => [
      { heading: 'Session overview', blocks: [para(`${c.org} is hosting a live session${topic(c)}. This page is a short summary; the original page is the authoritative source.`)] },
      { heading: 'Session details', blocks: [factsBlock(c)] },
      { heading: 'Join the session', blocks: [para('Go to the ', original('session page'), ' for the stream, the agenda and any updates.')] },
    ],
    name: (c) => `Live session with ${c.org}`,
    description: (c) => `${c.org} is hosting a live session. The original page has the stream, the agenda and any updates.`,
  }),

  'live-event': live({
    id: 'live-event', layout: 'split', theme: 'sky', minutes: 120, kicker: 'Live event',
    h1: (c) => `${c.org}: live event coverage`,
    title: (c) => `Live event coverage — ${c.org}${c.label ? ` · ${c.label}` : ''}`,
    ledes: [
      (c) => [`Live coverage of an event from ${c.org}. For the full stream and programme, continue to the `, original('event page'), '.'],
      (c) => [`${c.org} is covering an event live. The `, original('event page'), ' carries the stream and the programme.'],
    ],
    sections: (c) => [
      { heading: 'About the event', blocks: [para(`${c.org} is broadcasting an event${topic(c)} live on its own website.`)] },
      { heading: 'Broadcast facts', blocks: [factsBlock(c)] },
      { heading: 'Coverage', blocks: [para('Live updates, the stream and any replay are collected on the ', original('event page'), '.')] },
      { heading: 'Watch it at the source', blocks: [para('The ', original(`page at ${c.org}`), ' is the authoritative version.')] },
    ],
    name: (c) => `Live event coverage from ${c.org}`,
    description: (c) => `Live coverage of an event from ${c.org}. The event page has the full stream and programme.`,
  }),

  'live-schedule': live({
    id: 'live-schedule', layout: 'plain', theme: 'teal', minutes: 45, kicker: 'Broadcast schedule',
    h1: (c) => `Broadcast schedule — ${c.org}`,
    title: (c) => `Broadcast schedule: ${c.org}${c.label ? ` · ${c.label}` : ''}`,
    ledes: [
      (c) => [`What is on the air at ${c.org}, in a few lines. The `, original('broadcast page'), ' has the stream itself.'],
      (c) => [`The current broadcast from ${c.org}, summarized. Follow the link to the `, original('broadcast page'), ' to watch.'],
    ],
    sections: (c) => [
      {
        heading: 'On the schedule',
        blocks: [{ type: 'list', ordered: true, items: [[`A live broadcast from ${c.org}.`], [`It runs ${c.windowHuman}.`], ['The stream and replay are on the broadcast page.']] }],
      },
      { heading: 'Details', blocks: [factsBlock(c)] },
      { heading: 'Where to watch', blocks: [para('Watch on the ', original('original page'), '.')] },
    ],
    name: (c) => `Broadcast schedule: ${c.org}`,
    description: (c) => `The current live broadcast from ${c.org}. The broadcast page has the stream and the replay.`,
  }),

  'live-premiere': live({
    id: 'live-premiere', layout: 'leftbar', theme: 'slate', minutes: 75, kicker: 'Live premiere',
    h1: (c) => `Live premiere on ${c.org}`,
    title: (c) => withLabel(c, `Live premiere on ${c.org}`),
    ledes: [
      (c) => [`A premiere is streaming live on ${c.org}. Open the `, original('premiere page'), ' to watch.'],
      (c) => [`${c.org} is premiering live. The `, original('premiere page'), ' has the stream and the background.'],
    ],
    sections: (c) => [
      { heading: 'About the premiere', blocks: [para(`${c.org} is premiering a broadcast${topic(c)}, live.`)] },
      { heading: 'Key details', blocks: [factsBlock(c)] },
      { heading: 'Watch the premiere', blocks: [para('The stream is on the ', original('original page'), '. This page only summarizes it.')] },
    ],
    name: (c) => `Live premiere on ${c.org}`,
    description: (c) => `${c.org} is premiering a broadcast live. The premiere page has the stream and the background.`,
  }),

  'live-studio': live({
    id: 'live-studio', layout: 'card', theme: 'teal', minutes: 90, kicker: 'Studio broadcast',
    h1: (c) => `Studio broadcast from ${c.org}`,
    title: (c) => withLabel(c, `Studio broadcast from ${c.org}`),
    ledes: [
      (c) => [`Tune in to the studio broadcast from ${c.org}. The `, original('broadcast page'), ' has the stream and more.'],
      (c) => [`The ${c.org} studio is live. Everything is on the `, original('broadcast page'), '.'],
    ],
    sections: (c) => [
      { heading: 'In the studio', blocks: [para(`A live studio broadcast from ${c.org}${topic(c)}, published on the organization’s own website.`)] },
      { heading: 'Broadcast facts', blocks: [factsBlock(c)] },
      { heading: 'Tune in', blocks: [para('Watch on the ', original(`page at ${c.org}`), '.')] },
    ],
    name: (c) => `Studio broadcast from ${c.org}`,
    description: (c) => `A live studio broadcast from ${c.org}. The broadcast page has the stream and more.`,
  }),

  'live-roundtable': live({
    id: 'live-roundtable', layout: 'split', theme: 'violet', minutes: 60, kicker: 'Live roundtable',
    h1: (c) => `${c.org} live roundtable`,
    title: (c) => `Live roundtable — ${c.org}${c.label ? ` · ${c.label}` : ''}`,
    ledes: [
      (c) => [`A live roundtable hosted by ${c.org}. The stream and the topics are on the `, original('roundtable page'), '.'],
      (c) => [`${c.org} is hosting a roundtable, live. See the `, original('roundtable page'), ' for the stream.'],
    ],
    sections: (c) => [
      { heading: 'About the roundtable', blocks: [para(`${c.org} brings people together${topic(c)} in a live discussion.`)] },
      { heading: 'Roundtable facts', blocks: [factsBlock(c)] },
      {
        heading: 'Topics',
        blocks: [{ type: 'list', items: [['The discussion is live and unscripted.'], ['The topics are listed on the roundtable page.'], ['A replay may follow on the same page.']] }],
      },
      { heading: 'Join in', blocks: [para('Watch on the ', original('original page'), '.')] },
    ],
    name: (c) => `${c.org} live roundtable`,
    description: (c) => `A live roundtable hosted by ${c.org}. The roundtable page has the stream and the topics.`,
  }),

  'live-briefing': live({
    id: 'live-briefing', layout: 'leftbar', theme: 'sky', minutes: 30, kicker: 'Live briefing',
    h1: (c) => `Live briefing from ${c.org}`,
    title: (c) => withLabel(c, `Live briefing from ${c.org}`),
    ledes: [
      (c) => [`${c.org} is giving a live briefing. The `, original('briefing page'), ' has the stream and the notes.'],
      (c) => [`A short live briefing from ${c.org}. Watch it on the `, original('briefing page'), '.'],
    ],
    sections: (c) => [
      { heading: 'Briefing summary', blocks: [para(`${c.org} is live with a short briefing${topic(c)}.`)] },
      { heading: 'Details', blocks: [factsBlock(c)] },
      { heading: 'Full coverage', blocks: [para('The stream and the notes are on the ', original(`page at ${c.org}`), '.')] },
    ],
    name: (c) => `Live briefing from ${c.org}`,
    description: (c) => `${c.org} is giving a live briefing. The briefing page has the stream and the notes.`,
  }),
};

export const TEMPLATES: Record<WrapperTemplateId, TemplateDef> = { ...JOB_TEMPLATES, ...LIVE_TEMPLATES };

// ─── Page label from the URL ──────────────────────────────────────────

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs']);

/**
 * A short readable name for a page, from the last meaningful path segment:
 * /blog/getting-started-with-seo.html → "Getting Started With Seo". Returns '' when the path has
 * nothing readable (the home page, ids, hashes). Only letters, digits and a little punctuation
 * survive, so whatever a URL contains can never smuggle markup into the page.
 */
export function labelFromUrl(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    let segment = segments[i];
    try {
      segment = decodeURIComponent(segment);
    } catch {
      /* keep the raw segment */
    }
    segment = segment.replace(/\.(html?|php\d?|aspx?|jsp|shtml)$/i, '');
    if (/^\d+$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment)) continue; // ids and hashes

    const words = segment
      .replace(/[-_+.]+/g, ' ')
      .replace(/[^\p{L}\p{N}\s'’&,:()]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/\p{L}/u.test(words)) continue;

    const label = words
      .split(' ')
      .map((word, index) => {
        if (word !== word.toLowerCase()) return word; // keep SEO, iPhone, McDonald's, ...
        if (index > 0 && SMALL_WORDS.has(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
    return label.length > 60 ? `${label.slice(0, 59).trimEnd()}…` : label;
  }
  return '';
}

// ─── Livestream thumbnail ─────────────────────────────────────────────

/**
 * The thumbnail a livestream's markup points to: a plain "LIVE" card in the template's colours.
 * It contains no text taken from a URL, so there is nothing to escape; the route that serves it
 * only accepts a theme name from THEMES.
 */
export function thumbnailSvg(theme: Theme): string {
  const t = THEMES[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.dark}"/><stop offset="1" stop-color="${t.accent}"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="640" cy="320" r="120" fill="#fff" fill-opacity=".14"/><path d="M600 255v130l112-65z" fill="#fff"/><rect x="540" y="510" width="200" height="64" rx="32" fill="#ef4444"/><text x="640" y="554" font-family="Arial,Helvetica,sans-serif" font-size="32" font-weight="700" fill="#fff" text-anchor="middle">LIVE</text></svg>`;
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value);
}

// ─── Styles ───────────────────────────────────────────────────────────

export function templateCss(def: TemplateDef): string {
  const t = THEMES[def.theme];
  const serif = def.layout === 'plain';
  return `
:root{--accent:${t.accent};--soft:${t.soft};--dark:${t.dark};--ink:#0f172a;--muted:#475569;--line:#e2e8f0}
*{box-sizing:border-box}
body{margin:0;background:#f8fafc;color:var(--ink);font:16px/1.65 ${serif ? 'Georgia,"Times New Roman",serif' : 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'}}
a{color:var(--accent);text-underline-offset:3px}
a:hover{color:var(--dark)}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}
.top{background:#fff;border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:14px;padding-bottom:14px}
.brand{margin:0;font-weight:700;letter-spacing:-.01em}
.crumbs ol{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none;font-size:14px;color:var(--muted)}
.crumbs li+li::before{content:"/";margin-right:6px;color:#94a3b8}
main{padding:40px 0 56px}
article{background:#fff;border:1px solid var(--line);border-radius:16px;padding:32px 28px;box-shadow:0 1px 3px rgba(15,23,42,.06)}
.kicker{display:inline-block;margin:0 0 12px;padding:3px 12px;border-radius:999px;background:var(--soft);color:var(--accent);font:600 12px/1.6 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase}
h1{margin:0 0 14px;font-size:clamp(26px,5vw,36px);line-height:1.2;letter-spacing:-.02em}
h2{margin:0 0 8px;font-size:19px;line-height:1.3}
.lede{margin:0 0 6px;font-size:18px;color:var(--muted)}
section{margin-top:28px;padding-top:24px;border-top:1px solid var(--line)}
p{margin:0 0 12px}
ul,ol{margin:0;padding-left:22px}
li{margin:4px 0}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:0}
.facts div{padding:10px 14px;border-radius:10px;background:var(--soft)}
.facts dt{font:600 12px/1.5 system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.facts dd{margin:2px 0 0;font-weight:600}
.foot{border-top:1px solid var(--line);background:#fff;font-size:14px;color:var(--muted)}
.foot .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 24px;padding-top:18px;padding-bottom:18px}
.foot p{margin:0}
${layoutCss(def.layout)}
@media (max-width:560px){article{padding:24px 18px;border-radius:12px}main{padding:24px 0 40px}}
`.trim();
}

function layoutCss(layout: Layout): string {
  switch (layout) {
    case 'banner':
      return `
.top{background:var(--dark);border-bottom:0}.top .brand,.top .crumbs ol,.top .crumbs li+li::before{color:#e2e8f0}.top a{color:#fff}
article{border-top:5px solid var(--accent)}`.trim();
    case 'split':
      return `
@media (min-width:720px){.wrap{max-width:900px}article{display:grid;grid-template-columns:1fr 1fr;column-gap:32px}article>header{grid-column:1/-1}article>section:nth-of-type(2){grid-row:span 2}article>section:last-of-type{grid-column:1/-1}}
article{border-radius:20px}`.trim();
    case 'plain':
      return `
body{background:#fffdf8}article{background:transparent;border:0;box-shadow:none;padding:8px 0}
h1,h2{font-family:Georgia,"Times New Roman",serif}.kicker{border-radius:4px}ol{padding-left:26px}`.trim();
    case 'leftbar':
      return `
article{border-left:6px solid var(--accent);border-radius:6px 16px 16px 6px}`.trim();
    default:
      return '';
  }
}
