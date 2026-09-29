// 30_chrome.js — the masthead, the tabs, the project, the language and the theme.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

async function loadCatalog(lang){
  if(lang==='en' || I18N.catalog[lang]) return;
  if(SNAP){ const c=SNAP.catalogs && SNAP.catalogs[lang]; if(c) I18N.catalog[lang]=c; return; }
  try{
    const r=await fetch('/i18n/'+encodeURIComponent(lang)+'.json');
    if(!r.ok) return;
    const j=await r.json();
    if(j && typeof j==='object' && !Array.isArray(j)) I18N.catalog[lang]=j;
  }catch(e){ /* no catalogue — the chrome stays English */ }
}
// Switching theme sets ONE attribute. Everything else follows from it: every
// CSS rule reads a custom property, and every canvas renderer reads the same
// property through cssVar() — whose memo is dropped here, because that is the
// only moment those values can move. NOTHING is fetched: a theme is a stylesheet
// decision, and asking the server for one would be a lie about what changed.
function setTheme(name, quiet){
  const th = THEMES.indexOf(name)>=0 ? name : THEMES[0];
  document.documentElement.setAttribute('data-theme', th);
  lsSet(LS_THEME, th);
  themeForget();
  if(quiet) return;
  // The drawing theme has no motion; the signal theme has particles. A reader
  // who has never touched the flow toggle gets the theme's own answer — and the
  // toolbar says so, because applyChrome() below re-labels that button.
  if(!GMAP.flowTouched) GMAP.flow=mapFlowDefault();
  applyChrome();      // every panel the page authors, from the answers in memory
  repaintPictures();  // …and every canvas, which bakes a colour into its model
}
const themeNow=()=> document.documentElement.getAttribute('data-theme') || THEMES[0];
// The three live canvases hold colours in their view models (a node's `col` is
// read once, when the model is built, because the renderer asks for it per frame
// per node). A theme change is the one event that invalidates them, so each one
// is re-coloured in place and repainted — no re-layout, no re-query, and the
// picture the reader had settled stays exactly where it was.
function repaintPictures(){
  if(GMAP.api && GMAP.nodes.length){
    for(const n of GMAP.nodes){ n.col=kindColor(n.kind); n.fill=kindFill(n.kind); }
    for(const l of GMAP.links) l.col=mapLinkBaseColor(l.data);
    if(GMAP.drawn==='3d'){ try{ GMAP.api.backgroundColor(cssVar('--g0')); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } }
    mapRefresh();
    gfRepaint(GMAP.api, mapDrawNode2D);
  }
  if(GA.api && GA.nodes.length){
    for(const l of GA.links){ const st=l.style;
      if(st){ l.colOn=gfAlpha(st.color(), st.opacity); l.colLit=gfAlpha(st.color(), 0.9); } }
    aroundRepaint();
  }
  if(ERD.api && ERD.nodes.length){
    for(const n of ERD.nodes) n.color=erdInk();
    erdRepaint();
  }
}
function setLang(lang){
  I18N.lang = LANGS.indexOf(lang)>=0 ? lang : 'en';
  I18N.t = makeT(I18N.catalog, I18N.lang);
  lsSet(LS_LANG, I18N.lang);
  // The chrome is re-rendered from the catalogue; NOTHING is re-fetched. The
  // answers already on screen are the engine's own words and do not change.
  applyChrome();
}

// ---------- five places, and the views inside them (RM67-U2c) ----------
// The tab bar used to be ten things of three different sorts on one line:
// questions (Explore, Flow, Impact), drawings (Graph, ERD, Coupling) and the
// analysis's own state (Rules). It is now five PLACES, each a question a reader
// comes with. A place with more than one VIEW shows a second row that switches
// between them. A view is still the unit the page draws (`#tab-<view>`) and
// keeps its own state, and it is what a URL's `tab=` names, so `tab=graph`,
// `tab=erd`, `tab=tx` and `tab=rules` land where they always did.
const PLACES=[
  { id:'start', views:['start'] },
  { id:'trace', views:['trace'] },
  { id:'structure', views:['graph','erd','coupling','tx'] },
  { id:'compare', views:['compare'] },
  { id:'status', views:['status','rules'] },
];
const TABNAMES=PLACES.flatMap((p)=> p.views);
// What each view is called on its place's second row, key by key.
const VIEW_KEY={ graph:'tab.graph', erd:'tab.erd', coupling:'tab.coupling', tx:'tab.tx',
  status:'tab.status.view', rules:'tab.rules' };
