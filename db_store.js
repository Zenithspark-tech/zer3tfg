// Durable record store for ZenithMax.
//
// The app keeps its full state in memory (the single source of truth for reads).
// Every change is written as one row per record in PostgreSQL, in a background
// transaction. Only records that changed are written, so a small update does not
// rewrite the whole database. Without DATABASE_URL, the same state is kept in a
// local JSON file for development.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// A stable key for each record. Records with an id keep that id. Records without one are keyed by content.
function keysFor(list) {
  const seen = new Map();
  return list.map(item => {
    const base = item && typeof item.id === 'string' && item.id ? 'i:' + item.id : 'h:' + sha(JSON.stringify(item));
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? base + '#' + n : base;
  });
}

// Compares the new state with what was last written and returns only the changes.
function diffState(shadow, state, collections) {
  const next = new Map();
  const upserts = [];
  const deletes = [];
  for (const name of collections) {
    const list = Array.isArray(state[name]) ? state[name] : [];
    const keys = keysFor(list);
    const prev = shadow.get(name) || new Map();
    const cur = new Map();
    list.forEach((item, pos) => {
      const json = JSON.stringify(item);
      const key = keys[pos];
      cur.set(key, { json, pos });
      const old = prev.get(key);
      if (!old || old.json !== json || old.pos !== pos) upserts.push({ collection: name, key, pos, json });
    });
    for (const key of prev.keys()) if (!cur.has(key)) deletes.push({ collection: name, key });
    next.set(name, cur);
  }
  return { next, upserts, deletes };
}

// Top-level values that are not record arrays (for example schemaVersion).
function rootOf(state) {
  const o = {};
  for (const [k, v] of Object.entries(state)) if (!Array.isArray(v)) o[k] = v;
  return JSON.stringify(o);
}

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

class FileStore {
  constructor(file) { this.file = file; }
  async open() {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }
  schedule(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }
  async flushNow() {}
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS zm_records (
  collection TEXT NOT NULL,
  rec_key TEXT NOT NULL,
  pos INTEGER NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, rec_key)
);
CREATE INDEX IF NOT EXISTS zm_records_order ON zm_records (collection, pos);
CREATE TABLE IF NOT EXISTS zm_root (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

class PgStore {
  // legacyFile: an existing JSON database file to import on first run (optional).
  constructor(pool, legacyFile) {
    this.pool = pool;
    this.legacyFile = legacyFile;
    this.shadow = new Map();
    this.rootJson = null;
    this.state = null;
    this.timer = null;
    this.chain = Promise.resolve();
  }

  async open() {
    await this.pool.query(SCHEMA_SQL);
    const { rows } = await this.pool.query('SELECT collection, rec_key, pos, data FROM zm_records ORDER BY collection, pos');
    if (rows.length) {
      const { rows: root } = await this.pool.query('SELECT data FROM zm_root WHERE id=1');
      return this.hydrate(rows, root[0]?.data);
    }
    return this.importLegacy();
  }

  hydrate(rows, rootData) {
    const state = rootData && typeof rootData === 'object' ? { ...rootData } : {};
    for (const r of rows) {
      if (!Array.isArray(state[r.collection])) state[r.collection] = [];
      state[r.collection].push(r.data);
      if (!this.shadow.has(r.collection)) this.shadow.set(r.collection, new Map());
      this.shadow.get(r.collection).set(r.rec_key, { json: JSON.stringify(r.data), pos: r.pos });
    }
    this.rootJson = rootData ? JSON.stringify(rootData) : null;
    return state;
  }

  async importLegacy() {
    let payload = null, source = '';
    if (this.legacyFile && fs.existsSync(this.legacyFile)) {
      payload = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
      source = 'database file';
    } else {
      try {
        const r = await this.pool.query('SELECT payload FROM zenithmax_state WHERE id=1');
        if (r.rows[0]) { payload = r.rows[0].payload; source = 'earlier snapshot'; }
      } catch (err) {
        if (err.code !== '42P01') throw err; // table does not exist: nothing to import
      }
    }
    if (payload) console.log(`Imported existing ZenithMax data (${source}) into the record store.`);
    return payload;
  }

  // Changes are queued so writes never overlap and a burst of saves becomes one write.
  schedule(state) {
    this.state = state;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow().catch(err => {
        console.error('Record store write failed; retrying in 2 seconds:', err.message);
        this.timer = setTimeout(() => { this.timer = null; this.flushNow().catch(() => {}); }, 2000);
      });
    }, 300);
  }

  flushNow() {
    const run = this.chain.catch(() => {}).then(() => this.write(this.state));
    this.chain = run;
    return run;
  }

  async write(state) {
    if (!state) return;
    const names = new Set([...Object.keys(state).filter(k => Array.isArray(state[k])), ...this.shadow.keys()]);
    const { next, upserts, deletes } = diffState(this.shadow, state, [...names]);
    const root = rootOf(state);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const byCollection = new Map();
      for (const d of deletes) {
        if (!byCollection.has(d.collection)) byCollection.set(d.collection, []);
        byCollection.get(d.collection).push(d.key);
      }
      for (const [collection, keys] of byCollection) {
        for (const part of chunks(keys, 500)) {
          await client.query('DELETE FROM zm_records WHERE collection=$1 AND rec_key = ANY($2::text[])', [collection, part]);
        }
      }
      for (const part of chunks(upserts, 300)) {
        await client.query(
          `INSERT INTO zm_records (collection, rec_key, pos, data)
           SELECT c, k, p, d::jsonb FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS t(c, k, p, d)
           ON CONFLICT (collection, rec_key) DO UPDATE SET pos = EXCLUDED.pos, data = EXCLUDED.data, updated_at = NOW()`,
          [part.map(x => x.collection), part.map(x => x.key), part.map(x => x.pos), part.map(x => x.json)]
        );
      }
      if (root !== this.rootJson) {
        await client.query(
          `INSERT INTO zm_root (id, data) VALUES (1, $1::jsonb)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [root]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    this.shadow = next;
    this.rootJson = root;
  }
}

module.exports = { keysFor, diffState, rootOf, FileStore, PgStore, SCHEMA_SQL };
