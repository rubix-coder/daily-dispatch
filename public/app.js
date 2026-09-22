'use strict';

/* ------------------------------------------------------------------ *
 *  Sections: order here is the order of pages in the paper.
 * ------------------------------------------------------------------ */
const SECTIONS = [
  { key: 'front',       name: 'Front Page' },
  { key: 'nation',      name: 'The Nation',            accent: 'brick' },
  { key: 'politics',    name: 'Politics & Governance', accent: 'brick' },
  { key: 'world',       name: 'World',                 accent: 'blue' },
  { key: 'cities',      name: 'Cities',                accent: 'ochre' },
  { key: 'business',    name: 'Business & Finance',    accent: 'green' },
  { key: 'technology',  name: 'Technology',            accent: 'blue' },
  { key: 'research',    name: 'Science & Research',    accent: 'plum' },
  { key: 'security',    name: 'Cybersecurity',         accent: 'brick' },
  { key: 'health',      name: 'Health',                accent: 'green' },
  { key: 'environment', name: 'Environment',           accent: 'green' },
  { key: 'sports',      name: 'Sports',                accent: 'ochre' },
  { key: 'arts',        name: 'Arts & Entertainment',  accent: 'plum' },
  { key: 'lifestyle',   name: 'Lifestyle',             accent: 'ochre' },
  { key: 'learning',    name: 'Learning & Culture',    accent: 'blue' },
  { key: 'alerts',      name: 'Weather & Alerts',      accent: 'brick' },
  { key: 'classifieds', name: 'Classifieds',           accent: 'ink' },
];

const PER_FEED_LIMIT = 25;
const PER_FEED_LIMIT_BULK = 10;   // very high-volume feeds (arXiv)
const CONCURRENCY = 8;

/* ------------------------------------------------------------------ *
 *  Classification
 * ------------------------------------------------------------------ */
const KW = {
  health: /\b(health|hospital|doctors?|disease|cancer|stroke|vaccin\w*|virus|medical|medicine|patients?|diabetes|obesity|mental health|nutrition|fitness|diet|who|icmr|aiims|dengue|malaria|tb|heart attack|surgery)\b/i,
  environment: /\b(climate|environment\w*|pollution|emissions?|forests?|wildlife|tigers?|leopards?|elephants?|monsoon|heatwave|floods?|cyclone|drought|biodiversity|carbon|renewable|solar|glaciers?|rivers?|air quality|aqi|conservation|species)\b/i,
  politics: /\b(bjp|congress|aap|tmc|aimim|sp|bsp|minister|ministry|mla|mp|cm|chief minister|election|polls?|parliament|lok sabha|rajya sabha|govt|government|opposition|cabinet|modi|rahul|shah|governor|assembly|supreme court|high court|hc|sc|policy|bill|ucc|jaishankar|unga|diplomat\w*)\b/i,
};

const PATH_SECTION = {
  sports: 'sports', business: 'business', 'real-estate': 'business', 'toi-plus': 'business',
  technology: 'technology', gadgets: 'technology', 'gadgets-news': 'technology',
  entertainment: 'arts', tv: 'arts', 'web-series': 'arts', etimes: 'arts', 'movie-reviews': 'arts',
  'life-style': 'lifestyle', world: 'world', city: 'cities', india: 'nation', legal: 'politics',
  science: 'research', education: 'learning', auto: 'business',
};

