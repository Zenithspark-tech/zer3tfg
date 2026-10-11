const crypto = require('crypto');

const MODULES = new Set(['arcade','watch-party','creator-battle','tournament']);
const cleanUrl = value => {
  if (!value) return '';
  try { const u = new URL(String(value)); return ['http:','https:'].includes(u.protocol) ? u.href : ''; }
  catch { return ''; }
};
const hashInvite = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const member = (party, userId) => Array.isArray(party.participantIds) && party.participantIds.includes(String(userId));
function rankFor(xp) {
  if (xp >= 2500) return 'Zenith Legend';
  if (xp >= 1000) return 'Superstar';
  if (xp >= 350) return 'Rising Creator';
  if (xp >= 100) return 'Explorer';
  return 'Rookie';
}
function userName(d, id) { return d.users.find(u => String(u.id) === String(id))?.name || 'ZenithMax member'; }
function progressFor(d, userId) {
  let p = d.entertainmentProgress.find(x => String(x.userId) === String(userId));
  if (!p) { p = { userId: String(userId), xp: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; d.entertainmentProgress.push(p); }
  return p;
}
function awardXP(d, userId, amount, module, action, title, description, eventKey) {
  const uid = String(userId);
  if (d.entertainmentEvents.some(e => e.eventKey === eventKey)) return { awarded: 0, duplicate: true };
  const day = new Date().toISOString().slice(0,10);
  let daily = d.entertainmentDailyXp.find(x => String(x.userId) === uid && x.day === day);
  if (!daily) { daily = { userId: uid, day, xpAwarded: 0 }; d.entertainmentDailyXp.push(daily); }
  const actual = Math.max(0, Math.min(Number(amount) || 0, 100 - Number(daily.xpAwarded || 0)));
  daily.xpAwarded = Number(daily.xpAwarded || 0) + actual;
  const p = progressFor(d, uid); p.xp = Number(p.xp || 0) + actual; p.updatedAt = new Date().toISOString();
  d.entertainmentEvents.unshift({
    id: crypto.randomUUID(), eventKey, userId: uid, module, action,
    title: String(title || 'Community activity').slice(0,120),
    description: String(description || '').slice(0,400), xpAwarded: actual,
    createdAt: new Date().toISOString()
  });
  if (d.entertainmentEvents.length > 5000) d.entertainmentEvents.length = 5000;
  return { awarded: actual, duplicate: false };
}
function contestState(c) {
  if (c.status === 'completed' || c.status === 'cancelled') return c.status;
  const now = Date.now(), start = c.startsAt ? new Date(c.startsAt).getTime() : 0, end = c.endsAt ? new Date(c.endsAt).getTime() : Infinity;
  if (Number.isFinite(end) && now >= end) return 'completed';
  if (start && now < start) return 'scheduled';
  return 'live';
}
function publicChallenge(d, c) {
  return { ...c, creatorName: userName(d,c.creatorId), opponentName: c.opponentId ? userName(d,c.opponentId) : null };
}
function publicContest(d, c, viewerId) {
  const state = contestState(c);
  if (c.status !== state && !['completed','cancelled'].includes(c.status)) c.status = state;
  return {
    id:c.id,kind:c.kind,title:c.title,description:c.description,status:state,
    creatorId:c.creatorId,creatorName:userName(d,c.creatorId),startsAt:c.startsAt||null,endsAt:c.endsAt||null,
    maxEntries:c.maxEntries||32,createdAt:c.createdAt,
    entries:(c.entries||[]).map(e=>({id:e.id,userId:e.userId,username:userName(d,e.userId),caption:e.caption,mediaUrl:e.mediaUrl||'',submittedAt:e.submittedAt,votes:(c.votes||[]).filter(v=>v.entryId===e.id).length,isMine:String(e.userId)===String(viewerId)})),
    voted: (c.votes||[]).some(v=>String(v.userId)===String(viewerId)),
    myEntry: (c.entries||[]).some(e=>String(e.userId)===String(viewerId))
  };
}
function publicParty(d,p,viewerId,includeSecret=false) {
  const out={id:p.id,title:p.title,description:p.description,mediaUrl:p.mediaUrl,visibility:p.visibility,status:p.status,
    hostId:p.hostId,hostName:userName(d,p.hostId),participantCount:(p.participantIds||[]).length,
    isMember:member(p,viewerId),isHost:String(p.hostId)===String(viewerId),createdAt:p.createdAt,
    playback:p.playback||{currentTime:0,playing:false,updatedAt:p.createdAt},
    messages:(p.messages||[]).slice(-80).map(m=>({...m,username:userName(d,m.userId)}))};
  if(includeSecret && p.inviteCodeHash) out.inviteRequired=true;
  return out;
}
module.exports = function registerEntertainment(app, ctx) {
  const { auth, load, save, uid, now, clean, notify } = ctx;

  app.get('/api/entertainment/dashboard', auth, (req,res) => {
    const d=load(), id=String(req.user.id), p=progressFor(d,id);
    const day=new Date().toISOString().slice(0,10);
    const daily=d.entertainmentDailyXp.find(x=>String(x.userId)===id&&x.day===day);
    const activities=d.entertainmentEvents.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,30).map(e=>({...e,username:userName(d,e.userId),isMine:String(e.userId)===id}));
    const leaderboard=d.entertainmentProgress.map(x=>({username:userName(d,x.userId),userId:String(x.userId),xp:Number(x.xp)||0,rank:rankFor(Number(x.xp)||0)}))
      .filter(x=>d.users.some(u=>String(u.id)===x.userId && !u.starter)).sort((a,b)=>b.xp-a.xp||a.username.localeCompare(b.username)).slice(0,15);
    const challenges=d.entertainmentChallenges.filter(c=>c.status!=='cancelled').slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,40).map(c=>publicChallenge(d,c));
    const parties=d.entertainmentWatchParties.filter(x=>x.status==='active'&&(x.visibility==='public'||member(x,id))).slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,20).map(p=>publicParty(d,p,id));
    const contests=d.entertainmentContests.filter(c=>!['cancelled'].includes(contestState(c))).slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,30).map(c=>publicContest(d,c,id));
    save(d);
    res.json({progress:{xp:Number(p.xp)||0,rank:rankFor(Number(p.xp)||0),dailyXp:Number(daily?.xpAwarded)||0,dailyCap:100},activities,leaderboard,challenges,watchParties:parties,contests});
  });

  app.post('/api/entertainment/activity', auth, (req,res) => {
    const d=load(), module=clean(req.body?.module,32), action=clean(req.body?.action,40), resourceId=clean(req.body?.resourceId,120);
    if(module!=='video'||action!=='content-watched'||!resourceId) return res.status(400).json({error:'Unsupported activity event.'});
    const video=d.videos.find(v=>String(v.id)===resourceId&&v.status!=='removed');
    if(!video) return res.status(404).json({error:'Content not found.'});
    const id=String(req.user.id), kind=video.isShort?'shorts':'video';
    const result=awardXP(d,id,1,kind,'content-watched',`Watched: ${clean(video.title,90)}`,'Started watching content on ZenithMax.',`${id}:${new Date().toISOString().slice(0,10)}:${kind}:${resourceId}`);
    save(d); res.json({ok:true,...result,progress:progressFor(d,id)});
  });

  app.post('/api/entertainment/games/:gameId/launch', auth, (req,res) => {
    const d=load(), game=d.games.find(g=>String(g.id)===String(req.params.gameId));
    if(!game) return res.status(404).json({error:'Game not found.'});
    const id=String(req.user.id);
    const result=awardXP(d,id,2,'arcade','game-launched',`Opened game: ${clean(game.title,90)}`,'Started a browser game on ZenithMax.',`${id}:${new Date().toISOString().slice(0,10)}:arcade:${game.id}`);
    save(d); res.json({ok:true,...result,progress:progressFor(d,id)});
  });

  app.post('/api/entertainment/challenges', auth, (req,res) => {
    const d=load(), title=clean(req.body?.title,100), module=clean(req.body?.module,32), description=clean(req.body?.description,400);
    if(title.length<3 || !MODULES.has(module)) return res.status(400).json({error:'Enter a title of at least 3 characters and choose a supported module.'});
    const c={id:uid(),creatorId:String(req.user.id),title,module,description,status:'open',opponentId:null,createdAt:now(),completedAt:null};
    d.entertainmentChallenges.push(c);
    const award=awardXP(d,req.user.id,5,module,'challenge-created',`Challenge created: ${title}`,'Started a new community challenge.',`${c.id}:created:${req.user.id}`);
    save(d); res.status(201).json({challenge:publicChallenge(d,c),xpAwarded:award.awarded});
  });
  app.post('/api/entertainment/challenges/:id/join', auth, (req,res) => {
    const d=load(), c=d.entertainmentChallenges.find(x=>x.id===req.params.id);
    if(!c || c.status==='cancelled') return res.status(404).json({error:'Challenge not found.'});
    if(String(c.creatorId)===String(req.user.id)) return res.status(400).json({error:'You cannot join your own challenge.'});
    if(c.status!=='open') return res.status(409).json({error:'This challenge has already been accepted or completed.'});
    c.status='accepted';c.opponentId=String(req.user.id);c.joinedAt=now();
    const award=awardXP(d,req.user.id,5,c.module,'challenge-joined',`Joined: ${c.title}`,'Accepted a community challenge.',`${c.id}:joined:${req.user.id}`);
    if(notify) notify(d,c.creatorId,'challenge',`${userName(d,req.user.id)} accepted your challenge: ${c.title}`,'entertainment',req.user.id);
    save(d);res.json({ok:true,xpAwarded:award.awarded});
  });
  app.post('/api/entertainment/challenges/:id/complete', auth, (req,res) => {
    const d=load(), c=d.entertainmentChallenges.find(x=>x.id===req.params.id);
    if(!c || ![String(c.creatorId),String(c.opponentId)].includes(String(req.user.id))) return res.status(404).json({error:'Challenge not found or you are not a participant.'});
    if(c.status!=='accepted') return res.status(409).json({error:'Only an accepted challenge can be completed.'});
    c.status='completed';c.completedAt=now();
    const award=awardXP(d,req.user.id,10,c.module,'challenge-completed',`Challenge completed: ${c.title}`,'Completed a community challenge.',`${c.id}:completed:${req.user.id}`);
    if(notify){const other=String(c.creatorId)===String(req.user.id)?c.opponentId:c.creatorId;if(other)notify(d,other,'challenge',`Challenge completed: ${c.title}`,'entertainment',req.user.id);}
    save(d);res.json({ok:true,xpAwarded:award.awarded});
  });

  // Real REST-backed watch parties on the existing ZenithMax accounts/database.
  app.get('/api/entertainment/watch-parties', auth, (req,res) => {
    const d=load(), id=String(req.user.id);
    const items=d.entertainmentWatchParties.filter(p=>p.status==='active'&&(p.visibility==='public'||String(p.hostId)===id||member(p,id)))
      .slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,30).map(p=>publicParty(d,p,id,true));
    res.json({watchParties:items});
  });
  app.post('/api/entertainment/watch-parties', auth, (req,res) => {
    const d=load(), title=clean(req.body?.title,100), description=clean(req.body?.description,400), mediaUrl=cleanUrl(req.body?.mediaUrl), visibility=req.body?.visibility==='private'?'private':'public';
    if(title.length<3 || !mediaUrl) return res.status(400).json({error:'Enter a title and a valid HTTP(S) direct media URL.'});
    const inviteCode=visibility==='private'?crypto.randomBytes(5).toString('hex').toUpperCase():'';
    const p={id:uid(),hostId:String(req.user.id),title,description,mediaUrl,visibility,status:'active',inviteCodeHash:inviteCode?hashInvite(inviteCode):'',participantIds:[String(req.user.id)],messages:[],playback:{currentTime:0,playing:false,updatedAt:now()},createdAt:now(),updatedAt:now()};
    d.entertainmentWatchParties.push(p);
    const award=awardXP(d,req.user.id,5,'watch-party','watch-party-created',`Watch party created: ${title}`,'Created a watch party on ZenithMax.',`${p.id}:created:${req.user.id}`);
    save(d);res.status(201).json({watchParty:publicParty(d,p,req.user.id),inviteCode:inviteCode||null,xpAwarded:award.awarded});
  });
  app.post('/api/entertainment/watch-parties/:id/join', auth, (req,res) => {
    const d=load(), p=d.entertainmentWatchParties.find(x=>x.id===req.params.id&&x.status==='active');
    if(!p) return res.status(404).json({error:'Watch party not found or ended.'});
    if(p.visibility==='private' && !member(p,req.user.id) && hashInvite(req.body?.inviteCode)!==p.inviteCodeHash) return res.status(403).json({error:'That private-party invitation code is incorrect.'});
    const id=String(req.user.id), fresh=!member(p,id);if(fresh)p.participantIds.push(id);
    const award=fresh?awardXP(d,id,3,'watch-party','watch-party-joined',`Joined watch party: ${p.title}`,'Joined a shared viewing session.',`${p.id}:joined:${id}`):{awarded:0,duplicate:true};
    save(d);res.json({watchParty:publicParty(d,p,id),xpAwarded:award.awarded});
  });
  app.get('/api/entertainment/watch-parties/:id', auth, (req,res) => {
    const d=load(), p=d.entertainmentWatchParties.find(x=>x.id===req.params.id);
    if(!p) return res.status(404).json({error:'Watch party not found.'});
    if(p.visibility==='private'&&!member(p,req.user.id)) return res.status(403).json({error:'Join this private party using its invitation code first.'});
    res.json({watchParty:publicParty(d,p,req.user.id)});
  });
  app.post('/api/entertainment/watch-parties/:id/messages', auth, (req,res) => {
    const d=load(), p=d.entertainmentWatchParties.find(x=>x.id===req.params.id&&x.status==='active');
    if(!p) return res.status(404).json({error:'Watch party is no longer active.'});
    if(!member(p,req.user.id)) return res.status(403).json({error:'Join this party before chatting.'});
    const text=clean(req.body?.text,300);if(!text) return res.status(400).json({error:'Message cannot be empty.'});
    const m={id:uid(),userId:String(req.user.id),text,createdAt:now()};p.messages.push(m);if(p.messages.length>200)p.messages=p.messages.slice(-200);p.updatedAt=now();
    save(d);res.status(201).json({message:{...m,username:userName(d,m.userId)}});
  });
  app.patch('/api/entertainment/watch-parties/:id/playback', auth, (req,res) => {
    const d=load(), p=d.entertainmentWatchParties.find(x=>x.id===req.params.id&&x.status==='active');
    if(!p) return res.status(404).json({error:'Watch party is no longer active.'});
    if(String(p.hostId)!==String(req.user.id)) return res.status(403).json({error:'Only the host can synchronize playback.'});
    p.playback={currentTime:Math.max(0,Math.min(86400,Number(req.body?.currentTime)||0)),playing:!!req.body?.playing,updatedAt:now()};p.updatedAt=now();save(d);res.json({ok:true,playback:p.playback});
  });
  app.post('/api/entertainment/watch-parties/:id/end', auth, (req,res) => {
    const d=load(),p=d.entertainmentWatchParties.find(x=>x.id===req.params.id);
    if(!p)return res.status(404).json({error:'Watch party not found.'});
    if(String(p.hostId)!==String(req.user.id))return res.status(403).json({error:'Only the host can end this watch party.'});
    p.status='ended';p.endedAt=now();save(d);res.json({ok:true});
  });

  // Creator Battles and scheduled community tournaments.
  app.get('/api/entertainment/contests', auth, (req,res) => {
    const d=load(), id=String(req.user.id);
    const items=d.entertainmentContests.filter(c=>contestState(c)!=='cancelled').slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,40).map(c=>publicContest(d,c,id));
    save(d);res.json({contests:items});
  });
  app.post('/api/entertainment/contests', auth, (req,res) => {
    const d=load(), kind=clean(req.body?.kind,30), title=clean(req.body?.title,100), description=clean(req.body?.description,400), maxEntries=Math.max(2,Math.min(32,Number(req.body?.maxEntries)||16));
    if(!['creator-battle','tournament'].includes(kind)||title.length<3)return res.status(400).json({error:'Choose Creator Battle or Tournament and provide a title of at least 3 characters.'});
    let startsAt='',endsAt='';
    if(kind==='tournament'){
      if(req.body?.startsAt){const start=new Date(req.body?.startsAt);if(Number.isNaN(start.getTime()))return res.status(400).json({error:'Invalid tournament start date.'});startsAt=start.toISOString();}
      if(req.body?.endsAt){const end=new Date(req.body?.endsAt);if(Number.isNaN(end.getTime())||(startsAt&&end.getTime()<=new Date(startsAt).getTime()))return res.status(400).json({error:'Tournament end must be after the start.'});endsAt=end.toISOString();}
      if(!startsAt) startsAt=now();
    }
    const c={id:uid(),kind,title,description,creatorId:String(req.user.id),status:'live',startsAt,endsAt,maxEntries,entries:[],votes:[],createdAt:now()};
    d.entertainmentContests.push(c);
    const award=awardXP(d,req.user.id,5,kind,'contest-created',`${kind==='tournament'?'Tournament':'Creator battle'} created: ${title}`,'Created a community competition.',`${c.id}:created:${req.user.id}`);
    save(d);res.status(201).json({contest:publicContest(d,c,req.user.id),xpAwarded:award.awarded});
  });
  app.post('/api/entertainment/contests/:id/entries', auth, (req,res) => {
    const d=load(), c=d.entertainmentContests.find(x=>x.id===req.params.id);
    if(!c)return res.status(404).json({error:'Competition not found.'});
    const state=contestState(c);if(!['live','scheduled'].includes(state))return res.status(409).json({error:'Entries are closed.'});
    const id=String(req.user.id);if((c.entries||[]).some(e=>String(e.userId)===id))return res.status(409).json({error:'You already entered this competition.'});
    if((c.entries||[]).length>=c.maxEntries)return res.status(409).json({error:'This competition has reached its entry limit.'});
    const caption=clean(req.body?.caption,400), mediaUrl=cleanUrl(req.body?.mediaUrl);
    if(!caption&&!mediaUrl)return res.status(400).json({error:'Add a caption or an HTTP(S) media link.'});
    if(req.body?.mediaUrl&&!mediaUrl)return res.status(400).json({error:'Media links must use HTTP or HTTPS.'});
    const e={id:uid(),userId:id,caption,mediaUrl,submittedAt:now()};c.entries.push(e);
    const award=awardXP(d,id,10,c.kind,'contest-entry',`Entered: ${c.title}`,'Submitted a competition entry.',`${c.id}:entry:${id}`);
    if(notify)notify(d,c.creatorId,'competition',`${userName(d,id)} entered ${c.title}`,'entertainment',id);
    save(d);res.status(201).json({entry:e,xpAwarded:award.awarded});
  });
  app.post('/api/entertainment/contests/:id/votes', auth, (req,res) => {
    const d=load(), c=d.entertainmentContests.find(x=>x.id===req.params.id), id=String(req.user.id), entryId=clean(req.body?.entryId,120);
    if(!c)return res.status(404).json({error:'Competition not found.'});
    if(contestState(c)!=='live')return res.status(409).json({error:'Voting is only open while the competition is live.'});
    const entry=(c.entries||[]).find(e=>e.id===entryId);if(!entry)return res.status(404).json({error:'Entry not found.'});
    if(String(entry.userId)===id)return res.status(400).json({error:'You cannot vote for your own entry.'});
    if((c.votes||[]).some(v=>String(v.userId)===id))return res.status(409).json({error:'You have already voted in this competition.'});
    c.votes.push({id:uid(),userId:id,entryId,votedAt:now()});
    const award=awardXP(d,id,2,c.kind,'contest-vote',`Voted in: ${c.title}`,'Supported another member in a competition.',`${c.id}:vote:${id}`);
    save(d);res.json({ok:true,xpAwarded:award.awarded});
  });
};