// A `tab=` a link may still carry that names no view today: the Overview is
// the Start place now, and a place's own name opens its first view. Trace's
// three old names (explore, flow, impact) are read by traceReadHash, because
// each carries a direction as well.
const OLD_TABS={ overview:'start', structure:'graph' };
const placeOf=(view)=> PLACES.find((p)=> p.views.includes(view)) || PLACES[0];
// The view each place was last on, so coming back to a place lands where the
// reader left it. Per page, not remembered: a fresh page opens each on its first.
const PLACE_LAST={};
const LAZY_TABS={ tx:{ box:'txview', load:()=>loadTx() }, rules:{ box:'rulesview', load:()=>loadRules() } };
// Showing a tab and LOADING a tab are two different things: a project switch
// empties every tab's cache and then asks the visible one to fill itself again,
// which is exactly `loadTab` with nothing cached.
function activateTab(name){
  name=OLD_TABS[name] || name;
  if(TABNAMES.indexOf(name)<0) name='start';
  const left=STATE.tab;
  STATE.tab=name;
  PLACE_LAST[placeOf(name).id]=name;
  // Compare with nothing to compare stays marked only while it is on screen (RM67-U2e).
  if(left==='compare' && name!=='compare') renderCompareChrome();
  renderPlaceChrome();
  TABNAMES.forEach(n=> document.getElementById('tab-'+n).classList.toggle('hidden', name!==n));
  writeHash();
  loadTab(name);
  refreshShowAll();
}
/** Open a place on the view it was last on, or its first. */
function openPlace(id){
  const p=PLACES.find((x)=> x.id===id);
  if(p) activateTab(PLACE_LAST[p.id] || p.views[0]);
}
/**
 * The place on screen, marked on the first row, and the second row for a place
 * that holds more than one view. Clicking the view already on screen puts it
 * back to its opening state, as clicking its place does.
 */
