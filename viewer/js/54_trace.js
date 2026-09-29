// 54_trace.js — the Trace place: one target, asked about either way (RM67-U2b).
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.
//
// WHAT CHANGED. Explore, Flow and Impact were three tabs over one question:
// pick a thing, then read what it uses (Flow), where it is used (Impact), or
// what it is (Explore). A reader had to know which tab held which half before
// asking, and each tab kept its own pick, so a switch lost the target. Now the
// target is picked once and the direction is a switch.
//
// THE RULES THIS FILE KEEPS, each said where it is kept:
//   1. A target offers only the directions it has (TRACE_DIRS, mirroring the
//      tool's FLOW_DIRECTIONS). One it does not have is absent from the switch,
//      and the line over the answer says why (TRACE_NODIR).
//   2. The START of the question (TRACE.target) is not the row clicked in the
//      picture (TRACEV.sel). A click shows that row's card; "Trace from here"
//      is what moves the start. Switching direction keeps the start.
//   3. Depth (the most links a walk follows), mode (which grades it follows)
//      and paging (how many rows a lane shows) are three settings with three
//      names. A depth the reader chose survives a direction switch and a new
//      target; only the automatic default adapts to the target.
//   4. A remembered answer is keyed by everything that shaped it: project,
//      target kind and id, direction, mode, depth and rows per lane (traceKey).
//      The old key was `tab|id`, which handed back an answer asked in another
//      mode or depth as if it were this one.
//   5. The URL carries the whole question (`dir`, `mode`, `depth`), so a shared
//      link reproduces it, and every link written before Trace (tab=explore,
//      flow, impact) lands on the same target and source pane.

// ---- 1. which directions a target has ----------------------------------------
// MIRRORS src/mcp/tools.mjs FLOW_DIRECTIONS: `down` and `up` are the walks the
// tool answers for that kind, and test/viewer_trace.test.mjs holds the two
// equal. `detail` is every kind's: what the thing is, read as lists.
const TRACE_DIRS = {
  endpoint:  ['down', 'up', 'detail'],
  screen:    ['down', 'detail'],
  symbol:    ['down', 'up', 'detail'],
  statement: ['up', 'detail'],
  table:     ['up', 'detail'],
  column:    ['up', 'detail'],
};
// Why a direction is absent, in the reader's words, key by key (a key built at
// run time is one the catalogue tests cannot see).
const TRACE_NODIR = {
  screen: { up:'trace.nodir.screen.up' },
  statement: { down:'trace.nodir.statement.down' },
  table: { down:'trace.nodir.table.down' },
  column: { down:'trace.nodir.column.down' },
};
// The direction a target opens on when the one on screen is not one it has: a
// change question on the schema's side, a reach question on the code's.
const TRACE_DIR_DEFAULT = { endpoint:'down', screen:'down', symbol:'down', statement:'up', table:'up', column:'up' };
const TRACE_DIR_KEY = { down:'trace.dir.down', up:'trace.dir.up', detail:'trace.dir.detail' };
// What the list says before a pick, when the place is already reading one way
// (a question asked from Start with no target, RM67-U2c).
const TRACE_LEAD = { up:'rail.lead.trace.up', down:'rail.lead.trace.down' };
const TRACE_DIR_TITLE = { down:'trace.dir.down.title', up:'trace.dir.up.title', detail:'trace.dir.detail.title' };
// Every link written before Trace names the tab it was on. Each lands here,
// read the way that tab read its pick.
const TRACE_OLD_TABS = { explore:'detail', flow:'down', impact:'up' };
// The glyph a target is drawn with: a frontend function is a symbol too.
const TRACE_GLYPH = { endpoint:'endpoint', screen:'screen', symbol:'symbol', statement:'statement', table:'table', column:'column' };

const traceHas = (kind, dir) => !!(TRACE_DIRS[kind] && TRACE_DIRS[kind].includes(dir));
/** The direction a target is read in: the one asked for when it has it, else its own default. */
function traceDirFor(kind, want){
  return traceHas(kind, want) ? want : (TRACE_DIR_DEFAULT[kind] || 'detail');
}
/**
 * The AUTOMATIC depth for a target. One default for every kind since RM67
 * (the engine's DEFAULT_WALK_DEPTH, which a screen needs to reach a table);
 * it is a function of the kind so a kind that needs another has one place to
 * say so. A depth the reader chose is never replaced by it (TRACE.depthSet).
 */
