// 90_boot.js — the wiring, and the one thing that runs on load.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// CLICKING THE TAB YOU ARE ALREADY ON puts it back to its opening state. It is
// the gesture every reader already tries, and until now it did nothing.
// Everything the PAGE navigates with calls activateTab directly, so an internal
// hand-off to a tab never reads as that click.
document.querySelectorAll('.tab').forEach((node)=> { node.onclick=()=>{
  const name=node.dataset.tab;
  if(name===STATE.tab && Object.hasOwn(SHOWALL, name)){ showAll(name); return; }
  activateTab(name);
}; });
window.addEventListener('hashchange', applyHash);
window.addEventListener('popstate', applyHash);
// Coupling toolbar: a different axis / mode / depth is a different ANSWER (the
// server walks again); "show all groups" is only a different drawing of the one
// already on screen, so it never re-queries.
document.getElementById('cpdraw').onclick = ()=>drawCoupling();
document.getElementById('cpmode').onchange = ()=>drawCoupling();
document.getElementById('cpdepth').onchange = ()=>drawCoupling();
document.getElementById('cpall').onchange = (e)=>{ CP.showAll=e.target.checked; if(CP.resp) renderCoupling(); };
document.querySelectorAll('#cpaxis button').forEach(b=> b.onclick=()=>{
  if(CP.axis===b.dataset.axis) return;
  CP.axis=b.dataset.axis;
  document.querySelectorAll('#cpaxis button').forEach(x=> x.classList.toggle('on', x===b));
  drawCoupling();
});
document.getElementById('ereset').onclick = ()=>{ document.getElementById('etable').value=''; if(erdClearFn) erdClearFn(); if(erdResetFn) erdResetFn(); };
document.getElementById('etable').addEventListener('keydown', e=>{ if(e.key==='Enter'){ const q=e.target.value.trim(); if(q && erdSelectFn) erdSelectFn(q); else if(erdClearFn) erdClearFn(); } });
// Explore's box is the rail's filter AND the old search box. Enter takes the
// highlighted row; with nothing highlighted (the filter matched none of the
// rows this kind holds) it asks the server, exactly as it always did.
document.getElementById('q').addEventListener('keydown', e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); railMove('explore', e.key==='ArrowDown'?1:-1); return; }
  if(e.key!=='Enter') return;
  if(railEnter('explore')) return;
  doSearch(e.target.value.trim());
});
document.getElementById('q').addEventListener('input', ()=>railFilterInput('explore'));
document.getElementById('edits').onclick = showEdits;
railWire();
srcWire();
// The five Show all buttons, and the page's one Escape rule. The pane's own
// keys (j / k / arrows to scroll a line, f for the whole file) ride the same
// listener, because they only mean anything while the pane is open.
for(const [tab, id] of Object.entries(SHOWALL)) byId(id).onclick = ()=>showAll(tab);
document.addEventListener('keydown', (e)=>{
  if(e.key==='Escape'){ escapeRule(e); return; }
  if(srcKeydown(e) && e.preventDefault) e.preventDefault();
});
// Both lane tabs are wired by the same function — one behaviour, two pictures.
wireChainToolbar(FLOWV);
wireChainToolbar(IMPACTV);
// The Graph tab's entry box is the SAME typeahead the lane tabs use (one
// resolution rule, so a focus is never a guessed kind); only what a commit
// draws differs.
(function wireGraphToolbar(){
  const input=byId('gfocus');
  byId('gload').onclick=()=>chainCommit(GRAPHV);
  input.addEventListener('keydown', e=>{
    const open=!byId('gsug').classList.contains('hidden');
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){ if(open){ e.preventDefault(); chainSugMove(GRAPHV, e.key==='ArrowDown'?1:-1); } return; }
    if(e.key==='Enter') chainCommit(GRAPHV);
  });
  input.addEventListener('input', ()=>{ GRAPHV.pick=null; clearTimeout(GRAPHV.sugTimer);
    GRAPHV.sugTimer=setTimeout(()=>chainSuggest(GRAPHV, input.value.trim()),150); });
  input.addEventListener('focus', ()=>{ if(!input.value.trim()) chainSuggest(GRAPHV, ''); });
  byId('gdir').onchange=()=>drawGraph();
  byId('ghops').onchange=()=>drawGraph();
  // A different mode or depth is a different ANSWER — the server walks again.
  byId('gmode').onchange=()=>drawMap();
  byId('gdepth').onchange=()=>drawMap();
  // 2D or 3D is only a different PROJECTION of the answer already on screen:
  // no re-query, and the node positions carry across (GMAP.pos).
  document.querySelectorAll('#grend button').forEach(b=> b.onclick=()=>{
    if(GMAP.rend===b.dataset.rend) return;
    GMAP.rend=b.dataset.rend;
    document.querySelectorAll('#grend button').forEach(x=> x.classList.toggle('on', x===b));
    if(GRAPHV.mode==='map' && GMAP.resp) renderMap();
  });
  // Folded or unfolded is a property of the DRAWING, not of the answer: the
  // endpoints were always in it. Nothing is re-queried; the picture is rebuilt
  // and the forces settle it again.
  document.querySelectorAll('#gfold button').forEach(b=> b.onclick=()=>{
    const moved = b.dataset.fold==='endpoints' ? mapUnfoldAll() : mapFoldAll();
    if(!moved){ renderMapFoldNote(); return; }
    GMAP.sel=null;
    mapRebuild();
  });
  // The flow is a property of the PICTURE, not of the answer: nothing is
  // re-queried and nothing is re-laid-out, the renderers are just re-read.
  byId('gflow').onclick=()=>flowToggle();
  byId('fflow').onclick=()=>flowToggle();
  byId('iflow').onclick=()=>flowToggle();
  byId('gback').onclick=()=>graphMode('map');
  byId('gfit').onclick=()=>mapRefit();
  document.addEventListener('click',(ev)=>{ if(!ev.target.closest('#gsug') && ev.target.id!=='gfocus') closeSug(GRAPHV); });
})();
window.addEventListener('resize', graphPaneOnResize);
// the bezier ends are measured from the DOM, so a resize must re-measure them
let chainResizeTimer=null;
window.addEventListener('resize', ()=>{ clearTimeout(chainResizeTimer); chainResizeTimer=setTimeout(()=>{
  // The browse rail's height is MEASURED, like the Graph pane's: a new window
  // means a new bottom edge, and a drawer-width window means no measured height
  // at all.
  { const tab=railVisibleTab(); if(tab) railPaneApply(tab); }
  // The source pane is fixed under a masthead whose height moves with the
  // width, and its own width is a share of the window until the reader drags it.
  srcPaneApply();
  for(const v of [FLOWV, IMPACTV]) if(v.resp && v.view==='lanes') drawChainLinks(v);
  // Every canvas renderer owns a canvas sized in PIXELS: it has to be told. The
  // layouts are not recomputed — a resize is a different window on the same
  // picture, not a different picture.
  // The Graph pane's height was re-measured by graphPaneOnResize above; this
  // reads what it settled on.
  if(!byId('tab-graph').classList.contains('hidden')) graphPaneResize();
  const gw=byId('gwrap');
  if(GA.api){ try{ GA.api.width(gw.clientWidth||900).height(gw.clientHeight||620); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } }
  if(GMAP.api){ const mw=mapWrapEl();
    try{ GMAP.api.width(mw.clientWidth||900).height(mw.clientHeight||420); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } }
  if(ERD.api){ const w=byId('erdwrap');
    try{ ERD.api.width(w.clientWidth||900).height(w.clientHeight||620); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } }
},120); });
// Scrolling changes WHICH connectors the reader can see, and only those may
// move. Throttled, and never a re-measure of the beziers - only the dots.
let laneScrollTimer=null;
window.addEventListener('scroll', ()=>{ clearTimeout(laneScrollTimer); laneScrollTimer=setTimeout(()=>{
  for(const v of [FLOWV, IMPACTV]) if(v.resp && v.view==='lanes') laneFlowVisibility(v);
},140); }, {passive:true});
// A hidden tab is not being read. SMIL keeps its own clock, so it is told.
document.addEventListener('visibilitychange', ()=>{
  laneFlowPause(document.visibilityState==='hidden');
});