function renderPlaceChrome(){
  const place=placeOf(STATE.tab);
  for(const x of document.querySelectorAll('.tab')){
    const on=x.dataset.place===place.id;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', String(on));
  }
  const row=byId('subtabs');
  if(!row) return;
  row.classList.toggle('hidden', place.views.length<2);
  row.replaceChildren(...(place.views.length<2 ? [] : place.views.map((v)=> el('button',{
    type:'button', className:'subtab'+(v===STATE.tab ? ' active' : ''), textContent:t(VIEW_KEY[v]),
    onclick:()=> ((v===STATE.tab && Object.hasOwn(SHOWALL, v)) ? showAll(v) : activateTab(v)) }))));
}
function loadTab(name){
  // Start and Analysis status are both drawn from the one landing answer; the
  // map on Start asks its own question once Start is on screen.
  if ((name==='start' || name==='status') && !OV.resp && !OV.loading) loadOverview();
  if (name==='start') startOnScreen();
  // A tab that draws one answer into one box asks for it once, when the box is empty.
  const lazy=LAZY_TABS[name];
  if (lazy && !byId(lazy.box).hasChildNodes()) lazy.load();
  if (name==='compare' && !byId('cmpview').hasChildNodes()) drawCompare();
  // Trace opens SHOWING the pack: the rail draws what it already holds, and
  // asks the server for its list exactly once. A snapshot holds one answer and
  // no list to browse, so it opens no rail.
  if (RAILDEF[name] && !SNAP) railOpenTab(name);
  if (name==='trace') traceOnScreen();
  if (name==='erd' && !document.getElementById('erdside').hasChildNodes()) { document.getElementById('etable').value=''; drawErd(); }
  if (name==='coupling' && !document.getElementById('cpmatrix').hasChildNodes()) drawCoupling();
  // The Graph tab opens on the WHOLE map and loads it on first visit — the old
  // empty-until-you-type state was a regression. A picture already on screen is
  // left alone: a re-render would throw its settled layout away.
  if (name==='graph'){
    // The pane is sized from its own top offset, which only exists once the tab
    // is on screen: measure BEFORE anything mounts into it, or the renderer is
    // built at the wrong size and every layout that follows is fitted to it.
    graphPaneResize();
    if (GRAPHV.mode==='map'){
      mapMoveTo('graph');
      if(!GMAP.resp) drawMap();
      else if(!GMAP.api) renderMap();
    }
    else if (!GA.api) drawGraph();
    graphPaneApply();
  }
}
// Zero projects, one, or several — three different controls, because "pick one"
// is a lie when there is nothing to pick and noise when there is no choice.
function renderProjectChrome(){
  const sel=byId('projsel'), one=byId('projone'), none=byId('projnone');
  const items=STATE.projects;
  sel.classList.toggle('hidden', items.length<2);
  one.classList.toggle('hidden', items.length!==1);
  none.classList.toggle('hidden', items.length!==0);
  if(items.length===0){ none.replaceChildren(t('project.none')+' — ', ...richNodes(t('project.none.hint'))); return; }
  if(items.length===1){ one.textContent=items[0].id; return; }
  sel.replaceChildren(...items.map((p)=> el('option',{
    value:p.id, textContent:p.id, title:projectTitle(p), selected:p.id===STATE.project })));
  sel.value=STATE.project||items[0].id;
}
// What the registry (and, for a project already in memory, its pack) says about
// one entry. Relayed, never recomputed — and `null` for an unloaded project
// means "not loaded", not "nothing to say".
function projectTitle(p){
  const bits=[p.id];
  if(p.stack && p.stack.length) bits.push('lanes: '+p.stack.join(' + '));
  if(p.meta && p.meta.digest) bits.push('digest: '+p.meta.digest);
  if(p.meta && p.meta.builtAt) bits.push('built: '+String(p.meta.builtAt).replace('T',' ').replace(/\..*$/,''));
  if(!p.loaded) bits.push('(not loaded)');
  return bits.join('\u00a0\u00a0');
}
function renderLangChrome(){
  byId('langseg').replaceChildren(...LANGS.map((code)=> el('button',{
    textContent: langLabel(code),
    className: code===I18N.lang ? 'on' : '',
    onclick: ()=> setLang(code) })));
}
// BUILD IDENTITY, opened and closed by the reader. It uses the fold's own
// memory, so a reader who wants the digest on screen has it on every page they
// load until they close it again — the same bargain every other fold on this
// page makes. `mast.build` is a static id, not a per-answer key: which pack is
// on screen does not change whether this reader wants to see digests.
const MAST_BUILD_FOLD='mast.build';
function paintBuildFold(open){
  byId('mbuild').classList.toggle('hidden', !open);
  // The chain's counts are behind the same control (RM67-U2e), so the masthead
  // is one line until a reader asks for more.
  byId('crail').classList.toggle('hidden', !open);
  byId('mbuildbtn').setAttribute('aria-expanded', String(open));
}
function wireBuildFold(){
  const btn=byId('mbuildbtn');
  btn.onclick=()=>{ const open=!foldIsOpen(MAST_BUILD_FOLD); foldSetOpen(MAST_BUILD_FOLD, open); paintBuildFold(open); };
  paintBuildFold(foldIsOpen(MAST_BUILD_FOLD));
}
// FRESHNESS, in the reader's words. The verdict is a COMPUTED value the engine
// emits and this page never types one: what changes here is only how loud it is
// said. `behind` and `provisional-overlay` are the two a reader can act on, so
// they get a sentence; `current` gets a quiet two words; `unknown` gets the dot
// and nothing else, because `unknown` is the resting state of a pack with no git
// base to compare against and printing the word made it read as a failure.
// EVERY one of the four keeps the engine's own verdict, verbatim, in the chip's
// tooltip beside the contract field it came from.
const MAST_FRESH = {
  'behind': { say:'mast.fresh.behind', why:'mast.fresh.behind.title', tint:'warn' },
  'provisional-overlay': { say:'mast.fresh.overlay', why:'mast.fresh.overlay.title', tint:'warn' },
  'current': { say:'mast.fresh.current', why:'mast.fresh.current.title', tint:'' },
  'unknown': { say:'', why:'mast.fresh.unknown.title', tint:'' },
};
// TRUST, the same bargain. The GLOSS is a rewording of the engine's own value
// and nothing more: a level with no gloss here is printed exactly as it arrived,
// so an unknown level can never be silently renamed to a known one.
//
// THIS PAGE HOLDS NO LIST OF LEVELS. A trust level is computed by the engine
// (SPEC §14.3), and only the module that computes it may write those names, so
// the key is DERIVED from whatever value arrived rather than looked up in a
// table the page typed. `mastSay` is the whole rule: use the plain wording if
// we wrote one for this value, and otherwise say the value itself.
const mastTrustKey=(lvl)=> 'mast.trust.'+String(lvl).toLowerCase();
const mastSay=(key, fallback)=> Object.hasOwn(VIEWER_STRINGS.en, key) ? t(key) : fallback;
// Does this answer say the project has NO approved golden set at all? Read off
// the engine's own REASON, never off the level's name: the page has no list of
// levels, and this is the one state where it has to know the difference.
const noGoldenSet=(tt)=> (((tt && tt.knownGaps)||[]).includes('no-project-golden'));
// WHAT THE LEVEL MEANS, in the reader's words, with the engine's own value and
// every reason it held something back beside it. Where there is no golden set at
// all it also says the two things that change that, because a label with no way
// out of it is a dead end rather than a disclosure. The masthead chip and the
// evidence rail both say this, so the two cannot drift apart.
function trustWhy(tt){
  const lvl=(tt && tt.trustLevel) || null;
  const held=[...((tt && tt.gatesNotShown)||[]), ...((tt && tt.knownGaps)||[])];
  return [ lvl ? mastSay(mastTrustKey(lvl)+'.title', '') : t('mast.trust.none.title'),
    noGoldenSet(tt) ? t('mast.trust.how') : '',
    lvl ? t('mast.trust')+' '+lvl : '', 'trust.trustLevel', ...held ].filter((x)=>x).join('  ');
}
// THE TRUST CHIP, which is silent unless it has something to say. A project with
// no approved golden set gets NO chip: `not certified` over every answer anybody
// ever opened was the page shouting a state that is true of almost every project
// and actionable in almost none. The level still rides in the evidence rail
// below, with the two ways to change it on its tooltip.
//
// The TINT is read off the engine's own reasons and never off the level's name:
// an answer that names a gate it could not show, or a gap it knows about, wears
// the soft amber, and one that names neither wears nothing. A runtime level
// always names the checks it could not score, so it wears the amber by that rule
// rather than by anybody typing its name here.
function renderTrustChip(tt){
  const lvl=(tt && tt.trustLevel) || null;
  const hide=!lvl || noGoldenSet(tt);
  const held=tt ? ((tt.gatesNotShown||[]).length + (tt.knownGaps||[]).length) : 0;
  const say=lvl ? mastSay(mastTrustKey(lvl), lvl) : '';
  const chip=byId('mtrustchip');
  chip.className='mchip quiet'+(held ? ' warn' : '')+(hide ? ' hidden' : '');
  byId('mtrust').textContent=hide ? '' : say;
  // SAID OUT LOUD for a reader who is being read to, and silent when the chip is:
  // a hidden chip that still spoke would be the shouting moved somewhere quieter.
  byId('mtrustsr').textContent=hide ? '' : t('mast.trust')+' '+say;
  chip.title=hide ? '' : trustWhy(tt);
}
/** The freshness chip: the page's words for the verdict, the engine's verdict on its title and for a screen reader. */
function renderFreshChip(m){
  const fresh=(m && !m.error && m.freshness && m.freshness.verdict) || 'unknown';
  const fs=MAST_FRESH[fresh] || { say:'', why:'', tint:'' };
  const fchip=byId('mfreshchip');
  byId('mfresh').textContent=fs.say ? t(fs.say) : '';
  // A verdict the page has no words for is not a bare dot (RM67-U2e): the chip
  // stands down, and the verdict stays in the rail and on Analysis status.
  fchip.className='mchip quiet'+(fs.tint ? ' '+fs.tint : '')+(fs.say ? '' : ' hidden');
  // SAID OUT LOUD, for a reader who is being read to. The visible chip leans on
  // a coloured dot and a tooltip, and neither of those reaches a screen reader,
  // so the state is written again here and clipped to a pixel. It names what it
  // is about, because in speech there is no row of chips to read it in context.
  // Where the page has no plain wording, this says the engine's own verdict:
  // that is exactly the parity a hover already gives.
  byId('mfreshsr').textContent=t('mast.freshness')+' '+(fs.say ? t(fs.say) : fresh);
  // A verdict this page has no sentence for still says WHICH verdict it is: the
  // tooltip is where the engine's word lives, so it is never the missing half.
  fchip.title=[ fs.why ? t(fs.why) : '', t('mast.freshness')+' '+fresh,
    'basis.freshness.verdict' ].filter((x)=>x).join('  ');
}
// THE MASTHEAD CHIPS: what this answer is worth, and the two things a reader may
// change. The limits chip is the SAME fold as the one in the evidence rail (it
// shares its key, so opening either opens both), and its body drops under the
// masthead rather than beside a tab.
function renderMastChrome(){
  const now=themeNow();
  byId('themeseg').replaceChildren(...THEMES.map((name)=> el('button',{
    textContent: t(name==='signal' ? 'theme.dark' : 'theme.light'),
    className: name===now ? 'on' : '',
    onclick: ()=> setTheme(name) })));
  wireBuildFold();
  renderFreshChip(STATE.meta);
  // The trust level rides with the landing answer, which every tab's rail also
  // carries: one source, printed once at the top of the page. The NAME is the
  // engine's and is relayed verbatim in the tooltip. A trust level is a computed
  // value (SPEC §14.3), and a page that typed one would be a second source of
  // truth for it, so nothing here reads the name except to look up the wording.
  renderTrustChip((OV.resp && OV.resp.trust) || null);
  // WHICH CAPTURE INFORMED THIS PACK. `basis.runtimeEvidence` is the engine's
  // own coverage statement and this chip only puts two of its fields in ink:
  // the source word and the span count, both relayed and neither rewritten. The
  // NOTE is the half that keeps the mark honest ("a row without the mark was
  // not visited, not dead"), so it rides in the tooltip verbatim. No capture,
  // no chip: an absent trace has nothing to say and says nothing.
  const re=runtimeEvidenceOf(OV.resp);
  const tchip=byId('mtracechip');
  tchip.classList.toggle('hidden', !re);
  byId('mtrace').textContent = re ? t('mast.trace',{source:re.source??'', n:re.spans??0}) : '';
  tchip.title = re ? [t('mast.trace.title'), runtimeNote(OV.resp), 'basis.runtimeEvidence']
    .filter((x)=>x).join('  ') : '';
  const lim=(OV.resp && OV.resp.limits) || [];
  const cell=byId('mlimitcell'), body=byId('mfolds');
  if(!lim.length){ cell.replaceChildren(); body.replaceChildren(); return; }
  const [head, list]=foldParts('rail.overview.limits', [t('mast.limits',{n:lim.length})],
    ()=> limitRows('rail.overview.lim.', lim), 'mchip');
  // The rail below is built from the same key, so the two chips agree about
  // what is open — whichever one the reader used. The rail is re-drawn from the
  // answer already in memory: nothing is asked for again.
  const flip=head.onclick;
  head.onclick=()=>{ flip(); if(OV.resp) byId('ovside').replaceChildren(honesty(OV.resp,'overview')); };
  cell.replaceChildren(head);
  body.replaceChildren(list);
}
// Every string on this page that the PAGE wrote, re-read from the catalogue.
// Answers are not touched: they are the engine's words, in the engine's
// language, and re-rendering them would be a translation of evidence.
function applyChrome(){
  for(const n of document.querySelectorAll('[data-t]')) n.textContent=t(n.dataset.t);
  // A mode is named in the reader's words, then by the grade it adds, which is
  // the engine's token and is never translated (RM67).
  for(const n of document.querySelectorAll('option[data-grade]')) n.textContent=t(n.dataset.t)+' ('+n.dataset.grade+')';
  for(const n of document.querySelectorAll('[data-t-rich]')) n.replaceChildren(...richNodes(t(n.dataset.tRich)));
  for(const n of document.querySelectorAll('[data-t-fold]')) renderFoldHint(n);
  for(const n of document.querySelectorAll('[data-t-title]')) n.title=t(n.dataset.tTitle);
  for(const n of document.querySelectorAll('[data-t-ph]')) n.placeholder=t(n.dataset.tPh);
  renderProjectChrome();
  renderPlaceChrome();
  renderCompareChrome();
  renderRulesChrome();
  renderLangChrome();
  renderMastChrome();
  renderGraphChrome();
  renderMetaChrome();
  renderCascadeRail();
  renderAuthoredChrome();
  renderSnapshotChrome();
  document.documentElement.lang=I18N.lang;
}
// A TAB HINT, folded. The `data-t-fold` attribute names a PAIR of catalogue keys:
// `hint.x.lead` is the one line that stands on the page, `hint.x.more` the
// paragraph this tab used to print in full. The whole block is rebuilt on a
// language switch — the reader's open/closed choice lives under the key, in
// localStorage, so it survives that rebuild.
function renderFoldHint(n){
  const key=n.dataset.tFold;
  n.classList.add('hintfold');
  n.replaceChildren(fold(key, richNodes(t(key+'.lead')),
    ()=> [el('div',{}, richNodes(t(key+'.more')))]));
}
// The chrome the page writes in JAVASCRIPT, beside an answer, rather than as a
// `data-t` attribute in the markup: the Graph map's legend and its lead card,
// the Flow/Impact side panels, and the ERD's side and strip. `applyChrome()`
// above can only re-read attributes, so without this a language switch left
// every one of those panels in the language they were drawn in — a Korean
// reader saw a Korean toolbar over an English pane.
//
// Each one is re-drawn from the answer ALREADY IN MEMORY. Nothing is re-asked:
// the engine's words do not change with the interface language, and putting a
// request on the wire for a translation would be both slower and a lie about
// what changed. (test/viewer_multi.test.mjs asserts the zero-request part.)
function renderAuthoredChrome(){
  renderMapLegend();
  // Start, Analysis status and the Graph rail are drawn in JavaScript too — and none
  // asks the server for anything to be drawn again.
  if(OV.resp) renderOverview();
  if(GRAPHV.mode==='around' && GRAPHV.resp){
    renderGraphSide();
    // ...and the count line under the picture, from the answer it was drawn from.
    const c=GRAPHV.counts; if(c) renderGraphCounts(c.r, c.a, c.shownNodes, c.shownLinks);
  }
  if(GRAPHV.mode==='map' && GMAP.resp){ renderMapSide(); renderMapChips(); renderMapCounts(); }
  // The browse rail is page words from end to end: the kind chips, the sort
  // names, the count line, the stat titles, the lead card. Re-drawn from the
  // `browse` answer already in `RAIL[tab].resp`, so the switch asks nothing.
  for(const tab of RAILTABS) if(RAIL[tab].resp || RAIL[tab].needQuery){ railRender(tab); railIdle(tab); }
  // The lane STRIP carries page words too — the lane headings, the hop dividers,
  // the candidate bands — so the whole picture is drawn again, not only the rail
  // beside it. From the answer already in memory, like everything else here.
  if(TRACEV.resp && TRACE.dir!=='detail') renderChain(TRACEV, TRACEV.resp);
  // The details lists are page words around the engine's rows, so they are
  // drawn again too, from the answer remembered under the question on screen.
  else if(TRACE.target && TRACE.dir==='detail' && PICKMEM.has(TRACEV.lastKey)) traceDetailDraw(TRACE.target, PICKMEM.get(TRACEV.lastKey));
  renderTraceChrome();
  if(erdData){
    redrawErdLegend();
    renderErdIsolated(ERD.iso||[]);
    if(ERD.sel) renderErdSideTable(ERD.sel); else renderErdSideOverview();
  }
}

