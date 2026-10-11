const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./shorts_catalog_store');

const SHORTS_CAPACITY = 567000;
const DEFAULT_USER_AGENT = 'ZenithMax/20 remote Shorts discovery';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'shorts_discovery_state.json');
const ALLOWED = ['cc0', 'public domain', 'cc by', 'cc by-sa'];

const TOPIC_SEEDS = [
  ['SPORTS',['football match','street football','basketball game','volleyball match','athletics race','cycling race','table tennis match','swimming competition','boxing training','tennis match']],
  ['FOOTBALL',['football training','football skills','football stadium','youth football','women football','futsal','goalkeeper training','football fans','football referee','football academy']],
  ['BASKETBALL',['basketball training','basketball street game','basketball dunk','basketball team','school basketball','women basketball','basketball tournament']],
  ['TRAVEL',['city walk','mountain travel','beach travel','market travel','road trip','village travel','tourist train','travel street','national park travel','island travel']],
  ['NATURE',['waterfall nature','river nature','forest walk','sunset nature','rainy day nature','flower garden','mountain landscape','desert landscape','tree canopy','spring nature']],
  ['WILDLIFE',['bird wildlife','butterfly wildlife','fish wildlife','elephant wildlife','monkey wildlife','lion wildlife','reptile wildlife','zebra wildlife','giraffe wildlife','marine wildlife']],
  ['PETS',['dog playing','cat playing','pet birds','pet rabbit','pets outdoors','puppy playing','kitten playing']],
  ['TECH',['robotics demonstration','3D printer','computer laboratory','electronics repair','drone technology','technology workshop','AI demonstration','coding workshop']],
  ['SCIENCE',['science experiment','physics demonstration','chemistry experiment','biology laboratory','microscope science','meteorology experiment','engineering experiment']],
  ['SPACE',['telescope astronomy','night sky','moon observation','planetarium','rocket launch','space science','aurora sky']],
  ['EDUCATION',['classroom lesson','school science','teacher demonstration','students learning','library study','educational experiment','math lesson']],
  ['DIY',['woodworking project','craft project','electronics DIY','home repair','paper craft','maker workshop','sewing project']],
  ['COOKING',['street food cooking','home cooking','bakery kitchen','bread making','fruit preparation','traditional cooking','grilling food']],
  ['FOOD',['fresh market food','food market','restaurant kitchen','farm food','fruit market','local cuisine','food festival']],
  ['DANCE',['street dance','traditional dance','folk dance','dance rehearsal','cultural dance','dance performance','african dance']],
  ['MUSIC',['live music performance','folk music performance','drum performance','guitar performance','choir performance','music rehearsal','piano performance']],
  ['CULTURE',['cultural festival','traditional clothing','cultural ceremony','local festival','traditional craft','cultural parade','heritage festival']],
  ['ART',['painting demonstration','sculpture art','street art','art workshop','drawing process','museum art','ceramic art']],
  ['HISTORY',['historic building','historical reenactment','old town walk','heritage site','historic railway','museum history','ancient ruins']],
  ['CARS',['sports car','car restoration','car show','classic car','car workshop','driving road','electric car']],
  ['MOTORCYCLES',['motorcycle ride','motorcycle show','motorcycle repair','bike road trip','motorcycle racing','scooter city']],
  ['TRAINS',['train station','passenger train','railway journey','tram ride','metro train','railway bridge','freight train']],
  ['AVIATION',['airplane takeoff','airport runway','helicopter flight','aircraft museum','aviation show','small airplane','airport terminal']],
  ['CITY',['city street','urban traffic','city park','downtown walk','night city','public square','city festival']],
  ['ARCHITECTURE',['modern building','historic architecture','bridge architecture','city skyline','mosque architecture','church architecture','stadium architecture']],
  ['FARMING',['farm work','tractor farming','harvest season','vegetable farm','rice farming','fruit orchard','irrigation farming']],
  ['OCEAN',['ocean waves','beach ocean','coastal wildlife','fishing boat','sailing boat','underwater ocean','coral reef']],
  ['WEATHER',['rain storm','clouds timelapse','snow weather','sunset sky','thunderstorm sky','wind weather','fog weather']],
  ['COMMUNITY',['community event','volunteer activity','neighborhood event','school community','local market','public gathering','community sports']],
  ['AFRICA',['African city','African market','African culture','African wildlife','African football','African festival','African transport']],
  ['NIGERIA',['Nigeria street','Nigeria football','Nigeria culture','Nigeria market','Nigeria nature','Nigeria festival','Nigeria technology','Lagos city','Ibadan city']],
  ['GHANA',['Ghana street','Ghana culture','Ghana football','Ghana market','Ghana dance','Ghana coast']],
  ['SOUTH AFRICA',['South Africa city','South Africa wildlife','South Africa football','South Africa coast','Cape Town street']],
  ['FITNESS',['fitness training','running exercise','gym training','stretching exercise','sports workout','yoga outdoors']],
  ['OUTDOORS',['hiking trail','camping outdoors','rock climbing','kayaking','cycling outdoors','nature walk','canoeing']],
  ['TRANSPORT',['bus station','city bus','ferry boat','bicycle transport','public transport','road traffic','taxi street']],
  ['ENGINEERING',['bridge construction','machine workshop','engineering laboratory','construction equipment','mechanical engineering','factory machinery']],
  ['BUSINESS',['small business market','shop owner','craft business','farm business','street entrepreneur','small shop'],],
  ['PEOPLE',['family activity','friends outdoors','students activity','teamwork real life','community life','people walking']],
];

