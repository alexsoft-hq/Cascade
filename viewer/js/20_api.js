// 20_api.js — one way to ask the server, and one way to say where the reader is.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

const withProject = (url) => STATE.project ? url + (url.includes('?') ? '&' : '?') + 'project=' + encodeURIComponent(STATE.project) : url;
const staleAnswer=(p)=>{ const e=new Error('answer for project '+p+' was dropped: the page has moved on'); e.stale=true; return e; };
const stale=(e)=> !!(e && e.stale);
const api = async (name, args={}) => {
  const forProject=STATE.project, mine=STATE.seq;
  const body = forProject ? {name, arguments:args, project:forProject} : {name, arguments:args};
  const r = await fetch('/api/call', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  const j = await r.json();
  if(mine!==STATE.seq || forProject!==STATE.project) throw staleAnswer(forProject);
  if (j.error) throw new Error(j.error.code+': '+j.error.message);
  return j;
};
/**
 * Ask ANOTHER registered project one question, without leaving this one.
 *
 * `api` always addresses the project on screen, and its own staleness rule then
 * throws away anything that came back for a different one. This is the single
 * place that addresses a sibling: a federated table's columns are that
 * project's own fact, and asking the pack on screen for them comes back
 * unknown. The page does not MOVE - `STATE.project` is untouched - so the
 * answer is still dropped if the reader switches while it is in flight.
 */
const apiFor = async (project, name, args={}) => {
  const mine=STATE.seq, was=STATE.project;
  const r = await fetch('/api/call', { method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({name, arguments:args, project}) });
  const j = await r.json();
  if(mine!==STATE.seq || was!==STATE.project) throw staleAnswer(was);
  if (j.error) throw new Error(j.error.code+': '+j.error.message);
  return j;
};
const view = document.getElementById('view');
// One error banner, everywhere. `e.message` is the ENGINE's own sentence and is
// relayed word for word; only the frame around it is translated.
const errPanel=(e)=> el('div',{className:'panel', textContent:t('err.generic',{message:(e&&e.message)||String(e)})});

// ---------- the URL hash: which project, which tab, which pick --------------
// `#p=<id>&tab=<name>&pick=<node id>&src=<node id>`. A tab or a project change
// REPLACES the entry (they are not steps a Back button should undo one at a
// time); a PICK, and opening the source pane, PUSH one — so Back returns to the
// previous picture and a reload lands on the same one. `popstate` and
// `hashchange` come back through the same door, and a pick whose answer is
// still in memory is re-drawn without a request.
function readHash(){
  const q=new URLSearchParams(String(location.hash||'').replace(/^#/,''));
  return { p:q.get('p')||null, tab:q.get('tab')||null, pick:q.get('pick')||null, src:q.get('src')||null };
}
/**
 * The hash for one destination. ONE place knows the format, so a hand-off that
 * names another project (a federated row's Flow button) builds the same string
 * the address bar already carries rather than a second spelling of it.
 * @param {{project:?string, tab:?string, pick:?string, src:?string}} to
 */
function hashFor(to){
  // A server with no project has no id to write: the hash then says only which
  // tab is open, rather than carrying an empty `p=`.
  const parts=[];
  if(to.project) parts.push('p='+encodeURIComponent(to.project));
  parts.push('tab='+encodeURIComponent(to.tab||'overview'));
  if(to.pick) parts.push('pick='+encodeURIComponent(to.pick));
  if(to.src) parts.push('src='+encodeURIComponent(to.src));
  return '#'+parts.join('&');
}
function hashNow(){
  return hashFor({ project:STATE.project, tab:STATE.tab||'overview',
    pick:PICK[STATE.tab], src:(SRC.open && SRC.node) ? SRC.node : null });
}
function writeHash(push){
  if(HASHLOCK) return;
  const h=hashNow();
  if(location.hash===h) return;
  try{ push ? history.pushState(null,'',h) : history.replaceState(null,'',h); }
  catch(e){ location.hash=h; }
}
function applyHash(){
  const h=readHash();
  if(h.p && h.p!==STATE.project && STATE.projects.some((x)=>x.id===h.p)){ switchProject(h.p, { tab:h.tab, pick:h.pick }); return; }
  const was=HASHLOCK; HASHLOCK=true;
  try{
    if(h.tab && h.tab!==STATE.tab && TABNAMES.indexOf(h.tab)>=0) activateTab(h.tab);
    if(Object.hasOwn(PICK, STATE.tab)) pickRestore(STATE.tab, h.pick||null);
    if(h.src){ if(!SRC.open || SRC.node!==h.src) srcOpen(h.src, {push:false}); }
    else if(SRC.open) srcClose();
  } finally { HASHLOCK=was; }
  refreshShowAll();
}

// ---------- the project selector --------------------------------------------
// Selecting a project is not a filter on what is on screen: it is a different
// pack, so everything on screen is WRONG until it is asked again. STATE.seq is
// bumped first (every answer still in flight is now stale and will be dropped),
// then every tab's cache and every live renderer is torn down, and only then is
// anything re-asked.
/**
 * @param {string} id
 * @param {{tab:?string, pick:?string}} [dest] where the reader asked to LAND.
 *        A deep link, or a federated row's Flow button, names a tab and a pick
 *        as well as a project, and both belong to the project that is arriving.
 *        The tab is switched only AFTER the old project's state is gone, so
 *        nothing is ever asked of the pack that is being left.
 */
function switchProject(id, dest){
  if(!id || id===STATE.project) return;
  STATE.project=id;
  STATE.seq++;
  lsSet(LS_PROJECT, id);
  writeHash();
  resetProjectState();
  renderProjectChrome();
  loadMeta();
  // The Overview is the landing answer for every project, whichever tab is on
  // screen; the visible tab then fills itself, because its cache is now empty.
  loadOverview();
  const to = dest && dest.tab && TABNAMES.indexOf(dest.tab)>=0 ? dest.tab : STATE.tab;
  if(to!==STATE.tab) activateTab(to); else loadTab(STATE.tab);
  if(dest && dest.pick && Object.hasOwn(PICK, STATE.tab)) pickAsk(STATE.tab, dest.pick);
}
// Everything the PREVIOUS project left behind. A renderer that is not stopped
// here keeps its own animation loop and its own canvas alive behind the new
// picture — which is why the Graph tab is put back on the map with the renderer
// DOWN (graphSetMode draws nothing) rather than through graphMode().
function resetProjectState(){
  // Every pick, every remembered answer and the source pane belong to the pack
  // that is being left: none of them describes the one arriving.
  for(const k of Object.keys(PICK)) PICK[k]=null;
  PICKMEM.clear();
  SRC.mem.clear();
  srcClose();
  OV.resp=null;
  byId('ovcards').replaceChildren(); byId('ovpanels').replaceChildren(); byId('ovside').replaceChildren();
  byId('ovhero').classList.add('hidden');
  byId('ovherocol').replaceChildren(); byId('ovmapsub').replaceChildren();
  byId('ovmapleg').replaceChildren(); byId('ovfold').replaceChildren();
  renderCascadeRail();
  renderMastChrome();
  view.replaceChildren();
  // The browse rails are the OLD pack's lists: everything in them is wrong now.
  for(const tab of RAILTABS){
    RAIL[tab].seq++;
    railCloseDrawer(tab);
    const input=byId(RAILDEF[tab].inputId); if(input) input.value='';
    RAIL[tab]=railFresh(tab);   // …and the filter it held: railFresh types nothing
    byId(RAILDEF[tab].listId).replaceChildren();
    byId(RAILDEF[tab].countId).replaceChildren();
    byId(RAILDEF[tab].moreId).replaceChildren();
    if(RAILDEF[tab].chipsId) byId(RAILDEF[tab].chipsId).replaceChildren();
  }
  for(const v of [FLOWV, IMPACTV]){
    v.seq++; v.resp=null; v.sel=null; v.pick=null; v.limit=40;
    v.rows.clear(); v.linkSpecs=[]; v.paths=[]; v.layerOpen.clear();
    const w=vwrap(v); w.classList.remove('layersmode'); w.replaceChildren();
    vside(v).replaceChildren();
    closeSug(v);
  }
  CP.seq++; CP.resp=null; CP.sel=null; CP.cellEls=new Map();
  byId('cpsummary').replaceChildren(); byId('cpmatrix').replaceChildren(); byId('cpside').replaceChildren();
  GRAPHV.seq++; GMAP.seq++; GMAP.findSeq++;
  stopMap(false); stopAround();
  GMAP.resp=null; GMAP.sel=null; GMAP.hover=null; GMAP.lit=null; GMAP.fitDone=false;
  mapForgetLayout();
  GMAP.nodes=[]; GMAP.links=[];
  GRAPHV.resp=null; GRAPHV.sel=null; GRAPHV.pick=null; GRAPHV.hop=new Map();
  GRAPHV.hidden=new Set(); GRAPHV.hiddenFor=null;
  closeSug(GRAPHV);
  graphSetMode('map');
  byId('gchips').replaceChildren(); byId('gcounts').replaceChildren(); byId('gside').replaceChildren();
  erdStop();
  erdData=null; erdSelectFn=null; erdClearFn=null; erdResetFn=null;
  ERD.answer=null; ERD.sel=null; ERD.lit=null; ERD.fitDone=false; ERD.byId=new Map();
  ERD.iso=[]; ERD.cols=new Map();
  byId('etable').value='';
  byId('erdside').replaceChildren(); byId('erdiso').replaceChildren();
  byId('ehonesty').replaceChildren(); byId('erdleg').replaceChildren();
  byId('txview').replaceChildren();
}
async function loadMeta(){
  const forProject=STATE.project, mine=STATE.seq;
  STATE.meta=null; renderMetaChrome();
  let m;
  try{ m=await (await fetch(withProject('/api/meta'))).json(); }
  catch(e){ return; }
  if(mine!==STATE.seq || forProject!==STATE.project) return;   // another project is on screen now
  STATE.meta=m; renderMetaChrome();
}
// Which projects this server serves. Registry only — asking does not load a
// single pack (`meta` is null until a project has answered something).
async function loadProjects(){
  try{
    const j=await (await fetch('/api/projects')).json();
    if(j && !j.error && j.answer && Array.isArray(j.answer.projects)) STATE.projects=j.answer.projects;
  }catch(e){ /* leave the list empty: the selector then says so */ }
}