function classify(item, feed) {
  const cat = feed.category.toLowerCase();
  const url = feed.url.toLowerCase();
  if (cat.includes('alert')) return 'alerts';
  if (cat.includes('job')) return 'classifieds';
  if (cat.includes('learn')) return 'learning';
  if (cat.includes('security')) return 'security';
  if (cat.includes('financ') || cat.includes('business')) return 'business';
  if (url.includes('arxiv.org')) return 'research';
  if (cat.includes('tech')) return 'technology';
  if (url.includes('downtoearth')) return 'environment';
  if (url.includes('pib.gov.in')) return 'politics';

  // General news wires: use the section encoded in the article URL, then keywords.
  let seg = '', sub = '';
  try { [seg = '', sub = ''] = new URL(item.link).pathname.split('/').filter(Boolean); } catch {}
  let section = PATH_SECTION[seg] || (cat.includes('politic') ? 'nation' : 'nation');
  if (seg === 'life-style' && sub === 'health-fitness') return 'health';
  if (sub === 'nature' || sub === 'environment') section = 'environment';

  const generic = ['nation', 'cities', 'world', 'research', 'lifestyle', 'politics'].includes(section);
  if (generic) {
    const t = item.title;
    if (KW.health.test(t)) return 'health';
    if (KW.environment.test(t)) return 'environment';
    if ((section === 'nation' || section === 'cities') && KW.politics.test(t)) return 'politics';
  }
  return section;
}

/* ------------------------------------------------------------------ *
 *  Feed parsing (RSS 2.0, RSS 1.0/RDF, Atom) via DOMParser
 * ------------------------------------------------------------------ */
const kids = (el, name) => [...el.children].filter(c => c.nodeName.toLowerCase() === name);
const kid = (el, ...names) => { for (const n of names) { const k = kids(el, n)[0]; if (k) return k; } return null; };
const txt = (el, ...names) => (kid(el, ...names)?.textContent || '').trim();

function parseDate(s) {
  if (!s) return null;
  let d = new Date(s);
  if (isNaN(d)) d = new Date(s.replace(/([+-])(\d):(\d\d)$/, '$10$2:$3')); // "+5:30" -> "+05:30"
  return isNaN(d) ? null : d;
}

function htmlToText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstImageInHtml(html) {
  if (!html || !/<img/i.test(html)) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    const w = +img.getAttribute('width');
    if (/^https?:/.test(src) && !(w && w < 60) && !/feedburner|gravatar|pixel|emoji|\.gif$/i.test(src)) return src;
  }
  return '';
}

function findImage(el, html) {
  const candidates = [
    ...kids(el, 'media:content'), ...kids(el, 'media:thumbnail'),
    ...kids(el, 'media:group').flatMap(g => [...kids(g, 'media:content'), ...kids(g, 'media:thumbnail')]),
    ...kids(el, 'enclosure'),
  ];
  for (const c of candidates) {
    const u = c.getAttribute('url');
    const type = c.getAttribute('type') || c.getAttribute('medium') || '';
    if (u && (/image/.test(type) || (!type && /\.(jpe?g|png|webp)(\?|$)/i.test(u)) || c.nodeName === 'media:thumbnail')) return u;
  }
  const itunes = kid(el, 'itunes:image');
  return firstImageInHtml(html) || itunes?.getAttribute('href') || '';
}

function parseFeed(xml, feed) {
  let doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(xml, 'text/html');
  let nodes = [...doc.getElementsByTagName('item')];
  const atom = nodes.length === 0;
  if (atom) nodes = [...doc.getElementsByTagName('entry')];
  const limit = feed.url.includes('arxiv.org') ? PER_FEED_LIMIT_BULK : PER_FEED_LIMIT;

  return nodes.slice(0, limit).map(el => {
    let link = txt(el, 'link');
    if (!link || atom) {
      const links = kids(el, 'link');
      const alt = links.find(l => (l.getAttribute('rel') || 'alternate') === 'alternate') || links[0];
      link = alt?.getAttribute('href') || link;
    }
    if (!link) link = txt(el, 'guid');
    const content = txt(el, 'content:encoded', 'content');
    const descHtml = txt(el, 'description', 'summary', 'media:description', 'itunes:summary');
    const summary = htmlToText(descHtml) || htmlToText(content);
    const author = txt(el, 'dc:creator', 'author').replace(/^\S+@\S+\s*\((.*)\)$/, '$1') ||
                   (kid(el, 'author') && txt(kid(el, 'author'), 'name')) || '';
    const item = {
      title: htmlToText(txt(el, 'title')) || '(untitled)',
      link,
      date: parseDate(txt(el, 'pubdate', 'pubDate', 'published', 'updated', 'dc:date')),
      summary,
      content: content || (descHtml.length > 600 ? descHtml : ''),
      image: findImage(el, content || descHtml),
      author: author.replace(/\s+/g, ' ').slice(0, 80),
      category: txt(el, 'category'),
      feed,
    };
    // Bare version numbers (e.g. a changelog's "2.1.278") need their product name.
    if (/^v?\d+(\.\d+)+$/.test(item.title)) item.title = `${feed.title.replace(/\s*changelog$/i, '')} ${item.title} released`;
    item.section = classify(item, feed);
    return item;
  });
}

