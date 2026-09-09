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

// ---------- tabs / init ----------
const TABNAMES=['overview','explore','flow','impact','coupling','graph','erd','tx'];
const CHAINTABS={flow:FLOWV, impact:IMPACTV};
// Showing a tab and LOADING a tab are two different things: a project switch
// empties every tab's cache and then asks the visible one to fill itself again,
// which is exactly `loadTab` with nothing cached.
function activateTab(name){
  if(TABNAMES.indexOf(name)<0) name='overview';
  STATE.tab=name;
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active', x.dataset.tab===name));
  TABNAMES.forEach(n=> document.getElementById('tab-'+n).classList.toggle('hidden', name!==n));
  writeHash();
  loadTab(name);
  refreshShowAll();
}
function loadTab(name){
  if (name==='overview'){
    if(!byId('ovcards').hasChildNodes()) loadOverview();
    // The cartography is the live map: bring it here (from the Graph tab, if
    // that is where it was) rather than mounting a second one.
    else ovMapMount();
  }
  if (name==='tx' && !document.getElementById('txview').hasChildNodes()) loadTx();
  // Explore, Flow and Impact open SHOWING the pack: the rail draws what it
  // already holds, and asks the server for its list exactly once.
  if (RAILDEF[name]) railOpenTab(name);
  const v=CHAINTABS[name];
  if (v){
    if(!vwrap(v).hasChildNodes()) drawChain(v);
    // The picture may have been rendered while this tab was hidden (no layout,
    // so no lines could be measured). Now that it is visible, measure it.
    else if(v.resp && v.view==='lanes') requestAnimationFrame(()=>drawChainLinks(v));
  }
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
  const m=STATE.meta;
  const fresh=(m && !m.error && m.freshness && m.freshness.verdict) || 'unknown';
  const fs=MAST_FRESH[fresh] || { say:'', why:'', tint:'' };
  const fchip=byId('mfreshchip');
  byId('mfresh').textContent=fs.say ? t(fs.say) : '';
  fchip.className='mchip quiet'+(fs.tint ? ' '+fs.tint : '');
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
  // The trust level rides with the landing answer, which every tab's rail also
  // carries: one source, printed once at the top of the page. The NAME is the
  // engine's and is relayed verbatim in the tooltip; the TINT is read off the
  // engine's own reasons and never off that name — a trust level is a computed
  // value (SPEC §14.3), and a page that typed one would be a second source of
  // truth for it. An answer that names a gate it could not show, or a gap it
  // knows about, wears the soft amber; one that names neither wears nothing.
  // NOT the green it used to wear: an uncertified pack painted like a passing
  // build is the page telling the reader something the engine never said.
  const tt=(OV.resp && OV.resp.trust) || null;
  const lvl=(tt && tt.trustLevel) || null;
  const held=tt ? ((tt.gatesNotShown||[]).length + (tt.knownGaps||[]).length) : 0;
  const chip=byId('mtrustchip');
  const key=lvl ? mastTrustKey(lvl) : '';
  byId('mtrust').textContent=lvl ? mastSay(key, lvl) : '';
  byId('mtrustsr').textContent=t('mast.trust')+' '+(lvl ? mastSay(key, lvl) : t('mast.trust.none.title'));
  chip.className='mchip quiet'+(held ? ' warn' : '');
  chip.title=[ lvl ? mastSay(key+'.title', '') : t('mast.trust.none.title'),
    lvl ? t('mast.trust')+' '+lvl : '', 'trust.trustLevel',
    ...(held ? [...(tt.gatesNotShown||[]), ...(tt.knownGaps||[])] : []) ].filter((x)=>x).join('  ');
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
    ()=> lim.map((l,i)=> railLimit('rail.overview.lim.'+i, l)), 'mchip');
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
  for(const n of document.querySelectorAll('[data-t-rich]')) n.replaceChildren(...richNodes(t(n.dataset.tRich)));
  for(const n of document.querySelectorAll('[data-t-fold]')) renderFoldHint(n);
  for(const n of document.querySelectorAll('[data-t-title]')) n.title=t(n.dataset.tTitle);
  for(const n of document.querySelectorAll('[data-t-ph]')) n.placeholder=t(n.dataset.tPh);
  renderProjectChrome();
  renderLangChrome();
  renderMastChrome();
  renderGraphChrome();
  renderMetaChrome();
  renderCascadeRail();
  renderAuthoredChrome();
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
  // The Overview and the Graph rail are drawn in JavaScript too — and neither
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
  for(const v of [FLOWV, IMPACTV]) if(v.resp) renderChain(v, v.resp);
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
}