const QUERY_VARIANTS = ['video', 'footage', 'webm', 'real life', 'documentary clip'];

function ensureState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 2, cursors: {}, exhausted: {}, updatedAt: 0 }));
}
function loadState() {
  ensureState();
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { version: 2, cursors: {}, exhausted: {}, updatedAt: 0 }; }
}
function saveState(state) {
  state.updatedAt = Date.now();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function allowedLicense(license) {
  const s = String(license || '').replace(/<[^>]+>/g, '').toLowerCase();
  return ALLOWED.some(x => s.includes(x));
}

async function searchCommons(query, offset = 0, limit = 50) {
  const qs = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6',
    gsrlimit: String(Math.min(limit, 50)), gsroffset: String(offset),
    prop: 'imageinfo', iiprop: 'url|mime|extmetadata', format: 'json', origin: '*'
  });
  const response = await fetch('https://commons.wikimedia.org/w/api.php?' + qs.toString(), {
    headers: { 'User-Agent': DEFAULT_USER_AGENT }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Commons API ' + response.status);
  const data = await response.json();
  const items = Object.values(data.query?.pages || {}).map(page => {
    const ii = page.imageinfo?.[0] || {};
    const md = ii.extmetadata || {};
    return {
      url: ii.url || '', mime: ii.mime || '',
      title: String(page.title || '').replace(/^File:/, ''),
      license: md.LicenseShortName?.value || md.License?.value || '',
      sourcePage: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(page.title || '')),
      sourceCreator: md.Artist?.value || md.Credit?.value || ''
    };
  }).filter(item => /^video\/(mp4|webm|ogg)$/i.test(item.mime) && item.url && allowedLicense(item.license));
  return { items, nextOffset: data.continue?.gsroffset ?? null };
}

function topicsFor(category) {
  const c = String(category || 'ALL').toUpperCase();
  return c === 'ALL' ? TOPIC_SEEDS.flatMap(([categoryName, topics]) => topics.map(topic => ({ category: categoryName, topic })))
    : TOPIC_SEEDS.filter(([categoryName]) => categoryName === c).flatMap(([categoryName, topics]) => topics.map(topic => ({ category: categoryName, topic })));
}

function makeItem(raw, category, topic) {
  const id = 'rshort-' + crypto.createHash('sha256').update(raw.url).digest('hex').slice(0, 24);
  return {
    id, category, topic, title: raw.title.replace(/\.[^.]+$/, '').slice(0, 120) || topic,
    description: `Real-world ${topic} footage from Wikimedia Commons.`,
    tags: [category, ...topic.split(/\s+/)].slice(0, 10), duration: 0,
    sourceFile: raw.title, sourcePage: raw.sourcePage, sourceCreator: raw.sourceCreator,
    license: raw.license, audio: true, mediaSource: 'Wikimedia Commons', remoteUrl: raw.url,
    remoteKey: Buffer.from(raw.url).toString('base64url'), createdAt: new Date().toISOString()
  };
}