/* ------------------------------------------------------------------ *
 *  Sanitising article HTML for the reader
 * ------------------------------------------------------------------ */
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,input,button,link,meta,noscript,svg,video,audio').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n => {
    for (const a of [...n.attributes]) {
      const keep = (a.name === 'href' || a.name === 'src' || a.name === 'alt') && !/^\s*javascript:/i.test(a.value);
      if (!keep) n.removeAttribute(a.name);
    }
    if (n.tagName === 'A') { n.target = '_blank'; n.rel = 'noopener noreferrer'; }
    if (n.tagName === 'IMG') { n.loading = 'lazy'; n.referrerPolicy = 'no-referrer'; }
  });
  return doc.body.innerHTML;
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const words = (s, n) => { const w = s.split(' '); return w.length > n ? w.slice(0, n).join(' ') + '…' : s; };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function sourceName(feed) {
  const t = feed.title;
  if (/times of india|india news|ahmedabad news/i.test(t)) return 'Times of India';
  if (/arxiv/i.test(t)) return 'arXiv ' + (t.match(/cs\.\w+/) || [''])[0];
  if (/we work remotely/i.test(t)) return 'We Work Remotely';
  if (/CAP Disaster/i.test(t)) return 'NDMA Sachet';
  return t.split(/[|:]/)[0].trim();
}

function ago(d) {
  if (!d) return '';
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} hr ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

const byline = a => [a.author && `By ${esc(a.author)}`, esc(sourceName(a.feed)), esc(ago(a.date))].filter(Boolean).join(' · ');

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
const state = { feeds: [], status: [], articles: [], bySection: new Map(), pages: [], source: '' };
const $ = id => document.getElementById(id);

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

