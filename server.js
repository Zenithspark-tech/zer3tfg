const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { Readable } = require('stream');
const shortsRemote = require('./shorts_remote');
const productionServices = require('./production_services');
const { FileStore, PgStore } = require('./db_store');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const GAME_DIR = path.join(DATA_DIR, 'games');
const DB = path.join(DATA_DIR, 'db.json');
const SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_IN_PRODUCTION';
const REFRESH_SECRET = process.env.REFRESH_SECRET || SECRET;
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const API_VERSION = '31.0.0';
const SCHEMA_VERSION = 29;
const RELEASE_CHANNEL = process.env.RELEASE_CHANNEL || 'stable';
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const SESSION_VERSIONS = new Map();
const METRICS = {startedAt:Date.now(),requests:0,errors:0,byStatus:{},routeCounts:{},latencyMs:0};
if (IS_PRODUCTION) {
  const weakSecret = v => v === 'CHANGE_THIS_IN_PRODUCTION' || v.length < 32;
  if (weakSecret(SECRET) || weakSecret(String(process.env.REFRESH_SECRET || ''))) {
    console.error('JWT_SECRET and REFRESH_SECRET must each be set to random values of 32+ characters in production.');
    process.exit(1);
  }
}
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'starter_catalog.json'), 'utf8'));
const LONG_VIDEOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'long_video_catalog.json'), 'utf8'));
const SHORTS_FILE = fs.existsSync(path.join(__dirname, 'shorts_catalog.json'))
  ? path.join(__dirname, 'shorts_catalog.json')
  : path.join(ROOT, 'shorts_catalog.json');
const SHORTS = JSON.parse(fs.readFileSync(SHORTS_FILE, 'utf8'));
const REMOTE_HOME_FILE = path.join(DATA_DIR, 'remote_home_videos.json');
const HOME_REMOTE_QUERIES = [
  'football match', 'basketball game', 'street football', 'cycling race', 'travel city walk',
  'ocean waves', 'waterfall nature', 'wildlife animals', 'science experiment', 'robotics technology',
  'space astronomy', 'cooking food', 'African culture', 'Nigerian culture', 'dance performance',
  'music performance', 'art painting', 'architecture', 'train railway', 'cars motorsport',
  'aviation airplane', 'education classroom', 'language learning', 'community event'
];
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(GAME_DIR, { recursive: true });

