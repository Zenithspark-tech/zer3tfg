const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const bool = v => ['1','true','yes','on'].includes(String(v||'').toLowerCase());
const clean = (v,n=500) => String(v ?? '').trim().slice(0,n);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key,data,encoding) => crypto.createHmac('sha256',key).update(data).digest(encoding);
const hmacBuffer = (key,data) => crypto.createHmac('sha256',key).update(data).digest();
const hashString = data => sha256(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
const rfc3986 = s => encodeURIComponent(String(s)).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());

const config = {
  storage: {
    provider: clean(process.env.MEDIA_STORAGE_PROVIDER || (process.env.S3_BUCKET ? 's3' : 'local'), 40).toLowerCase(),
    bucket: clean(process.env.S3_BUCKET, 120),
    region: clean(process.env.S3_REGION || 'us-east-1', 80),
    endpoint: clean(process.env.S3_ENDPOINT, 500).replace(/\/$/, ''),
    accessKey: clean(process.env.S3_ACCESS_KEY_ID, 180),
    secretKey: process.env.S3_SECRET_ACCESS_KEY || '',
    publicBaseUrl: clean(process.env.MEDIA_CDN_BASE_URL || process.env.S3_PUBLIC_BASE_URL, 800).replace(/\/$/, ''),
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE)
  },
  email: {
    provider: clean(process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : 'none'), 40).toLowerCase(),
    apiKey: process.env.RESEND_API_KEY || '',
    from: clean(process.env.RESEND_FROM || '', 200),
    appUrl: clean(process.env.APP_PUBLIC_URL || '', 800).replace(/\/$/, '')
  },
  payments: {
    provider: clean(process.env.PAYMENTS_PROVIDER || (process.env.STRIPE_SECRET_KEY ? 'stripe' : 'none'), 40).toLowerCase(),
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: clean(process.env.STRIPE_PUBLISHABLE_KEY || '', 240),
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  },
  database: {
    provider: clean(process.env.DATABASE_PROVIDER || (process.env.DATABASE_URL ? 'postgres' : 'json'), 40).toLowerCase(),
    url: process.env.DATABASE_URL || ''
  },
  realtime: {
    turnUrls: clean(process.env.TURN_URLS || '', 1200).split(',').map(x=>x.trim()).filter(Boolean),
    turnUsername: clean(process.env.TURN_USERNAME || '', 240),
    turnCredential: process.env.TURN_CREDENTIAL || '',
    stunUrls: clean(process.env.STUN_URLS || 'stun:stun.l.google.com:19302', 1200).split(',').map(x=>x.trim()).filter(Boolean)
  },
  processing: {
    ffmpegPath: clean(process.env.FFMPEG_PATH || 'ffmpeg', 300),
    ffprobePath: clean(process.env.FFPROBE_PATH || 'ffprobe', 300)
  }
};

function computeProviderStatus(){
  const ffmpeg = spawnSync(config.processing.ffmpegPath, ['-version'], {stdio:'ignore'}).status === 0;
  const ffprobe = spawnSync(config.processing.ffprobePath, ['-version'], {stdio:'ignore'}).status === 0;
  return {
    storage:{provider:config.storage.provider,configured:config.storage.provider==='local' || !!(config.storage.bucket&&config.storage.accessKey&&config.storage.secretKey),bucket:config.storage.bucket||'',cdnConfigured:!!config.storage.publicBaseUrl},
    email:{provider:config.email.provider,configured:config.email.provider==='none'?false:!!(config.email.apiKey&&config.email.from),from:config.email.from||''},
    payments:{provider:config.payments.provider,configured:config.payments.provider==='none'?false:!!config.payments.secretKey,webhookConfigured:!!config.payments.webhookSecret},
    database:{provider:config.database.provider,configured:config.database.provider==='json'?false:!!config.database.url},
    realtime:{turnConfigured:!!(config.realtime.turnUrls.length&&config.realtime.turnUsername&&config.realtime.turnCredential),stunUrls:config.realtime.stunUrls.length},
    processing:{ffmpeg,ffprobe}
  };
}