async function loadEdition(refresh = false) {
  const { feeds, source } = await (await fetch('/api/feeds')).json();
  state.feeds = feeds; state.source = source; state.status = [];
  let done = 0;
  const all = [];
  const tick = () => {
    done++;
    const p = $('progress'); if (p) p.style.width = `${(done / feeds.length) * 100}%`;
    const t = $('progress-text'); if (t) t.textContent = `${done} of ${feeds.length} wires received`;
  };
  await pool(feeds, CONCURRENCY, async feed => {
    try {
      const res = await fetch(`/api/feed/${feed.id}${refresh ? '?refresh=1' : ''}`);
      const body = await res.text();
      if (!res.ok) throw new Error(body || res.statusText);
      const items = parseFeed(body, feed);
      all.push(...items);
      state.status[feed.id] = { feed, ok: true, count: items.length };
    } catch (e) {
      state.status[feed.id] = { feed, ok: false, error: e.message.slice(0, 80) };
    }
    tick();
  });

  // De-duplicate stories syndicated across multiple feeds; repeats signal popularity.
  const seen = new Map();
  for (const a of all) {
    const key = (a.link || '').replace(/[?#].*$/, '') || a.title.toLowerCase();
    const prev = seen.get(key);
    if (prev) { prev.hits++; continue; }
    a.hits = 1;
    seen.set(key, a);
  }
  state.articles = [...seen.values()];

  // An image shared by several stories is a publisher placeholder, not a photograph.
  const imgCount = new Map();
  for (const a of state.articles) if (a.image) imgCount.set(a.image, (imgCount.get(a.image) || 0) + 1);
  for (const a of state.articles) if (imgCount.get(a.image) >= 3) a.image = '';
  state.articles.forEach((a, i) => { a.id = i; });

  state.bySection = new Map(SECTIONS.map(s => [s.key, []]));
  for (const a of state.articles) state.bySection.get(a.section)?.push(a);
  for (const list of state.bySection.values()) list.sort(storyOrder);

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  state.pages = SECTIONS.filter(s => s.key === 'front' || state.bySection.get(s.key).length)
                        .map((s, i) => ({ ...s, letter: letters[i] }));
}

// Newer first, with a nudge for stories carried by several wires.
const score = a => (a.date ? a.date.getTime() : 0) + (a.hits - 1) * 6 * 3600e3;
const storyOrder = (a, b) => score(b) - score(a);

// Pick a lead: prefer a story with a picture and some substance among the freshest few.
function pickLead(list) {
  const top = list.slice(0, 6);
  return top.find(a => a.image && a.summary.length > 120) || top.find(a => a.summary.length > 160) || list[0];
}

/* ------------------------------------------------------------------ *
 *  Rendering: story blocks
 * ------------------------------------------------------------------ */
function figure(a, cls = '') {
  if (!a.image) return '';
  return `<figure class="photo ${cls}"><img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('figure').remove()"><figcaption>${esc(sourceName(a.feed))}</figcaption></figure>`;
}

function kicker(a, show) {
  if (!show) return '';
  const s = SECTIONS.find(x => x.key === a.section);
  return `<div class="kicker accent-${s.accent}">${esc(s.name)}</div>`;
}

function story(a, size, opts = {}) {
  const limits = { lead: 150, major: 70, minor: 40, brief: 18 };
  const body = words(a.summary, limits[size]);
  const pic = size === 'lead' || size === 'major' || (size === 'minor' && opts.pic) ? figure(a) : '';
  const bodyCls = size === 'lead' ? 'body cols-2 dropcap' : 'body';
  return `
    <article class="story story-${size} ${opts.cls || ''}">
      ${kicker(a, opts.kicker)}
      <h2 class="headline"><a href="#" data-article="${a.id}">${esc(a.title)}</a></h2>
      <div class="byline">${byline(a)}</div>
      ${pic}
      ${body ? `<div class="${bodyCls}"><p>${esc(body)}</p></div>` : ''}
      ${a.summary.split(' ').length > limits[size] || a.content ? `<a href="#" class="more" data-article="${a.id}">Continued ›</a>` : ''}
    </article>`;
}

function briefs(list, title = 'In Brief') {
  if (!list.length) return '';
  return `
    <section class="briefs">
      <h3 class="rubric"><span>${esc(title)}</span></h3>
      <ul class="brief-list">
        ${list.map(a => `<li><a href="#" data-article="${a.id}"><b>${esc(a.title)}</b></a> <span class="src">— ${esc(sourceName(a.feed))}${a.date ? ', ' + esc(ago(a.date)) : ''}</span></li>`).join('')}
      </ul>
    </section>`;
}

function pageRef(key) {
  const p = state.pages.find(x => x.key === key);
  return p ? `<a class="pageref" href="#${p.key}">${esc(p.name)}, ${p.letter}1</a>` : '';
}

/* ------------------------------------------------------------------ *
 *  Rendering: pages
 * ------------------------------------------------------------------ */
function renderFront() {
  const pool = key => state.bySection.get(key) || [];
  const newsKeys = ['nation', 'politics', 'world', 'cities', 'business'];
  const news = newsKeys.flatMap(pool).sort(storyOrder);
  // Hard news leads the paper; fall back to anything on the wire.
  const hard = ['nation', 'politics', 'world'].flatMap(pool).sort(storyOrder);
  const lead = pickLead(hard.length ? hard : news.length ? news : state.articles.slice().sort(storyOrder));
  const used = new Set([lead?.id]);
  const take = (key, n = 1) => pool(key).filter(a => !used.has(a.id)).slice(0, n).map(a => (used.add(a.id), a));
  const nextNews = () => { const a = news.find(x => !used.has(x.id)); if (a) used.add(a.id); return a; };
  const underLead = [...take('nation'), ...take('cities')];
  while (underLead.length < 2) { const a = nextNews(); if (!a) break; underLead.push(a); }

  const secondary = [...take('politics'), ...take('world'), ...take('business')];
  while (secondary.length < 3) { const a = nextNews(); if (!a) break; secondary.push(a); }

  const teaserKeys = ['technology', 'sports', 'health', 'environment', 'security', 'arts', 'research', 'cities', 'lifestyle'];
  const teasers = teaserKeys.flatMap(k => take(k)).slice(0, 6);

  const alerts = pool('alerts').slice(0, 4);
  const inside = state.pages.filter(p => p.key !== 'front');
  const brief = news.filter(a => !used.has(a.id)).slice(0, 9);

  return `
    <div class="grid front">
      <div class="span-4 lead-well">
        ${lead ? story(lead, 'lead', { kicker: true }) : '<p>No stories on the wire.</p>'}
        ${underLead.length ? `<div class="under-lead">${underLead.map(a => story(a, 'major', { kicker: true })).join('')}</div>` : ''}
      </div>
      <aside class="span-2 rail">
        ${alerts.length ? `
        <section class="box box-alert">
          <h3 class="box-title">⚠ Weather &amp; Disaster Alerts</h3>
          ${alerts.map(a => `<p class="alert-item"><a href="#" data-article="${a.id}">${esc(words(a.title, 28))}</a><span class="src">${esc(a.category || '')} · ${esc(ago(a.date))}</span></p>`).join('')}
          <div class="box-foot">More on ${pageRef('alerts')}</div>
        </section>` : ''}
        <section class="box box-index">
          <h3 class="box-title">Inside Today</h3>
          <ol class="index-list">
            ${inside.map(p => `<li><a href="#${p.key}"><span class="idx-name">${esc(p.name)}</span><span class="dots"></span><span class="idx-page">${p.letter}1</span></a></li>`).join('')}
          </ol>
        </section>
      </aside>

      ${secondary.map(a => `<div class="span-2 ruled">${story(a, 'major', { kicker: true })}</div>`).join('')}

      <div class="span-6 band"><span>Across the Sections</span></div>
      ${teasers.map(a => `<div class="span-1 ruled">${story(a, 'minor', { kicker: true, pic: true })}<div class="jump">See ${pageRef(a.section)}</div></div>`).join('')}

      <div class="span-6">${briefs(brief, 'News in Brief')}</div>
    </div>`;
}

function renderSection(page) {
  const list = state.bySection.get(page.key);
  if (page.key === 'classifieds') return renderClassifieds(list);
  if (page.key === 'alerts') return renderAlerts(list);

  const lead = pickLead(list);
  const rest = list.filter(a => a !== lead);
  const side = rest.slice(0, 2);
  const under = lead.image ? [] : rest.slice(2, 4);
  const after = rest.slice(2 + under.length);
  const minors = after.slice(0, 6);
  const more = after.slice(6, 12);
  const brief = after.slice(12);
  const compact = page.key === 'research';

  return `
    <div class="grid section-${page.key}">
      <div class="span-4 lead-well">${story(lead, 'lead')}${under.length ? `<div class="under-lead">${under.map(a => story(a, 'major')).join('')}</div>` : ''}</div>
      <aside class="span-2 rail">${side.map(a => story(a, 'major', { cls: 'stacked' })).join('')}</aside>
      ${minors.length ? `<div class="span-6 band"><span>More ${esc(page.name)}</span></div>` : ''}
      ${minors.map(a => `<div class="span-${compact ? 2 : 1} ruled">${story(a, 'minor', { pic: !compact })}</div>`).join('')}
      ${more.length ? `<div class="span-6 thin-rule"></div>` : ''}
      ${more.map(a => `<div class="span-2 ruled">${story(a, 'minor')}</div>`).join('')}
      ${brief.length ? `<div class="span-6">${briefs(brief)}</div>` : ''}
    </div>`;
}

function renderAlerts(list) {
  return `
    <div class="bulletin">
      <p class="bulletin-note">Official Common Alerting Protocol warnings from the National Disaster Management Authority. Newest first.</p>
      <div class="bulletin-grid">
        ${list.map(a => `
          <article class="bulletin-item">
            <div class="bulletin-tag">${esc(a.category || 'Alert')}</div>
            <p><a href="#" data-article="${a.id}">${esc(a.title)}</a></p>
            <div class="byline">${esc(a.author || sourceName(a.feed))} · ${esc(a.date ? a.date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '')}</div>
          </article>`).join('')}
      </div>
    </div>`;
}

function renderClassifieds(list) {
  return `
    <div class="classifieds">
      <div class="classified-head">
        <span>HELP WANTED</span><span>Remote positions · Programming · Design · Marketing</span>
      </div>
      <div class="classified-cols">
        ${list.map(a => {
          const [company, ...role] = a.title.split(':');
          return `
          <article class="ad">
            <h4><a href="#" data-article="${a.id}">${esc(role.length ? role.join(':').trim() : a.title)}</a></h4>
            ${role.length ? `<div class="ad-co">${esc(company.trim())}</div>` : ''}
            <p>${esc(words(a.summary.replace(/(URL:\s*)?https?:\/\/\S+/g, '').replace(/\s+/g, ' '), 30))}</p>
            <div class="ad-foot">Apply via ${esc(sourceName(a.feed))} · ${esc(ago(a.date))}</div>
          </article>`;
        }).join('')}
      </div>
    </div>`;
}

function renderPage(key) {
  const idx = Math.max(0, state.pages.findIndex(p => p.key === key));
  const page = state.pages[idx];
  const prev = state.pages[idx - 1], next = state.pages[idx + 1];

  $('nav').querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.key === page.key));
  const header = page.key === 'front' ? '' : `
    <header class="section-head accent-${page.accent}">
      <span class="section-letter">Section ${page.letter}</span>
      <h2>${esc(page.name)}</h2>
      <span class="section-count">${state.bySection.get(page.key).length} stories</span>
    </header>`;

  $('page').innerHTML = `
    ${header}
    ${page.key === 'front' ? renderFront() : renderSection(page)}
    <div class="turn">
      ${prev ? `<a href="#${prev.key}">‹ Page ${prev.letter}1 · ${esc(prev.name)}</a>` : '<span></span>'}
      <span class="folio">${page.letter}1</span>
      ${next ? `<a href="#${next.key}">${esc(next.name)} · Page ${next.letter}1 ›</a>` : '<span></span>'}
    </div>`;
  window.scrollTo({ top: 0 });
}