function traceAutoDepth(kind){
  void kind;
  return WALK_DEPTH_DEFAULT;
}

// ---- 4. the cache key ----------------------------------------------------------
/** Everything that shaped one answer on this place, read off the controls. */
function traceNow(){
  const tg = TRACE.target || { kind:'', id:'' };
  return { project:STATE.project || '', kind:tg.kind, id:tg.id, dir:TRACE.dir,
    mode:byId('tmode').value, depth:depthArg('tdepth'), limit:TRACEV.limit };
}
/** One string per question: project, target, direction, mode, depth, rows per lane. */
function traceKey(q){
  return [q.project, q.kind + ':' + q.id, q.dir, q.mode, q.depth, q.limit].join('|');
}

// ---- 2. the start of the question ----------------------------------------------
/**
 * ASK THE TRACE PLACE ONE QUESTION: this target, this way. Every hand-off on
 * the page comes through here (a rail row, Start, a Graph card, a
 * transaction, a row's "Trace from here"), so the kind is always SAID, never
 * guessed back out of a name.
 * @param {{kind:string, id:string}} target
 * @param {'down'|'up'|'detail'} [dir]  kept when the target has it, else its default
 */
function openTrace(target, dir){
  if(STATE.tab !== 'trace') activateTab('trace');
  traceSetTarget(target, dir || TRACE.dir);
  traceAsk();
}
/**
 * THE WAY INTO TRACE FROM ANOTHER TAB: a button named by the direction it asks
 * ("What it uses", "Where it is used"), offered only for a direction the kind
 * has. The Graph cards, Start, the ERD, Coupling, Compare and the Rules
 * all hand off through here, so every one of them says it the same way.
 * @returns {HTMLElement|null} null when this kind has no such direction
 */
function traceButton(kind, id, dir){
  if(!traceHas(kind, dir)) return null;
  return el('button', { className:'mini', textContent:t(TRACE_DIR_KEY[dir]), title:t(TRACE_DIR_TITLE[dir]),
    onclick:()=> openTrace({ kind, id }, dir) });
}
/** Move the START. A new target forgets the old picture's selection and paging. */
function traceSetTarget(target, dir){
  const was = TRACE.target;
  TRACE.edits = false;
  if(!target){ TRACE.target = null; return; }
  TRACE.target = { kind:String(target.kind), id:String(target.id) };
  TRACE.dir = traceDirFor(TRACE.target.kind, dir);
  if(!TRACE.depthSet) byId('tdepth').value = depthOption(traceAutoDepth(TRACE.target.kind));
  byId('tentry').value = TRACE.target.id;
  TRACEV.pick = { kind:TRACE.target.kind, value:TRACE.target.id };
  if(!was || was.kind !== TRACE.target.kind || was.id !== TRACE.target.id){ TRACEV.limit = 40; TRACEV.sel = null; }
  // The list follows the target's kind, so the row it came from is on screen
  // and marked. Methods are the exception: that list needs two letters typed
  // before it holds anything, and a target is not a filter.
  const R = RAIL.trace;
  if(!SNAP && R.kind !== TRACE.target.kind && TRACE.target.kind !== 'symbol' && RAILDEF.trace.kinds.includes(TRACE.target.kind)) railSetKind('trace', TRACE.target.kind);
  railSyncPick('trace', TRACE.target.kind, TRACE.target.id);
  closeSug(TRACEV);
}
/** Draw the question on the controls: the picture, or the details. */
function traceAsk(){
  renderTraceChrome();
  if(TRACE.dir === 'detail') return traceDetail();
  return drawChain(TRACEV);
}
/** Read the same target the other way. The start does not move. */
function traceSetDir(dir){
  if(!TRACE.target || !traceHas(TRACE.target.kind, dir) || dir === TRACE.dir) return;
  TRACE.dir = dir;
  TRACEV.sel = null;
  traceAsk();
}
/**
 * "TRACE FROM HERE": a row of the picture becomes the start, read the same way
 * when it can be, else its own way. A row from another project is that
 * project's question and is never offered this.
 */
