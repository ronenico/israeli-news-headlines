import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4173;

const SOURCES = [
  { id: 'ynet', name: 'Ynet', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml' },
  { id: 'israelhayom', name: 'ישראל היום', url: 'https://www.israelhayom.co.il/rss.xml' },
  { id: 'maariv', name: 'מעריב', url: 'https://www.maariv.co.il/Rss/RssChadashot' },
  { id: 'walla', name: 'וואלה! חדשות', url: 'https://rss.walla.co.il/feed/1?ss=1' },
  { id: 'mako', name: 'מאקו', url: 'https://rcs.mako.co.il/rss/news-israel.xml' },
];

const MAX_ITEMS = 10;

function decodeEntities(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : '';
}

function parseRss(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks.slice(0, MAX_ITEMS)) {
    const title = extractTag(block, 'title');
    let link = extractTag(block, 'link');
    if (!link) {
      const guid = extractTag(block, 'guid');
      link = guid;
    }
    const pubDate = extractTag(block, 'pubDate');
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}

const lastGood = new Map(); // id -> { items, fetchedAt }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce(source) {
  const origin = new URL(source.url).origin;
  const res = await fetch(source.url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': origin + '/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseRss(xml);
  if (items.length === 0) throw new Error('Empty feed');
  return items;
}

async function fetchSource(source) {
  const attempts = [0, 600, 1500]; // retry a couple times with backoff
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i]) await sleep(attempts[i]);
    try {
      const items = await fetchOnce(source);
      const fetchedAt = new Date().toISOString();
      lastGood.set(source.id, { items, fetchedAt });
      return { ...source, items, error: null, stale: false, fetchedAt };
    } catch (err) {
      lastErr = err;
    }
  }
  // All attempts failed — fall back to the last successful fetch, if any.
  const cached = lastGood.get(source.id);
  if (cached) {
    return { ...source, items: cached.items, error: lastErr.message, stale: true, fetchedAt: cached.fetchedAt };
  }
  return { ...source, items: [], error: lastErr.message, stale: false, fetchedAt: new Date().toISOString() };
}

async function getAllHeadlines() {
  const results = await Promise.all(SOURCES.map(fetchSource));
  return results;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/headlines') {
      const data = await getAllHeadlines();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'public', filePath);
    const ext = path.extname(filePath);
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Israeli news headlines app running at http://localhost:${PORT}`);
});