// The TITLE BLOCK's rows: what pack is on screen, which lanes built it, what it
// was built against, how fresh the served answer is. Every VALUE is /api/meta's,
// word for word; only the labels beside them come from the catalogue, which is
// why the block can be re-drawn on a language switch without asking again.
//
// The `project` row is not written here: it is the selector, and
// renderProjectChrome() owns its three states (a <select>, one static name, or
// the init hint). A value the meta does not carry is left EMPTY — an em dash
// would read as a fact the engine stated.
function renderMetaChrome(){
  const note=byId('proj'), m=STATE.meta;
  const put=(id,v)=>{ byId(id).textContent = v==null ? '' : String(v); };
  const blank=()=>{ for(const id of ['mdigest','mbase','mlanes']) put(id,''); };
  if(!m){ note.textContent=t('header.loading'); blank(); renderMastChrome(); return; }
  if(m.error){
    // An unknown project (404) or an unnamed one on a multi-project server
    // (409) is SAID, under the line, in the engine's own words. A blank line
    // would leave the reader thinking the project is empty.
    note.textContent=t('err.generic',{message:m.error.message||m.error.code});
    blank(); renderMastChrome(); return;
  }
  note.textContent='';
  put('mdigest', m.digest||'');
  put('mbase', m.base && m.base.commit ? m.base.commit.slice(0,10) : '');
  // The lanes read as the engine names them, joined the way the dateline
  // reads: `sql + java`, one field of four.
  put('mlanes', m.lanes ? m.lanes.join(' + ') : '');
  renderMastChrome();
  renderCompareChrome();
}