function traceFrom(key){
  const id = keyNodeId(key), at = id.indexOf(':');
  const kind = id.slice(0, at);
  if(!TRACE_DIRS[kind]) return;
  openTrace({ kind, id:id.slice(at + 1) }, TRACE.dir);
}
/** Whether a picture row can become a start: a kind this place asks about, in this project. */
function traceCanStart(key, data){
  if(data && data.project && data.project !== STATE.project) return false;
  const id = keyNodeId(key);
  return !!TRACE_DIRS[id.slice(0, id.indexOf(':'))] && !(TRACE.target && id === TRACE.target.kind + ':' + TRACE.target.id);
}
/**
 * Record the question in the URL, once its answer is on screen. A new target or
 * direction is a step the Back button undoes one at a time (a pushed entry); a
 * new mode or depth for the same one replaces the entry, as a tab switch does.
 */
function traceWritePick(){
  const id = TRACE.target ? TRACE.target.kind + ':' + TRACE.target.id : null;
  PICK.trace = id;
  const h = traceReadHash(readHash());
  writeHash(h.tab !== 'trace' || h.pick !== id || (!!id && h.dir !== TRACE.dir));
  refreshShowAll();
}

// ---- the switch, and the line over the answer ------------------------------------
function renderTraceChrome(){
  renderTraceDir();
  renderTraceHead();
  tracePane(TRACE.dir === 'detail' || TRACE.edits ? 'detail' : 'chain');
}
/** The direction switch: only what this target has, the one on screen pressed. */
function renderTraceDir(){
  const box = byId('tdir');
  const tg = TRACE.target;
  if(!tg || TRACE.edits){ box.replaceChildren(); return; }
  box.replaceChildren(...TRACE_DIRS[tg.kind].map((dir)=> el('button', {
    type:'button', className: dir === TRACE.dir ? 'on' : '', title:t(TRACE_DIR_TITLE[dir]),
    textContent:t(TRACE_DIR_KEY[dir]), onclick:()=> traceSetDir(dir) })));
  for(const b of box.children) b.setAttribute('aria-pressed', String(b.classList.contains('on')));
}
/**
 * What is being asked, and ANSWERED, over the picture (RM67-U2e): the question
 * on one line, then the answer in one sentence and the ends it reaches
 * (58_answer.js), then why a direction is absent. Until the answer is in, the
 * line says the mode and depth it is being asked in.
 */
function renderTraceHead(){
  const head = byId('tracehead');
  const tg = TRACE.target;
  if(!tg || TRACE.edits){ head.classList.add('hidden'); head.replaceChildren(); return; }
  head.classList.remove('hidden');
  const answer = TRACE.dir !== 'detail' ? traceAnswerLine(TRACEV) : null;
  const nodir = Object.entries(TRACE_NODIR[tg.kind] || {}).map(([, key])=> el('div', { className:'tnodir', textContent:t(key) }));
  setKids(head, traceQuestionLine(tg, !answer && TRACE.dir !== 'detail'), answer, answer ? traceEndsBlock(TRACEV) : null, ...nodir);
}
/** The question: the target, the way it is read, and until the answer says them, the mode and depth asked. */
function traceQuestionLine(tg, asking){
  return el('div', { className:'tquestionrow' }, [
    el('span', { className:'tquestion' }, [ kindGlyph(TRACE_GLYPH[tg.kind], 12), ' ', t(TRACE_DIR_KEY[TRACE.dir]) + ': ',
      el('code', { className:'id', textContent:tg.id }) ]),
    asking ? el('span', { textContent:t('trace.q.mode', { mode:byId('tmode').value }) }) : null,
    asking ? el('span', { title:t('trace.depth.title'), textContent:t('trace.q.depth', { n:depthText(byId('tdepth').value) }) }) : null ]);
}
/** Which half of the pane is on: the chain picture, or the details lists. */
function tracePane(which){
  const pane = byId('tracecanvas').parentNode;
  const detail = which === 'detail';
  pane.classList.toggle('detailmode', detail);
  view.classList.toggle('hidden', !detail);
  if(detail){ byId('tracestrip').classList.add('hidden'); vside(TRACEV).replaceChildren(); }
}