function renderChrome() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayNo = Math.floor((now - start) / 864e5);
  const ok = state.status.filter(s => s?.ok).length;
  const alert = (state.bySection.get('alerts') || [])[0];

  $('ear-left').innerHTML = alert
    ? `<div class="ear-title">Weather</div><div class="ear-text">${esc(words(alert.title, 18))}</div>`
    : `<div class="ear-title">Weather</div><div class="ear-text">No warnings in force.</div>`;
  $('ear-right').innerHTML = `<div class="ear-title">Late Edition</div><div class="ear-text">${state.articles.length} stories from ${ok} wire services.<br>Price: One Click</div>`;

  $('dateline').innerHTML = `
    <span>Vol. ${toRoman(now.getFullYear() - 2020)} · No. ${dayNo}</span>
    <span class="date">${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
    <span><button id="reprint" class="reprint" title="Fetch the latest from all feeds">↻ Reprint</button> ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>`;
  $('reprint').onclick = () => boot(true);

  $('nav').innerHTML = state.pages.map(p => `<a href="#${p.key}" data-key="${p.key}">${esc(p.key === 'front' ? 'Front Page' : p.name)}</a>`).join('');

  $('colophon').innerHTML = `
    <h3 class="rubric"><span>Wire Service Report</span></h3>
    <p class="colophon-note">Compiled from <code>${esc(state.source)}</code>.</p>
    <ul class="wires">
      ${state.status.map(s => s && `<li class="${s.ok ? 'ok' : 'down'}"><span>${s.ok ? '✓' : '✗'}</span> ${esc(s.feed.title.slice(0, 48))} <em>${s.ok ? `${s.count} items · ${esc(s.feed.category)}` : esc(s.error)}</em></li>`).join('')}
    </ul>
    <p class="imprint">Printed by The Daily Dispatch press · Set in Playfair Display &amp; Libre Caslon</p>`;
}

