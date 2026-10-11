const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_DIR = path.join(DATA_DIR, 'shorts');
const SHARDS_DIR = path.join(STORE_DIR, 'shards');
const INDEX_FILE = path.join(STORE_DIR, 'index.json');
const SEEN_FILE = path.join(STORE_DIR, 'seen.sha256');
const SHARD_SIZE = 10000;

let index = null;
let seen = null;
let writeChain = Promise.resolve();

function ensure() {
  fs.mkdirSync(SHARDS_DIR, { recursive: true });
  if (!fs.existsSync(SEEN_FILE)) fs.writeFileSync(SEEN_FILE, '');
  if (!fs.existsSync(INDEX_FILE)) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify({ version: 3, shardSize: SHARD_SIZE, total: 0, byCategory: { ALL: [] } }));
  }
}

function init() {
  ensure();
  if (!index) {
    try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
    catch { index = { version: 3, shardSize: SHARD_SIZE, total: 0, byCategory: { ALL: [] } }; }
    if (!index.byCategory || !Array.isArray(index.byCategory.ALL) || index.version !== 3) {
      // Fresh V20 store; an older runtime-generated catalog is intentionally rebuilt lazily.
      index = { version: 3, shardSize: SHARD_SIZE, total: 0, byCategory: { ALL: [] } };
    }
    if (!Number.isFinite(index.total)) index.total = index.byCategory.ALL.length;
  }
  if (!seen) {
    seen = new Set();
    const text = fs.readFileSync(SEEN_FILE, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const h = line.trim();
      if (h) seen.add(h);
    }
  }
}

function hashUrl(url) { return crypto.createHash('sha256').update(String(url)).digest('hex'); }
function shardName(n) { return String(n).padStart(6, '0') + '.ndjson'; }
function shardPath(name) { return path.join(SHARDS_DIR, name); }
function persistIndex() {
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, INDEX_FILE);
}
function normalizeCategory(value) {
  const c = String(value || 'GENERAL').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').slice(0, 60);
  return c || 'GENERAL';
}
function withWriteLock(task) {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

function appendMany(items) {
  return withWriteLock(async () => {
    init();
    let nextTotal = index.total;
    const pending = [];
    const shardOffsets = new Map();
    for (const item of items || []) {
      const url = String(item?.remoteUrl || item?.url || '').trim();
      if (!url) continue;
      const hash = hashUrl(url);
      if (seen.has(hash) || pending.some(x => x.hash === hash)) continue;
      const category = normalizeCategory(item.category);
      const record = { ...item, category, url, remoteUrl: url, id: item.id || `rshort-${hash.slice(0, 24)}` };
      const line = Buffer.from(JSON.stringify(record) + '\n');
      const shard = shardName(Math.floor(nextTotal / SHARD_SIZE) + 1);
      let offset = shardOffsets.get(shard);
      if (offset === undefined) {
        const file = shardPath(shard);
        offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
      }
      shardOffsets.set(shard, offset + line.length);
      pending.push({ hash, category, record, line, shard, offset });
      nextTotal += 1;
    }
    if (!pending.length) return { added: 0, total: index.total, skipped: items?.length || 0 };

    const grouped = new Map();
    for (const item of pending) {
      if (!grouped.has(item.shard)) grouped.set(item.shard, []);
      grouped.get(item.shard).push(item);
    }
    for (const [shard, entries] of grouped) {
      const file = shardPath(shard);
      const fd = fs.openSync(file, 'a');
      try {
        for (const entry of entries) fs.writeSync(fd, entry.line);
      } finally { fs.closeSync(fd); }
    }

    const seenFd = fs.openSync(SEEN_FILE, 'a');
    try {
      for (const entry of pending) { fs.writeSync(seenFd, entry.hash + '\n'); seen.add(entry.hash); }
    } finally { fs.closeSync(seenFd); }

    for (const entry of pending) {
      const ref = [entry.shard, entry.offset, entry.line.length];
      index.byCategory.ALL.push(ref);
      if (!index.byCategory[entry.category]) index.byCategory[entry.category] = [];
      index.byCategory[entry.category].push(ref);
      index.total += 1;
    }
    persistIndex();
    return { added: pending.length, total: index.total, skipped: (items?.length || 0) - pending.length };
  });
}

function seed(items) {
  const normalized = (items || []).map(item => ({ ...item, remoteUrl: item.remoteUrl || item.url, audio: item.audio !== false, mediaSource: item.mediaSource || 'Wikimedia Commons' })).filter(item => item.remoteUrl);
  if (!normalized.length) return Promise.resolve({ added: 0, total: count() });
  return appendMany(normalized);
}
function markSeen(items) {
  init();
  const hashes = [];
  for (const item of items || []) {
    const url = String(item?.remoteUrl || item?.url || '').trim();
    if (!url) continue;
    const hash = hashUrl(url);
    if (seen.has(hash)) continue;
    seen.add(hash); hashes.push(hash);
  }
  if (hashes.length) fs.appendFileSync(SEEN_FILE, hashes.join('\n') + '\n');
  return hashes.length;
}

function readRecord(ref) {
  const [shard, offset, length] = ref;
  const file = shardPath(shard);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, offset);
    return JSON.parse(buf.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function getPage({ page = 1, limit = 12, category = 'ALL' } = {}) {
  init();
  const p = Math.max(1, Number(page) || 1);
  const l = Math.max(1, Math.min(100, Number(limit) || 12));
  const cat = String(category || 'ALL').toUpperCase();
  const refs = index.byCategory[cat] || (cat === 'ALL' ? index.byCategory.ALL : []);
  const start = (p - 1) * l;
  if (start >= refs.length) return { items: [], total: refs.length, page: p, limit: l, hasMore: false };
  const selected = refs.slice(start, start + l);
  return { items: selected.map(readRecord), total: refs.length, page: p, limit: l, hasMore: start + selected.length < refs.length };
}

function stats() {
  init();
  const categories = {};
  for (const [key, refs] of Object.entries(index.byCategory)) if (key !== 'ALL') categories[key] = refs.length;
  let bytes = 0;
  for (const name of fs.readdirSync(SHARDS_DIR)) {
    if (name.endsWith('.ndjson')) bytes += fs.statSync(shardPath(name)).size;
  }
  return { total: index.total, categories, indexedBytes: bytes, shardCount: Math.max(0, Math.ceil(index.total / SHARD_SIZE)), shardSize: SHARD_SIZE };
}
function count(category = 'ALL') { init(); return (index.byCategory[String(category).toUpperCase()] || []).length; }

module.exports = { init, appendMany, seed, markSeen, getPage, stats, count, hashUrl, SHARD_SIZE };