// ---- 5. the URL ------------------------------------------------------------------
/** The hash parts only Trace writes: which way, which grades, how deep. */
function traceHashParts(){
  if(!TRACE.target) return {};
  return { dir:TRACE.dir, mode:byId('tmode').value, depth:byId('tdepth').value };
}
/**
 * A hash in either form, read as a Trace question when it is one: `tab=trace`,
 * or a link written before Trace named explore, flow or impact (TRACE_OLD_TABS).
 * Anything else comes back as it was.
 */
function traceReadHash(h){
  if(!h || !Object.hasOwn(TRACE_OLD_TABS, h.tab)) return h;
  return { ...h, tab:'trace', dir:h.dir || TRACE_OLD_TABS[h.tab] };
}
/**
 * Put the place on the question a URL asks: mode and depth first (they are
 * part of the answer's key), then the target and the direction. An answer
 * still in memory under that WHOLE key is drawn from memory; any other is
 * asked for.
 */
function traceRestore(h){
  if(h.mode && Object.hasOwn(MODE_ADMITS, h.mode)) byId('tmode').value = h.mode;
  const at = h.pick ? h.pick.indexOf(':') : -1;
  const kind = at > 0 ? h.pick.slice(0, at) : null;
  const depth = Number(h.depth);
  if(Number.isInteger(depth) && depth >= 1 && depth <= 8){
    byId('tdepth').value = String(depth);
    TRACE.depthSet = !!kind;
  }
  if(!kind || !TRACE_DIRS[kind]){ if(TRACE.target || TRACE.edits) showAll('trace', true); return; }
  const target = { kind, id:h.pick.slice(at + 1) };
  const same = TRACE.target && TRACE.target.kind === kind && TRACE.target.id === target.id
    && TRACE.dir === traceDirFor(kind, h.dir) && TRACEV.lastKey === traceKey({ ...traceNow(), kind, id:target.id, dir:traceDirFor(kind, h.dir) });
  if(same) return;
  traceSetTarget(target, h.dir || TRACE_DIR_DEFAULT[kind]);
  traceAsk();
}

// ---- the limits that change THIS answer, beside it --------------------------------
/**
 * WHAT CUT THIS ANSWER, in one panel beside it: how many rows sat at the depth
 * cap (with the depth that would follow them), the node cap, the generated
 * interior, rows named past the cap, and every lane shown in part. The mode
 * floor has its own panel (chainLeftOut). Each count is the answer's own; the
 * sentences are the page's, and the engine's own note stays in the rail. The
 * count is IN the sentence, bold (RM67-U2e), so no language starts one with a
 * bare counter word the way a number column made the Korean line read.
 */
function traceLimitsPanel(v, r){
  const a = r.answer, w = a.walk || {}, cut = w.cut || {};
  const rows = [];
  const line = (text, btn)=> rows.push(el('div', { className:'tlim' }, [ el('span', {}, richNodes(text)), btn || null ]));
  traceLimitsDepth(w, line);
  if(cut.nodeCap) line(t('trace.lim.nodecap'));
  if(cut.generated > 0) line(t('trace.lim.generated', { n:ovNum(cut.generated) }));
  const beyond = (w.beyond || {})[w.endLane];
  if(beyond > 0) line(t('trace.lim.beyond', { n:ovNum(beyond), lane:laneTitle(w.endLane) }));
  for(const f of (r.truncated && r.truncated.fields) || []){
    if(f.shown < f.total) line(t('trace.lim.page', { n:ovNum(f.total - f.shown), lane:laneTitle(f.field), shown:f.shown, total:f.total }));
  }
  if(a.empty && a.empty.screens === 'not-shipped') line(t('trace.lim.noscreens'));
  return el('div', { className:'panel tlimits' }, [ el('h2', { textContent:t('trace.lim.title') }),
    rows.length ? el('div', {}, rows) : el('div', { className:'comment', textContent:t('trace.lim.none') }) ]);
}
/**
 * A walk the reader narrowed stopped at that depth. Every walk's own rule is no
 * cap, so the way on is to lift it; walked up, Details also lists every screen
 * a change is felt on, with no cap. (It used to say this was the deepest a walk
 * goes, beside the button that goes deeper.)
 */
