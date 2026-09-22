// Zero-dependency server: serves the newspaper UI and proxies RSS feeds
// listed in the local OPML file (browsers can't fetch them directly due to CORS).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0'; // use 127.0.0.1 to keep it private to this machine
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

function findOpml() {
  if (process.env.FEEDS_FILE) return path.resolve(process.env.FEEDS_FILE);
  if (fs.existsSync(path.join(ROOT, 'feeds.opml'))) return path.join(ROOT, 'feeds.opml');
  const file = fs.readdirSync(ROOT).filter(f => f.endsWith('.opml')).sort().pop();
  if (!file) throw new Error('No .opml file found. Set FEEDS_FILE or drop one in ' + ROOT);
  return path.join(ROOT, file);
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  return out;
}

// Minimal OPML reader: category <outline> elements containing feed <outline type="rss"> children.
function parseOpml(xml) {
  const feeds = [];
  let category = 'General';
  for (const m of xml.matchAll(/<outline\b[^>]*?(\/?)>|<\/outline>/g)) {
    if (m[0].startsWith('</')) continue;
    const a = attrs(m[0]);
    if (a.xmlUrl) {
      feeds.push({
        id: feeds.length,
        title: (a.title || a.text || a.xmlUrl).trim(),
        url: a.xmlUrl,
        site: a.htmlUrl || '',
        category,
      });
    } else if (!m[1]) {
      category = (a.title || a.text || 'General').trim();
    }
  }
  return feeds;
}

let opmlPath, feeds;
function loadFeeds() {
  opmlPath = findOpml();
  feeds = parseOpml(fs.readFileSync(opmlPath, 'utf8'));
  console.log(`Loaded ${feeds.length} feeds from ${path.basename(opmlPath)}`);
}
loadFeeds();
fs.watchFile(opmlPath, { interval: 2000 }, () => { cache.clear(); loadFeeds(); });

const cache = new Map(); // feed id -> { at, status, body }

async function fetchFeed(feed, force) {
  const hit = cache.get(feed.id);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit;
  let entry;
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36',
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
      },
    });
    const body = await res.text();
    entry = res.ok
      ? { at: Date.now(), status: 200, body }
      : { at: Date.now(), status: 502, body: `Upstream responded ${res.status}` };
  } catch (err) {
    entry = { at: Date.now(), status: 504, body: err.name === 'TimeoutError' ? 'Timed out' : err.message };
  }
  // Keep serving the last good copy if a refresh fails.
  if (entry.status !== 200 && hit && hit.status === 200) return hit;
  cache.set(feed.id, entry);
  return entry;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/feeds') {
    return send(res, 200, JSON.stringify({ source: path.basename(opmlPath), feeds }), 'application/json');
  }

  // Only feeds from the OPML file can be fetched (by id), never arbitrary URLs.
  const m = url.pathname.match(/^\/api\/feed\/(\d+)$/);
  if (m) {
    const feed = feeds[Number(m[1])];
    if (!feed) return send(res, 404, 'Unknown feed');
    const entry = await fetchFeed(feed, url.searchParams.has('refresh'));
    return send(res, entry.status, entry.body, entry.status === 200 ? 'application/xml; charset=utf-8' : undefined);
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, HOST, () => console.log(`The Daily Dispatch is on the press at http://localhost:${PORT}`));