const toRoman = n => [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']].reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '') || 'I';

/* ------------------------------------------------------------------ *
 *  Reader (article clipping)
 * ------------------------------------------------------------------ */
function openReader(id) {
  const a = state.articles[id];
  if (!a) return;
  const s = SECTIONS.find(x => x.key === a.section);
  const html = a.content ? sanitize(a.content) : `<p>${esc(a.summary || 'No summary was supplied by the wire.')}</p>`;
  const hasFigureInBody = a.content && a.image && a.content.includes(a.image);
  $('reader-body').innerHTML = `
    <div class="kicker accent-${s.accent}">${esc(s.name)}</div>
    <h2 class="reader-headline" id="reader-headline">${esc(a.title)}</h2>
    <div class="byline">${byline(a)}${a.date ? ' · ' + esc(a.date.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })) : ''}</div>
    ${hasFigureInBody ? '' : figure(a, 'reader-photo')}
    <div class="reader-text ${a.content && a.content.length > 1500 ? 'cols-2' : ''} dropcap">${html}</div>
    ${a.link ? `<p class="reader-source"><a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">Read the full story at ${esc(host(a.link))} ›</a></p>` : ''}`;
  $('reader').hidden = false;
  document.body.classList.add('reading');
  $('reader').querySelector('.clipping').scrollTop = 0;
}

function closeReader() {
  $('reader').hidden = true;
  document.body.classList.remove('reading');
}

document.addEventListener('click', e => {
  const art = e.target.closest('[data-article]');
  if (art) { e.preventDefault(); openReader(+art.dataset.article); return; }
  if (e.target.closest('[data-close]')) closeReader();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') return closeReader();
  if (!$('reader').hidden || e.target.closest('input,textarea')) return;
  const idx = state.pages.findIndex(p => p.key === (location.hash.slice(1) || 'front'));
  if (e.key === 'ArrowRight' && state.pages[idx + 1]) location.hash = state.pages[idx + 1].key;
  if (e.key === 'ArrowLeft' && state.pages[idx - 1]) location.hash = state.pages[idx - 1].key;
});

window.addEventListener('hashchange', () => state.pages.length && renderPage(location.hash.slice(1) || 'front'));

async function boot(refresh = false) {
  if (refresh) {
    $('page').innerHTML = `<div class="presses"><div class="presses-title">Stop the Presses!</div><div class="presses-sub">Resetting type with the latest wires…</div><div class="presses-bar"><span id="progress"></span></div><div class="presses-count" id="progress-text"></div></div>`;
  }
  try {
    await loadEdition(refresh);
    renderChrome();
    renderPage(location.hash.slice(1) || 'front');
  } catch (e) {
    $('page').innerHTML = `<div class="presses"><div class="presses-title">The Presses Have Jammed</div><div class="presses-sub">${esc(e.message)}</div></div>`;
  }
}

boot();