function traceLimitsDepth(w, line){
  const cut = w.cut || {};
  if(!(cut.depth > 0)) return;
  line(t('trace.lim.depth', { n:ovNum(cut.depth), depth:depthText(w.depth) }), traceDeeperButton(w));
  if(w.depth != null && w.direction === 'up' && TRACE.target && TRACE_SCREENS_OF.includes(TRACE.target.kind)) {
    line(t('trace.lim.todetail', { depth:w.depth }), el('button', { className:'mini', textContent:t('trace.dir.detail'), title:t('trace.dir.detail.title'),
      onclick:()=> traceSetDir('detail') }));
  }
}
/** The button that lifts the depth a cut walk was narrowed to: every walk's own rule is no cap. */
function traceDeeperButton(w){
  if(w.depth == null) return null;
  return el('button', { className:'mini', textContent:t('trace.lim.deeper'), title:t('trace.depth.title'),
    onclick:()=>{ byId('tdepth').value = depthOption(WALK_DEPTH_DEFAULT); TRACE.depthSet = false; traceAsk(); } });
}
/** A lane's name, in the reader's words, from the one table the lanes are drawn by. */
function laneTitle(field){
  for(const spec of Object.values(CHAIN_LANES)){
    const hit = spec.lanes.find(([f])=> f === field);
    if(hit) return t(hit[1]);
  }
  return String(field || '');
}

// ---- the typeahead: every kind a question can start from ----------------------------
/**
 * What the box offers for `q`: the routes and screens (the flow tool's own list
 * modes), the tables, columns and statements (`search`) and the methods
 * (`browse`, which needs two letters). What was typed exactly comes first, then
 * the widest kind. null when there is nothing to offer yet.
 */
async function traceSuggestFetch(q){
  const s = String(q || '').trim();
  const hasScreens = !!(OV.resp && OV.resp.answer && OV.resp.answer.screens);
  const none = ()=> [];
  const [eps, scr, found, syms] = await Promise.all([
    api('flow', s ? { query:s, limit:12 } : { limit:8 }).then((r)=> r.answer.entries || [], none),
    hasScreens ? api('flow', s ? { kind:'screen', query:s, limit:8 } : { kind:'screen', limit:4 }).then((r)=> r.answer.entries || [], none) : Promise.resolve([]),
    s.length >= 2 ? api('search', { query:s, limit:12 }).then((r)=> r.answer, ()=> ({})) : Promise.resolve({}),
    s.length >= 2 ? api('browse', { kind:'symbol', query:s, limit:8 }).then((r)=> r.answer.items || [], none) : Promise.resolve([]),
  ]);
  const items = [
    ...(found.tables || []).map((x)=> ({ value:x.table, kind:'table', sub:x.comment || '' })),
    ...(found.columns || []).map((x)=> ({ value:x.column, kind:'column', sub:x.comment || '' })),
    ...eps.map((e)=> ({ value:e.id, kind:'endpoint', sub:e.handlerShort || '' })),
    ...scr.map((x)=> ({ value:x.screen, kind:'screen', sub:x.title || x.component || '' })),
    ...(found.statements || []).map((x)=> ({ value:x.statement, kind:'statement', sub:'' })),
    ...syms.map((x)=> ({ value:x.symbol, kind:'symbol', sub:x.short || '' })),
  ];
  const RANK = { table:0, column:1, endpoint:2, screen:3, statement:4, symbol:5 };
  const exact = (x)=> x.value.toLowerCase() === s.toLowerCase() ? 0 : 1;
  items.sort((x, y)=> (exact(x) - exact(y)) || (RANK[x.kind] - RANK[y.kind]));
  return items;
}
/**
 * The box committed (Enter, the Trace button, a row of the dropdown): the text
 * becomes a target of a SAID kind. A row picked from the dropdown or the rail
 * says its kind; a typed id is read by its shape, and a bare name is looked up
 * so a table is never taken for a column. The engine names what it cannot find.
 */