const REMOTE_CACHE = path.join(DATA_DIR, 'remote_video_cache.json');
const RESUMABLE_DIR = path.join(DATA_DIR, 'resumable');
const RESUMABLE_CHUNK = 2 * 1024 * 1024;
fs.mkdirSync(RESUMABLE_DIR, { recursive: true });
const ALLOWED_LICENSES = ['CC0','Public domain','CC BY','CC BY-SA'];
function commonsDirectUrl(fileName){
  const name=String(fileName||'').replace(/^File:/,'').trim();
  if(!name)return '';
  const hash=crypto.createHash('md5').update(name).digest('hex');
  return `https://upload.wikimedia.org/wikipedia/commons/${hash[0]}/${hash.slice(0,2)}/${encodeURIComponent(name)}`;
}
function commonsRedirectUrl(fileName){
  const name=String(fileName||'').replace(/^File:/,'').trim();
  return name?`https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(name)}`:'';
}
function isRemoteMediaUrl(url){
  try{const u=new URL(url);return u.protocol==='https:'&&(u.hostname==='upload.wikimedia.org'||u.hostname==='commons.wikimedia.org'||u.hostname.endsWith('.wikimedia.org'));}
  catch{return false;}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function isAllowedLicense(license){
  const s=String(license||'').replace(/<[^>]+>/g,'').trim().toLowerCase();
  return ALLOWED_LICENSES.some(x=>s.includes(x.toLowerCase()));
}

const YOUTUBE_API_KEY = String(process.env.YOUTUBE_API_KEY || '').trim();
function youtubeVideoId(value){
  try{
    const u=new URL(String(value));
    if(u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0] || '';
    if(u.hostname.includes('youtube.com')){
      if(u.pathname==='/watch') return u.searchParams.get('v')||'';
      const m=u.pathname.match(/\/(?:embed|shorts|live)\/([^/?]+)/i); if(m)return m[1];
    }
  }catch{}
  return '';
}
function youtubeEmbedUrl(id){return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?playsinline=1&rel=0`}
function youtubeThumb(id){return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`}
async function youtubeSearch(term,limit=10){
  if(!YOUTUBE_API_KEY)return [];
  const qs=new URLSearchParams({key:YOUTUBE_API_KEY,part:'snippet',type:'video',maxResults:String(Math.min(50,Math.max(1,limit))),q:String(term||'')});
  const r=await fetch('https://www.googleapis.com/youtube/v3/search?'+qs.toString(),{headers:{'User-Agent':'ZenithMax/26 YouTube API client'},signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw new Error(`YouTube API ${r.status}`);
  const j=await r.json();
  return (j.items||[]).map(x=>{
    const id=x.id?.videoId; if(!id)return null;
    return {id:'youtube-'+id,title:x.snippet?.title||'YouTube video',description:x.snippet?.description||'',category:'DISCOVER',tags:String(x.snippet?.title||'').split(/\s+/).slice(0,8),url:`https://www.youtube.com/watch?v=${id}`,sourceUrl:`https://www.youtube.com/watch?v=${id}`,embedUrl:youtubeEmbedUrl(id),thumbnail:youtubeThumb(id),provider:x.snippet?.channelTitle||'YouTube creator',creator:x.snippet?.channelTitle||'YouTube creator',source:'YouTube',sourceProvider:'YouTube',external:true,remote:false,audio:true,views:0,likes:0,createdAt:x.snippet?.publishedAt||now(),duration:0,status:'published'};
  }).filter(Boolean);
}
async function commonsSearch(term, limit=50){
  const qs=new URLSearchParams({
    action:'query',generator:'search',gsrsearch:String(term),gsrnamespace:'6',gsrlimit:String(Math.min(limit,50)),
    prop:'imageinfo',iiprop:'url|mime|extmetadata',format:'json',origin:'*'
  });
  const r=await fetch(`https://commons.wikimedia.org/w/api.php?${qs.toString()}`,{headers:{'User-Agent':'ZenithMax/20 remote starter media'},signal:AbortSignal.timeout(8000)});
  if(!r.ok) throw new Error(`Commons API ${r.status}`);
  const j=await r.json();
  return Object.values(j.query?.pages||{}).map(page=>{
    const ii=page.imageinfo?.[0]||{}, md=ii.extmetadata||{};
    return {
      title:String(page.title||'').replace(/^File:/,''),
      url:ii.url||'', mime:ii.mime||'',
      license:md.LicenseShortName?.value||md.License?.value||'',
      sourcePage:`https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title||''))}`,
      sourceCreator:md.Artist?.value||md.Credit?.value||''
    };
  }).filter(x=>/^video\/(mp4|webm|ogg)$/i.test(x.mime)&&x.url&&isAllowedLicense(x.license));
}
function tokenScore(a,b){
  const stop=new Set(['video','videos','the','and','for','with','of','a','an','on','in']);
  const A=new Set(String(a).toLowerCase().split(/[^a-z0-9]+/).filter(x=>x&&!stop.has(x)));
  const B=String(b).toLowerCase();
  let score=0; for(const t of A) if(B.includes(t)) score+=t.length>=6?3:1; return score;
}
async function resolveRemoteCatalog(){
  let cache={}; try{if(fs.existsSync(REMOTE_CACHE))cache=JSON.parse(fs.readFileSync(REMOTE_CACHE,'utf8'));}catch{}
  const used=new Set();
  // Reuse already verified cache entries first.
  for(const item of CATALOG.videos){
    const hit=cache[item.slug];
    if(hit?.url && isAllowedLicense(hit.license)){
      Object.assign(item,{remoteUrl:hit.url,remoteTitle:hit.title,license:hit.license,sourcePage:hit.sourcePage,sourceCreator:hit.sourceCreator,mediaSource:'Wikimedia Commons'});
      used.add(hit.url);
    }
  }
  const cats=[...new Set(CATALOG.videos.map(v=>v.category))];
  for(const cat of cats){
    const pending=CATALOG.videos.filter(v=>v.category===cat && !v.remoteUrl);
    if(!pending.length) continue;
    let pool=[];
    try{ pool=await commonsSearch(`${cat.toLowerCase()} video`,50); }catch(err){ console.warn(`Remote pool lookup failed for ${cat}: ${err.message}`); }
    // Prefer files whose titles overlap the requested topic; then fill any gaps from the category pool.
    const available=pool.filter(x=>!used.has(x.url));
    const chosen=new Set();
    for(const item of pending){
      const ranked=[...available].filter(x=>!chosen.has(x.url)).sort((a,b)=>tokenScore(item.searchTopic,a.title)-tokenScore(item.searchTopic,b.title));
      const hit=ranked.find(x=>tokenScore(item.searchTopic,x.title)>0) || ranked[0];
      if(hit){
        Object.assign(item,{remoteUrl:hit.url,remoteTitle:hit.title,license:hit.license,sourcePage:hit.sourcePage,sourceCreator:hit.sourceCreator,mediaSource:'Wikimedia Commons'});
        used.add(hit.url); chosen.add(hit.url); cache[item.slug]=hit;
      }
    }
  }
  // A final small number of topic searches handles category terms that Commons does not index well.
  const unresolved=CATALOG.videos.filter(v=>!v.remoteUrl);
  for(let i=0;i<unresolved.length;i+=6){
    const batch=unresolved.slice(i,i+6);
    const results=await Promise.all(batch.map(async item=>{
      try{return [item, await commonsSearch(`${item.searchTopic} video`,20)]}catch(err){console.warn(`Topic lookup failed for ${item.searchTopic}: ${err.message}`);return [item,[]]}
    }));
    for(const [item,rs] of results){
      const hit=rs.find(x=>!used.has(x.url));
      if(hit){
        Object.assign(item,{remoteUrl:hit.url,remoteTitle:hit.title,license:hit.license,sourcePage:hit.sourcePage,sourceCreator:hit.sourceCreator,mediaSource:'Wikimedia Commons'});
        used.add(hit.url); cache[item.slug]=hit;
      } else Object.assign(item,{remoteUrl:'',remoteTitle:'Remote source unavailable',mediaSource:'unresolved'});
    }
  }
  try{fs.mkdirSync(DATA_DIR,{recursive:true});fs.writeFileSync(REMOTE_CACHE,JSON.stringify(cache,null,2));}catch{}
  CATALOG.remote_video_library=Object.values(cache).filter(x=>x?.url);
  return {unique:[...used].length,unresolved:CATALOG.videos.filter(v=>!v.remoteUrl).length};
}


function curatedExternalVideos(){
  return LONG_VIDEOS.filter(v=>v.duration>=60&&v.duration<=18000).map(v=>({...v,external:true,remote:false,creator:v.provider,creatorId:'external-'+v.id,verified:false,audio:true,views:0,likes:0,createdAt:v.publishedAt||'2026-09-01T00:00:00.000Z'}));
}
function curatedStarterYouTube(limit=6){
  return CATALOG.videos.filter(v=>v.external && String(v.source||'').toLowerCase()==='youtube' && v.embedUrl).slice(0,limit).map((v,i)=>({
    id:'starter-'+v.slug,userId:CATALOG.creators[v.creatorIndex%CATALOG.creators.length]?.id||'creator-zenith',title:v.title,description:v.description||'',category:v.category||'DISCOVER',tags:v.tags||[],
    url:v.sourceUrl||'',sourceUrl:v.sourceUrl||'',embedUrl:v.embedUrl,thumbnail:v.thumbnail||'',provider:v.provider||'YouTube',creator:v.provider||'YouTube creator',source:'YouTube',sourceProvider:'YouTube',external:true,remote:false,audio:true,
    views:4200+i*731,likes:180+i*37,createdAt:new Date(Date.now()-i*3600000).toISOString(),duration:Number(v.duration)||240,status:'published',verified:true,avatar:'',starter:true,
    sourcePage:v.sourceUrl||'',sourceCreator:v.provider||'YouTube'
  }));
}
function externalFeedVideos(limit=12){
  const yt=curatedStarterYouTube(Math.min(6,limit));
  const long=curatedExternalVideos(Math.max(0,limit-yt.length)).slice(0,Math.max(0,limit-yt.length));
  const remote=loadRemoteHome().slice(0,Math.max(0,limit-yt.length-long.length)).map(x=>remotePub(x,{user:null}));
  return [...yt,...long,...remote].slice(0,limit);
}
function loadRemoteHome(){
  try { if(fs.existsSync(REMOTE_HOME_FILE)) return JSON.parse(fs.readFileSync(REMOTE_HOME_FILE,'utf8')); } catch {}
  return [];
}
function saveRemoteHome(items){
  try { fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(REMOTE_HOME_FILE,JSON.stringify(items,null,2)); } catch {}
}
function remoteId(url){ return 'remote-'+crypto.createHash('sha256').update(String(url)).digest('hex').slice(0,24); }
function remotePub(x,req){
  return {
    id:x.id,title:x.title,description:x.description||`Remote video about ${x.query||'this topic'}.`,category:x.category||'DISCOVER',tags:x.tags||[],
    url:x.url,remoteUrl:x.url,remote:true,remoteTitle:x.title,audio:true,mediaSource:'Wikimedia Commons',license:x.license||'',sourcePage:x.sourcePage||'',sourceCreator:x.sourceCreator||'',
    likes:0,views:x.views||0,createdAt:x.createdAt||now(),duration:x.duration||0,status:'published',
    streamUrl:`/api/remote-video/${encodeURIComponent(x.id)}`,creator:'Open Media Source',creatorId:'creator-zenith',verified:true,avatar:'',
    liked:false,saved:false,following:false,commentCount:0,query:x.query||''
  };
}
async function discoverRemoteHome(limitPerQuery=12){
  const items=loadRemoteHome(); const used=new Set(items.map(x=>x.url).filter(Boolean));
  for(const query of HOME_REMOTE_QUERIES){
    try{
      const results=await commonsSearch(query,Math.min(20,limitPerQuery+8));
      for(const r of results){
        if(!r.url||used.has(r.url)) continue;
        const id=remoteId(r.url); if(items.some(x=>x.id===id)) continue;
        items.push({id,title:r.title,description:`Real remote video about ${query}.`,query,category:'DISCOVER',tags:query.split(/\s+/),url:r.url,license:r.license,sourcePage:r.sourcePage,sourceCreator:r.sourceCreator,createdAt:now(),views:0,audio:true});
        used.add(r.url);
        if(items.length>=192) break;
      }
    } catch(err){ console.warn(`Remote home lookup failed for ${query}: ${err.message}`); }
    if(items.length>=192) break;
  }
  saveRemoteHome(items); return items;
}
async function searchRemoteVideos(query,limit=16){
  const q=clean(query,120); if(q.length<2)return [];
  const cached=loadRemoteHome().filter(x => (x.title||'').toLowerCase().includes(q.toLowerCase()) || (x.query||'').toLowerCase().includes(q.toLowerCase()));
  const out=[]; const used=new Set();
  for(const x of cached){ if(!used.has(x.url)){out.push(x);used.add(x.url);} if(out.length>=limit) return out; }
  const terms=[`${q} video`,`${q} footage`,`${q} performance`];
  for(const term of terms){
    try{
      const results=await commonsSearch(term,Math.min(20,limit*2));
      for(const r of results){
        if(!r.url||used.has(r.url)) continue;
        const item={id:remoteId(r.url),title:r.title,description:`Real remote video related to ${q}.`,query:q,category:'SEARCH',tags:q.split(/\s+/),url:r.url,license:r.license,sourcePage:r.sourcePage,sourceCreator:r.sourceCreator,createdAt:now(),views:0,audio:true};
        out.push(item); used.add(r.url);
        if(out.length>=limit) break;
      }
    }catch(err){ console.warn(`Remote search failed for ${term}: ${err.message}`); }
    if(out.length>=limit) break;
  }
  if(out.length){
    const all=loadRemoteHome(); const map=new Map(all.map(x=>[x.url,x])); for(const x of out) map.set(x.url,x); saveRemoteHome([...map.values()].slice(0,1000));
  }
  return out;
}
function relatedSearchTerms(q){
  const s=String(q||'').toLowerCase();
  const m={football:['soccer','football match','football training'],soccer:['football','soccer match'],car:['cars','motorsport','racing'],cars:['car','motorsport','racing'],music:['music performance','musician','concert'],travel:['travel','city walk','tourism'],food:['cooking','food','recipe'],nature:['nature','wildlife','waterfall'],wildlife:['animals','wildlife','nature'],science:['science','experiment','robotics'],technology:['robotics','technology','computer'],school:['education','classroom','learning'],education:['education','classroom','learning'],dance:['dance performance','cultural dance'],nigeria:['nigeria','nigerian culture','africa'],africa:['africa','african culture'],train:['train','railway'],airplane:['aviation','airplane'],space:['astronomy','space']};
  return [...new Set([q,...(m[s]||[])])].slice(0,4);
}

const COLLECTIONS = ['users','videos','comments','follows','likes','stories','storyViews','posts','postLikes','postBookmarks','postComments','messages','notifications','bookmarks','reports','history','playlists','subscriptions','creatorSubscriptions','tips','adCampaigns','earnings','music','games','groups','calls','callSignals','scheduledLives','premieres','series','sounds','effects','membershipTiers','creatorPolls','remixDrafts','blocks','auditLogs','loginEvents','hiddenVideos','entertainmentProgress','entertainmentDailyXp','entertainmentEvents','entertainmentChallenges','entertainmentWatchParties','entertainmentContests'];
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '234';
const CEO_EMAILS = new Set(
  String(process.env.CEO_EMAILS || 'zenitholuwambe5@gmail.com')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean)
);
function applyExecutiveIdentity(u){
  if(!u) return u;
  const email=String(u.email||'').trim().toLowerCase();
  if(CEO_EMAILS.has(email) && (u.googleVerified===true || u.emailVerified===true)){
    u.isCEO=true;
    u.companyRole='CEO';
    u.companyName='ZenithMax';
    u.title='CEO of ZenithMax';
    u.verified=true;
  } else if(u.isCEO){
    // An executive title granted without a Google-verified email is removed.
    u.isCEO=false; u.companyRole=''; u.companyName=''; u.title=''; u.verified=false;
  }
  return u;
}
function normalizePhone(input){
  let s=String(input||'').trim().replace(/[^0-9+]/g,'');
  if(!s)return '';
  if(s.startsWith('00'))s='+'+s.slice(2);
  if(s.startsWith('+'))return '+'+s.slice(1).replace(/\D/g,'');
  if(s.startsWith('0'))return '+'+DEFAULT_COUNTRY_CODE+s.slice(1).replace(/\D/g,'');
  return '+'+s.replace(/\D/g,'');
}
function maskPhone(phone){const p=String(phone||''); if(p.length<7)return p; return p.slice(0,4)+'••••'+p.slice(-3)}
function isMember(group,userId){return !!group && Array.isArray(group.memberIds) && group.memberIds.includes(userId)}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const clean = (v, n=500) => String(v || '').trim().slice(0, n);

function save(d){
  d.schemaVersion=SCHEMA_VERSION;
  for(const u of d.users) SESSION_VERSIONS.set(u.id,Number(u.sessionVersion||0));
  if(PERSIST) PERSIST.schedule(d);
}
function seed(d){
  let changed = false;
  d.users ??= []; d.videos ??= []; d.posts ??= []; d.stories ??= []; d.storyViews ??= []; d.postLikes ??= []; d.postBookmarks ??= []; d.postComments ??= [];
  for (const c of CATALOG.creators){
    if (!d.users.some(u => u.id === c.id)){
      d.users.push({
        id:c.id, name:c.name, email:c.id+'@demo.zenithmax.app',
        password:bcrypt.hashSync(crypto.randomBytes(32).toString('hex'),8), bio:c.bio,
        followers:350+Math.floor(Math.random()*4200), following:12,
        role:'creator', createdAt:'2026-01-01T00:00:00.000Z', starter:true,
        verified:true, avatar:'', banner:'', notificationsEnabled:true
      });
      changed = true;
    }
  }
  CATALOG.videos.forEach((x,i)=>{
    const vid='starter-'+x.slug;
    const existing=d.videos.find(v=>v.id===vid);
    const c=CATALOG.creators[x.creatorIndex%CATALOG.creators.length];
    if(existing){
      // V27.3 migration: replace the old 2-second Wikimedia demo records with
      // the curated, playable featured catalog. Do not leave the old starter
      // duration/source metadata in the feed after an upgrade.
      const next = {
        title:x.title, description:x.description||'', category:x.category||'GENERAL', tags:Array.isArray(x.tags)?x.tags:[],
        audio:true, starter:true, status:'published', duration:Number(x.duration)||240,
        source:x.source||'', sourceUrl:x.sourceUrl||'', embedUrl:x.embedUrl||'', thumbnail:x.thumbnail||'', provider:x.provider||c.name,
        external:!!x.external, remote:false, mediaSource:x.source==='YouTube'?'YouTube':'remote',
        url:x.sourceUrl||x.remoteUrl||'', remoteUrl:x.remoteUrl||'', remoteTitle:x.remoteTitle||'',
        license:x.license||'', sourcePage:x.sourcePage||x.sourceUrl||'', sourceCreator:x.sourceCreator||x.provider||c.name
      };
      for(const [k,v] of Object.entries(next)){ if(v!==undefined) existing[k]=v; }
      if(existing.external && existing.source==='YouTube') existing.streamUrl='';
      changed=true;
      return;
    }
    d.videos.push({
      id:vid,userId:c.id,title:x.title,description:x.description||'',category:x.category||'GENERAL',
      tags:Array.isArray(x.tags)?x.tags:[],url:x.sourceUrl||x.remoteUrl||'',remoteTitle:x.remoteTitle||'',audio:true,
      mediaSource:x.source==='YouTube'?'YouTube':'remote',license:x.license||'',sourcePage:x.sourcePage||x.sourceUrl||'',sourceCreator:x.sourceCreator||x.provider||c.name,
      source:x.source||'',sourceUrl:x.sourceUrl||'',embedUrl:x.embedUrl||'',thumbnail:x.thumbnail||'',provider:x.provider||c.name,
      external:!!x.external,remote:false,likes:70+(i*43)%9500,views:1200+(i*7919)%980000,
      createdAt:new Date(Date.now()-i*2100000).toISOString(),starter:true,duration:Number(x.duration)||240,status:'published'
    });
    changed=true;
  });
  const C=i=>CATALOG.creators[i%CATALOG.creators.length];
  // Original HTML5 starter game, copied into the game store and listed in the Arcade.
  const triviaSrc = path.join(ROOT, 'server/starter_games/trivia-blitz/index.html');
  if (fs.existsSync(triviaSrc)) {
    const gameDir = path.join(GAME_DIR, 'game-starter-trivia');
    fs.mkdirSync(gameDir, { recursive: true });
    const html = fs.readFileSync(triviaSrc);
    const target = path.join(gameDir, 'index.html');
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(html)) { fs.writeFileSync(target, html); }
    if (!d.games.some(g => g.id === 'game-starter-trivia')) {
      d.games.push({ id:'game-starter-trivia', userId:CATALOG.creators[0]?.id||'', title:'Trivia Blitz', description:'Eight quick questions, ten seconds each. Faster answers score more.', genre:'QUIZ', version:'1.0.0', url:'/game-assets/game-starter-trivia/index.html', playUrl:'/api/games/game-starter-trivia/play', files:1, bytes:html.length, plays:0, createdAt:now(), status:'published', starter:true });
      changed = true;
    }
  }
  const starterPosts = [
    ['starter-post-1', CATALOG.creators[0], 'Welcome to ZenithMax 🚀 Build, discover and share your world.', ['ZenithMax','Creators','Community']],
    ['starter-post-2', CATALOG.creators[1], 'What are you watching today? Share a topic and discover something new.', ['Discover','Video']],
    ['starter-post-3', CATALOG.creators[2], 'Music, games, learning and communication are coming together in one place.', ['Music','Games','Learning']],
    ['starter-post-4', CATALOG.creators[3], 'Creators can publish original content, build playlists and connect with their audience.', ['Creators','Playlists']],
    ['starter-post-5', CATALOG.creators[4], 'Use Stories for quick updates, behind-the-scenes moments and announcements.', ['Stories','Updates']],
    ['starter-post-6', CATALOG.creators[5], 'Tip: save videos and posts so you can return to them later.', ['Tips','Saved']],
    ['starter-post-7', CATALOG.creators[6], 'ZenithMax communication supports direct chat, groups, voice notes and internet calls.', ['Chat','Calls']],
    ['starter-post-8', CATALOG.creators[7], 'Tell the community what you are creating this week.', ['Community','Creation']],
    ['starter-post-9', C(8), 'Did you know? Honey found in ancient Egyptian tombs was still edible after thousands of years.', ['DidYouKnow','Science']],
    ['starter-post-10', C(9), 'Octopuses have three hearts and blue blood. Which animal fact blew your mind this week?', ['DidYouKnow','Animals']],
    ['starter-post-11', C(10), 'Weekend challenge: film a 15-second clip that makes someone smile, then tag #ZenithChallenge.', ['Challenge','Creators']],
    ['starter-post-12', C(11), 'Creator tip: your first three seconds decide whether people keep watching. Hook them early.', ['CreatorTips','Video']],
    ['starter-post-13', C(0), 'Lightning can be about five times hotter than the surface of the sun. Science never stops surprising us.', ['DidYouKnow','Science']],
    ['starter-post-14', C(1), 'Music tip: upload a demo today, even if it is rough. Feedback beats waiting for perfect.', ['Music','CreatorTips']],
    ['starter-post-15', C(2), 'Trivia: Venus takes longer to spin once than to orbit the Sun. Did you guess that?', ['Trivia','Space']],
    ['starter-post-16', C(3), 'Learning tip: explain what you learned to someone else in one minute. It sticks.', ['Learning','Tips']],
    ['starter-post-17', C(4), 'Community poll: morning person or night owl? Reply below and see what the community picks.', ['Poll','Community']],
    ['starter-post-18', C(5), 'Sea otters hold paws while they sleep so they do not drift apart. Friendship goals.', ['DidYouKnow','Animals']],
    ['starter-post-19', C(6), 'Your ZenithMax XP grows when you play games, join challenges and share. Start your streak today!', ['Arcade','Rewards']]
  ];
  for (const [id,creator,text,tags] of starterPosts) {
    if (!d.posts.some(p=>p.id===id)) {
      d.posts.push({id,userId:creator.id,text,hashtags:tags,mediaUrl:'',mediaType:'',likes:20+Math.floor(Math.random()*900),comments:0,createdAt:new Date(Date.now()-(d.posts.length*2+1)*3600000).toISOString(),starter:true});
      changed=true;
    }
  }
  const starterStories = [
    ['starter-story-1', CATALOG.creators[0], '🚀 Welcome to the ZenithMax community!'],
    ['starter-story-2', CATALOG.creators[1], '🎬 A new day to discover something interesting.'],
    ['starter-story-3', CATALOG.creators[2], '🎵 Music creators: share your newest work.'],
    ['starter-story-4', CATALOG.creators[3], '⚽ Match-day energy on ZenithMax.'],
    ['starter-story-5', CATALOG.creators[4], '🎮 Games, creators and community in one place.'],
    ['starter-story-6', CATALOG.creators[5], '💡 Save useful videos and posts for later.'],
    ['starter-story-7', C(6), '🧠 Daily trivia is live. Test what you know!'],
    ['starter-story-8', C(7), '🎨 Show us your latest artwork in the community feed.'],
    ['starter-story-9', C(8), '🌍 New culture and travel clips are coming to Discover.'],
    ['starter-story-10', C(9), '🏆 Creator Battles open this week. Enter your best clip.']
  ];
  const currentStarterIds=new Set(CATALOG.videos.map(x=>'starter-'+x.slug));
  for(const v of d.videos){
    if(v.starter && !v.isShort && !currentStarterIds.has(v.id) && !String(v.id||'').startsWith('uploaded-')){
      if(v.status!=='removed'){v.status='removed';changed=true;}
    }
  }
  for (const [id,creator,text] of starterStories) {
    const existing=d.stories.find(x=>x.id===id);
    if(!existing || new Date(existing.expiresAt||0).getTime() < Date.now()) {
      if(existing) Object.assign(existing,{text,createdAt:now(),expiresAt:new Date(Date.now()+24*3600000).toISOString()});
      else d.stories.push({id,userId:creator.id,text,mediaUrl:'',mediaType:'',createdAt:now(),expiresAt:new Date(Date.now()+24*3600000).toISOString(),starter:true});
      changed=true;
    }
  }
  const suiteSeed=[
    ['sound-starter-1','Midnight Motion','Electronic / Original sound'],
    ['sound-starter-2','Afro Pulse','Afro / Original sound'],
    ['sound-starter-3','Bright Morning','Lo-fi / Original sound'],
    ['sound-starter-4','Stadium Energy','Sports / Original sound'],
    ['sound-starter-5','Golden Hour','Acoustic / Original sound'],
    ['sound-starter-6','Night Drive Beat','Synthwave / Original sound']
  ];
  for(const [id,name,genre] of suiteSeed){
    if(!d.sounds.some(x=>x.id===id)) { d.sounds.push({id,userId:CATALOG.creators[0]?.id||'',name,genre,uses:120+Math.floor(Math.random()*900),createdAt:now(),starter:true}); changed=true; }
  }
  const effectSeed=[
    ['effect-starter-1','Neon Glow','Adds a bright creator-style color glow.'],
    ['effect-starter-2','Focus Zoom','A clean cinematic punch-in effect.'],
    ['effect-starter-3','Retro Frame','A playful retro frame overlay.'],
    ['effect-starter-4','Soft Portrait','A gentle portrait-light preset.'],
    ['effect-starter-5','Sunset Glow','A warm golden-hour colour grade.'],
    ['effect-starter-6','Night Drive','A cool neon colour grade for city footage.']
  ];
  for(const [id,name,description] of effectSeed){
    if(!d.effects.some(x=>x.id===id)) { d.effects.push({id,userId:CATALOG.creators[1]?.id||'',name,description,uses:40+Math.floor(Math.random()*600),createdAt:now(),starter:true}); changed=true; }
  }
  if(!d.membershipTiers.some(x=>x.id==='membership-starter-1')){
    d.membershipTiers.push({id:'membership-starter-1',userId:CATALOG.creators[0]?.id||'',name:'Supporter',price:5,perks:['Member badge','Behind-the-scenes posts','Early announcements'],createdAt:now(),starter:true}); changed=true;
  }
  if(!d.series.some(x=>x.id==='series-starter-1')){
    d.series.push({id:'series-starter-1',userId:CATALOG.creators[0]?.id||'',name:'ZenithMax Creator Basics',description:'A starter series about publishing and growing a channel.',videoIds:[],createdAt:now(),starter:true}); changed=true;
  }
  SHORTS.shorts.forEach((x,i)=>{
    const existing=d.videos.find(v=>v.id===x.id);
    const c=SHORTS.shorts[i];
    const creator=CATALOG.creators[x.creatorIndex%CATALOG.creators.length];
    const remote=x.remoteUrl || (x.sourceFile ? commonsDirectUrl(x.sourceFile) : '');
    if(existing){
      const next={url:remote,remoteUrl:remote,sourcePage:x.sourcePage||'',sourceCreator:x.sourceCreator||'',license:x.license||'',audio:true,isShort:true,starter:true,shortCategory:x.category};
      let diff=false; for(const [k,val] of Object.entries(next)){ if(existing[k]!==val){ existing[k]=val; diff=true; } }
      if(diff) changed=true;
      return;
    }
    d.videos.push({
      id:x.id,userId:creator.id,title:x.title,description:x.description,category:x.category,tags:x.tags,
      url:remote,remoteTitle:x.title,remoteUrl:remote,audio:true,mediaSource:'Wikimedia Commons',license:x.license||'',sourcePage:x.sourcePage||'',sourceCreator:x.sourceCreator||'',likes:45+(i*71)%1900,
      views:900+(i*1831)%76000,createdAt:new Date(Date.now()-i*930000).toISOString(),starter:true,isShort:true,shortCategory:x.category,duration:x.duration,status:'published'
    });
    changed=true;
  });
  return changed;
}
let STATE = null;
let PERSIST = null;
function emptyState(){ return {schemaVersion:SCHEMA_VERSION, ...Object.fromEntries(COLLECTIONS.map(k=>[k,[]]))}; }
function normalizeState(d){
  for(const k of COLLECTIONS) if(!Array.isArray(d[k])) d[k]=[];
  for(const u of d.users){
    if(!u.preferences || typeof u.preferences!=='object') u.preferences={};
    if(!Array.isArray(u.preferences.interests)) u.preferences.interests=[];
    if(typeof u.preferences.autoplay!=='boolean') u.preferences.autoplay=true;
    if(typeof u.preferences.dataSaver!=='boolean') u.preferences.dataSaver=false;
    if(typeof u.artistName!=='string') u.artistName='';
    if(!Number.isInteger(u.sessionVersion)) u.sessionVersion=0;
  }
  for(const u of d.users) applyExecutiveIdentity(u);
  return d;
}
// Every route reads the same in-memory state. Changes are persisted by save().
function load(){ if(!STATE) throw new Error('Database is not open yet'); return STATE; }
function verifyAccessToken(token){
  const payload=jwt.verify(token,SECRET);
  if(payload.kind==='refresh') throw new Error('Refresh token is not an access token');
  if(!SESSION_VERSIONS.has(payload.id)) load();
  const current=Number(SESSION_VERSIONS.get(payload.id)||0);
  if(Number(payload.sv||0)!==current) throw new Error('Session revoked');
  return payload;
}
function auth(req,res,next){
  try{
    const raw=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!raw) throw new Error('Missing token');
    req.user=verifyAccessToken(raw);
    next();
  }catch{ res.status(401).json({error:'Please sign in'}); }
}
function optional(req,res,next){
  try{
    const raw=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    req.user=raw?verifyAccessToken(raw):null;
  }catch{ req.user=null; }
  next();
}
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '1h';
const REFRESH_TTL = process.env.REFRESH_TOKEN_TTL || '30d';
function issueAccessToken(u){ return jwt.sign({id:u.id,name:u.name,sv:Number(u.sessionVersion||0)},SECRET,{expiresIn:ACCESS_TTL}); }
function issueRefreshToken(u){ return jwt.sign({id:u.id,sv:Number(u.sessionVersion||0),kind:'refresh'},REFRESH_SECRET,{expiresIn:REFRESH_TTL}); }
const RANK_TIERS = [
  {min:1,max:100,name:'Beginners',icon:'🌱'},
  {min:101,max:1000,name:'Amateur',icon:'⭐'},
  {min:1001,max:100000,name:'Migrate Level',icon:'🚀'},
  {min:100001,max:1000000,name:'Rising Level',icon:'🔥'},
  {min:1000001,max:10000000,name:'Elite Level',icon:'💎'},
  {min:10000001,max:100000000,name:'Grand Master',icon:'👑'},
  {min:100000001,max:1000000000,name:'King Level',icon:'🦁'},
  {min:1000000001,max:Infinity,name:'Lord Level',icon:'🏆'}
];
function followerRank(followers=0){
  const n=Math.max(0,Number(followers)||0);
  if(n<1) return {name:'Unranked',icon:'▫️',min:0,max:1,next:1,followers:n,progress:0};
  const tier=RANK_TIERS.find(r=>n>=r.min&&n<=r.max)||RANK_TIERS[RANK_TIERS.length-1];
  const next=tier.max===Infinity?null:tier.max+1;
  const span=tier.max===Infinity?Math.max(1,n):Math.max(1,tier.max-tier.min+1);
  const progress=tier.max===Infinity?100:Math.min(100,Math.round(((n-tier.min+1)/span)*100));
  return {...tier,next,followers:n,progress};
}
function safeUser(u){ if(!u)return null; applyExecutiveIdentity(u); const {password,phone,googleId,verifyCodeHash,verifyCodeExpires,verifyAttempts,...rest}=u; return {...rest,artistName:u.artistName||'',rank:followerRank(u.followers),phone:phone?maskPhone(phone):'',hasPhone:!!phone,isCEO:!!u.isCEO,companyRole:u.companyRole||'',companyName:u.companyName||'',title:u.title||'',interestCount:Array.isArray(u.preferences?.interests)?u.preferences.interests.length:0}; }
function publicUser(u){ if(!u)return null; const {email,sessionVersion,preferences,phoneDiscoverable,lastSeenAt,...rest}=safeUser(u); return rest; }
function contactUser(u){ return publicUser(u); }
function notify(d,userId,type,text,link='',actorId=''){
  if(!userId || userId===actorId) return;
  const target=d.users.find(u=>u.id===userId);
  if(target?.notificationsEnabled===false) return;
  d.notifications.push({id:uid(),userId,type,text,link,actorId,read:false,createdAt:now()});
  if(d.notifications.length>3000) d.notifications=d.notifications.slice(-3000);
}
function pub(d,v,req){
  const u=d.users.find(x=>x.id===v.userId);
  const shortStream=v.isShort&&v.remoteUrl&&shortsRemote.isAllowedRemoteUrl(v.remoteUrl)
    ?`/api/short-video-remote?key=${encodeURIComponent(Buffer.from(v.remoteUrl).toString('base64url'))}`
    :`/api/short-video/${encodeURIComponent(v.id)}`;
  const safeSourceCreator=String(v.sourceCreator||'').replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').trim();
  return {...v,streamUrl:v.isShort?shortStream:(v.starter && !v.external?`/api/starter-video/${encodeURIComponent(v.id)}`:v.url),creator:u?.name||v.provider||'ZenithMax Creator',creatorId:v.userId,verified:!!u?.verified||!!v.verified,avatar:u?.avatar||'',sourceCreator:safeSourceCreator,
    liked:!!req.user&&d.likes.some(x=>x.videoId===v.id&&x.userId===req.user.id),
    saved:!!req.user&&d.bookmarks.some(x=>x.userId===req.user.id&&x.videoId===v.id),
    following:!!req.user&&d.follows.some(x=>x.userId===req.user.id&&x.targetId===v.userId),
    commentCount:d.comments.filter(c=>c.videoId===v.id).length,notInterested:!!req.user&&d.hiddenVideos.some(x=>x.userId===req.user.id&&x.videoId===v.id)};
}
function affinity(d,userId){
  const out={};
  if(!userId) return out;
  const hist=d.history.filter(h=>h.userId===userId).slice(-120);
  for(const h of hist){ const v=d.videos.find(x=>x.id===h.videoId); if(v) out[v.category]=(out[v.category]||0)+1+Math.min(1,(h.progress||0)/100); }
  for(const b of d.bookmarks.filter(b=>b.userId===userId)){ const v=d.videos.find(x=>x.id===b.videoId); if(v) out[v.category]=(out[v.category]||0)+2.2; }
  return out;
}
function score(d,v,req,source){
  let s=Math.log10((v.views||0)+10)*26+Math.log10((v.likes||0)+5)*45+(v.starter?4:0);
  if(source&&v.category===source.category) s+=80;
  if(req.user){
    if(d.hiddenVideos.some(x=>x.userId===req.user.id&&x.videoId===v.id)) return -1e9;
    const a=affinity(d,req.user.id); s+=(a[v.category]||0)*18;
    const prefs=d.users.find(u=>u.id===req.user.id)?.preferences;
    if(Array.isArray(prefs?.interests)&&prefs.interests.includes(v.category)) s+=115;
    if(d.follows.some(x=>x.userId===req.user.id&&x.targetId===v.userId)) s+=150;
    if(d.bookmarks.some(x=>x.userId===req.user.id&&x.videoId===v.id)) s+=35;
    if(d.history.some(x=>x.userId===req.user.id&&x.videoId===v.id&&x.progress>90)) s-=40;
  }
  const ageHours=Math.max(1,(Date.now()-new Date(v.createdAt))/36e5); s+=Math.max(0,50-Math.log10(ageHours+1)*20);
  return s;
}
function reasons(d,v,req){
  const r=[];
  if(req.user&&d.follows.some(x=>x.userId===req.user.id&&x.targetId===v.userId)) r.push('From a creator you follow');
  if(req.user&&(affinity(d,req.user.id)[v.category]||0)>1) r.push('Because you watch '+v.category.toLowerCase());
  if(v.views>100000) r.push('Popular on ZenithMax');
  if(!r.length) r.push('Recommended for you');
  return r.slice(0,2);
}
function publicPost(d,p,req){
  const u=d.users.find(x=>x.id===p.userId);
  const comments=d.postComments.filter(c=>c.postId===p.id).length;
  return {...p,creator:u?.name||'ZenithMax User',creatorId:p.userId,avatar:u?.avatar||'',verified:!!u?.verified,
    liked:!!req.user&&d.postLikes.some(x=>x.postId===p.id&&x.userId===req.user.id),
    saved:!!req.user&&d.postBookmarks.some(x=>x.postId===p.id&&x.userId===req.user.id),commentCount:comments};
}
function publicStory(d,st,req){
  const u=d.users.find(x=>x.id===st.userId);
  return {...st,creator:u?.name||'ZenithMax User',avatar:u?.avatar||'',verified:!!u?.verified,
    own:!!req.user&&st.userId===req.user.id,
    viewed:!!req.user&&d.storyViews.some(x=>x.storyId===st.id&&x.userId===req.user.id)};
}

