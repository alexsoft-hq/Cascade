// 56_start.js — the Start place: ask about one thing, what this analysis can see, and the way in (RM67-U2c).
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.
//
// WHAT A READER COMES WITH. Three questions, in the words a reader asks them:
// what breaks if I change this, how far does it reach, and what did the
// analysis not see. The first two are Trace walked up and walked down, the
// third is Analysis status. So Start is a box that finds any target and those
// three questions under it. A target is picked first and then asked about,
// because the same table can be asked either way and the kind decides which
// ways it has: a question this kind has no answer to stays on the page and
// says why in one sentence (TRACE_NODIR), rather than going grey. With no
// target, a question opens Trace's list on the kind it starts from.
//
// Under the questions: what this analysis can see (the lanes that read it, the
// mode the census was walked in, every axis with where it was read from), the
// gaps that change an answer, the shares, the summary map, and the busiest
// tables, routes and screens as places to start. Every number is the one
// `overview` answer's; the map is the `summary` tool's (50_summary.js).

// `mode` is the mode the map, the shares and every ranking look in when the
// reader moved the map's control off the landing answer's (null: that one),
// `byMode` the overview answers asked for it (RM67-U2e), and `screens` the
// screens rankings asked for it (RM67-U2i; null while one is on its way). The
// landing mode's screens ranking is OV.screens.
const START = { target:null, mode:null, byMode:new Map(), screens:new Map(), seq:0 };
// The typeahead's own state, shaped like a chain view's so the one typeahead
// (42_flow.js chainSuggest, chainCommit) serves this box too.
const STARTV = { name:'start', direction:'start', entryId:'sentry', sugId:'ssug',
  sugSeq:0, sugTimer:null, sugItems:[], sugRows:[], sugCur:-1, sugMoved:false, sugLast:null, pick:null };
// The three questions. `up` and `down` are Trace's walks; `status` is a place.
const START_QUESTIONS = [
  { id:'up', key:'start.q.up', sub:'start.q.up.sub', none:'start.q.up.none' },
  { id:'down', key:'start.q.down', sub:'start.q.down.sub', none:'start.q.down.none' },
  { id:'status', key:'start.q.status' },
];
// With no target, a question opens Trace's list on the kind a reader most often
// starts it from: a change question on the schema's side, a reach question on a route.
const START_LIST_KIND = { up:'table', down:'endpoint' };
// How many of the gaps that change an answer Start lists before "and N more".
const START_GAPS = 6;

/** The box, the questions, and `/` to find a target from anywhere on Start. */
function startWire(){
  const input=byId('sentry');
  if(!input) return;
  input.addEventListener('keydown', (e)=>{
    const open=!byId('ssug').classList.contains('hidden');
    if(e.key==='ArrowDown' || e.key==='ArrowUp'){ if(open){ e.preventDefault(); chainSugMove(STARTV, e.key==='ArrowDown' ? 1 : -1); } return; }
    if(e.key==='Enter') chainCommit(STARTV);
  });
  input.addEventListener('input', ()=>{ STARTV.pick=null; clearTimeout(STARTV.sugTimer);
    STARTV.sugTimer=setTimeout(()=> chainSuggest(STARTV, input.value.trim()), 150); });
  input.addEventListener('focus', ()=>{ if(!input.value.trim()) chainSuggest(STARTV, ''); });
  document.addEventListener('click', (ev)=>{ if(!(ev.target.closest && ev.target.closest('#ssug')) && ev.target.id!=='sentry') closeSug(STARTV); });
  document.addEventListener('keydown', (e)=>{
    if(STATE.tab!=='start' || e.key!=='/') return;
    const tag=e.target && e.target.tagName;
    if(tag==='INPUT' || tag==='TEXTAREA' || tag==='SELECT') return;
    if(e.preventDefault) e.preventDefault();
    if(input.focus) input.focus();
  });
  renderStartAsk();
}
/** The box committed: the text becomes a target of a said kind, as it does on Trace. */
async function startCommitDraw(v){
  const raw=byId(v.entryId).value.trim();
  startSetTarget(raw ? (traceShapeOf(v, raw) || await traceLookup(raw)) : null);
}
STARTV.draw = startCommitDraw;
function startSetTarget(target){
  START.target = target ? { kind:String(target.kind), id:String(target.id) } : null;
  renderStartAsk();
}
/**
 * One question asked. With a target, Trace answers it about that target. With
 * none, Trace opens its list on the kind the question starts from, already
 * reading that way, and whatever the reader picks is answered.
 */
function startAsk(dir){
  if(START.target){ openTrace(START.target, dir); return; }
  if(TRACE.target || TRACE.edits) showAll('trace', true);
  TRACE.dir=dir;
  activateTab('trace');
  if(!SNAP) railSetKind('trace', START_LIST_KIND[dir]);
  railIdle('trace');
}