(async function init(){
  // The theme first, and QUIETLY: the head script already put it on <html>
  // before the first paint, so this only reconciles the state and writes the
  // choice back. Nothing is rendered yet to re-render.
  setTheme(lsGet(LS_THEME) || THEMES[0], true);
  // ...and the one flow preference the map and the two lane views share.
  flowPrefLoad();
  fedPrefLoad();
  const kl = document.getElementById('klegend');
  KINDS.forEach(k=> kl.append(el('span',{},[ kindDot(k, 11), k ])));
  renderLineLegend();
  renderMapLegend();
  renderMapLegend('ovmapleg');
  graphPaneWatch();
  ovMapWheelGate();
  // Every translation is fetched at start-up, not on the first click: the
  // toggle names each language in ITS OWN language, and it cannot do that for a
  // catalogue it has not read.
  await Promise.all(LANGS.filter((l)=>l!=='en').map(loadCatalog));
  await loadProjects();
  const hash=readHash();
  const ids=STATE.projects.map((p)=>p.id);
  const known=(x)=> !!x && ids.indexOf(x)>=0;
  // The hash wins (it is what a shared link says), then the ?project= the
  // server prints at start-up, then what this browser chose last time.
  STATE.project=[hash.p, new URLSearchParams(location.search).get('project'), lsGet(LS_PROJECT)].find(known) || ids[0] || null;
  if(STATE.project) lsSet(LS_PROJECT, STATE.project);
  STATE.tab=(hash.tab && TABNAMES.indexOf(hash.tab)>=0) ? hash.tab : 'overview';
  setLang(lsGet(LS_LANG) || 'en');   // applyChrome() runs inside
  byId('projsel').onchange=(e)=>switchProject(e.target.value);
  writeHash();
  loadMeta();
  // The Overview is the landing answer whichever tab a link points at.
  loadOverview();
  activateTab(STATE.tab);
  // ...and a link that names a pick lands ON it, source pane and all. Nothing
  // is in memory on a cold load, so this is the one place a restore asks.
  if(hash.pick && Object.hasOwn(PICK, STATE.tab)) pickAsk(STATE.tab, hash.pick);
  // ...and only if the pick did not already open it on that very node, or the
  // page would ask for the same file twice on one load.
  if(hash.src && !(SRC.open && SRC.node===hash.src)) srcOpen(hash.src, {tab:STATE.tab, push:false});
  refreshShowAll();
})();