const rateBuckets=new Map();
function rateLimit({windowMs=60_000,max=180,keyPrefix='api'}={}){
  return (req,res,next)=>{
    const key=`${keyPrefix}:${req.ip||req.socket.remoteAddress||'unknown'}`;
    const nowMs=Date.now(); const hit=rateBuckets.get(key);
    if(!hit || nowMs-hit.start>=windowMs){ rateBuckets.set(key,{start:nowMs,count:1}); return next(); }
    hit.count++;
    if(hit.count>max){
      const retry=Math.max(1,Math.ceil((windowMs-(nowMs-hit.start))/1000));
      res.setHeader('Retry-After',String(retry));
      return res.status(429).json({error:'Too many requests. Please try again shortly.',retryAfter:retry});
    }
    next();
  };
}
setInterval(()=>{ const t=Date.now(); for(const [k,v] of rateBuckets) if(t-v.start>15*60_000) rateBuckets.delete(k); },5*60_000).unref();
function audit(d,req,action,targetId='',meta={}){
  d.auditLogs.push({id:uid(),userId:req.user?.id||'',action, targetId:clean(targetId,120), ip:req.ip||'', userAgent:clean(req.get('user-agent')||'',240), meta, createdAt:now()});
  if(d.auditLogs.length>5000) d.auditLogs=d.auditLogs.slice(-5000);
}
function backupDb(){
  fs.mkdirSync(path.join(DATA_DIR,'backups'),{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const file=path.join(DATA_DIR,'backups',`db-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(load(), null, 2));
  const files=fs.readdirSync(path.join(DATA_DIR,'backups')).filter(x=>x.endsWith('.json')).sort();
  for(const old of files.slice(0,-5)) fs.rmSync(path.join(DATA_DIR,'backups',old),{force:true});
  return file;
}
// File extensions come from the declared type or an allowlist, never from the raw filename.
// This stops an uploaded .html file from being stored and served as a web page on this origin.
const MIME_EXT={'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov','video/ogg':'.ogv','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/wav':'.wav','audio/x-wav':'.wav','audio/ogg':'.ogg','audio/webm':'.weba','audio/aac':'.aac','audio/flac':'.flac','image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','application/zip':'.zip','application/x-zip-compressed':'.zip'};
const SAFE_EXTS=new Set(['.mp4','.webm','.mov','.ogv','.mp3','.m4a','.wav','.ogg','.weba','.aac','.flac','.jpg','.jpeg','.png','.webp','.gif','.zip']);
function safeExt(f){
  const fromMime=MIME_EXT[String(f?.mimetype||'').toLowerCase()];
  if(fromMime) return fromMime;
  const fromName=path.extname(String(f?.originalname||f?.name||'')).toLowerCase();
  return SAFE_EXTS.has(fromName)?fromName:'';
}
const storage=multer.diskStorage({destination:UPLOAD_DIR,filename:(req,f,cb)=>cb(null,uid()+(safeExt(f)||'.bin'))});
const upload=multer({storage,limits:{fileSize:250*1024*1024},fileFilter:(req,f,cb)=>cb(null,/^video\/(mp4|webm|quicktime)$/.test(f.mimetype))});
const mediaUpload=multer({storage,limits:{fileSize:100*1024*1024},fileFilter:(req,f,cb)=>{const ok=/^(video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg|webm)|image\/(jpeg|png|webp|gif))$/.test(f.mimetype);cb(null,ok)}});
const mediaType=m=>m.startsWith('video/')?'video':m.startsWith('audio/')?'audio':m.startsWith('image/')?'image':'file';
const musicUpload=multer({storage,limits:{fileSize:150*1024*1024},fileFilter:(req,f,cb)=>cb(null,/^(audio\/(mpeg|mp4|wav|ogg|webm|aac|flac)|video\/mp4)$/.test(f.mimetype)||/\.(mp3|m4a|wav|ogg|webm|aac|flac)$/i.test(f.originalname))});
const gameUpload=multer({storage,limits:{fileSize:200*1024*1024},fileFilter:(req,f,cb)=>cb(null,/zip|compressed/i.test(f.mimetype)||/\.zip$/i.test(f.originalname))});
const profileUpload=multer({storage,limits:{fileSize:5*1024*1024},fileFilter:(req,f,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/i.test(f.mimetype))});
async function cloudCopyUploadedFile(file,folder){
  const st=productionServices.providerStatus().storage;
  if(st.provider!=='s3' || !st.configured || !file?.path) return null;
  const ext=path.extname(file.originalname||file.filename||'').toLowerCase();
  const key=`${folder}/${new Date().toISOString().slice(0,10)}/${uid()}${ext}`;
  return productionServices.putFileViaPresignedUrl(file.path,key,file.mimetype||'application/octet-stream');
}
function publicMediaUrl(localPath,cloud){ return cloud?.url || localPath; }
function safeGameEntry(name){
  const n=String(name||'').replaceAll('\\','/');
  if(!n || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return false;
  if(n.split('/').includes('..')) return false;
  if(n.length>240) return false;
  return true;
}
function extractGameZip(zipPath, gameId){
  const zip=new AdmZip(zipPath);
  const entries=zip.getEntries();
  if(entries.length<1 || entries.length>2000) throw new Error('Game package must contain 1–2000 files');
  const root=path.join(GAME_DIR,gameId);
  fs.mkdirSync(root,{recursive:true});
  let total=0, hasIndex=false;
  for(const entry of entries){
    if(entry.isDirectory) continue;
    const name=String(entry.entryName||'').replaceAll('\\','/').replace(/^\.\//,'');
    if(!safeGameEntry(name)) throw new Error('Unsafe file path in game package');
    const ext=path.extname(name).toLowerCase();
    if(['.exe','.dll','.so','.dylib','.bat','.cmd','.ps1','.sh','.bash','.php','.py','.rb','.pl','.cgi'].includes(ext)) throw new Error('Game packages may only contain browser files');
    const data=entry.getData(); total+=data.length;
    if(total>200*1024*1024) throw new Error('Game package expands beyond 200 MB');
    const out=path.join(root,name);
    if(!out.startsWith(root+path.sep) && out!==root) throw new Error('Unsafe extraction path');
    fs.mkdirSync(path.dirname(out),{recursive:true});
    fs.writeFileSync(out,data);
    if(name.toLowerCase()==='index.html' || name.toLowerCase().endsWith('/index.html')) hasIndex=true;
  }
  if(!hasIndex) throw new Error('Game ZIP must include an index.html entry point');
  return {root,total,files:entries.length,index:'index.html'};
}
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req,res,next)=>{
  const requestId=crypto.randomBytes(8).toString('hex');
  const started=Date.now();
  res.setHeader('X-Request-ID',requestId);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(self), microphone=(self), geolocation=()');
  res.setHeader('X-ZenithMax-Version',API_VERSION);
  req.requestId=requestId;
  res.on('finish',()=>{
    const ms=Date.now()-started;
    METRICS.requests++; METRICS.latencyMs+=ms;
    METRICS.byStatus[res.statusCode]=(METRICS.byStatus[res.statusCode]||0)+1;
    const key=`${req.method} ${req.route?.path||req.path}`; METRICS.routeCounts[key]=(METRICS.routeCounts[key]||0)+1;
    if(res.statusCode>=500)METRICS.errors++;
  });
  next();
});
app.use('/api',rateLimit({windowMs:60_000,max:240,keyPrefix:'api'}));
app.use('/api/auth',rateLimit({windowMs:15*60_000,max:25,keyPrefix:'auth'}));
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true,limit:'2mb'}));
// Express 5 leaves req.body undefined when a request has no body; routes read req.body fields directly.
app.use((req,res,next)=>{ if(req.body===undefined) req.body={}; next(); });
const UNVERIFIED_ALLOWED=new Set(['/api/auth/login','/api/auth/register','/api/auth/google','/api/auth/refresh','/api/auth/logout','/api/auth/logout-all','/api/auth/verify-email','/api/auth/resend-verification','/api/me','/api/me/avatar']);
const UNVERIFIED_ACTIONS=/\/(view|play|progress|impression|launch|read)$/;
app.use('/api',(req,res,next)=>{
  if(req.method==='GET'||req.method==='HEAD')return next();
  const route=req.originalUrl.split('?')[0];
  if(UNVERIFIED_ALLOWED.has(route)||UNVERIFIED_ACTIONS.test(route))return next();
  const raw=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!raw)return next();
  try{
    const payload=verifyAccessToken(raw);
    const u=load().users.find(x=>x.id===payload.id);
    if(u && !isEmailVerified(u)) return res.status(403).json({error:'Verify your email to use this feature.',code:'EMAIL_UNVERIFIED'});
  }catch{}
  next();
});
// Uploaded files and games are user content. Sandboxing them stops any script in them from reading app data on this origin.
app.use('/uploads',(req,res,next)=>{res.setHeader('Content-Security-Policy','sandbox');next();},express.static(UPLOAD_DIR));
app.use('/game-assets',(req,res,next)=>{res.setHeader('Content-Security-Policy','sandbox allow-scripts allow-forms allow-pointer-lock allow-popups');next();},express.static(GAME_DIR,{fallthrough:false}));
app.use(express.static(path.join(ROOT,'client')));

app.get('/api/health',(req,res)=>{const d=load();const sv=d.videos.filter(v=>v.starter&&v.url);const rs=shortsRemote.stats();res.json({ok:true,version:API_VERSION,schemaVersion:SCHEMA_VERSION,posts:d.posts.length,stories:d.stories.filter(s=>new Date(s.expiresAt||0)>new Date()).length,shortsCatalogCapacity:shortsRemote.SHORTS_CAPACITY,remoteUniqueShorts:rs.total,videos:d.videos.length,starterVideos:d.videos.filter(v=>v.starter&&!v.isShort).length,remoteStarterVideos:sv.filter(v=>!v.isShort).length,uniqueStarterUrls:new Set(sv.filter(v=>!v.isShort).map(v=>v.url)).size,shorts:d.videos.filter(v=>v.isShort).length,uniqueShortUrls:new Set(d.videos.filter(v=>v.isShort).map(v=>v.url)).size,music:d.music.length,games:d.games.length,groups:d.groups.length,calls:d.calls.filter(c=>c.status==='active').length,categories:[...new Set(sv.filter(v=>!v.isShort).map(v=>v.category))].sort()});});
app.get('/api/ready',(req,res)=>{
  try{ fs.accessSync(DATA_DIR,fs.constants.W_OK); res.json({ok:true,ready:true,version:API_VERSION,schemaVersion:SCHEMA_VERSION}); }
  catch(e){ res.status(503).json({ok:false,ready:false,error:'Service not ready'}); }
});
app.get('/api/meta',(req,res)=>res.json({version:API_VERSION,channel:RELEASE_CHANNEL,features:['persistent-sessions','session-revocation','atomic-database-writes','rate-limiting','security-headers','health-checks','admin-backups','audit-logs','resumable-uploads','remote-media','creator-suite','communications','responsive-ui','production-service-adapters','s3-compatible-media-storage','cdn-media-urls','postgres-state-mirror','email-provider-ready','turn-ice-config','media-processing-detection','release-preflight','runtime-metrics','pwa-install','offline-shell','refresh-token-persistence','migration-safety','interest-personalization','home-feed-modes','continue-watching','not-interested-controls','data-saver-preference','autoplay-preference','account-profile-pictures','multi-step-signup','google-sign-in','device-download-library','entertainment-xp','shared-challenges','watch-parties','creator-battles','community-tournaments'],supportedVideoDurationSeconds:{min:60,max:18000}}));
app.get('/api/release/preflight',auth,async(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id);
  if(u?.role!=='admin'&&!u?.isCEO)return res.status(403).json({error:'Admin only'});
  const p=productionServices.providerStatus();
  let postgresReachable=false;
  try{postgresReachable=await Promise.race([productionServices.testPostgres(),sleep(5000).then(()=>false)])}catch{}
  const checks=[
    {id:'node',label:'Node.js 18+',status:process.versions.node.split('.')[0]>=18?'pass':'fail',detail:process.version},
    {id:'jwt',label:'JWT secret in production',status:!IS_PRODUCTION||(SECRET!=='CHANGE_THIS_IN_PRODUCTION'&&SECRET.length>=32)?'pass':'fail',detail:IS_PRODUCTION?'JWT_SECRET is set and strong.':'Development mode'},
    {id:'refresh',label:'Refresh secret in production',status:!IS_PRODUCTION||(REFRESH_SECRET!=='CHANGE_THIS_IN_PRODUCTION'&&REFRESH_SECRET.length>=32)?'pass':'fail',detail:IS_PRODUCTION?'REFRESH_SECRET is set and strong.':'Development mode'},
    {id:'data',label:'Persistent writable data directory',status:fs.existsSync(DATA_DIR)&&fs.accessSync(DATA_DIR,fs.constants.W_OK)===undefined?'pass':'fail',detail:DATA_DIR},
    {id:'backups',label:'Backup directory writable',status:(()=>{try{const dir=path.join(DATA_DIR,'backups');fs.mkdirSync(dir,{recursive:true});return fs.accessSync(dir,fs.constants.W_OK)===undefined?'pass':'fail'}catch{return 'fail'}})(),detail:path.join(DATA_DIR,'backups')},
    {id:'database',label:'Durable database',status:p.database.configured&&postgresReachable?'pass':p.database.configured?'warn':'warn',detail:p.database.configured?(postgresReachable?'PostgreSQL connection succeeded.':'DATABASE_URL is configured but connection test failed.'):'JSON/local fallback is active.'},
    {id:'storage',label:'Durable media storage + CDN',status:p.storage.configured&&p.storage.cdnConfigured?'pass':p.storage.configured?'warn':'warn',detail:p.storage.configured?(p.storage.cdnConfigured?'Object storage and CDN are configured.':'Object storage is configured without MEDIA_CDN_BASE_URL.'):'Local media storage only.'},
    {id:'email',label:'Transactional email',status:p.email.configured?'pass':'warn',detail:p.email.configured?'Resend sender configured.':'Email provider not configured.'},
    {id:'payments',label:'Payment provider',status:p.payments.configured&&p.payments.webhookConfigured?'pass':p.payments.configured?'warn':'warn',detail:p.payments.configured?(p.payments.webhookConfigured?'Stripe secret and webhook configured.':'Stripe secret configured; webhook secret missing.'):'Payments not configured.'},
    {id:'realtime',label:'TURN for reliable calls',status:p.realtime.turnConfigured?'pass':'warn',detail:p.realtime.turnConfigured?'TURN + STUN configured.':'Peer-to-peer/STUN fallback only.'},
    {id:'processing',label:'FFmpeg + FFprobe',status:p.processing.ffmpeg&&p.processing.ffprobe?'pass':'warn',detail:`FFmpeg ${p.processing.ffmpeg?'ready':'missing'} · FFprobe ${p.processing.ffprobe?'ready':'missing'}`},
    {id:'pwa',label:'Installable web app shell',status:fs.existsSync(path.join(ROOT,'client','manifest.json'))&&fs.existsSync(path.join(ROOT,'client','service-worker.js'))?'pass':'fail',detail:'Manifest + service worker'},
    {id:'schema',label:'Database schema migration',status:Number(d.schemaVersion||0)>=SCHEMA_VERSION?'pass':'fail',detail:`Schema ${d.schemaVersion||0}`},
  ];
  const blockers=checks.filter(x=>x.status==='fail').length;
  res.json({ok:blockers===0,release:{version:API_VERSION,channel:RELEASE_CHANNEL,schemaVersion:SCHEMA_VERSION},checks,summary:{pass:checks.filter(x=>x.status==='pass').length,warn:checks.filter(x=>x.status==='warn').length,fail:blockers}});
});
app.get('/api/release/manifest',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id);
  if(u?.role!=='admin'&&!u?.isCEO)return res.status(403).json({error:'Admin only'});
  res.json({name:'ZenithMax',version:API_VERSION,channel:RELEASE_CHANNEL,schemaVersion:SCHEMA_VERSION,builtAt:'2026-10-10',supportedPlatforms:['Web','Android PWA','Windows/macOS/Linux browsers'],features:['Video','Shorts','Long Video','Social','Stories','Music','Games','Messaging','Voice/Video Calls','Creator Hub','Rankings','Production Center'],notes:'Production services remain provider-configurable; Google Sign-In additionally requires GOOGLE_CLIENT_ID in Render.'});
});
app.get('/api/admin/metrics',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id);
  if(u?.role!=='admin'&&!u?.isCEO)return res.status(403).json({error:'Admin only'});
  const avg=METRICS.requests?Math.round(METRICS.latencyMs/METRICS.requests):0;
  res.json({version:API_VERSION,uptimeSeconds:Math.round(process.uptime()),requests:METRICS.requests,errors:METRICS.errors,errorRate:METRICS.requests?Number((METRICS.errors/METRICS.requests*100).toFixed(2)):0,averageLatencyMs:avg,statuses:METRICS.byStatus,topRoutes:Object.entries(METRICS.routeCounts).sort((a,b)=>b[1]-a[1]).slice(0,12),memoryMB:Math.round(process.memoryUsage().rss/1024/1024),users:d.users.filter(x=>!x.starter).length,videos:d.videos.length});
});


app.get('/api/long-videos',optional,(req,res)=>{
  const q=clean(req.query.q,120).toLowerCase();
  const bucket=clean(req.query.bucket,24).toLowerCase();
  const min=Number(req.query.min||0);
  const max=Number(req.query.max||18000);
  const limit=Math.min(40,Math.max(1,Number(req.query.limit||18)));
  const buckets={micro:[60,299],short:[300,1799],medium:[1800,5399],long:[5400,10799],marathon:[10800,18000]};
  const range=buckets[bucket];
  let items=LONG_VIDEOS.filter(v=>v.duration>=60&&v.duration<=18000);
  if(q) items=items.filter(v=>[v.title,v.description,v.provider,v.category,...(v.tags||[])].join(' ').toLowerCase().includes(q));
  if(range) items=items.filter(v=>v.duration>=range[0]&&v.duration<=range[1]);
  else { if(Number.isFinite(min)&&min>0)items=items.filter(v=>v.duration>=min); if(Number.isFinite(max)&&max>0)items=items.filter(v=>v.duration<=Math.min(18000,max)); }
  items=items.slice().sort((a,b)=>b.duration-a.duration);
  const videos=items.slice(0,limit).map(v=>({...v,external:true,remote:false,creator:v.provider,creatorId:'external-'+v.id,verified:false,audio:true,views:0,likes:0,createdAt:'2026-09-01T00:00:00.000Z'}));
  res.json({videos,total:items.length,limit,bucket:bucket||'ALL',supportedRange:{minSeconds:60,maxSeconds:18000,minLabel:'1 minute',maxLabel:'5 hours'},providers:[...new Set(items.map(v=>v.source))]});
});

app.get('/api/starter-video/:id',async(req,res)=>{
  try{
    const d=load(),v=d.videos.find(x=>x.id===req.params.id&&x.starter); if(!v)return res.sendStatus(404);
    const catalogItem=CATALOG.videos.find(x=>'starter-'+x.slug===v.id);
    async function pickSource(){
      if(catalogItem?.remoteUrl){v.url=catalogItem.remoteUrl;v.license=catalogItem.license||'';v.sourcePage=catalogItem.sourcePage||'';v.sourceCreator=catalogItem.sourceCreator||'';save(d);return true;}
      if(!catalogItem?.searchTopic)return false;
      const rs=await commonsSearch(`${catalogItem.searchTopic} video`,20); const hit=rs[0];
      if(!hit)return false;
      v.url=hit.url;v.license=hit.license;v.sourcePage=hit.sourcePage;v.sourceCreator=hit.sourceCreator;v.audio=true;save(d);Object.assign(catalogItem,{remoteUrl:hit.url,license:hit.license,sourcePage:hit.sourcePage,sourceCreator:hit.sourceCreator});return true;
    }
    if(!v.url && !(await pickSource()))return res.status(404).json({error:'Starter video source is temporarily unavailable. Please try again.'});
    const headers={'User-Agent':'ZenithMax/17 video proxy'}; if(req.headers.range)headers.Range=req.headers.range;
    let upstream=await fetch(v.url,{headers});
    if(!upstream.ok && upstream.status!==206 && await pickSource()) upstream=await fetch(v.url,{headers});
    if(!upstream.ok && upstream.status!==206) return res.status(upstream.status).json({error:'Remote video source returned '+upstream.status});
    res.status(upstream.status);
    const ct=upstream.headers.get('content-type'); if(ct)res.setHeader('Content-Type',ct);
    for(const h of ['content-length','content-range','accept-ranges','etag','last-modified']){const value=upstream.headers.get(h);if(value)res.setHeader(h,value)}
    if(upstream.body){Readable.fromWeb(upstream.body).pipe(res);} else res.end();
  }catch(e){res.status(502).json({error:'Video source could not be reached right now'});}
});

const VERIFY_TTL_MS = 30 * 60 * 1000;
const VERIFY_MAX_ATTEMPTS = 5;
function sha256Hex(v){ return crypto.createHash('sha256').update(v).digest('hex'); }
// Verification applies when an email provider is configured. Without one, new accounts are verified so nobody is locked out.
function emailVerificationEnabled(){ return productionServices.providerStatus().email.configured; }
// Accounts created before verification existed have no emailVerified field and count as verified.
function isEmailVerified(u){ return u.emailVerified !== false; }
function newVerifyCode(u){
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  u.verifyCodeHash = sha256Hex(u.id + ':' + code);
  u.verifyCodeExpires = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
  u.verifyAttempts = 0;
  return code;
}
function sendVerificationEmail(u, code){
  return productionServices.sendEmail({
    to: u.email,
    subject: 'Your ZenithMax verification code',
    text: `Your ZenithMax code is ${code}. It expires in 30 minutes. If you did not sign up, you can ignore this email.`,
    html: `<p>Your ZenithMax code is <b>${code}</b>.</p><p>It expires in 30 minutes. If you did not sign up, you can ignore this email.</p>`
  });
}

app.post('/api/auth/register',profileUpload.single('avatar'),async(req,res)=>{
  const name=clean(req.body.name,60),email=clean(req.body.email,160).toLowerCase(),password=String(req.body.password||''),phone=normalizePhone(req.body.phone);
  if(!name||!email||password.length<8||Buffer.byteLength(password)>72)return res.status(400).json({error:'Username, Gmail and an 8 to 72 character password are required'});
  if(!phone)return res.status(400).json({error:'Phone number is required for sign up'});
  const d=load(); if(d.users.some(u=>u.email===email))return res.status(409).json({error:'Email already registered'});
  if(phone && d.users.some(u=>u.phone===phone))return res.status(409).json({error:'That phone number is already registered'});
  const humanUsers=d.users.filter(u=>!u.starter);
  const artistName=clean(req.body.artistName,100);
  const u={id:uid(),name,email,phone,password:await bcrypt.hash(password,10),bio:'New ZenithMax creator',artistName,followers:0,following:0,role:'user',createdAt:now(),verified:false,notificationsEnabled:true,phoneDiscoverable:false,lastSeenAt:now(),sessionVersion:0,avatar:''};
  if(req.file){u.avatar='/uploads/'+req.file.filename;}
  u.emailVerified=!emailVerificationEnabled();
  const verifyCode=u.emailVerified?null:newVerifyCode(u);
  d.users.push(u); save(d);
  if(verifyCode) sendVerificationEmail(u,verifyCode).catch(err=>console.warn('Verification email failed:',err.message));
  applyExecutiveIdentity(u);
  res.json({token:issueAccessToken(u),refreshToken:issueRefreshToken(u),user:safeUser(u)});
});
app.get('/api/auth/config',(req,res)=>res.json({googleEnabled:!!GOOGLE_CLIENT_ID,googleClientId:GOOGLE_CLIENT_ID||''}));
app.post('/api/auth/google',async(req,res)=>{
  if(!GOOGLE_CLIENT_ID)return res.status(503).json({error:'Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID in Render Environment.'});
  const credential=String(req.body?.credential||'').trim();
  if(!credential)return res.status(400).json({error:'Google credential is missing'});
  try{
    const r=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(credential),{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('Google verification failed');
    const g=await r.json();
    if(String(g.aud||'')!==GOOGLE_CLIENT_ID)throw new Error('Google client mismatch');
    if(g.email_verified!=='true'&&g.email_verified!==true)throw new Error('Google email is not verified');
    const d=load();
    let u=d.users.find(x=>x.email===String(g.email||'').toLowerCase());
    if(!u){
      const humanUsers=d.users.filter(x=>!x.starter);
      u={id:uid(),name:clean(g.name||String(g.email||'User').split('@')[0],60),email:String(g.email||'').toLowerCase(),phone:'',password:await bcrypt.hash(crypto.randomBytes(24).toString('hex'),10),bio:'Google account · New ZenithMax user',artistName:'',followers:0,following:0,role:'user',createdAt:now(),verified:true,notificationsEnabled:true,phoneDiscoverable:false,lastSeenAt:now(),sessionVersion:0,avatar:String(g.picture||''),googleVerified:true,emailVerified:true};
      d.users.push(u);
    } else {
      u.googleId=String(g.sub||u.googleId||'');
      u.verified=true; u.googleVerified=true; u.emailVerified=true; u.lastSeenAt=now();
      if(g.picture&&!u.avatar)u.avatar=String(g.picture);
    }
    u.googleId=String(g.sub||u.googleId||'');
    applyExecutiveIdentity(u); save(d);
    res.json({token:issueAccessToken(u),refreshToken:issueRefreshToken(u),user:safeUser(u)});
  }catch(e){res.status(401).json({error:e.message||'Google sign-in failed'});}
});
app.post('/api/auth/login',async(req,res)=>{
  const d=load(),email=clean(req.body.email,160).toLowerCase(),u=d.users.find(x=>x.email===email);
  if(!u||u.starter||!(await bcrypt.compare(req.body.password||'',u.password))){
    d.loginEvents.push({id:uid(),userId:u?.id||'',at:now(),ip:req.ip||'',success:false,emailHint:email.slice(0,3)+'***'});
    if(d.loginEvents.length>3000)d.loginEvents=d.loginEvents.slice(-3000); save(d);
    return res.status(401).json({error:'Invalid email or password'});
  }
  u.lastSeenAt=now(); d.loginEvents.push({id:uid(),userId:u.id,at:now(),ip:req.ip||'',success:true}); if(d.loginEvents.length>3000)d.loginEvents=d.loginEvents.slice(-3000); save(d);
  applyExecutiveIdentity(u);
  res.json({token:issueAccessToken(u),refreshToken:issueRefreshToken(u),user:safeUser(u)});
});
app.post('/api/auth/refresh',(req,res)=>{
  try{
    const raw=String(req.body?.refreshToken||'').trim();
    if(!raw) throw new Error('Refresh token required');
    const payload=jwt.verify(raw,REFRESH_SECRET);
    if(payload.kind!=='refresh') throw new Error('Not a refresh token');
    const d=load(),u=d.users.find(x=>x.id===payload.id); if(!u || Number(payload.sv||0)!==Number(u.sessionVersion||0)) throw new Error('Session revoked');
    u.lastSeenAt=now(); applyExecutiveIdentity(u); save(d);
    res.json({token:issueAccessToken(u),refreshToken:issueRefreshToken(u),user:safeUser(u)});
  }catch{ res.status(401).json({error:'Session refresh failed. Please sign in again.'}); }
});
app.post('/api/auth/logout',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id);
  if(!u)return res.sendStatus(404);
  u.sessionVersion=Number(u.sessionVersion||0)+1;
  audit(d,req,'logout',u.id);
  save(d);
  res.json({ok:true});
});
app.post('/api/auth/verify-email',auth,(req,res)=>{
  const d=load(), u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  if(isEmailVerified(u))return res.json({ok:true,user:safeUser(u)});
  if(!u.verifyCodeHash||new Date(u.verifyCodeExpires||0)<new Date())return res.status(400).json({error:'That code has expired. Request a new one.'});
  if((u.verifyAttempts||0)>=VERIFY_MAX_ATTEMPTS)return res.status(429).json({error:'Too many wrong attempts. Request a new code.'});
  const code=String(req.body.code||'').replace(/\s/g,'');
  const given=Buffer.from(sha256Hex(u.id+':'+code)), expected=Buffer.from(u.verifyCodeHash);
  if(!/^\d{6}$/.test(code)||!crypto.timingSafeEqual(given,expected)){ u.verifyAttempts=(u.verifyAttempts||0)+1; save(d); return res.status(400).json({error:'That code is not correct.'}); }
  u.emailVerified=true; delete u.verifyCodeHash; delete u.verifyCodeExpires; delete u.verifyAttempts;
  applyExecutiveIdentity(u); save(d); res.json({ok:true,user:safeUser(u)});
});
app.post('/api/auth/resend-verification',auth,rateLimit({windowMs:15*60_000,max:5,keyPrefix:'verify-resend'}),(req,res)=>{
  const d=load(), u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  if(isEmailVerified(u))return res.json({ok:true,alreadyVerified:true});
  if(!emailVerificationEnabled())return res.status(503).json({error:'Email sending is not configured yet.'});
  const code=newVerifyCode(u); save(d);
  sendVerificationEmail(u,code).then(()=>res.json({ok:true})).catch(()=>res.status(503).json({error:'We could not send the email. Try again shortly.'}));
});

app.get('/api/account/security',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  res.json({session:{persistent:true,expiresInDays:30,accessMinutes:60,emailVerified:isEmailVerified(u),sessionVersion:u.sessionVersion||0,lastSeenAt:u.lastSeenAt||null},security:{twoFactorConfigured:false,passkeyConfigured:false,emailVerificationConfigured:false,notes:'Connect an approved email/identity provider before enabling account recovery or payment credentials.'}});
});
app.get('/api/me',auth,(req,res)=>res.json({user:safeUser(load().users.find(x=>x.id===req.user.id))}));
app.patch('/api/me',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  if(req.body.name)u.name=clean(req.body.name,60); if(req.body.bio!==undefined)u.bio=clean(req.body.bio,300);
  if(req.body.phone!==undefined){const p=normalizePhone(req.body.phone);if(p&&d.users.some(x=>x.id!==u.id&&x.phone===p))return res.status(409).json({error:'That phone number is already in use'});u.phone=p;}
  if(req.body.phoneDiscoverable!==undefined)u.phoneDiscoverable=!!req.body.phoneDiscoverable; if(req.body.notificationsEnabled!==undefined)u.notificationsEnabled=!!req.body.notificationsEnabled;
  u.lastSeenAt=now(); save(d); res.json({user:safeUser(u)});
});
app.post('/api/me/avatar',auth,profileUpload.single('avatar'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose a JPG, PNG, WEBP or GIF image'});
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  if(u.avatar && u.avatar.startsWith('/uploads/')) fs.rmSync(path.join(UPLOAD_DIR,path.basename(u.avatar)),{force:true});
  u.avatar='/uploads/'+req.file.filename; save(d); res.json({user:safeUser(u)});
});
const contactLookupLimit=rateLimit({windowMs:60*60_000,max:60,keyPrefix:'contacts'});
app.get('/api/contacts/by-phone',auth,contactLookupLimit,(req,res)=>{
  const phone=normalizePhone(req.query.phone); if(!phone)return res.status(400).json({error:'Enter a phone number'});
  const d=load(),u=d.users.find(x=>x.phone===phone&&!x.starter&&x.phoneDiscoverable!==false);
  if(!u)return res.status(404).json({error:'No ZenithMax account was found for that phone number'});
  res.json({user:contactUser(u),phone:phone});
});


let shortsGrowing=false, shortsGrowStartedAt=0;
app.get('/api/shorts',optional,async(req,res)=>{
  try{
    const d=load();
    const page=Math.max(1,Number(req.query.page||1));
    const limit=Math.min(24,Math.max(1,Number(req.query.limit||12)));
    const category=clean(req.query.category,40).toUpperCase()||'ALL';
    const seeded=d.videos.filter(v=>v.isShort && (category==='ALL'||v.category===category)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    const localStart=(page-1)*limit;
    const localItems=seeded.slice(localStart,localStart+limit).map(v=>pub(d,v,req));
    let mappedRemote=[];
    let remote={hasMore:true};
    // Always serve the curated starter Shorts immediately. Remote catalog discovery
    // must never be required just to make the first Shorts screen non-empty.
    if(localItems.length < limit && page>1){
      try{
        remote=await shortsRemote.getPage({page:Math.max(1,page-1),limit:Math.max(1,limit-localItems.length),category});
        const localUrls=new Set(seeded.map(v=>v.url).filter(Boolean));
        mappedRemote=remote.items.filter(x=>!localUrls.has(x.remoteUrl||x.url)).map(x=>({
          id:x.id,title:x.title,description:x.description,category:x.category,tags:x.tags,duration:x.duration,
          url:x.remoteUrl,remoteUrl:x.remoteUrl,remoteTitle:x.title,audio:true,mediaSource:x.mediaSource,
          license:x.license,sourcePage:x.sourcePage,sourceCreator:x.sourceCreator,createdAt:x.createdAt,
          views:0,likes:0,creator:'ZenithMax Remote Creator',creatorId:d.users.find(u=>u.id==='creator-zenith')?.id||d.users[0]?.id,
          verified:false,avatar:'',isShort:true,starter:true,shortCategory:x.category,directUrl:x.remoteUrl,
          streamUrl:`/api/short-video-remote?key=${encodeURIComponent(x.remoteKey||Buffer.from(x.remoteUrl).toString('base64url'))}`
        }));
      }catch(err){ console.warn('Remote Shorts page unavailable:',err.message); }
    }
    let youtubeItems=[];
    if(page===1 && YOUTUBE_API_KEY){
      try{
        const query=category==='ALL'?'shorts vertical video':`shorts ${category.toLowerCase()} video`;
        youtubeItems=(await youtubeSearch(query,Math.min(8,limit))).map(x=>({...x,id:'ytshort-'+x.id,category:category==='ALL'?'DISCOVER':category,isShort:true,shortCategory:category,reason:'YouTube embed',source:'YouTube',mediaSource:'YouTube',sourcePage:x.sourceUrl,sourceCreator:x.creator,sourceUrl:x.sourceUrl,streamUrl:'',directUrl:x.embedUrl,external:true,thumbnail:x.thumbnail}));
      }catch(err){ console.warn('YouTube Shorts lookup skipped:',err.message); }
    }
    const items=[...localItems,...mappedRemote,...youtubeItems].slice(0,limit);
    const remoteStats=shortsRemote.stats();
    const moreLocal=seeded.length>localStart+localItems.length;
    const hasMore=moreLocal || !!remote.hasMore || page*limit<shortsRemote.SHORTS_CAPACITY;
    // Grow the remote catalog in the background; this never blocks the initial UI.
    if(page===1 && !shortsGrowing && Date.now()-shortsGrowStartedAt>10*60_000){ shortsGrowing=true; shortsGrowStartedAt=Date.now(); setImmediate(()=>shortsRemote.ensureCount({targetCount:Math.max(123,remoteStats.total+12),category:'ALL'}).catch(()=>{}).finally(()=>{shortsGrowing=false;})); }
    res.json({videos:items,page,limit,hasMore,categories:[],catalogCapacity:shortsRemote.SHORTS_CAPACITY,discoveredRemoteShorts:remoteStats.total,remoteCategories:remoteStats.categories});
  }catch(e){res.status(500).json({error:'Shorts are temporarily unavailable. Please retry.'});}
});

app.get('/api/shorts/catalog-stats',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id);
  if(u?.role!=='admin')return res.status(403).json({error:'Admin access required'});
  res.json(shortsRemote.stats());
});

app.post('/api/shorts/admin/grow',auth,async(req,res)=>{
  try{
    const d=load(),u=d.users.find(x=>x.id===req.user.id);
    if(u?.role!=='admin')return res.status(403).json({error:'Admin access required'});
    const count=Math.min(500,Math.max(1,Number(req.body.count||100)));
    const category=clean(req.body.category,40).toUpperCase()||'ALL';
    const result=await shortsRemote.grow({count,category,maxRequests:160});
    res.json({ok:true,result});
  }catch(e){res.status(502).json({error:'Could not grow the Shorts catalog right now'});}
});

app.all('/api/short-video-remote',async(req,res)=>{
  try{
    const remote=shortsRemote.decodeRemoteKey(req.query.key||'');
    if(!shortsRemote.isAllowedRemoteUrl(remote))return res.status(400).json({error:'Unsupported remote video source'});
    const headers={'User-Agent':'ZenithMax/22 Shorts media proxy','Accept':'video/webm,video/mp4,video/ogg,video/*;q=0.9,*/*;q=0.1'};
    if(req.headers.range)headers.Range=req.headers.range;
    let upstream=await fetch(remote,{headers,redirect:'follow',signal:AbortSignal.timeout(25000)});
    if(!upstream.ok&&upstream.status!==206)return res.status(upstream.status).json({error:'Remote Short source returned '+upstream.status});
    res.status(req.method==='HEAD'?200:upstream.status);
    const ct=upstream.headers.get('content-type')||(/\.mp4(?:$|[?])/i.test(remote)?'video/mp4':/\.og[g]?(?:$|[?])/i.test(remote)?'video/ogg':'video/webm');
    res.setHeader('Content-Type',ct);
    res.setHeader('Cache-Control','public, max-age=300, stale-while-revalidate=60');
    res.setHeader('Accept-Ranges',upstream.headers.get('accept-ranges')||'bytes');
    for(const h of ['content-length','content-range','etag','last-modified']){const value=upstream.headers.get(h);if(value)res.setHeader(h,value)}
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method==='HEAD'||!upstream.body)return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  }catch(e){res.status(502).json({error:'Short video source could not be reached right now'});}
});
async function resolveCommonsFileExact(fileName){
  const name=String(fileName||'').replace(/^File:/,'').trim();
  if(!name)return null;
  try{
    const qs=new URLSearchParams({action:'query',titles:'File:'+name,prop:'imageinfo',iiprop:'url|mime|extmetadata',format:'json',origin:'*'});
    const r=await fetch('https://commons.wikimedia.org/w/api.php?'+qs.toString(),{headers:{'User-Agent':'ZenithMax/22 Shorts playback resolver'},signal:AbortSignal.timeout(10000)});
    if(!r.ok)return null;
    const j=await r.json();
    const page=Object.values(j.query?.pages||{})[0];
    const ii=page?.imageinfo?.[0];
    if(!ii?.url||!/^video\/(mp4|webm|ogg)$/i.test(ii.mime||''))return null;
    const md=ii.extmetadata||{};
    const license=md.LicenseShortName?.value||md.License?.value||'';
    if(!isAllowedLicense(license))return null;
    return {url:ii.url,license,sourcePage:'https://commons.wikimedia.org/wiki/'+encodeURIComponent('File:'+name),sourceCreator:md.Artist?.value||md.Credit?.value||'',mime:ii.mime};
  }catch{return null;}
}
async function resolveStarterShortSource(d,v){
  if(v?.remoteUrl && isRemoteMediaUrl(v.remoteUrl))return v.remoteUrl;
  if(v?.url && isRemoteMediaUrl(v.url))return v.url;
  const item=SHORTS.shorts.find(x=>x.id===v?.id);
  if(!item)return '';
  // First try the exact Commons file named by the curated catalog.
  const exact=await resolveCommonsFileExact(item.sourceFile);
  if(exact){
    Object.assign(v,{url:exact.url,remoteUrl:exact.url,remoteTitle:item.title,license:exact.license,sourcePage:exact.sourcePage,sourceCreator:exact.sourceCreator,audio:true,mediaSource:'Wikimedia Commons'});
    save(d);
    return exact.url;
  }
  // Fallback to the safer Commons redirect URL. This can survive file storage changes.
  const redirect=commonsRedirectUrl(item.sourceFile);
  if(redirect){
    Object.assign(v,{url:redirect,remoteUrl:redirect,remoteTitle:item.title,license:item.license||'',sourcePage:item.sourcePage||('https://commons.wikimedia.org/wiki/'+encodeURIComponent('File:'+item.sourceFile)),sourceCreator:item.sourceCreator||'',audio:true,mediaSource:'Wikimedia Commons'});
    save(d);
    return redirect;
  }
  const used=new Set(d.videos.filter(x=>x.isShort&&x.url).map(x=>x.url));
  const queries=[];
  if(item.searchTopic)queries.push(`${item.searchTopic} video`);
  if(item.category)queries.push(`${item.category.toLowerCase()} video`);
  for(const query of queries){
    try{
      const rs=await commonsSearch(query,24);
      const hit=rs.find(x=>x.url&&!used.has(x.url));
      if(hit){
        Object.assign(v,{url:hit.url,remoteUrl:hit.url,remoteTitle:hit.title,license:hit.license,sourcePage:hit.sourcePage,sourceCreator:hit.sourceCreator,audio:true,mediaSource:'Wikimedia Commons'});
        save(d);
        return hit.url;
      }
    }catch{}
  }
  return '';
}
app.all('/api/short-video/:id',async(req,res)=>{
  try{
    const d=load(),v=d.videos.find(x=>x.id===req.params.id&&x.isShort);
    if(!v)return res.sendStatus(404);
    let remote=await resolveStarterShortSource(d,v);
    if(!remote)return res.status(404).json({error:'This Short source is temporarily unavailable. Please retry.'});
    const headers={'User-Agent':'ZenithMax/22 Shorts media proxy','Accept':'video/webm,video/mp4,video/ogg,video/*;q=0.9,*/*;q=0.1'};
    if(req.headers.range)headers.Range=req.headers.range;
    let upstream=await fetch(remote,{headers,redirect:'follow',signal:AbortSignal.timeout(25000)});
    if(!upstream.ok&&upstream.status!==206){
      v.url='';v.remoteUrl='';save(d);
      remote=await resolveStarterShortSource(d,v);
      if(remote)upstream=await fetch(remote,{headers,redirect:'follow',signal:AbortSignal.timeout(25000)});
    }
    if(!upstream.ok&&upstream.status!==206)return res.status(upstream.status).json({error:'Remote Short source returned '+upstream.status});
    res.status(req.method==='HEAD'?200:upstream.status);
    const ct=upstream.headers.get('content-type')||(/\.mp4(?:$|[?])/i.test(remote)?'video/mp4':/\.og[g]?(?:$|[?])/i.test(remote)?'video/ogg':'video/webm');
    res.setHeader('Content-Type',ct);
    res.setHeader('Cache-Control','public, max-age=300, stale-while-revalidate=60');
    res.setHeader('Accept-Ranges',upstream.headers.get('accept-ranges')||'bytes');
    res.setHeader('X-Content-Type-Options','nosniff');
    for(const h of ['content-length','content-range','etag','last-modified']){const value=upstream.headers.get(h);if(value)res.setHeader(h,value)}
    if(req.method==='HEAD'||!upstream.body)return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  }catch(e){res.status(502).json({error:'Short video source could not be reached right now'});}
});
app.get('/api/remote-video/:id',async(req,res)=>{
  try{
    const id=clean(req.params.id,80); const item=loadRemoteHome().find(x=>x.id===id);
    if(!item?.url)return res.status(404).json({error:'Remote video not found'});
    const headers={'User-Agent':'ZenithMax/20 remote home video proxy'};
    if(req.headers.range)headers.Range=req.headers.range;
    const upstream=await fetch(item.url,{headers,redirect:'follow',signal:AbortSignal.timeout(20000)});
    if(!upstream.ok&&upstream.status!==206)return res.status(upstream.status).json({error:'Remote video source returned '+upstream.status});
    res.status(upstream.status); const ct=upstream.headers.get('content-type'); if(ct)res.setHeader('Content-Type',ct);
    for(const h of ['content-length','content-range','accept-ranges','etag','last-modified']){const v=upstream.headers.get(h);if(v)res.setHeader(h,v)}
    if(upstream.body)Readable.fromWeb(upstream.body).pipe(res); else res.end();
  }catch(e){res.status(502).json({error:'Remote home video source could not be reached right now'});}
});

app.get('/api/videos',optional,async(req,res)=>{
  const d=load(),q=clean(req.query.q,120).toLowerCase(),cat=clean(req.query.category,50),sort=req.query.sort||'latest',page=Math.max(1,Number(req.query.page||1)),limit=Math.min(40,Math.max(1,Number(req.query.limit||18)));
  let vs=d.videos.filter(v=>v.status!=='removed'&&(!cat||cat==='ALL'||v.category===cat)&&(!q||v.title.toLowerCase().includes(q)||(v.description||'').toLowerCase().includes(q)||(v.tags||[]).join(' ').toLowerCase().includes(q)));
  if(sort==='trending'||sort==='recommended')vs.sort((a,b)=>score(d,b,req)-score(d,a,req)); else vs.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  let localPublished=vs.map(v=>({...pub(d,v,req),remote:false}));
  let remoteMatches=[];
  if(q.length>=2){
    const terms=relatedSearchTerms(q);
    const batches=[];
    for(const term of terms) batches.push(searchRemoteVideos(term,Math.max(8,Math.ceil(limit/terms.length))));
    const rs=await Promise.all(batches);
    const seen=new Set(localPublished.map(v=>v.url).filter(Boolean));
    for(const group of rs){
      for(const item of group){if(!item.url||seen.has(item.url))continue;seen.add(item.url);remoteMatches.push(remotePub(item,req));if(remoteMatches.length>=limit)break;}
      if(remoteMatches.length>=limit)break;
    }
  }
  const combined=[...localPublished,...remoteMatches];
  const total=combined.length + Math.max(0,vs.length-localPublished.length);
  const slice=combined.slice((page-1)*limit,page*limit);
  res.json({videos:slice,page,limit,total,hasMore:page*limit<total,remoteResults:remoteMatches.length,remoteSearch:q||null});
});
app.get('/api/search/suggestions',(req,res)=>{
  const d=load(),q=clean(req.query.q,80).toLowerCase(); if(!q)return res.json({suggestions:[]});
  const suggestions=[...new Set(d.videos.flatMap(v=>[v.title,...(v.tags||[])]).filter(x=>String(x).toLowerCase().includes(q)))].slice(0,8);
  res.json({suggestions});
});
app.get('/api/discover',optional,async(req,res)=>{
  const d=load(); const videos=d.videos.filter(v=>v.status!=='removed').map(v=>({...pub(d,v,req),score:score(d,v,req),reasons:reasons(d,v,req)})).sort((a,b)=>b.score-a.score).slice(0,120);
  const categories=[...new Set(d.videos.map(v=>v.category))].sort();
  const external=externalFeedVideos(20);
  let youtube=[];
  if(YOUTUBE_API_KEY){ try{ youtube=await youtubeSearch('popular ' + (categories[0]||'video'),12); }catch(err){ console.warn('YouTube discover lookup skipped:',err.message); } }
  res.json({videos:[...videos,...external,...youtube],categories:[...new Set([...categories,...external.map(v=>v.category).filter(Boolean),'YOUTUBE'])]});
});
app.get('/api/trending',optional,(req,res)=>{
  const d=load(); const videos=[...d.videos].filter(v=>v.status!=='removed').sort((a,b)=>(b.views||0)+(b.likes||0)*18-((a.views||0)+(a.likes||0)*18)).slice(0,32).map(v=>pub(d,v,req));
  const remote=loadRemoteHome().slice(0,8).map(x=>remotePub(x,req));
  res.json({videos:[...videos,...remote]});
});

app.get('/api/preferences',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  const categories=[...new Set(d.videos.map(v=>String(v.category||'GENERAL')).filter(Boolean))].sort();
  res.json({preferences:{interests:Array.isArray(u.preferences?.interests)?u.preferences.interests:[],autoplay:u.preferences?.autoplay!==false,dataSaver:u.preferences?.dataSaver===true},categories});
});
app.patch('/api/preferences',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  const allowed=new Set(d.videos.map(v=>String(v.category||'GENERAL')));
  if(Array.isArray(req.body.interests)) u.preferences.interests=[...new Set(req.body.interests.map(x=>clean(x,50)).filter(x=>allowed.has(x)))].slice(0,12);
  if(req.body.autoplay!==undefined) u.preferences.autoplay=!!req.body.autoplay;
  if(req.body.dataSaver!==undefined) u.preferences.dataSaver=!!req.body.dataSaver;
  u.lastSeenAt=now(); save(d); res.json({preferences:u.preferences});
});
app.get('/api/continue-watching',auth,(req,res)=>{
  const d=load(),limit=Math.min(24,Math.max(1,Number(req.query.limit||12)));
  const items=d.history.filter(h=>h.userId===req.user.id&&(Number(h.progress)||0)>1&&(Number(h.progress)||0)<99).sort((a,b)=>new Date(b.watchedAt)-new Date(a.watchedAt)).map(h=>{const v=d.videos.find(x=>x.id===h.videoId); return v?{...pub(d,v,req),progress:Number(h.progress)||0,watchedAt:h.watchedAt}:null}).filter(Boolean).slice(0,limit);
  res.json({videos:items});
});
app.post('/api/videos/:id/not-interested',auth,(req,res)=>{
  const d=load(),v=d.videos.find(x=>x.id===req.params.id); if(!v)return res.sendStatus(404);
  if(!d.hiddenVideos.some(x=>x.userId===req.user.id&&x.videoId===v.id)) d.hiddenVideos.push({id:uid(),userId:req.user.id,videoId:v.id,createdAt:now()});
  audit(d,req,'video_not_interested',v.id,{title:v.title}); save(d); res.json({ok:true,notInterested:true});
});
app.delete('/api/videos/:id/not-interested',auth,(req,res)=>{
  const d=load(); d.hiddenVideos=d.hiddenVideos.filter(x=>!(x.userId===req.user.id&&x.videoId===req.params.id)); save(d); res.json({ok:true,notInterested:false});
});
app.get('/api/home-feed',optional,async(req,res)=>{
  const d=load(),mode=clean(req.query.mode,20)||'for-you',limit=Math.min(32,Math.max(1,Number(req.query.limit||16)));
  let videos=d.videos.filter(v=>v.status!=='removed'&&(!req.user||!d.hiddenVideos.some(x=>x.userId===req.user.id&&x.videoId===v.id)));
  if(mode==='following'&&req.user){const ids=new Set(d.follows.filter(f=>f.userId===req.user.id).map(f=>f.targetId)); videos=videos.filter(v=>ids.has(v.userId));}
  if(mode==='latest') videos.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  else if(mode==='trending') videos.sort((a,b)=>(b.views||0)+(b.likes||0)*18-((a.views||0)+(a.likes||0)*18));
  else videos=videos.map(v=>({...v,__score:score(d,v,req)})).sort((a,b)=>b.__score-a.__score);
  const local=videos.slice(0,limit).map(v=>{const out=pub(d,v,req); delete out.__score; return out;});
  const external=externalFeedVideos(Math.min(8,Math.max(0,limit-local.length)));
  let youtube=[];
  if(YOUTUBE_API_KEY && local.length<limit){ try{ youtube=await youtubeSearch(mode==='trending'?'trending technology sports music':mode==='following'?'creator videos':'popular video',Math.min(6,limit-local.length)); }catch(err){ console.warn('YouTube home lookup skipped:',err.message); } }
  res.json({mode,videos:[...local,...external,...youtube].slice(0,limit),preferences:req.user?d.users.find(u=>u.id===req.user.id)?.preferences||{}:{},externalCount:external.length+youtube.length});
});

app.get('/api/recommendations',optional,(req,res)=>{
  const d=load(),source=d.videos.find(v=>v.id===clean(req.query.videoId,100));
  const videos=d.videos.filter(v=>v.status!=='removed'&&v.id!==source?.id).map(v=>({...pub(d,v,req),score:score(d,v,req,source),reasons:reasons(d,v,req)})).sort((a,b)=>b.score-a.score).slice(0,64);
  const remote=loadRemoteHome().slice(0,16).map(x=>({...remotePub(x,req),score:0,reasons:['Real remote media']}));
  res.json({videos:[...videos,...remote]});
});
app.get('/api/creators',optional,(req,res)=>{
  const d=load(); const creators=d.users.filter(u=>u.role==='creator'||u.starter||d.videos.some(v=>v.userId===u.id)).map(u=>({id:u.id,name:u.name,bio:u.bio,followers:u.followers,videoCount:d.videos.filter(v=>v.userId===u.id&&v.status!=='removed').length,verified:!!u.verified,following:!!req.user&&d.follows.some(f=>f.userId===req.user.id&&f.targetId===u.id)})).sort((a,b)=>b.followers-a.followers);
  res.json({creators:creators.map(c=>({...c,rank:followerRank(c.followers)}))});
});
app.get('/api/users/:id',optional,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.params.id);if(!u)return res.sendStatus(404);
  res.json({user:publicUser(u),videos:d.videos.filter(v=>v.userId===u.id&&v.status!=='removed').map(v=>pub(d,v,req)),following:!!req.user&&d.follows.some(f=>f.userId===req.user.id&&f.targetId===u.id)});
});

function resumablePath(id){return path.join(RESUMABLE_DIR,id)}
function readResume(id){const p=resumablePath(id)+'.json';if(!fs.existsSync(p))return null;return JSON.parse(fs.readFileSync(p,'utf8'))}
function writeResume(s){s.updatedAt=now();fs.writeFileSync(resumablePath(s.id)+'.json',JSON.stringify(s,null,2))}
function resumeLimit(type){return type==='video'?500*1024*1024:type==='music'?250*1024*1024:200*1024*1024}
app.post('/api/resumable/start',auth,(req,res)=>{
  const type=String(req.body.type||''); if(!['video','music','game'].includes(type))return res.status(400).json({error:'Unsupported upload type'});
  const name=clean(req.body.name,180),size=Number(req.body.size||0),mime=clean(req.body.mime,120),meta=req.body.meta||{};
  if(!name||!Number.isFinite(size)||size<1||size>resumeLimit(type))return res.status(400).json({error:`File is missing or larger than the ${Math.round(resumeLimit(type)/1024/1024)} MB limit`});
  const id=uid(); const s={id,userId:req.user.id,type,name,size,mime,meta,chunkSize:RESUMABLE_CHUNK,totalChunks:Math.ceil(size/RESUMABLE_CHUNK),nextChunk:0,receivedBytes:0,tempPath:resumablePath(id)+'.part',createdAt:now(),updatedAt:now()};
  fs.writeFileSync(s.tempPath,''); writeResume(s); res.json({uploadId:id,chunkSize:s.chunkSize,totalChunks:s.totalChunks,nextChunk:0});
});
app.get('/api/resumable/:id/status',auth,(req,res)=>{const s=readResume(req.params.id);if(!s||s.userId!==req.user.id)return res.sendStatus(404);res.json({uploadId:s.id,chunkSize:s.chunkSize,totalChunks:s.totalChunks,nextChunk:s.nextChunk,receivedBytes:s.receivedBytes,size:s.size,type:s.type,name:s.name})});
app.put('/api/resumable/:id/chunks/:chunk',auth,express.raw({type:'application/octet-stream',limit:'5mb'}),(req,res)=>{
  const s=readResume(req.params.id); if(!s||s.userId!==req.user.id)return res.sendStatus(404); const n=Number(req.params.chunk); if(!Number.isInteger(n)||n<0||n>=s.totalChunks)return res.status(400).json({error:'Invalid chunk'});
  if(n<s.nextChunk)return res.json({ok:true,nextChunk:s.nextChunk,receivedBytes:s.receivedBytes});
  if(n!==s.nextChunk)return res.status(409).json({error:'Chunk out of order',nextChunk:s.nextChunk});
  const buf=Buffer.isBuffer(req.body)?req.body:Buffer.from([]); const expected=Math.min(s.chunkSize,s.size-n*s.chunkSize); if(buf.length!==expected)return res.status(400).json({error:`Expected ${expected} bytes for chunk ${n}, received ${buf.length}`});
  fs.appendFileSync(s.tempPath,buf); s.receivedBytes+=buf.length; s.nextChunk++; writeResume(s); res.json({ok:true,nextChunk:s.nextChunk,receivedBytes:s.receivedBytes});
});
app.post('/api/resumable/:id/complete',auth,async(req,res)=>{
  const s=readResume(req.params.id); if(!s||s.userId!==req.user.id)return res.sendStatus(404); if(s.receivedBytes!==s.size||s.nextChunk!==s.totalChunks)return res.status(409).json({error:'Upload is incomplete',nextChunk:s.nextChunk,receivedBytes:s.receivedBytes});
  let finalPath='';
  try{
    const ext=safeExt({mimetype:s.mime,name:s.name})||({video:'.mp4',music:'.mp3',game:'.zip'}[s.type]); const finalName=uid()+ext; finalPath=path.join(UPLOAD_DIR,finalName); fs.renameSync(s.tempPath,finalPath); let out;
    const d=load();
    let cloud=null, cloudError='';
    if(s.type==='video' || s.type==='music'){
      try{ cloud=await cloudCopyUploadedFile({path:finalPath,originalname:s.name,filename:finalName,mimetype:s.mime},s.type==='video'?'videos':'music'); }
      catch(err){ cloudError=err.message||'Cloud storage upload failed'; console.warn('Cloud media copy failed:',cloudError); }
    }
    const localUrl='/uploads/'+finalName; const mediaUrl=publicMediaUrl(localUrl,cloud);
    if(s.type==='video'){
      const m=s.meta||{}; out={id:uid(),userId:req.user.id,title:clean(m.title,120)||path.parse(s.name).name.slice(0,120),description:clean(m.description,2000),category:clean(m.category,40).toUpperCase()||'GENERAL',tags:clean(m.tags,240).split(',').map(x=>x.trim()).filter(Boolean).slice(0,8),url:mediaUrl,localUrl,storageProvider:cloud?'s3':'local',storageKey:cloud?.key||'',likes:0,views:0,createdAt:now(),status:'published'}; d.videos.push(out);
    } else if(s.type==='music'){
      const m=s.meta||{}; out={id:uid(),userId:req.user.id,title:clean(m.title,120)||path.parse(s.name).name.slice(0,120),artist:clean(m.artist,80)||req.user.name,album:clean(m.album,120),genre:clean(m.genre,60)||'GENERAL',description:clean(m.description,1000),url:mediaUrl,localUrl,mime:s.mime,fileName:s.name.slice(0,160),storageProvider:cloud?'s3':'local',storageKey:cloud?.key||'',likes:0,plays:0,createdAt:now(),status:'published'}; d.music.push(out);
    } else {
      const gameId=uid(); const info=extractGameZip(finalPath,gameId); fs.rmSync(finalPath,{force:true}); const m=s.meta||{}; out={id:gameId,userId:req.user.id,title:clean(m.title,120)||path.parse(s.name).name.slice(0,120),description:clean(m.description,1200),genre:clean(m.genre,60)||'ARCADE',version:clean(m.version,30)||'1.0.0',url:'/game-assets/'+gameId+'/index.html',playUrl:'/api/games/'+gameId+'/play',files:info.files,bytes:info.total,plays:0,createdAt:now(),status:'published'}; d.games.push(out);
    }
    save(d); fs.rmSync(resumablePath(s.id)+'.json',{force:true}); fs.rmSync(s.tempPath,{force:true});
    res.json({ok:true,type:s.type,storage:cloud?{provider:'s3',url:cloud.url,key:cloud.key,bytes:cloud.bytes}:{provider:'local'},storageWarning:cloudError||undefined,video:s.type==='video'?out:undefined,music:s.type==='music'?out:undefined,game:s.type==='game'?out:undefined});
  }catch(e){ return res.status(400).json({error:e.message||'Could not finalize upload'}); }
});

app.get('/api/music',(req,res)=>{
  const d=load();
  const tracks=d.music.filter(m=>m.status!=='removed').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,200).map(m=>({...m,artist:d.users.find(u=>u.id===m.userId)?.name||'ZenithMax Creator'}));
  res.json({music:tracks});
});
app.post('/api/music',auth,musicUpload.single('audio'),async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'Choose an MP3, M4A, WAV, OGG, WEBM, AAC or FLAC audio file'});
  const d=load();
  let cloud=null; try{cloud=await cloudCopyUploadedFile(req.file,'music')}catch(err){console.warn('Cloud music copy failed:',err.message)}
  const localUrl='/uploads/'+req.file.filename;
  const track={id:uid(),userId:req.user.id,title:clean(req.body.title,120)||path.parse(req.file.originalname).name.slice(0,120),artist:clean(req.body.artist,80)||req.user.name,album:clean(req.body.album,120),genre:clean(req.body.genre,60)||'GENERAL',description:clean(req.body.description,1000),url:publicMediaUrl(localUrl,cloud),localUrl,mime:req.file.mimetype,fileName:req.file.originalname.slice(0,160),storageProvider:cloud?'s3':'local',storageKey:cloud?.key||'',likes:0,plays:0,createdAt:now(),status:'published'};
  d.music.push(track); save(d); res.json({music:track});
});
app.post('/api/music/:id/play',optional,(req,res)=>{
  const d=load(),m=d.music.find(x=>x.id===req.params.id); if(!m) return res.sendStatus(404); m.plays=(m.plays||0)+1; save(d); res.json({ok:true,plays:m.plays});
});
app.get('/api/games',(req,res)=>{
  const d=load();
  const games=d.games.filter(g=>g.status!=='removed').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,200).map(g=>({...g,creator:d.users.find(u=>u.id===g.userId)?.name||'ZenithMax Creator'}));
  res.json({games});
});
app.post('/api/games',auth,gameUpload.single('game'),(req,res)=>{
  if(!req.file) return res.status(400).json({error:'Choose an HTML5 game ZIP package'});
  const gameId=uid();
  try{
    const info=extractGameZip(path.join(UPLOAD_DIR,req.file.filename),gameId);
    const d=load();
    const game={id:gameId,userId:req.user.id,title:clean(req.body.title,120)||path.parse(req.file.originalname).name.slice(0,120),description:clean(req.body.description,1200),genre:clean(req.body.genre,60)||'ARCADE',version:clean(req.body.version,30)||'1.0.0',url:'/game-assets/'+gameId+'/index.html',playUrl:'/api/games/'+gameId+'/play',files:info.files,bytes:info.total,plays:0,createdAt:now(),status:'published'};
    d.games.push(game); save(d); fs.rmSync(path.join(UPLOAD_DIR,req.file.filename),{force:true}); res.json({game});
  }catch(e){ fs.rmSync(path.join(GAME_DIR,gameId),{recursive:true,force:true}); fs.rmSync(path.join(UPLOAD_DIR,req.file.filename),{force:true}); return res.status(400).json({error:e.message||'Invalid game package'}); }
});
app.get('/api/games/:id/play',(req,res)=>{
  const d=load(),g=d.games.find(x=>x.id===req.params.id); if(!g) return res.sendStatus(404); g.plays=(g.plays||0)+1; save(d); res.redirect(g.url);
});

app.post('/api/videos',auth,upload.single('video'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose an MP4/WebM/MOV video'});
  const d=load(); let cloud=null; try{cloud=await cloudCopyUploadedFile(req.file,'videos')}catch(err){console.warn('Cloud video copy failed:',err.message)}
  const localUrl='/uploads/'+req.file.filename; const v={id:uid(),userId:req.user.id,title:clean(req.body.title,120)||'Untitled video',description:clean(req.body.description,2000),category:clean(req.body.category,40).toUpperCase()||'GENERAL',tags:clean(req.body.tags,240).split(',').map(x=>x.trim()).filter(Boolean).slice(0,8),url:publicMediaUrl(localUrl,cloud),localUrl,storageProvider:cloud?'s3':'local',storageKey:cloud?.key||'',likes:0,views:0,createdAt:now(),status:'published'};
  d.videos.push(v); save(d); res.json({video:v});
});
app.post('/api/videos/:id/view',optional,(req,res)=>{
  const d=load(),v=d.videos.find(x=>x.id===req.params.id);if(!v)return res.sendStatus(404);v.views=(v.views||0)+1;
  if(req.user){let h=d.history.find(x=>x.userId===req.user.id&&x.videoId===v.id);if(h)h.watchedAt=now();else d.history.push({id:uid(),userId:req.user.id,videoId:v.id,watchedAt:now(),progress:0});}
  save(d);res.json({ok:true,views:v.views});
});
app.post('/api/videos/:id/progress',auth,(req,res)=>{
  const d=load();let h=d.history.find(x=>x.userId===req.user.id&&x.videoId===req.params.id);const progress=Math.max(0,Math.min(100,Number(req.body.progress||0)));
  if(h){h.progress=progress;h.watchedAt=now();}else d.history.push({id:uid(),userId:req.user.id,videoId:req.params.id,watchedAt:now(),progress});save(d);res.json({ok:true});
});
app.get('/api/history',auth,(req,res)=>{
  const d=load();res.json({videos:d.history.filter(h=>h.userId===req.user.id).sort((a,b)=>new Date(b.watchedAt)-new Date(a.watchedAt)).map(h=>{const v=d.videos.find(x=>x.id===h.videoId);return v?{...pub(d,v,req),progress:h.progress,watchedAt:h.watchedAt}:null}).filter(Boolean).slice(0,100)});
});
app.post('/api/videos/:id/like',auth,(req,res)=>{
  const d=load(),v=d.videos.find(x=>x.id===req.params.id);if(!v)return res.sendStatus(404);const i=d.likes.findIndex(x=>x.videoId===v.id&&x.userId===req.user.id);
  if(i>=0){d.likes.splice(i,1);v.likes=Math.max(0,(v.likes||0)-1);}else{d.likes.push({videoId:v.id,userId:req.user.id,createdAt:now()});v.likes=(v.likes||0)+1;notify(d,v.userId,'like',`${req.user.name} liked your video`,v.id,req.user.id);}
  save(d);res.json({liked:i<0,likes:v.likes});
});
app.post('/api/videos/:id/bookmark',auth,(req,res)=>{const d=load(),i=d.bookmarks.findIndex(b=>b.userId===req.user.id&&b.videoId===req.params.id);if(i>=0)d.bookmarks.splice(i,1);else d.bookmarks.push({userId:req.user.id,videoId:req.params.id,createdAt:now()});save(d);res.json({saved:i<0});});
app.get('/api/bookmarks',auth,(req,res)=>{const d=load();res.json({videos:d.videos.filter(v=>d.bookmarks.some(b=>b.userId===req.user.id&&b.videoId===v.id)).map(v=>pub(d,v,req))});});

app.get('/api/videos/:id/comments',(req,res)=>{
  const d=load();const comments=d.comments.filter(c=>c.videoId===req.params.id).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).map(c=>({...c,user:d.users.find(u=>u.id===c.userId)?.name||'User',verified:!!d.users.find(u=>u.id===c.userId)?.verified}));res.json({comments});
});
app.post('/api/videos/:id/comments',auth,(req,res)=>{
  const d=load(),text=clean(req.body.text,500),v=d.videos.find(x=>x.id===req.params.id);if(!text)return res.status(400).json({error:'Comment must be 1–500 characters'});if(!v)return res.sendStatus(404);
  const c={id:uid(),videoId:req.params.id,userId:req.user.id,text,createdAt:now()};d.comments.push(c);notify(d,v.userId,'comment',`${req.user.name} commented on your video`,v.id,req.user.id);save(d);res.json({comment:c});
});
app.delete('/api/comments/:id',auth,(req,res)=>{const d=load(),i=d.comments.findIndex(c=>c.id===req.params.id&&(c.userId===req.user.id||d.users.find(u=>u.id===req.user.id)?.role==='admin'));if(i<0)return res.sendStatus(404);d.comments.splice(i,1);save(d);res.json({ok:true});});

app.post('/api/users/:id/follow',auth,(req,res)=>{
  const d=load();if(req.params.id===req.user.id)return res.status(400).json({error:'You cannot follow yourself'});const i=d.follows.findIndex(f=>f.userId===req.user.id&&f.targetId===req.params.id);
  if(i>=0)d.follows.splice(i,1);else{d.follows.push({userId:req.user.id,targetId:req.params.id,createdAt:now()});notify(d,req.params.id,'follow',`${req.user.name} followed you`,'',req.user.id);}
  for(const u of d.users){u.followers=d.follows.filter(f=>f.targetId===u.id).length;u.following=d.follows.filter(f=>f.userId===u.id).length;}save(d);res.json({following:i<0});
});
app.get('/api/following',auth,optional,(req,res)=>{const d=load(),ids=d.follows.filter(f=>f.userId===req.user.id).map(f=>f.targetId);res.json({videos:d.videos.filter(v=>ids.includes(v.userId)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(v=>pub(d,v,req))});});
app.get('/api/rankings',optional,(req,res)=>{
  const d=load();
  const creators=d.users.filter(u=>u.role==='creator'||u.role==='admin'||u.isCEO||u.starter||d.videos.some(v=>v.userId===u.id));
  const rows=creators.map(u=>({id:u.id,name:u.name,avatar:u.avatar||'',verified:!!u.verified,followers:u.followers||0,following:u.following||0,videoCount:d.videos.filter(v=>v.userId===u.id&&v.status!=='removed').length,rank:followerRank(u.followers),followingYou:!!req.user&&d.follows.some(f=>f.userId===req.user.id&&f.targetId===u.id)})).sort((a,b)=>b.followers-a.followers||a.name.localeCompare(b.name));
  res.json({rankings:rows.slice(0,100),tiers:RANK_TIERS});
});

app.post('/api/playlists',auth,(req,res)=>{const d=load(),name=clean(req.body.name,80);if(!name)return res.status(400).json({error:'Playlist name required'});const p={id:uid(),userId:req.user.id,name,description:clean(req.body.description,200),videoIds:[],createdAt:now()};d.playlists.push(p);save(d);res.json({playlist:p});});
app.get('/api/playlists',auth,(req,res)=>{const d=load();res.json({playlists:d.playlists.filter(p=>p.userId===req.user.id).map(p=>({...p,count:p.videoIds.length,cover:d.videos.find(v=>v.id===p.videoIds[0])?.url||''}))});});
app.get('/api/playlists/:id',auth,(req,res)=>{const d=load(),p=d.playlists.find(x=>x.id===req.params.id&&x.userId===req.user.id);if(!p)return res.sendStatus(404);res.json({playlist:p,videos:p.videoIds.map(id=>d.videos.find(v=>v.id===id)).filter(Boolean).map(v=>pub(d,v,req))});});
app.post('/api/playlists/:id/videos/:videoId',auth,(req,res)=>{const d=load(),p=d.playlists.find(x=>x.id===req.params.id&&x.userId===req.user.id);if(!p)return res.sendStatus(404);const i=p.videoIds.indexOf(req.params.videoId);if(i>=0)p.videoIds.splice(i,1);else p.videoIds.push(req.params.videoId);save(d);res.json({playlist:p,added:i<0});});
app.delete('/api/playlists/:id',auth,(req,res)=>{const d=load(),i=d.playlists.findIndex(p=>p.id===req.params.id&&p.userId===req.user.id);if(i<0)return res.sendStatus(404);d.playlists.splice(i,1);save(d);res.json({ok:true});});

app.get('/api/notifications',auth,(req,res)=>{const d=load();res.json({notifications:d.notifications.filter(n=>n.userId===req.user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,100)});});
app.post('/api/notifications/read',auth,(req,res)=>{const d=load();for(const n of d.notifications)if(n.userId===req.user.id)n.read=true;save(d);res.json({ok:true});});
app.get('/api/messages/conversations',auth,(req,res)=>{
  const d=load(),msgs=d.messages.filter(m=>m.fromId===req.user.id||m.toId===req.user.id);const map=new Map();
  for(const m of msgs.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))){const other=m.fromId===req.user.id?m.toId:m.fromId;if(!map.has(other))map.set(other,{user:publicUser(d.users.find(u=>u.id===other)),last:m});}
  res.json({conversations:[...map.values()].filter(x=>x.user)});
});
// Communication V21: phone contacts, group chats, WebRTC call signaling.
function getGroupForUser(d,groupId,userId){const g=d.groups.find(x=>x.id===groupId);return g&&isMember(g,userId)?g:null}
function addGroupMessage(d,group,text,kind,fromId,extra={}){const m={id:uid(),groupId:group.id,fromId,text:clean(text,1000),kind,createdAt:now(),...extra};d.messages.push(m);for(const id of group.memberIds)if(id!==fromId)notify(d,id,'group_message',`${d.users.find(u=>u.id===fromId)?.name||'Someone'} sent a message in ${group.name}`,'group:'+group.id,fromId);return m}
app.get('/api/groups',auth,(req,res)=>{const d=load();res.json({groups:d.groups.filter(g=>isMember(g,req.user.id)).map(g=>({...g,memberCount:g.memberIds.length,lastMessage:d.messages.filter(m=>m.groupId===g.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0]||null,creator:contactUser(d.users.find(u=>u.id===g.ownerId))}))})});
app.post('/api/groups',auth,(req,res)=>{const d=load(),name=clean(req.body.name,80);if(!name)return res.status(400).json({error:'Group name required'});let memberIds=[req.user.id];for(const raw of Array.isArray(req.body.phoneNumbers)?req.body.phoneNumbers:[]){const p=normalizePhone(raw);const u=d.users.find(x=>x.phone===p&&!x.starter&&x.phoneDiscoverable!==false);if(u&&!memberIds.includes(u.id))memberIds.push(u.id);}if(memberIds.length<2)return res.status(400).json({error:'Add at least one other ZenithMax user by phone number'});if(memberIds.length>8)return res.status(400).json({error:'Group chat limit is 8 members in this free build'});const g={id:uid(),name,ownerId:req.user.id,memberIds,createdAt:now()};d.groups.push(g);save(d);res.json({group:g});});
app.post('/api/groups/:id/members',auth,(req,res)=>{const d=load(),g=getGroupForUser(d,req.params.id,req.user.id);if(!g)return res.sendStatus(404);if(g.memberIds.length>=8)return res.status(400).json({error:'This group has reached 8 members'});const p=normalizePhone(req.body.phone),u=d.users.find(x=>x.phone===p&&!x.starter&&x.phoneDiscoverable!==false);if(!u)return res.status(404).json({error:'No ZenithMax account found for that phone number'});if(!g.memberIds.includes(u.id))g.memberIds.push(u.id);save(d);res.json({group:g});});
app.get('/api/groups/:id/messages',auth,(req,res)=>{const d=load(),g=getGroupForUser(d,req.params.id,req.user.id);if(!g)return res.sendStatus(404);res.json({group:{...g,members:g.memberIds.map(id=>contactUser(d.users.find(u=>u.id===id))).filter(Boolean)},messages:d.messages.filter(m=>m.groupId===g.id).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).slice(-500)});});
app.post('/api/groups/:id/messages',auth,(req,res)=>{const d=load(),g=getGroupForUser(d,req.params.id,req.user.id);if(!g)return res.sendStatus(404);const text=clean(req.body.text,1000);if(!text)return res.status(400).json({error:'Message cannot be empty'});const m=addGroupMessage(d,g,text,'text',req.user.id);save(d);res.json({message:m});});
app.post('/api/groups/:id/media',auth,mediaUpload.single('media'),(req,res)=>{const d=load(),g=getGroupForUser(d,req.params.id,req.user.id);if(!g)return res.sendStatus(404);if(!req.file)return res.status(400).json({error:'Choose an image, video, or audio file'});const kind=req.body.voice==='1'?'voice':'media';const m=addGroupMessage(d,g,clean(req.body.caption,300),kind,req.user.id,{mediaType:mediaType(req.file.mimetype),mime:req.file.mimetype,fileName:req.file.originalname.slice(0,160),url:'/uploads/'+req.file.filename});save(d);res.json({message:m});});

function buildCall(d,callerId,participantIds,mode,groupId=''){
  const ids=[...new Set([callerId,...participantIds])].filter(Boolean).slice(0,8);
  return {id:uid(),initiatorId:callerId,participantIds:ids,acceptedIds:[callerId],rejectedIds:[],mode:mode==='video'?'video':'audio',groupId:groupId||'',status:'ringing',createdAt:now(),updatedAt:now()};
}
app.post('/api/calls',auth,(req,res)=>{const d=load(),mode=req.body.mode==='video'?'video':'audio';let participants=[];let groupId='';
  if(req.body.groupId){const g=getGroupForUser(d,req.body.groupId,req.user.id);if(!g)return res.status(404).json({error:'Group not found'});groupId=g.id;participants=g.memberIds.filter(id=>id!==req.user.id).slice(0,7);}
  else if(req.body.userId){const u=d.users.find(x=>x.id===req.body.userId);if(!u||u.starter)return res.status(404).json({error:'User not found'});participants=[u.id];}
  else return res.status(400).json({error:'Choose a user or group'});
  const call=buildCall(d,req.user.id,participants,mode,groupId);d.calls.push(call);for(const id of participants)notify(d,id,'call',`${req.user.name} is calling you`,'call:'+call.id,req.user.id);save(d);res.json({call});
});
app.get('/api/calls/incoming',auth,(req,res)=>{const d=load(),cut=Date.now()-90000;const calls=d.calls.filter(c=>!['ended','declined'].includes(c.status)&&c.participantIds.includes(req.user.id)&&c.initiatorId!==req.user.id&&!c.acceptedIds.includes(req.user.id)&&!c.rejectedIds.includes(req.user.id)&&new Date(c.createdAt).getTime()>cut);res.json({calls:calls.map(c=>({...c,initiator:contactUser(d.users.find(u=>u.id===c.initiatorId)),group:c.groupId?d.groups.find(g=>g.id===c.groupId):null}))});});
app.get('/api/calls/:id',auth,(req,res)=>{const d=load(),c=d.calls.find(x=>x.id===req.params.id&&x.participantIds.includes(req.user.id));if(!c)return res.sendStatus(404);res.json({call:c,participants:c.participantIds.map(id=>contactUser(d.users.find(u=>u.id===id))).filter(Boolean)});});
app.post('/api/calls/:id/accept',auth,(req,res)=>{const d=load(),c=d.calls.find(x=>x.id===req.params.id&&x.participantIds.includes(req.user.id));if(!c)return res.sendStatus(404);if(!c.acceptedIds.includes(req.user.id))c.acceptedIds.push(req.user.id);c.rejectedIds=c.rejectedIds.filter(x=>x!==req.user.id);c.status='active';c.updatedAt=now();save(d);res.json({call:c});});
app.post('/api/calls/:id/decline',auth,(req,res)=>{const d=load(),c=d.calls.find(x=>x.id===req.params.id&&x.participantIds.includes(req.user.id));if(!c)return res.sendStatus(404);if(!c.rejectedIds.includes(req.user.id))c.rejectedIds.push(req.user.id);c.updatedAt=now();if(c.rejectedIds.filter(x=>c.participantIds.includes(x)).length>=c.participantIds.length-1)c.status='declined';save(d);res.json({ok:true});});
app.post('/api/calls/:id/end',auth,(req,res)=>{const d=load(),c=d.calls.find(x=>x.id===req.params.id&&x.participantIds.includes(req.user.id));if(!c)return res.sendStatus(404);c.status='ended';c.endedAt=now();c.updatedAt=c.endedAt;save(d);res.json({ok:true});});
app.post('/api/calls/:id/signal',auth,(req,res)=>{const d=load(),c=d.calls.find(x=>x.id===req.params.id&&x.participantIds.includes(req.user.id));if(!c)return res.sendStatus(404);const toId=clean(req.body.toId,80),target=c.participantIds.includes(toId)&&toId!==req.user.id;if(!target)return res.status(400).json({error:'Invalid call participant'});const sig={id:uid(),callId:c.id,fromId:req.user.id,toId,type:clean(req.body.type,30),data:req.body.data||null,createdAt:now()};d.callSignals.push(sig);if(d.callSignals.length>5000)d.callSignals=d.callSignals.slice(-5000);save(d);res.json({ok:true,id:sig.id});});
app.get('/api/calls/:id/signals',auth,(req,res)=>{const d=load(),c=d.calls.find(x=>x.id===req.params.id&&x.participantIds.includes(req.user.id));if(!c)return res.sendStatus(404);const after=String(req.query.after||'');const out=d.callSignals.filter(s=>s.callId===c.id&&s.toId===req.user.id&&(!after||s.createdAt>after)).slice(-100);res.json({signals:out});});

app.get('/api/messages/:userId',auth,(req,res)=>{const d=load();res.json({messages:d.messages.filter(m=>(m.fromId===req.user.id&&m.toId===req.params.userId)||(m.fromId===req.params.userId&&m.toId===req.user.id)).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)),user:publicUser(d.users.find(u=>u.id===req.params.userId))});});
app.post('/api/messages/:userId',auth,(req,res)=>{const d=load(),text=clean(req.body.text,1000);if(!text)return res.status(400).json({error:'Message cannot be empty'});if(!d.users.some(u=>u.id===req.params.userId))return res.sendStatus(404);const m={id:uid(),fromId:req.user.id,toId:req.params.userId,text,kind:'text',createdAt:now()};d.messages.push(m);notify(d,req.params.userId,'message',`${req.user.name} sent you a message`,'messages',req.user.id);save(d);res.json({message:m});});
app.post('/api/messages/:userId/media',auth,mediaUpload.single('media'),(req,res)=>{const d=load(),target=d.users.find(u=>u.id===req.params.userId);if(!target)return res.sendStatus(404);if(!req.file)return res.status(400).json({error:'Choose an image, video, or audio file'});const kind=req.body.voice==='1'?'voice':'media';const m={id:uid(),fromId:req.user.id,toId:target.id,text:clean(req.body.caption,300),kind,mediaType:mediaType(req.file.mimetype),mime:req.file.mimetype,fileName:req.file.originalname.slice(0,160),url:'/uploads/'+req.file.filename,createdAt:now()};d.messages.push(m);notify(d,target.id,'message',`${req.user.name} sent you ${kind==='voice'?'a voice note':m.mediaType==='audio'?'music/audio':m.mediaType}`,'messages',req.user.id);save(d);res.json({message:m});});

// V22 social publishing: posts, likes, comments, bookmarks and 24-hour Stories.
const postImageUpload=multer({storage,limits:{fileSize:8*1024*1024},fileFilter:(req,f,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/i.test(f.mimetype))});
app.get('/api/feed',optional,(req,res)=>{
  const d=load(),limit=Math.min(50,Math.max(1,Number(req.query.limit||30))),mode=clean(req.query.mode,20)||'for-you';
  let posts=d.posts.filter(p=>!p.expiresAt||new Date(p.expiresAt)>new Date());
  if(mode==='following'&&req.user){const ids=new Set(d.follows.filter(f=>f.userId===req.user.id).map(f=>f.targetId));posts=posts.filter(p=>ids.has(p.userId)||p.starter);}
  posts=posts.sort((a,b)=>{
    const sa=(a.likes||0)*2+d.postComments.filter(c=>c.postId===a.id).length*5+(a.starter?20:0);
    const sb=(b.likes||0)*2+d.postComments.filter(c=>c.postId===b.id).length*5+(b.starter?20:0);
    return (new Date(b.createdAt)-new Date(a.createdAt))*0.35+sb-sa;
  }).slice(0,limit);
  res.json({posts:posts.map(p=>publicPost(d,p,req)),mode});
});
app.post('/api/posts',auth,(req,res)=>{
  const d=load(),text=clean(req.body.text,2000),rawTags=Array.isArray(req.body.hashtags)?req.body.hashtags:clean(req.body.hashtags,500).split(/[ ,]+/).filter(Boolean);
  const hashtags=[...new Set(rawTags.map(x=>String(x).replace(/^#/,'').toLowerCase()).filter(x=>/^[a-z0-9_]{1,40}$/i.test(x)))].slice(0,12);
  if(!text)return res.status(400).json({error:'Write something before posting'});
  const p={id:uid(),userId:req.user.id,text,hashtags,mediaUrl:'',mediaType:'',likes:0,comments:0,createdAt:now(),starter:false};d.posts.push(p);save(d);res.json({post:publicPost(d,p,req)});
});
app.post('/api/posts/media',auth,postImageUpload.single('image'),(req,res)=>{
  const d=load(),text=clean(req.body.text,2000); if(!req.file&&!text)return res.status(400).json({error:'Add text or choose an image'});
  const raw=clean(req.body.hashtags,500).split(/[ ,]+/).filter(Boolean);const hashtags=[...new Set(raw.map(x=>x.replace(/^#/,'').toLowerCase()).filter(x=>/^[a-z0-9_]{1,40}$/i.test(x)))].slice(0,12);
  const p={id:uid(),userId:req.user.id,text,hashtags,mediaUrl:req.file?'/uploads/'+req.file.filename:'',mediaType:req.file?.mimetype||'',likes:0,comments:0,createdAt:now(),starter:false};d.posts.push(p);save(d);res.json({post:publicPost(d,p,req)});
});
app.delete('/api/posts/:id',auth,(req,res)=>{const d=load(),i=d.posts.findIndex(p=>p.id===req.params.id&&p.userId===req.user.id);if(i<0)return res.sendStatus(404);const p=d.posts[i];d.posts.splice(i,1);d.postLikes=d.postLikes.filter(x=>x.postId!==p.id);d.postBookmarks=d.postBookmarks.filter(x=>x.postId!==p.id);d.postComments=d.postComments.filter(x=>x.postId!==p.id);if(p.mediaUrl?.startsWith('/uploads/'))fs.rmSync(path.join(UPLOAD_DIR,path.basename(p.mediaUrl)),{force:true});save(d);res.json({ok:true});});
app.post('/api/posts/:id/like',auth,(req,res)=>{const d=load(),p=d.posts.find(x=>x.id===req.params.id);if(!p)return res.sendStatus(404);const i=d.postLikes.findIndex(x=>x.postId===p.id&&x.userId===req.user.id);if(i>=0){d.postLikes.splice(i,1);p.likes=Math.max(0,(p.likes||0)-1);}else{d.postLikes.push({id:uid(),postId:p.id,userId:req.user.id,createdAt:now()});p.likes=(p.likes||0)+1;notify(d,p.userId,'like',`${req.user.name} liked your post`,'social',req.user.id);}save(d);res.json({liked:i<0,likes:p.likes});});
app.post('/api/posts/:id/bookmark',auth,(req,res)=>{const d=load(),p=d.posts.find(x=>x.id===req.params.id);if(!p)return res.sendStatus(404);const i=d.postBookmarks.findIndex(x=>x.postId===p.id&&x.userId===req.user.id);if(i>=0)d.postBookmarks.splice(i,1);else d.postBookmarks.push({id:uid(),postId:p.id,userId:req.user.id,createdAt:now()});save(d);res.json({saved:i<0});});
app.get('/api/posts/:id/comments',(req,res)=>{const d=load(),comments=d.postComments.filter(c=>c.postId===req.params.id).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).slice(-100).map(c=>{const u=d.users.find(x=>x.id===c.userId);return {...c,user:u?.name||'User',avatar:u?.avatar||'',verified:!!u?.verified}});res.json({comments});});
app.post('/api/posts/:id/comments',auth,(req,res)=>{const d=load(),p=d.posts.find(x=>x.id===req.params.id),text=clean(req.body.text,500);if(!p)return res.sendStatus(404);if(!text)return res.status(400).json({error:'Comment cannot be empty'});const c={id:uid(),postId:p.id,userId:req.user.id,text,createdAt:now()};d.postComments.push(c);p.comments=(p.comments||0)+1;notify(d,p.userId,'comment',`${req.user.name} commented on your post`,'social',req.user.id);save(d);res.json({comment:c});});
app.get('/api/social/saved',auth,(req,res)=>{const d=load();res.json({posts:d.posts.filter(p=>d.postBookmarks.some(x=>x.postId===p.id&&x.userId===req.user.id)).map(p=>publicPost(d,p,req))});});
app.get('/api/stories',optional,(req,res)=>{const d=load(),cut=Date.now()-24*3600000;let list=d.stories.filter(s=>new Date(s.createdAt).getTime()>cut);if(req.user){const ids=new Set(d.follows.filter(f=>f.userId===req.user.id).map(f=>f.targetId));list=list.filter(s=>s.userId===req.user.id||ids.has(s.userId)||s.starter);}else list=list.filter(s=>s.starter);list.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));res.json({stories:list.slice(0,60).map(s=>publicStory(d,s,req))});});
app.post('/api/stories',auth,postImageUpload.single('image'),(req,res)=>{const d=load(),text=clean(req.body.text,500);if(!text&&!req.file)return res.status(400).json({error:'Add story text or an image'});const st={id:uid(),userId:req.user.id,text,mediaUrl:req.file?'/uploads/'+req.file.filename:'',mediaType:req.file?.mimetype||'',createdAt:now(),expiresAt:new Date(Date.now()+24*3600000).toISOString(),starter:false};d.stories.push(st);save(d);res.json({story:publicStory(d,st,req)});});
app.delete('/api/stories/:id',auth,(req,res)=>{const d=load(),i=d.stories.findIndex(s=>s.id===req.params.id&&s.userId===req.user.id);if(i<0)return res.sendStatus(404);const st=d.stories[i];d.stories.splice(i,1);d.storyViews=d.storyViews.filter(v=>v.storyId!==st.id);if(st.mediaUrl?.startsWith('/uploads/'))fs.rmSync(path.join(UPLOAD_DIR,path.basename(st.mediaUrl)),{force:true});save(d);res.json({ok:true});});
app.post('/api/stories/:id/view',auth,(req,res)=>{const d=load(),st=d.stories.find(s=>s.id===req.params.id);if(!st)return res.sendStatus(404);if(!d.storyViews.some(v=>v.storyId===st.id&&v.userId===req.user.id))d.storyViews.push({id:uid(),storyId:st.id,userId:req.user.id,createdAt:now()});save(d);res.json({ok:true});});
app.get('/api/search',optional,async(req,res)=>{
  const d=load(),q=clean(req.query.q,120).toLowerCase();if(!q)return res.json({query:'',videos:[],creators:[],posts:[],music:[],games:[]});
  const hit=t=>String(t||'').toLowerCase().includes(q);
  const videos=d.videos.filter(v=>hit(v.title)||hit(v.description)||hit(v.category)||(v.tags||[]).some(hit)).slice(0,20).map(v=>pub(d,v,req));
  const longVideos=LONG_VIDEOS.filter(v=>!v.overMax&&v.duration>=60&&v.duration<=18000&&(hit(v.title)||hit(v.description)||hit(v.category)||hit(v.provider)||(v.tags||[]).some(hit))).slice(0,10).map(v=>({...v,external:true,remote:false,creator:v.provider,creatorId:'external-'+v.id,verified:false,audio:true,views:0,likes:0,createdAt:'2026-09-01T00:00:00.000Z'}));
  videos.push(...longVideos);
  if(YOUTUBE_API_KEY){ try{ const yt=await youtubeSearch(q,10); videos.push(...yt.map(v=>({...v,category:'YOUTUBE',external:true,creator:v.provider,creatorId:'external-'+v.id,verified:false}))); }catch(err){ console.warn('YouTube search lookup skipped:',err.message); } }
  const creators=d.users.filter(u=>hit(u.name)||hit(u.bio)).slice(0,12).map(u=>publicUser(u));
  const posts=d.posts.filter(p=>hit(p.text)||(p.hashtags||[]).some(hit)).slice(0,20).map(p=>publicPost(d,p,req));
  const music=d.music.filter(m=>hit(m.title)||hit(m.artist)||hit(m.genre)||hit(m.album)).slice(0,12);
  const games=d.games.filter(g=>hit(g.title)||hit(g.creator)||hit(g.genre)).slice(0,12);
  res.json({query:q,videos,creators,posts,music,games,total:videos.length+creators.length+posts.length+music.length+games.length});
});

app.post('/api/videos/:id/report',auth,(req,res)=>{const d=load();if(d.reports.some(r=>r.videoId===req.params.id&&r.userId===req.user.id))return res.status(409).json({error:'You already reported this video'});d.reports.push({id:uid(),videoId:req.params.id,userId:req.user.id,reason:clean(req.body.reason,200)||'Other',status:'open',createdAt:now()});save(d);res.json({ok:true});});
app.get('/api/admin/system',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id);
  if(u?.role!=='admin' && !u?.isCEO)return res.status(403).json({error:'Admin only'});
  const backupDir=path.join(DATA_DIR,'backups');
  let backups=[]; try{backups=fs.readdirSync(backupDir).filter(x=>x.endsWith('.json')).sort().reverse().slice(0,5).map(x=>({name:x,bytes:fs.statSync(path.join(backupDir,x)).size}));}catch{}
  res.json({version:API_VERSION,schemaVersion:Number(d.schemaVersion||SCHEMA_VERSION),node:process.version,uptimeSeconds:Math.round(process.uptime()),memoryMB:Math.round(process.memoryUsage().rss/1024/1024),dataDirectory:DATA_DIR,backupCount:backups.length,backups,auditLogCount:d.auditLogs.length,loginEventCount:d.loginEvents.length});
});
app.post('/api/admin/backup',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id);
  if(u?.role!=='admin' && !u?.isCEO)return res.status(403).json({error:'Admin only'});
  audit(d,req,'create_backup','',{}); save(d); const file=backupDb();
  res.json({ok:true,file:path.basename(file),bytes:fs.statSync(file).size});
});
app.get('/api/admin/backups/:name',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id);
  if(u?.role!=='admin' && !u?.isCEO)return res.status(403).json({error:'Admin only'});
  const name=path.basename(req.params.name);
  if(!/^db-[A-Za-z0-9_.-]+\.json$/.test(name))return res.status(400).json({error:'Invalid backup name'});
  const file=path.join(DATA_DIR,'backups',name);
  if(!fs.existsSync(file))return res.sendStatus(404);
  audit(d,req,'download_backup',name,{}); save(d);
  res.download(file,name);
});
app.get('/api/admin/overview',auth,(req,res)=>{const d=load(),u=d.users.find(x=>x.id===req.user.id);if(u?.role!=='admin' && !u?.isCEO)return res.status(403).json({error:'Admin only'});res.json({users:d.users.filter(x=>!x.starter).length,videos:d.videos.length,reports:d.reports.filter(r=>r.status==='open').length,comments:d.comments.length,recentReports:d.reports.slice(-30).reverse().map(r=>({...r,title:d.videos.find(v=>v.id===r.videoId)?.title||'Unknown'}))});});
app.post('/api/admin/reports/:id/resolve',auth,(req,res)=>{const d=load(),u=d.users.find(x=>x.id===req.user.id);if(u?.role!=='admin' && !u?.isCEO)return res.status(403).json({error:'Admin only'});const r=d.reports.find(x=>x.id===req.params.id);if(!r)return res.sendStatus(404);r.status='resolved';r.resolvedAt=now();save(d);res.json({ok:true});});

app.post('/api/creator/apply',auth,(req,res)=>{const d=load(),u=d.users.find(x=>x.id===req.user.id);if(!u)return res.sendStatus(404);if(u.role!=='admin')u.role='creator';u.creatorSince=u.creatorSince||now();u.bio=u.bio||'ZenithMax creator';notify(d,u.id,'creator','Welcome to Creator Mode! Start publishing original content.','studio');save(d);res.json({ok:true,user:safeUser(u)});});
app.get('/api/stats',auth,(req,res)=>{
  const d=load(),vs=d.videos.filter(v=>v.userId===req.user.id),totalViews=vs.reduce((n,v)=>n+(v.views||0),0),totalLikes=vs.reduce((n,v)=>n+(v.likes||0),0);
  const top=[...vs].sort((a,b)=>(b.views||0)-(a.views||0)).slice(0,5).map(v=>({id:v.id,title:v.title,views:v.views,likes:v.likes}));
  const cats={};for(const v of vs)cats[v.category]=(cats[v.category]||0)+v.views;
  res.json({videos:vs.length,views:totalViews,likes:totalLikes,followers:d.users.find(u=>u.id===req.user.id)?.followers||0,comments:d.comments.filter(c=>vs.some(v=>v.id===c.videoId)).length,topVideos:top,categories:cats});
});
app.get('/api/production/status',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(u?.role!=='admin'&&!u?.isCEO)return res.status(403).json({error:'Admin only'});
  const status=productionServices.providerStatus();
  res.json({version:API_VERSION,providers:status,storage:{provider:status.storage.provider,cdn:status.storage.cdnConfigured},limits:{videoUploadMB:500,musicUploadMB:250,gameUploadMB:200,maxLongVideoSeconds:18000},notes:{database:'PostgreSQL is a durable state mirror/recovery source when DATABASE_URL is configured.',storage:'S3-compatible storage is used for completed media uploads when configured; local storage remains fallback.',processing:'FFmpeg/FFprobe availability is detected; add a worker for full transcoding at scale.'}});
});
app.get('/api/production/realtime',auth,(req,res)=>res.json(productionServices.rtcConfig()));
app.post('/api/media/presign',auth,(req,res)=>{
  const name=clean(req.body.name,180),mime=clean(req.body.mime,160)||'application/octet-stream',size=Number(req.body.size||0),folder=['uploads','videos','music','images','games'].includes(clean(req.body.folder,40))?clean(req.body.folder,40):'uploads';
  if(!name||!Number.isFinite(size)||size<1)return res.status(400).json({error:'File name and size are required'});
  if(size>550*1024*1024)return res.status(400).json({error:'File is larger than the V24 presign limit'});
  const ext=(path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,8}$/)||[''])[0]; const key=`${folder}/${new Date().toISOString().slice(0,10)}/${uid()}${ext}`;
  try{const signed=productionServices.presignedPutUrl(key,mime,900);res.json({provider:'s3',...signed,maxBytes:550*1024*1024});}
  catch(e){res.status(503).json({error:'S3-compatible storage is not configured'});}
});
app.post('/api/production/email/test',auth,async(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(u?.role!=='admin'&&!u?.isCEO)return res.status(403).json({error:'Admin only'});
  try{const result=await productionServices.sendEmail({to:u.email,subject:'ZenithMax V24 email test',text:'Your ZenithMax V24 email provider is configured and reachable.',html:'<p>Your <b>ZenithMax V24</b> email provider is configured and reachable.</p>'});audit(d,req,'test_email','',{});save(d);res.json({ok:true,id:result.id||null,to:u.email});}
  catch(e){res.status(503).json({error:e.message||'Email provider is not configured'});}
});
app.get('/api/production/database',auth,async(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(u?.role!=='admin'&&!u?.isCEO)return res.status(403).json({error:'Admin only'});
  if(!productionServices.config.database.url) return res.json({configured:false,connected:false});
  try{const ok=await productionServices.testPostgres();res.json({configured:true,connected:ok});}catch(e){res.status(503).json({configured:true,connected:false,error:e.message});}
});

app.get('/api/live/status',(req,res)=>{const p=productionServices.providerStatus();res.json({enabled:!!p.realtime.turnConfigured,version:'24',transport:p.realtime.turnConfigured?'WebRTC with TURN + STUN':'WebRTC peer-to-peer fallback',message:p.realtime.turnConfigured?'TURN is configured for NAT traversal.':'Add TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL for reliable production calls.'});});

// V14 monetization architecture. This is a safe demo ledger: it does NOT process real money.
function monetizationSummary(d,userId){
  const rows=d.earnings.filter(e=>e.creatorId===userId);
  const tips=rows.filter(e=>e.type==='tip').reduce((n,e)=>n+e.amount,0);
  const subs=rows.filter(e=>e.type==='subscription').reduce((n,e)=>n+e.amount,0);
  const ads=rows.filter(e=>e.type==='ad').reduce((n,e)=>n+e.amount,0);
  const sponsorships=rows.filter(e=>e.type==='sponsorship').reduce((n,e)=>n+e.amount,0);
  return {tips,subscriptions:subs,ads,sponsorships,total:tips+subs+ads+sponsorships};
}
const DEMO_MONETIZATION=String(process.env.ENABLE_DEMO_MONETIZATION||'').toLowerCase()==='true';
const demoOnly=(req,res,next)=>DEMO_MONETIZATION?next():res.status(403).json({error:'Creator payments are not live yet.'});
app.get('/api/monetization/dashboard',auth,(req,res)=>{
  const d=load(), u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  const summary=monetizationSummary(d,u.id);
  const creatorSubs=d.creatorSubscriptions.filter(x=>x.creatorId===u.id&&x.status==='active').length;
  const campaigns=d.adCampaigns.filter(x=>x.creatorId===u.id);
  res.json({mode:'demo',summary,creatorSubscribers:creatorSubs,campaigns,history:d.earnings.filter(e=>e.creatorId===u.id).slice(-50).reverse(),eligible:(u.followers||0)>=100});
});
app.post('/api/monetization/tip',auth,demoOnly,(req,res)=>{
  const d=load(), creator=d.users.find(x=>x.id===clean(req.body.creatorId,100));
  const amount=Math.min(100,Math.max(1,Number(req.body.amount||1)));
  if(!creator)return res.sendStatus(404); if(creator.id===req.user.id)return res.status(400).json({error:'You cannot tip yourself'});
  // Demo credits only; no card/payment is touched.
  const platform=Math.round(amount*0.10*100)/100, net=Math.round((amount-platform)*100)/100;
  d.tips.push({id:uid(),fromId:req.user.id,creatorId:creator.id,amount,platformFee:platform,net,createdAt:now(),mode:'demo'});
  d.earnings.push({id:uid(),creatorId:creator.id,sourceUserId:req.user.id,type:'tip',amount:net,gross:amount,createdAt:now(),mode:'demo'});
  notify(d,creator.id,'tip',`${req.user.name} sent you a demo tip of ${amount} credits`,'monetization',req.user.id); save(d);
  res.json({ok:true,mode:'demo',gross:amount,platformFee:platform,creatorEarned:net});
});
app.post('/api/monetization/subscribe',auth,demoOnly,(req,res)=>{
  const d=load(), creator=d.users.find(x=>x.id===clean(req.body.creatorId,100)); if(!creator)return res.sendStatus(404);
  if(creator.id===req.user.id)return res.status(400).json({error:'You cannot subscribe to yourself'});
  const existing=d.creatorSubscriptions.find(x=>x.creatorId===creator.id&&x.userId===req.user.id);
  if(existing){existing.status=existing.status==='active'?'cancelled':'active'; existing.updatedAt=now(); save(d); return res.json({active:existing.status==='active',mode:'demo'});}
  const price=5, fee=.5, sub={id:uid(),creatorId:creator.id,userId:req.user.id,price,platformFee:fee,status:'active',createdAt:now()};
  d.creatorSubscriptions.push(sub); d.earnings.push({id:uid(),creatorId:creator.id,sourceUserId:req.user.id,type:'subscription',amount:price-fee,gross:price,createdAt:now(),mode:'demo'});
  creator.followers=(creator.followers||0)+1; notify(d,creator.id,'subscription',`${req.user.name} subscribed to your creator channel`,'monetization',req.user.id); save(d);
  res.json({active:true,mode:'demo',price});
});
app.post('/api/monetization/campaigns',auth,demoOnly,(req,res)=>{
  const d=load(), title=clean(req.body.title,100), budget=Math.min(10000,Math.max(10,Number(req.body.budget||10)));
  if(!title)return res.status(400).json({error:'Campaign title required'});
  const c={id:uid(),creatorId:req.user.id,title,budget,status:'draft',createdAt:now(),impressions:0,clicks:0}; d.adCampaigns.push(c); save(d); res.json({campaign:c,mode:'demo'});
});
app.post('/api/monetization/campaigns/:id/activate',auth,demoOnly,(req,res)=>{
  const d=load(),c=d.adCampaigns.find(x=>x.id===req.params.id&&x.creatorId===req.user.id); if(!c)return res.sendStatus(404); c.status=c.status==='active'?'paused':'active'; save(d); res.json({campaign:c,mode:'demo'});
});
app.post('/api/monetization/ads/impression',optional,demoOnly,(req,res)=>{
  const d=load(), id=clean(req.body.campaignId,100), c=d.adCampaigns.find(x=>x.id===id&&x.status==='active');
  if(!c)return res.status(404).json({error:'Campaign not active'});
  c.impressions=(c.impressions||0)+1; if(c.impressions%100===0){const amount=.20; d.earnings.push({id:uid(),creatorId:c.creatorId,type:'ad',amount,gross:amount,createdAt:now(),mode:'demo'});} save(d); res.json({ok:true});
});
app.get('/api/monetization/eligibility',auth,(req,res)=>{const d=load(),u=d.users.find(x=>x.id===req.user.id);res.json({followers:u?.followers||0,verified:!!u?.verified,eligible:(u?.followers||0)>=100,requirements:['Build a real audience','Publish original or licensed content','Follow applicable platform/payment rules','Complete adult-assisted business/payment setup when required'],mode:'demo'});});



// V22.7 creator ecosystem: live scheduling, premieres, series, sounds, effects,
// memberships, polls, and remix collaboration drafts. Broadcast transport and
// real payment processing remain separate integrations; this layer stores the
// creator workflow safely in the ZenithMax application database.
app.get('/api/creator-suite',auth,(req,res)=>{
  const d=load(),uid=req.user.id;
  res.json({
    scheduledLives:d.scheduledLives.filter(x=>x.userId===uid&&x.status!=='cancelled'),
    premieres:d.premieres.filter(x=>x.userId===uid&&x.status!=='cancelled'),
    series:d.series.filter(x=>x.userId===uid),
    sounds:[...d.sounds.filter(x=>x.userId===uid),...d.sounds.filter(x=>x.starter)].slice(0,50),
    effects:[...d.effects.filter(x=>x.userId===uid),...d.effects.filter(x=>x.starter)].slice(0,50),
    membershipTiers:d.membershipTiers.filter(x=>x.userId===uid),
    polls:d.creatorPolls.filter(x=>x.userId===uid).slice(-30).reverse(),
    remixDrafts:d.remixDrafts.filter(x=>x.userId===uid).slice(-30).reverse()
  });
});
app.post('/api/creator-suite/live',auth,(req,res)=>{
  const d=load(),title=clean(req.body.title,120),description=clean(req.body.description,500),audience=clean(req.body.audience,30)||'Public',scheduledAt=clean(req.body.scheduledAt,60);
  if(!title||!scheduledAt)return res.status(400).json({error:'Live title and date/time are required'});
  const dt=new Date(scheduledAt); if(Number.isNaN(dt.getTime()))return res.status(400).json({error:'Invalid live date/time'});
  if(dt.getTime()<=Date.now())return res.status(400).json({error:'Choose a future live time'});
  const item={id:uid(),userId:req.user.id,title,description,audience,scheduledAt:dt.toISOString(),status:'scheduled',createdAt:now()}; d.scheduledLives.push(item); save(d); res.json({event:item});
});
app.delete('/api/creator-suite/live/:id',auth,(req,res)=>{const d=load(),x=d.scheduledLives.find(v=>v.id===req.params.id&&v.userId===req.user.id);if(!x)return res.sendStatus(404);x.status='cancelled';x.updatedAt=now();save(d);res.json({ok:true});});
app.post('/api/creator-suite/premiere',auth,(req,res)=>{
  const d=load(),video=d.videos.find(v=>v.id===clean(req.body.videoId,100)&&v.userId===req.user.id),scheduledAt=clean(req.body.scheduledAt,60);
  if(!video)return res.status(404).json({error:'Choose one of your videos'});
  const dt=new Date(scheduledAt); if(Number.isNaN(dt.getTime())||dt.getTime()<=Date.now())return res.status(400).json({error:'Choose a future premiere time'});
  const item={id:uid(),userId:req.user.id,videoId:video.id,title:video.title,scheduledAt:dt.toISOString(),status:'scheduled',createdAt:now()};d.premieres.push(item);save(d);res.json({premiere:item});
});
app.post('/api/creator-suite/series',auth,(req,res)=>{const d=load(),name=clean(req.body.name,100),description=clean(req.body.description,300);if(!name)return res.status(400).json({error:'Series name required'});const item={id:uid(),userId:req.user.id,name,description,videoIds:[],createdAt:now()};d.series.push(item);save(d);res.json({series:item});});
app.post('/api/creator-suite/series/:id/videos/:videoId',auth,(req,res)=>{const d=load(),s=d.series.find(x=>x.id===req.params.id&&x.userId===req.user.id),v=d.videos.find(x=>x.id===req.params.videoId&&x.userId===req.user.id);if(!s||!v)return res.sendStatus(404);if(!s.videoIds.includes(v.id))s.videoIds.push(v.id);save(d);res.json({series:s});});
app.post('/api/creator-suite/sounds',auth,(req,res)=>{const d=load(),name=clean(req.body.name,100),genre=clean(req.body.genre,60)||'Original sound';if(!name)return res.status(400).json({error:'Sound name required'});const item={id:uid(),userId:req.user.id,name,genre,uses:0,createdAt:now()};d.sounds.push(item);save(d);res.json({sound:item});});
app.post('/api/creator-suite/effects',auth,(req,res)=>{const d=load(),name=clean(req.body.name,100),description=clean(req.body.description,240)||'Creator effect';if(!name)return res.status(400).json({error:'Effect name required'});const item={id:uid(),userId:req.user.id,name,description,uses:0,createdAt:now()};d.effects.push(item);save(d);res.json({effect:item});});
app.post('/api/creator-suite/memberships',auth,(req,res)=>{const d=load(),name=clean(req.body.name,80),perks=Array.isArray(req.body.perks)?req.body.perks.map(x=>clean(x,100)).filter(Boolean).slice(0,10):[],price=Math.min(100,Math.max(1,Number(req.body.price||5)));if(!name)return res.status(400).json({error:'Membership name required'});const item={id:uid(),userId:req.user.id,name,perks,price,mode:'demo',createdAt:now()};d.membershipTiers.push(item);save(d);res.json({membership:item,mode:'demo'});});
app.post('/api/creator-suite/polls',auth,(req,res)=>{const d=load(),question=clean(req.body.question,240),options=Array.isArray(req.body.options)?req.body.options.map(x=>clean(x,80)).filter(Boolean).slice(0,6):[];if(!question||options.length<2)return res.status(400).json({error:'A poll needs a question and at least two options'});const item={id:uid(),userId:req.user.id,question,options:options.map((label,i)=>({id:'opt-'+i,label,votes:0})),createdAt:now(),status:'open'};d.creatorPolls.push(item);save(d);res.json({poll:item});});
app.post('/api/creator-suite/remix',auth,(req,res)=>{const d=load(),video=d.videos.find(v=>v.id===clean(req.body.videoId,100)&&v.status!=='removed'),mode=clean(req.body.mode,20).toLowerCase();if(!video)return res.status(404).json({error:'Source video not found'});if(!['remix','duet','stitch'].includes(mode))return res.status(400).json({error:'Unsupported collaboration type'});const item={id:uid(),userId:req.user.id,sourceVideoId:video.id,sourceTitle:video.title,mode,status:'draft',createdAt:now()};d.remixDrafts.push(item);save(d);res.json({draft:item,sourceTitle:video.title});});


// V29: V6 Dynamic Entertainment Integration. Uses the canonical V28 auth and state store.
require('./entertainment')(app, { auth, load, save, uid, now, clean, notify });

app.use((err,req,res,next)=>{
  if(err?.code==='LIMIT_FILE_SIZE') return res.status(413).json({error:'Uploaded file is too large.'});
  if(err?.name==='MulterError') return res.status(400).json({error:err.message||'Upload failed'});
  console.error('Request error',req.requestId,err);
  res.status(500).json({error:'Unexpected server error',requestId:req.requestId});
});
app.use('/api',(req,res)=>res.status(404).json({error:'Not found'}));
app.use((req,res)=>res.sendFile(path.join(ROOT,'client/index.html')));

async function openDatabase(){
  PERSIST = productionServices.config.database.url
    ? new PgStore(await productionServices.getPgPool(), DB)
    : new FileStore(DB);
  const stored = await PERSIST.open();
  const fromVersion = Number(stored?.schemaVersion || 0);
  STATE = normalizeState(stored || emptyState());
  if(stored && fromVersion < SCHEMA_VERSION){ try{ backupDb(); }catch{} }
  seed(STATE);
  save(STATE);
}
async function startZenithMax(){
  if(IS_PRODUCTION && !productionServices.config.database.url) console.warn("WARNING: DATABASE_URL is not set. Accounts and content are kept on this instance's disk and will be lost on redeploy.");
  if(IS_PRODUCTION && !productionServices.providerStatus().storage.configured) console.warn('WARNING: S3 media storage is not configured. Uploads will be lost on redeploy.');
  await openDatabase();
  const shutdown = async () => {
    try { await PERSIST?.flushNow(); } catch (err) { console.error('Final save failed:', err.message); }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  app.listen(PORT,'0.0.0.0',()=>console.log(`ZenithMax V31.0.0 running on port ${PORT}`));
  (async()=>{
    try {
      const media=await resolveRemoteCatalog();
      shortsRemote.markSeen(load().videos.filter(v=>v.isShort&&v.starter).map(v=>({...v,remoteUrl:v.url})));
      console.log(`Remote starter media: ${media.unique} unique, ${media.unresolved} unresolved`);
      console.log(`Remote Shorts catalog: ${shortsRemote.stats().total} unique entries indexed`);
      discoverRemoteHome(12).then(items=>console.log(`Remote Home library: ${items.length} unique entries cached`)).catch(err=>console.warn('Remote Home hydration skipped:',err?.message||err));
    } catch (err) {
      console.warn('Remote catalog hydration skipped:', err?.message || err);
    }
  })();
}
startZenithMax().catch(err=>{console.error('ZenithMax startup failed:',err);process.exit(1)});