async function traceCommitDraw(v){
  const raw = byId(v.entryId).value.trim();
  if(!raw){ showAll('trace'); return; }
  openTrace(traceShapeOf(v, raw) || await traceLookup(raw), TRACE.dir);
}
/** The kind a committed text SAYS: the dropdown's own row, a method's `#`, a route's verb, a screen's slash. */
function traceShapeOf(v, raw){
  if(v.pick && v.pick.value === raw) return { kind:v.pick.kind, id:raw };
  if(raw.includes('#')) return { kind:'symbol', id:raw };
  if(/^[A-Z]+ \//.test(raw)) return { kind:'endpoint', id:raw };
  if(raw.startsWith('/')) return { kind:'screen', id:raw };
  return null;
}
async function traceLookup(raw){
  try{
    const s = (await api('search', { query:raw, limit:100 })).answer;
    if((s.tables || []).some((x)=> x.table === raw)) return { kind:'table', id:raw };
    if((s.columns || []).some((x)=> x.column === raw)) return { kind:'column', id:raw };
    if((s.statements || []).some((x)=> x.statement === raw)) return { kind:'statement', id:raw };
  }catch(e){ /* the shape rule below; the engine then names what it cannot find */ }
  return { kind: raw.split('.').length >= 2 ? 'column' : 'table', id:raw };
}
TRACEV.draw = traceCommitDraw;

// ---- "My edits": the one question that has no target -------------------------------
/** What the working tree's changes would affect, in the details half of the place. */
function traceShowEdits(){
  if(STATE.tab !== 'trace') activateTab('trace');
  TRACE.target = null; TRACE.edits = true; PICK.trace = null;
  TRACEV.seq++; TRACEV.resp = null; TRACEV.args = null;
  renderTraceChrome();
  refreshExportButtons();
  showEdits();
  writeHash(true);
}

// ---- a project switch, a tab coming on screen, a saved file -----------------------------
/**
 * The Trace question and its picture belong to the pack being left. A chosen
 * depth and mode stay, because they are the reader's settings, not the pack's.
 */
function traceResetProject(){
  const v = TRACEV;
  v.seq++; v.resp = null; v.args = null; v.sel = null; v.pick = null; v.limit = 40; v.lastKey = null;
  v.rows.clear(); v.linkSpecs = []; v.paths = []; v.layerOpen.clear(); laneReset(v);
  const w = vwrap(v); w.classList.remove('layersmode'); w.replaceChildren();
  vside(v).replaceChildren();
  closeSug(v);
  TRACE.target = null; TRACE.edits = false; view.replaceChildren();
  renderTraceChrome();
}
/**
 * The place coming on screen: draw what it holds, or its lead. A picture drawn
 * while the tab was hidden had no layout, so no line could be measured; now it
 * can be.
 */
function traceOnScreen(){
  const v = TRACEV;
  if(!vwrap(v).hasChildNodes() && !view.hasChildNodes()) drawChain(v);
  else if(v.resp && v.view === 'lanes' && TRACE.dir !== 'detail') requestAnimationFrame(()=> drawChainLinks(v));
}
/**
 * A SAVED FILE'S ONE QUESTION, set on the controls the live page asks with: a
 * Flow file is its target walked down, an Impact file its target walked up.
 * The controls that would ask another question are switched off.
 */
function traceFromSnapshot(snap){
  const v = TRACEV;
  byId(v.modeId).value = snap.args.mode;
  byId(v.depthId).value = depthOption(snap.args.depth);
  TRACE.depthSet = true;
  TRACE.target = { kind:snap.entry.kind, id:snap.entry.value };
  TRACE.dir = snap.tab === 'impact' ? 'up' : 'down';
  byId(v.entryId).value = snap.entry.value;
  v.pick = { kind:snap.entry.kind, value:snap.entry.value };
  v.limit = snap.args.limit;
  for(const id of [v.entryId, v.modeId, v.depthId]) byId(id).disabled = true;
  renderTraceChrome();
}

// ---- wiring --------------------------------------------------------------------------
/** The controls only this place has: the mode and depth re-ask; a chosen depth is kept. */
function traceWire(){
  byId('tmode').onchange = ()=>{ if(TRACE.target) traceAsk(); };
  byId('tdepth').onchange = ()=>{ TRACE.depthSet = true; if(TRACE.target) traceAsk(); };
  byId('tedits').onclick = ()=> traceShowEdits();
}