let discoveryLock = null;
async function grow({ count = 100, category = 'ALL', maxRequests = 80 } = {}) {
  if (discoveryLock) return discoveryLock;
  discoveryLock = (async () => {
    store.init();
    const before = store.count(category);
    const target = Math.min(SHORTS_CAPACITY, before + Math.max(1, Math.min(5000, Number(count) || 100)));
    const state = loadState();
    const topics = topicsFor(category);
    let requests = 0;
    let added = 0;
    let cursorIndex = 0;

    while (store.count(category) < target && requests < maxRequests && topics.length) {
      const topicEntry = topics[cursorIndex % topics.length];
      cursorIndex += 1;
      const baseKey = `${topicEntry.category}|${topicEntry.topic}`;
      const variant = Number(state.cursors[baseKey]?.variant || 0) % QUERY_VARIANTS.length;
      const queryKey = `${baseKey}|${variant}`;
      if (state.exhausted[queryKey]) continue;
      const offset = Number(state.cursors[queryKey]?.offset || 0);
      const query = `${topicEntry.topic} ${QUERY_VARIANTS[variant]}`;
      let result;
      try {
        requests += 1;
        result = await searchCommons(query, offset, 50);
      } catch {
        continue;
      }
      const newItems = result.items.map(item => makeItem(item, topicEntry.category, topicEntry.topic));
      const write = await store.appendMany(newItems);
      added += write.added;
      if (result.nextOffset !== null && result.nextOffset !== undefined) {
        state.cursors[queryKey] = { offset: result.nextOffset, variant };
      } else if (variant + 1 < QUERY_VARIANTS.length) {
        state.cursors[baseKey] = { variant: variant + 1 };
        state.exhausted[queryKey] = true;
      } else {
        state.exhausted[queryKey] = true;
      }
      saveState(state);
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    const stats = store.stats();
    return { before, added, requested: target - before, total: stats.total, categoryTotal: store.count(category), stats };
  })().finally(() => { discoveryLock = null; });
  return discoveryLock;
}

async function ensureCount({ targetCount = 12, category = 'ALL' } = {}) {
  store.init();
  const target = Math.min(SHORTS_CAPACITY, Math.max(0, Number(targetCount) || 0));
  if (store.count(category) >= target) return store.getPage({ page: 1, limit: target, category });
  const needed = target - store.count(category);
  try { await grow({ count: needed, category, maxRequests: Math.min(250, Math.ceil(needed / 3) + 15) }); } catch {}
  return store.getPage({ page: 1, limit: Math.min(target, 100), category });
}

async function getPage({ page = 1, limit = 12, category = 'ALL' } = {}) {
  store.init();
  const start = (Math.max(1, Number(page)) - 1) * Math.max(1, Number(limit));
  const target = Math.min(SHORTS_CAPACITY, start + Math.max(1, Number(limit)));
  if (store.count(category) < target) {
    try { await grow({ count: target - store.count(category), category, maxRequests: 60 }); } catch {}
  }
  const pageData = store.getPage({ page, limit, category });
  return { ...pageData, capacity: SHORTS_CAPACITY, available: store.count(category) };
}

function seed(items) { return store.seed(items); }
function markSeen(items) { return store.markSeen(items); }
function stats() { return { capacity: SHORTS_CAPACITY, ...store.stats() }; }
function decodeRemoteKey(key) { try { return Buffer.from(String(key), 'base64url').toString('utf8'); } catch { return ''; } }
function isAllowedRemoteUrl(url) { try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'commons.wikimedia.org' || u.hostname.endsWith('.wikimedia.org')); } catch { return false; } }

module.exports = { SHORTS_CAPACITY, TOPIC_SEEDS, searchCommons, grow, ensureCount, getPage, seed, markSeen, stats, decodeRemoteKey, isAllowedRemoteUrl };