// ---- drawing it ------------------------------------------------------------------
/** The landing answer arrived (or the language changed): everything Start draws from it. */
function renderStart(r){
  const a=r.answer;
  renderStartAsk();
  renderStartScope(r);
  renderStartLead(a);
  renderStartGaps(a);
  renderStartNumbers();
  if(STATE.tab==='start') summaryOnScreen();
}
/** The answer the shares and the busiest lists are drawn from: the mode Start is looking in, once it is in. */
function startNumbersResp(){
  const r=OV.resp;
  if(!r) return null;
  return (START.mode && START.byMode.get(START.mode)) || r;
}
/** The shares and the busiest lists, under a line that says the mode and depth they were counted in. */
function renderStartNumbers(){
  const r=startNumbersResp();
  if(!r) return;
  const a=r.answer;
  setKids(byId('skpimode'), el('span',{textContent:t('start.kpi.mode',{ mode:a.mode, depth:depthText(a.depth) })}));
  byId('ovcards').replaceChildren(...ovKpis(a));
  const screens=START.mode ? (START.screens.get(START.mode) || null) : OV.screens;
  setKids(byId('shubs'), ovHubBars(r, a), ovHubEndpoints(r, a), ovHubScreens(a, screens));
}
/**
 * ONE MODE FOR WHAT START COUNTS (RM67-U2e). The map's control used to move the
 * map alone, and the shares and the busiest lists under it stayed in the mode
 * the page opened in: two numbers for one thing, side by side. Now the control
 * moves all of them, asking the overview once in that mode, and the screens
 * ranking once too, since `browse` counts in the mode it is asked in
 * (RM67-U2i). The gaps and Analysis status stay in the landing answer's mode,
 * and say it.
 */
async function startSetMode(mode){
  if(!OV.resp || !Object.hasOwn(MODE_ADMITS, mode)) return;
  START.mode=mode===OV.resp.answer.mode ? null : mode;
  summarySetMode(mode);
  renderStartLead(OV.resp.answer);
  startAskScreens(mode);
  if(!START.mode || START.byMode.has(mode)){ renderStartNumbers(); return; }
  const mine=++START.seq;
  let r;
  try{ r=await api('overview', { mode }); }
  catch(e){ if(!stale(e) && mine===START.seq) byId('ovcards').replaceChildren(errPanel(e)); return; }
  if(mine!==START.seq) return;
  START.byMode.set(mode, r);
  renderStartNumbers();
}
/**
 * The screens ranking in a mode other than the landing one: one `browse
 * kind=screen` answer, asked once per mode and drawn when it lands, if Start
 * still looks in that mode. A lookup that failed is forgotten, so the next
 * visit to that mode asks again.
 */
async function startAskScreens(mode){
  if(!START.mode || SNAP || !OV.resp.answer.screens || START.screens.has(mode)) return;
  const mine=STATE.seq, project=STATE.project;
  START.screens.set(mode, null);
  let b;
  try{ b=await api('browse', { kind:'screen', sort:'tables', limit:OV_HUB_TOP, mode }); }
  catch(e){ if(mine===STATE.seq && project===STATE.project) START.screens.delete(mode); return; }
  if(mine!==STATE.seq || project!==STATE.project || START.screens.get(mode)!==null) return;
  START.screens.set(mode, b);
  if(START.mode===mode) renderStartNumbers();
}
/** Start on screen: the map is asked for once the landing answer is in. */
function startOnScreen(){
  renderStartAsk();
  if(OV.resp) summaryOnScreen();
}
/** The project is being left: its target, its lists and its map with it. */
function startReset(){
  START.target=null; STARTV.pick=null;
  START.mode=null; START.byMode.clear(); START.screens.clear(); START.seq++;
  const input=byId('sentry'); if(input) input.value='';
  closeSug(STARTV);
  for(const id of ['slead','sscope','sgaps','skpimode','ovcards','shubs']) byId(id).replaceChildren();
  summaryReset();
  renderStartAsk();
}
/** The picked target, and the three questions, each saying what it will answer. */
function renderStartAsk(){
  const tg=START.target;
  setKids(byId('starget'), tg ? el('div',{className:'startpicked'},[
    el('span',{className:'raillbl',textContent:t('start.picked')}), kindGlyph(TRACE_GLYPH[tg.kind], 12),
    el('code',{className:'id',textContent:tg.id}), el('span',{className:'tag',textContent:tg.kind}),
    el('button',{type:'button', className:'mini', textContent:t('start.clear'),
      onclick:()=>{ byId('sentry').value=''; STARTV.pick=null; startSetTarget(null); }}) ]) : null);
  byId('sentries').replaceChildren(...START_QUESTIONS.map(startQuestion));
}
/** One question, as a card: what it asks and what it will answer here, or why it cannot. */
function startQuestion(q){
  const tg=START.target;
  if(q.id==='status') return startCard(q, startStatusSub(), ()=> activateTab('status'));
  if(tg && !traceHas(tg.kind, q.id)) return startCard(q, t(TRACE_NODIR[tg.kind][q.id]), null);
  return startCard(q, tg ? t(q.sub, { id:tg.id }) : t(q.none), ()=> startAsk(q.id));
}
function startCard(q, sub, go){
  const kids=[ el('span',{className:'sqtitle',textContent:t(q.key)}), el('span',{className:'sqsub',textContent:sub}) ];
  return go ? el('button',{type:'button', className:'startq', onclick:go}, kids)
    : el('div',{className:'startq off', role:'note'}, kids);
}
/** The third question's line: how many things it could not see, and how many change an answer. */
function startStatusSub(){
  if(!OV.resp) return t('start.q.status.sub');
  const items=statusItems(OV.resp.answer);
  return t('start.q.status.count', { n:items.length, k:items.filter(startChangesAnswers).length });
}