let providerCache=null, providerCachedAt=0;
// ffmpeg/ffprobe checks spawn processes. Cache them so the public status endpoint does not spawn processes on every request.
function providerStatus(){
  if(!providerCache || Date.now()-providerCachedAt>5*60_000){ providerCache=computeProviderStatus(); providerCachedAt=Date.now(); }
  return providerCache;
}
function endpointForBucket(){
  if(config.storage.endpoint) return config.storage.endpoint;
  return `https://s3.${config.storage.region}.amazonaws.com`;
}
function objectUrl(key){
  const k=String(key||'').replace(/^\/+/, '');
  if(config.storage.publicBaseUrl) return `${config.storage.publicBaseUrl}/${k}`;
  const ep=endpointForBucket();
  if(config.storage.forcePathStyle || config.storage.endpoint) return `${ep}/${rfc3986(config.storage.bucket)}/${k.split('/').map(rfc3986).join('/')}`;
  return `https://${config.storage.bucket}.s3.${config.storage.region}.amazonaws.com/${k.split('/').map(rfc3986).join('/')}`;
}
function presignedPutUrl(key, contentType, expiresSeconds=900){
  if(!(config.storage.bucket&&config.storage.accessKey&&config.storage.secretKey)) throw new Error('S3-compatible storage is not configured');
  const method='PUT';
  const endpoint=endpointForBucket();
  const u=new URL(endpoint);
  let host, pathName;
  const safeKey=String(key||'').replace(/^\/+/, '');
  if(config.storage.forcePathStyle || config.storage.endpoint){ host=u.host; pathName=`/${rfc3986(config.storage.bucket)}/${safeKey.split('/').map(rfc3986).join('/')}`; }
  else { host=`${config.storage.bucket}.${u.host}`; pathName=`/${safeKey.split('/').map(rfc3986).join('/')}`; }
  const now=new Date();
  const amzDate=now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const date=amzDate.slice(0,8);
  const credentialScope=`${date}/${config.storage.region}/s3/aws4_request`;
  const credential=`${config.storage.accessKey}/${credentialScope}`;
  const query={
    'X-Amz-Algorithm':'AWS4-HMAC-SHA256',
    'X-Amz-Credential':credential,
    'X-Amz-Date':amzDate,
    'X-Amz-Expires':String(Math.min(3600,Math.max(60,Number(expiresSeconds)||900))),
    'X-Amz-SignedHeaders':'host'
  };
  const canonicalQuery=Object.keys(query).sort().map(k=>`${rfc3986(k)}=${rfc3986(query[k])}`).join('&');
  const canonicalHeaders=`host:${host}\n`;
  const canonicalRequest=[method,pathName,canonicalQuery,canonicalHeaders,'host','UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign=['AWS4-HMAC-SHA256',amzDate,credentialScope,hashString(canonicalRequest)].join('\n');
  const kDate=hmacBuffer(Buffer.from('AWS4'+config.storage.secretKey),date);
  const kRegion=hmacBuffer(kDate,config.storage.region);
  const kService=hmacBuffer(kRegion,'s3');
  const kSigning=hmacBuffer(kService,'aws4_request');
  query['X-Amz-Signature']=hmac(kSigning,stringToSign,'hex');
  const url=`${u.protocol}//${host}${pathName}?${Object.keys(query).sort().map(k=>`${rfc3986(k)}=${rfc3986(query[k])}`).join('&')}`;
  return {url,objectUrl:objectUrl(safeKey),key:safeKey,expiresAt:new Date(now.getTime()+Number(query['X-Amz-Expires'])*1000).toISOString(),headers:{'Content-Type':contentType||'application/octet-stream'}};
}

async function putFileViaPresignedUrl(filePath,key,contentType){
  const fsStat=fs.statSync(filePath);
  const signed=presignedPutUrl(key,contentType,900);
  const stream=fs.createReadStream(filePath);
  const r=await fetch(signed.url,{method:'PUT',headers:{'Content-Type':contentType||'application/octet-stream','Content-Length':String(fsStat.size)},body:stream,duplex:'half',signal:AbortSignal.timeout(120000)});
  if(!r.ok) throw new Error(`Object storage upload failed (${r.status})`);
  return {url:signed.objectUrl,key:signed.key,bytes:fsStat.size};
}

async function sendEmail({to,subject,html,text}){
  if(config.email.provider!=='resend' || !config.email.apiKey || !config.email.from) throw new Error('Email provider is not configured');
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.email.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from:config.email.from,to:[to],subject,html,text}),signal:AbortSignal.timeout(15000)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.message||`Email provider returned ${r.status}`);
  return data;
}

function rtcConfig(){
  const iceServers=config.realtime.stunUrls.map(url=>({urls:url}));
  if(config.realtime.turnUrls.length&&config.realtime.turnUsername&&config.realtime.turnCredential){
    iceServers.push({urls:config.realtime.turnUrls,username:config.realtime.turnUsername,credential:config.realtime.turnCredential});
  }
  return {iceServers};
}

let pgPool=null;
async function getPgPool(){
  if(!config.database.url) return null;
  if(pgPool) return pgPool;
  try{
    const {Pool}=require('pg');
    pgPool=new Pool({connectionString:config.database.url,ssl:config.database.url.includes('localhost')?false:{rejectUnauthorized:bool(process.env.PGSSL_REJECT_UNAUTHORIZED)},max:4,connectionTimeoutMillis:7000,idleTimeoutMillis:30000});
    return pgPool;
  }catch(e){ return null; }
}
async function ensurePostgresStateTable(){
  const pool=await getPgPool(); if(!pool) return false;
  await pool.query(`CREATE TABLE IF NOT EXISTS zenithmax_state (id INTEGER PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  return true;
}
async function mirrorState(payload){
  const pool=await getPgPool(); if(!pool) return false;
  await ensurePostgresStateTable();
  await pool.query(`INSERT INTO zenithmax_state (id,payload,updated_at) VALUES (1,$1::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()`,[JSON.stringify(payload)]);
  return true;
}
async function testPostgres(){
  const pool=await getPgPool(); if(!pool) return false;
  await pool.query('SELECT 1');
  return true;
}

async function restoreStateToFile(dbPath){
  if(fs.existsSync(dbPath)) return false;
  const pool=await getPgPool(); if(!pool) return false;
  await ensurePostgresStateTable();
  const r=await pool.query('SELECT payload FROM zenithmax_state WHERE id=1 LIMIT 1');
  if(!r.rows[0]?.payload) return false;
  fs.mkdirSync(path.dirname(dbPath),{recursive:true});
  fs.writeFileSync(dbPath,JSON.stringify(r.rows[0].payload,null,2));
  return true;
}

module.exports={config,getPgPool,providerStatus,presignedPutUrl,objectUrl,putFileViaPresignedUrl,sendEmail,rtcConfig,mirrorState,restoreStateToFile,testPostgres};