// ---- what this analysis can see ----------------------------------------------------
/**
 * THE SCOPE OF EVERY ANSWER ON THIS PAGE, before any of them is asked: which
 * lanes read the project, the mode and depth the census was walked in, and
 * each axis with its state and, where the pack says, the file it was read
 * from. An axis is a button to its row on Analysis status.
 */
function renderStartScope(r){
  const a=r.answer, lanes=(a.pack && a.pack.lanes) || [];
  setKids(byId('sscope'),
    el('h2',{textContent:t('start.scope.title')}),
    el('div',{className:'sfacts'},[
      startFact(t('start.scope.lanes'), lanes.length ? lanes.join(' + ') : '?'),
      startFact(t('start.scope.mode'), t('start.scope.mode.value',{ mode:a.mode, depth:depthText(a.depth), grades:(MODE_ADMITS[a.mode]||[]).join(', ') })) ]),
    el('div',{className:'saxes'}, statusAxesShown(a).map(([axis, key])=> startAxisChip(a, axis, key))));
}
function startFact(label, value){
  return el('div',{className:'sfact'},[ el('span',{className:'raillbl',textContent:label}), el('span',{textContent:value}) ]);
}
/** One axis: its name, whether it was read whole, and where from. */
function startAxisChip(a, axis, key){
  const st=ovAxisStatus(a, axis) || 'shipped', src=statusAxisSource(a, axis);
  return el('button',{type:'button', className:'saxis '+st, title:ovAxisReason(a, axis) || statusAxisNotes(a, axis),
    onclick:()=> ovGoToGaps('ov.axis.'+axis)}, [
    el('b',{textContent:t(key)}), ' ', el('span',{textContent:t(STATUS_AXIS_STATE[st] || STATUS_AXIS_STATE.shipped)}),
    src ? el('span',{className:'count',textContent:' '+t('start.axis.from',{ src })}) : null ]);
}

// ---- the gaps that change an answer -------------------------------------------------
/**
 * An input the run did not have, something it could not read, an axis read in
 * part, a lane's diagnostic: each of these changes what an answer says, where a
 * walk's own bound or a table nothing reaches does not. Those are listed here,
 * most first, each a way to its row on Analysis status, and each with the
 * engine's one thing to do about it under it (RM67-U2d), where the reader is.
 */
const startChangesAnswers=(it)=> it.cls==='input' || it.cls==='unresolved';
function renderStartGaps(a){
  const all=statusItems(a), mine=all.filter(startChangesAnswers);
  const guessed=startLeadHasRoutes(a) ? null : ovRoutesGuessed(a);
  const rows=mine.slice(0, START_GAPS).map((it)=> el('li',{},[
    el('button',{type:'button', className:'sgap warn', title:it.kind, onclick:()=> ovGoToGaps(it.key)},[
      el('span',{textContent:it.label}), it.count!=null ? el('span',{className:'ovnum',textContent:ovNum(it.count)}) : null ]),
    remedyLine(it.remedy) ]));
  setKids(byId('sgaps'),
    el('h2',{},[ t('start.gaps.title')+' ', el('span',{className:'count',textContent:'('+mine.length+')'})]),
    el('div',{className:'panelsub',textContent:t(mine.length ? 'start.gaps.lead' : 'start.gaps.none')}),
    guessed ? el('div',{className:'sgapguesswrap'},[ el('button',{type:'button', className:'sgap warn sgapguess', onclick:()=> ovGoToGaps('ov.gap.mode-floor')}, [guessed]),
      remedyLine(a.routeRemedy) ]) : null,
    rows.length ? el('ul',{className:'sgaps'}, rows) : null,
    mine.length>START_GAPS ? el('div',{className:'count',textContent:t('start.gaps.more',{ n:mine.length-START_GAPS })}) : null,
    el('button',{type:'button', className:'mini', style:'margin-top:8px', textContent:t('start.gaps.all',{ n:all.length }),
      onclick:()=> activateTab('status')}));
}
