// 41_explore.js — the Explore tab, the browse rail every list tab opens on, the source pane and the way back.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

async function fetchSource(nodeId, whole) {
  const forProject=STATE.project, mine=STATE.seq;
  const r = await fetch(withProject('/api/source?node=' + encodeURIComponent(nodeId) + (whole?'&whole=1':'')));
  if(mine!==STATE.seq || forProject!==STATE.project) throw staleAnswer(forProject);
  if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error((j.error&&j.error.message)||('HTTP '+r.status)); }
  return r.json();
}
const srcKey=(node, whole)=> node+(whole?'|whole':'');
/** Keep the last few answers, so a Back button and a re-open ask for nothing. */
function srcRemember(key, s){
  SRC.mem.set(key, s);
  while(SRC.mem.size>SRC_MEM) SRC.mem.delete(SRC.mem.keys().next().value);
}
const srcIsOpen=()=> SRC.open;
/** Is the pane open on behalf of THIS tab? That is one of the ways it is narrowed. */
const srcFor=(tab)=> SRC.open && SRC.tab===tab;

/**
 * Open the pane on one node.
 * @param {string} nodeId  a full `<kind>:<key>` id
 * @param {{tab?:string, grade?:string, basis?:string, excerpt?:object, push?:boolean}} [opts]
 *   `excerpt` is an element on a chain row's card: the first six lines land in
 *   it when the answer does, off the SAME request the pane made.
 */
function srcOpen(nodeId, opts){
  opts=opts||{};
  const same = SRC.open && SRC.node===nodeId;
  SRC.open=true; SRC.node=nodeId;
  SRC.tab = opts.tab || STATE.tab;
  SRC.grade = opts.grade || null;
  SRC.basis = opts.basis || null;
  SRC.excerpt = opts.excerpt ? { node:nodeId, el:opts.excerpt } : null;
  if(!same) SRC.whole=false;
  SRC.error=null;
  byId('srcpane').classList.remove('hidden');
  srcPaneApply();
  srcLoad();
  if(opts.push!==false) writeHash(true);
  refreshShowAll();
}
function srcClose(){
  if(!SRC.open) return;
  SRC.open=false; SRC.node=null; SRC.resp=null; SRC.excerpt=null; SRC.seq++; SRC.inflight=null;
  byId('srcpane').classList.add('hidden');
  byId('srchd').replaceChildren();
  byId('srcbody').replaceChildren();
  byId('srcft').replaceChildren();
  writeHash(false);
  refreshShowAll();
}
/** The one request this pane makes, and only when the answer is not already here. */
async function srcLoad(){
  const node=SRC.node, whole=SRC.whole, key=srcKey(node, whole);
  const memo=SRC.mem.get(key);
  if(memo){ SRC.inflight=null; SRC.resp=memo; SRC.loading=false; SRC.error=null; srcRender(); return; }
  // The SAME file, asked for twice before the first answer lands, is one
  // request: a chain card opens the pane on a statement by itself, and the
  // reader pressing `Source` a moment later must not put a second one on the
  // wire for the very node that is already on its way.
  if(SRC.inflight===key) return;
  SRC.inflight=key;
  const mine=++SRC.seq;
  SRC.loading=true; SRC.resp=null; SRC.error=null;
  srcRender();
  let s;
  try{ s=await fetchSource(node, whole); }
  catch(e){ if(SRC.inflight===key) SRC.inflight=null;
    if(stale(e)||mine!==SRC.seq) return; SRC.loading=false; SRC.error=e; srcRender(); return; }
  if(SRC.inflight===key) SRC.inflight=null;
  if(mine!==SRC.seq || SRC.node!==node) return;
  srcRemember(key, s);
  SRC.loading=false; SRC.resp=s;
  srcRender();
}
function srcToggleWhole(){
  if(!SRC.open || !SRC.resp) return;
  SRC.whole=!SRC.whole;
  srcLoad();
}
// ---- where the pane sits, and how wide -------------------------------------
// Under the masthead, which is sticky and whose height changes with the window:
// measured, never assumed. The width is the reader's, kept in localStorage, and
// clamped to the pane's own floor and ceiling every time it is applied.
function srcWantedWidth(vw){
  const stored=Number(lsGet(LS_SRCW));
  const want = Number.isFinite(stored) && stored>0 ? stored : Math.round(vw*SRC_DEF_SHARE);
  return Math.max(SRC_MIN_W, Math.min(Math.round(vw*SRC_MAX_SHARE), Math.round(want)));
}
function srcPaneApply(){
  const pane=byId('srcpane');
  if(!pane || pane.classList.contains('hidden')) return null;
  const head=document.querySelector('header');
  if(head && head.getBoundingClientRect){
    const b=head.getBoundingClientRect();
    if(b && Number.isFinite(b.bottom)) pane.style.top=Math.max(0, Math.round(b.bottom))+'px';
  }
  const vw=(typeof window!=='undefined' && window.innerWidth) || 1400;
  if(vw<=1100){ pane.style.width=''; return null; }   // full width: the stylesheet says so
  const w=srcWantedWidth(vw);
  pane.style.width=w+'px';
  return w;
}
function srcSetWidth(w){
  const vw=(typeof window!=='undefined' && window.innerWidth) || 1400;
  const clamped=Math.max(SRC_MIN_W, Math.min(Math.round(vw*SRC_MAX_SHARE), Math.round(w)));
  lsSet(LS_SRCW, String(clamped));
  byId('srcpane').style.width=clamped+'px';
  return clamped;
}
// ---- drawing it -------------------------------------------------------------
function srcEditorNow(){
  const v=lsGet(LS_EDITOR);
  return SRC_EDITORS.some((x)=>x[0]===v) ? v : SRC_EDITORS[0][0];
}
/** Copy, and say so on the control that was pressed. */
function srcCopy(text, node, sayKey){
  try{
    if(typeof navigator!=='undefined' && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  }catch(e){ /* a browser that refuses the clipboard still shows the path */ }
  if(!node) return;
  const was=node.textContent;
  node.textContent=t(sayKey);
  setTimeout(()=>{ if(node.textContent===t(sayKey)) node.textContent=was; }, SRC_SAID_MS);
}
function srcRender(){
  if(!SRC.open) return;
  srcRenderHead();
  srcRenderBody();
  srcRenderFoot();
}
function srcRenderHead(){
  const hd=byId('srchd'), s=SRC.resp;
  const kids=[ el('span',{className:'srcnode', title:SRC.node, textContent:SRC.node}) ];
  if(s && s.file){
    // The path is a control: it copies `path:line`, which is what a reader
    // pastes into a terminal, a review comment or a colleague's chat. Where the
    // preview is a WHOLE FILE about a point inside it (a screen's component),
    // the line is that point, not line 1.
    const line=s.mark!=null ? s.mark : (s.from||1);
    const path=el('button',{className:'srcpath', title:t('src.copy.title'), textContent:s.file+':'+line});
    path.onclick=()=> srcCopy(s.file+':'+line, path, 'src.copied');
    kids.push(path);
  }
  if(s && s.lang) kids.push(el('span',{className:'tag', textContent:s.lang}));
  if(s && s.from!=null) kids.push(el('span',{className:'srcrange',
    textContent: SRC.whole && s.fileLines!=null
      ? t('src.range.of',{from:s.from, to:s.to, lines:s.fileLines})
      : t('src.range',{from:s.from, to:s.to}) }));
  kids.push(el('span',{className:'srcgap'}));
  // snippet / whole file. The toggle is only offered once there is an answer to
  // toggle, and it is the same key `f` presses.
  if(s && s.ok){
    const seg=el('span',{className:'seg mini', title:t('src.mode.title')},[
      el('button',{className: SRC.whole?'':'on', textContent:t('src.mode.snippet'), onclick:()=>{ if(SRC.whole) srcToggleWhole(); }}),
      el('button',{className: SRC.whole?'on':'', textContent:t('src.mode.whole'), onclick:()=>{ if(!SRC.whole) srcToggleWhole(); }}),
    ]);
    kids.push(seg);
  }
  // Open in editor. The absolute path is the SERVER's — this page never builds
  // one — and `none` hands it over to be pasted instead.
  const pick=srcEditorNow();
  const sel=el('select',{title:t('src.editor.title')}, SRC_EDITORS.map(([id,label])=>
    el('option',{value:id, textContent:label, selected:id===pick})));
  sel.value=pick;
  sel.onchange=(e)=>{ lsSet(LS_EDITOR, e.target.value); srcRenderHead(); };
  kids.push(sel);
  if(s && s.abs){
    const line=s.mark!=null ? s.mark : (s.from||1);
    const spec=SRC_EDITORS.find((x)=>x[0]===pick);
    if(spec && spec[2]){
      const a=el('a',{className:'srcopen', title:t('src.open.title'), textContent:t('src.open')});
      // The ATTRIBUTE, not the property: an href a browser can follow, and one
      // a test can read back as the string this page actually wrote.
      a.setAttribute('href', spec[2](s.abs, line));
      kids.push(a);
    }
    else {
      const b=el('button',{className:'mini', title:t('src.copyabs.title'), textContent:t('src.copyabs')});
      b.onclick=()=> srcCopy(s.abs+':'+line, b, 'src.copied');
      kids.push(b);
    }
  }
  kids.push(el('button',{className:'mini', title:t('src.close'), textContent:'✕', onclick:()=>srcClose()}));
  hd.replaceChildren(...kids);
}
function srcRenderBody(){
  const body=byId('srcbody');
  if(SRC.error){ body.replaceChildren(errPanel(SRC.error)); return; }
  const s=SRC.resp;
  if(!s){ body.replaceChildren(el('div',{className:'srcmsg', textContent:t('load.source')})); return; }
  if(!s.ok){ body.replaceChildren(el('div',{className:'srcmsg', textContent:s.note||t('src.none')})); return; }
  const text = SRC.whole ? (s.text||'') : (s.snippet||'');
  const base = SRC.whole ? 1 : (s.from||1);
  const lines = String(text).split('\n');
  const code=el('div',{className:'srccode'});
  let firstMark=-1;
  // WHICH LINES THE ANSWER IS ABOUT. Normally the whole range the extractor
  // cut; where the cut is a whole file with a `mark` inside it (a screen's
  // component), the mark alone, or every line of the file would be lit.
  const one = s.mark!=null ? s.mark : null;
  for(let i=0;i<lines.length;i++){
    const no=base+i;
    const hi = one!=null ? (no===one) : (s.from!=null && s.to!=null && no>=s.from && no<=s.to);
    if(hi && firstMark<0) firstMark=i;
    code.append(el('div',{className:'srcln'+(hi?' hi':'')},[
      el('span',{className:'srcno', textContent:String(no)}),
      el('span',{className:'srctx'}, srcPaintLine(lines[i], s.lang)),
    ]));
  }
  const kids=[code];
  if(s.note) kids.unshift(el('div',{className:'srcmsg', textContent:s.note}));
  body.replaceChildren(...kids);
  // Three lines of context above the mark, so the reader sees what it sits in.
  if(firstMark>=0) srcScrollTo(body, code, Math.max(0, firstMark-SRC_CTX));
  // ...and the card that asked keeps its six lines, off this very answer.
  if(SRC.excerpt && SRC.excerpt.node===SRC.node && SRC.excerpt.el && !SRC.whole){
    SRC.excerpt.el.replaceChildren(el('div',{className:'srcexc',
      textContent: lines.slice(0, SRC_EXCERPT).join('\n') + (lines.length>SRC_EXCERPT ? '\n…' : '')}));
  }
}
/** Scroll one row of the code to the top of the pane, measured, never assumed. */
function srcScrollTo(body, code, index){
  const rows=code.children||[];
  const target=rows[index];
  if(!target || !target.getBoundingClientRect || !body.getBoundingClientRect) return;
  const bt=body.getBoundingClientRect().top, tt=target.getBoundingClientRect().top;
  if(Number.isFinite(bt) && Number.isFinite(tt)) body.scrollTop=(body.scrollTop||0)+(tt-bt);
}
/** One line, split into plain and coloured runs by the language's own patterns. */
function srcPaintLine(line, lang){
  const rules=SRC_PAINT[lang];
  if(!rules) return [String(line)];
  const marks=[];
  for(const [re, cls] of rules){
    re.lastIndex=0;
    let m;
    while((m=re.exec(String(line)))!==null){
      if(m[0]==='') { re.lastIndex++; continue; }
      const a=m.index, b=a+m[0].length;
      if(marks.some((x)=> a<x.b && b>x.a)) continue;   // the first rule wins the run
      marks.push({a, b, cls});
    }
  }
  if(!marks.length) return [String(line)];
  marks.sort((x,y)=>x.a-y.a);
  const out=[]; let at=0;
  for(const mk of marks){
    if(mk.a>at) out.push(String(line).slice(at, mk.a));
    out.push(el('span',{className:mk.cls, textContent:String(line).slice(mk.a, mk.b)}));
    at=mk.b;
  }
  if(at<String(line).length) out.push(String(line).slice(at));
  return out;
}
// The footer answers WHY this code is in the answer: the grade of the edge that
// led here and the one sentence the engine gave for it. The row card already
// carries both, so the reader does not have to go back for them.
function srcRenderFoot(){
  const ft=byId('srcft');
  if(!SRC.grade && !SRC.basis){ ft.classList.add('hidden'); ft.replaceChildren(); return; }
  ft.classList.remove('hidden');
  ft.replaceChildren(
    el('span',{textContent:t('src.why')}),
    SRC.grade? badge(SRC.grade) : null,
    SRC.basis? el('span',{className:'id', textContent:SRC.basis}) : null);
}
// ---- the keyboard, while the pane is open -----------------------------------
// Escape closes (the page's one Escape rule owns that); j/k and the arrows
// scroll a line; `f` swaps the snippet for the whole file.
const SRC_LINE=21;
function srcKeydown(e){
  if(!SRC.open) return false;
  const tag=e.target && e.target.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return false;
  const body=byId('srcbody');
  if(e.key==='j'||e.key==='ArrowDown'){ body.scrollTop=(body.scrollTop||0)+SRC_LINE; return true; }
  if(e.key==='k'||e.key==='ArrowUp'){ body.scrollTop=Math.max(0,(body.scrollTop||0)-SRC_LINE); return true; }
  if(e.key==='f'){ srcToggleWhole(); return true; }
  return false;
}
function srcWire(){
  const grab=byId('srcgrab');
  let dragging=false;
  grab.addEventListener('mousedown',(e)=>{ dragging=true; grab.classList.add('on'); if(e.preventDefault) e.preventDefault(); });
  document.addEventListener('mousemove',(e)=>{
    if(!dragging) return;
    const vw=(typeof window!=='undefined' && window.innerWidth) || 1400;
    srcSetWidth(vw-(e.clientX||0));
  });
  document.addEventListener('mouseup',()=>{ if(!dragging) return; dragging=false; grab.classList.remove('on'); });
}
/** Every tab that used to draw its own preview says the same thing now. */
function showSource(nodeId, opts){ srcOpen(nodeId, opts); }

const pickKey = (tab, id) => tab + '|' + id;
function pickRemember(tab, id, payload){
  PICKMEM.set(pickKey(tab, id), payload);
  while(PICKMEM.size > PICKMEM_MAX) PICKMEM.delete(PICKMEM.keys().next().value);
}
/** Record a pick and push it into the browser's history. */
function pickSet(tab, id){
  if(!Object.hasOwn(PICK, tab) || !id) return;
  const changed = PICK[tab] !== id;
  PICK[tab] = id;
  if(changed) writeHash(true);
  refreshShowAll();
}
/** Mark the rail row this pick belongs to, without re-rendering the list. */
function railSyncPick(tab, kind, key){
  if(!RAILDEF[tab]) return;
  RAIL[tab].sel = key; RAIL[tab].selKind = kind;
  railMarkSel(tab);
}
/**
 * Put a tab back on one pick, for the Back button. An answer still in memory is
 * re-drawn from memory and asks the server for NOTHING; one that has fallen out
 * of the memo is asked for again, the same way the original click asked.
 */
function pickRestore(tab, id){
  if(PICK[tab] === id) return;
  if(!id){ showAll(tab, true); return; }
  const memo = PICKMEM.get(pickKey(tab, id));
  if(memo) pickDrawFrom(tab, id, memo); else pickAsk(tab, id);
}
function pickDrawFrom(tab, id, memo){
  const kind = id.slice(0, id.indexOf(':')), key = id.slice(id.indexOf(':') + 1);
  PICK[tab] = id;
  if(tab === 'explore'){
    if(memo.table) renderTableAnswer(key, memo.table);
    else if(memo.column) renderColumnAnswer(key, memo.column.ci, memo.column.ei);
    else if(memo.screen) renderScreenAnswer(key, memo.screen);
    else srcOpen(id, { tab:'explore', push:false });
  } else if(tab === 'flow' || tab === 'impact'){
    const v = tab === 'flow' ? FLOWV : IMPACTV;
    v.resp = memo.r; v.sel = null; v.limit = memo.limit || 40;
    byId(v.entryId).value = memo.raw != null ? memo.raw : key;
    renderChain(v, memo.r);
  }
  railSyncPick(tab, kind, key);
  refreshShowAll();
}
function pickAsk(tab, id){
  const at = id.indexOf(':');
  if(at < 0) return;
  const kind = id.slice(0, at), key = id.slice(at + 1);
  if(tab === 'explore'){
    railSyncPick(tab, kind, key);
    if(kind === 'table') showTable(key);
    else if(kind === 'column') showColumn(key);
    else if(kind === 'screen') showScreen(key);
    else { PICK[tab] = id; srcOpen(id, { tab:'explore', push:false }); }
    return;
  }
  if(tab === 'flow'){ railSyncPick(tab, kind, key);
    openFlow(kind === 'symbol' ? { symbol:key } : kind === 'screen' ? { screen:key } : { endpoint:key }); return; }
  if(tab === 'impact'){ railSyncPick(tab, kind, key); openImpact({ [kind]:key }); return; }
  if(tab === 'graph'){ openGraph(id); return; }
  if(tab === 'erd'){ openErd(key); return; }
}

/**
 * Back to this tab as it opened. The SAME sentence on all five: nothing picked,
 * nothing filtered, nothing folded open, no highlight, no source pane.
 * @param {string} tab
 * @param {boolean} [quiet]  true when a URL is being applied, so write no new one
 */
function showAll(tab, quiet){
  if(!Object.hasOwn(SHOWALL, tab)) return;
  const was = HASHLOCK;
  HASHLOCK = true;
  try {
    if(SRC.open) srcClose();
    PICK[tab] = null;
    if(RAILDEF[tab]){
      const R = RAIL[tab], D = RAILDEF[tab];
      const input = byId(D.inputId); if(input) input.value = '';
      R.typed = '';
      R.sel = null; R.selKind = null;
      R.closedGroups.clear(); R.openTables.clear();
      railCloseDrawer(tab);
      // The KIND is part of a tab's opening state. A reader who drilled into
      // Statements and pressed this expects the first screen back, which is the
      // list this tab opens on; the answer for it is the one the tab loaded on
      // its way in, so this costs no request.
      if(R.kind !== D.kind) railSetKind(tab, D.kind);
      // The one list that cannot exist without a query goes back to saying so.
      if(R.kind === 'symbol'){ R.rows = []; R.hays = []; R.resp = null; R.more = false; R.needQuery = true; }
      railRender(tab);
      const list = byId(D.listId); if(list) list.scrollTop = 0;
    }
    if(tab === 'explore'){ view.replaceChildren(); railIdle('explore'); }
    if(tab === 'flow' || tab === 'impact'){
      const v = tab === 'flow' ? FLOWV : IMPACTV;
      v.seq++; v.resp = null; v.sel = null; v.pick = null; v.limit = 40;
      v.rows.clear(); v.linkSpecs = []; v.paths = []; v.layerOpen.clear();
      const w = vwrap(v); w.classList.remove('layersmode'); w.replaceChildren();
      vside(v).replaceChildren();
      closeSug(v);
      railIdle(tab);
    }
    if(tab === 'graph'){
      byId('gfocus').value = ''; GMAP.find = '';
      closeSug(GRAPHV);
      if(GRAPHV.mode !== 'map') graphMode('map');
      // Fold everything the reader opened, drop the spotlight, and fit.
      if(mapFoldAll()){ GMAP.sel = null; GMAP.hover = null; mapRebuild(); }
      else mapClear();
      if(GMAP.api) mapRefit();
    }
    if(tab === 'erd'){
      byId('etable').value = '';
      // The highlight is dropped whether or not a renderer is mounted: the
      // picture may not be drawn yet, and "nothing is highlighted" is still the
      // state this control promises.
      ERD.sel = null; ERD.lit = null;
      if(erdClearFn) erdClearFn();
      if(erdResetFn) erdResetFn();
    }
  } finally { HASHLOCK = was; }
  if(!quiet) writeHash(true);
  refreshShowAll();
}
/** Is this tab showing something narrower than what it opened on? */
function tabNarrowed(tab){
  if(srcFor(tab)) return true;
  if(tab === 'explore'){
    if(RAIL.explore.sel !== null || railTyped('explore')) return true;
    // An answer standing where the lead card was is a narrowing too: a search,
    // a table, a column, the edits panel.
    return view.hasChildNodes() && view.querySelector('.brlead') == null;
  }
  if(tab === 'flow' || tab === 'impact'){
    const R = RAIL[tab], v = tab === 'flow' ? FLOWV : IMPACTV;
    return !!v.resp || R.sel !== null || !!railTyped(tab)
      || R.closedGroups.size > 0 || R.openTables.size > 0;
  }
  if(tab === 'graph'){
    return GRAPHV.mode !== 'map' || !!GMAP.sel || GMAP.open.size > 0 || !!byId('gfocus').value.trim();
  }
  if(tab === 'erd') return !!ERD.sel || !!byId('etable').value.trim();
  return false;
}
function refreshShowAll(){
  for(const tab of Object.keys(SHOWALL)){
    const b = byId(SHOWALL[tab]);
    if(!b) continue;
    const on = tabNarrowed(tab);
    b.disabled = !on;
    if(on) b.removeAttribute('disabled'); else b.setAttribute('disabled', '');
  }
}
// ONE ESCAPE RULE for the whole page, in one place, so no two handlers can
// disagree about what the key means. In order: the source pane, the browse
// drawer, the Graph tab's own Escape (unchanged), then the tab reset — and that
// last one is TWO STEPS when a box has the focus, because a reader clearing a
// filter did not ask for the picture to go too.
function escapeRule(e){
  if(e.key !== 'Escape') return;
  if(SRC.open){ srcClose(); return; }
  if(RAILOPEN){ railCloseDrawer(RAILOPEN); return; }
  const tab = STATE.tab;
  if(tab === 'graph'){ graphEscape(); return; }
  if(!Object.hasOwn(SHOWALL, tab)) return;
  const box = e.target;
  if(box && (box.tagName === 'INPUT' || box.tagName === 'TEXTAREA') && box.value){
    box.value = '';
    if(RAILDEF[tab]){ railTakeTyped(tab); railFilterNow(tab); }
    refreshShowAll();
    return;
  }
  showAll(tab);
}

// ---------- Explore tab ----------
// ASKING and DRAWING are two functions, not one: the Back button re-draws a
// picture from the answer already in memory, and it can only do that if the
// drawing does not have a request wired into it.
async function showColumn(colId) {
  const key = colId.startsWith('column:') ? colId.slice(7) : colId;
  view.replaceChildren(el('div',{className:'panel', textContent:'querying '+key+' …'}));
  try {
    const [ci, ei] = await Promise.all([ api('column_impact',{column:key,mode:'both'}), api('endpoint_impact',{column:key}) ]);
    pickRemember('explore', 'column:'+key, { column:{ ci, ei } });
    renderColumnAnswer(key, ci, ei);
    pickSet('explore', 'column:'+key);
  } catch(e){ if(stale(e)) return; view.replaceChildren(errPanel(e)); }
}
function renderColumnAnswer(key, ci, ei) {
  {
    const stmts = ci.answer.statements||[];
    const stmtPanel = listPanel('SQL statements', ci.truncated?.fields?.[0]?.total ?? stmts.length, stmts,
      (s)=> el('li',{}, [ el('a',{className:'id clickable', textContent:s.id, title:'view SQL', onclick:()=>showSource('statement:'+s.id)}), el('span',{}, [ el('span',{className:'tag '+s.access, textContent:s.access}), ' ', badge(s.grade) ]) ]),
      ci.answer.empty, 'statements');
    const eps = ei.answer.endpoints||[];
    const epPanel = listPanel('HTTP endpoints affected', ei.truncated?.fields?.[0]?.total ?? eps.length, eps,
      (e)=> el('li',{}, [ epName(e, el('a',{className:'id clickable', textContent:e.httpMethod+' '+e.path, title:'view handler (controller) source', onclick:()=>showSource('endpoint:'+e.id)})),
        el('span',{style:'display:flex;align-items:center;gap:6px'},[ flowRowButton(e, e.id), badge(e.grade) ]) ]), ei.answer.empty, 'endpoints');
    const head = el('div',{className:'panel'}, [
      el('h2',{textContent:'column'}),
      el('div',{}, [ el('span',{className:'id', textContent:key}), '  ',
        el('button',{textContent:'DDL', title:'view CREATE TABLE', onclick:()=>showSource('column:'+key)}), ' ',
        el('button',{textContent:'Impact', title:t('btn.impact.column.title'), onclick:()=>openImpact({column:key})}), ' ',
        el('button',{textContent:'Graph', onclick:()=>openGraph('column:'+key)}) ]),
      ci.answer.comment ? el('div',{className:'comment', textContent:'“'+ci.answer.comment+'”'+(ci.answer.type?'\u00a0\u00a0'+ci.answer.type:'')}) : null
    ]);
    view.replaceChildren(head, el('div',{className:'cols'},[stmtPanel, epPanel]), honesty(ei, 'explore'));
  }
  refreshShowAll();
}
async function showTable(table) {
  view.replaceChildren(el('div',{className:'panel', textContent:'querying '+table+'…'}));
  try {
    const r = await api('table_usage',{table});
    pickRemember('explore', 'table:'+table, { table:r });
    renderTableAnswer(table, r);
    pickSet('explore', 'table:'+table);
  } catch(e){ if(stale(e)) return; view.replaceChildren(errPanel(e)); }
}
function renderTableAnswer(table, r) {
  {
    const a = r.answer;
    const stmtPanel = listPanel('statements touching '+table, r.truncated?.fields?.[0]?.total ?? (a.statements||[]).length, a.statements||[],
      (s)=> el('li',{}, [ el('a',{className:'id clickable',textContent:s.id, title:'view SQL', onclick:()=>showSource('statement:'+s.id)}), el('span',{className:'tag',textContent:s.access}) ]), a.empty, 'statements');
    const colPanel = listPanel('columns (read/write counts)', (a.columns||[]).length, a.columns||[],
      (c)=> el('li',{}, [ el('a',{className:'id',textContent:c.column, onclick:()=>showColumn(c.column)}),
        el('span',{}, [ el('span',{className:'tag read',textContent:'r '+c.reads}), ' ', el('span',{className:'tag write',textContent:'w '+c.writes}) ]) ]), a.empty, 'columns');
    view.replaceChildren(el('div',{className:'panel'},[el('h2',{textContent:'table'}), el('div',{},[el('span',{className:'id',textContent:table}),'  ',el('button',{textContent:'ERD',onclick:()=>openErd(table)}),' ',el('button',{textContent:'Impact',title:t('btn.impact.table.title'),onclick:()=>openImpact({table})}),' ',el('button',{textContent:'Graph',onclick:()=>openGraph('table:'+table)})])]),
      el('div',{className:'cols'},[stmtPanel,colPanel]), honesty(r, 'explore'));
  }
  refreshShowAll();
}
// ---------- Explore: one SCREEN, from one answer -----------------------------
// The far end of the round trip, read the way a table is read. The card is ONE
// `flow screen=` answer: what the route mounts, the functions that component
// runs, the API routes those functions reach and the tables the request ends
// at. Nothing here is counted or walked by the page.
async function showScreen(path) {
  view.replaceChildren(el('div',{className:'panel', textContent:t('load.screen')}));
  try {
    const r = await api('flow',{ screen:path, depth:8, limit:200 });
    pickRemember('explore', 'screen:'+path, { screen:r });
    renderScreenAnswer(path, r);
    pickSet('explore', 'screen:'+path);
  } catch(e){ if(stale(e)) return; view.replaceChildren(errPanel(e)); }
}
function renderScreenAnswer(path, r) {
  const a=r.answer, e=a.entry||{};
  // WHICH of these functions actually sends the request: the ones the ANSWER's
  // endpoint rows hang off. Everything else the screen renders leads to one of
  // them. Read off the rows this answer carries, never re-derived — so a lane
  // the limit cut is a lane this reading does not claim to have seen.
  const senders=new Set((a.endpoints||[]).map(x=>x.link&&x.link.from).filter(Boolean));
  const srcOf=(id)=> srcOpen(id, { tab:'explore', push:false });
  const head=el('div',{className:'panel'},[
    el('h2',{textContent:t('screen.title')}),
    // WHAT IT IS on the left, WHAT YOU CAN DO on the right: the head row is a
    // space-between flex, so the buttons travel together in one box rather than
    // spreading themselves across the width of the card.
    el('div',{className:'srchead'},[
      el('span',{style:'display:flex;align-items:center;gap:8px;min-width:0'},[
        el('span',{className:'id',textContent:e.path||path}),
        e.group? el('span',{className:'tag',textContent:e.group}) : null,
        e.observed? el('span',{className:'tag',title:t('chain.tag.seen.title'),textContent:t('chain.tag.seen')}) : null ]),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        el('button',{className:'mini',textContent:'Source',title:t('src.open.title'),onclick:()=>srcOf('screen:'+path)}),
        el('button',{className:'mini',textContent:'Flow',title:t('btn.flow.screen.title'),onclick:()=>openFlow({screen:path})}),
        el('button',{className:'mini',textContent:'Graph',title:t('btn.graph.screen.title'),onclick:()=>openGraph('screen:'+path)}) ]),
    ]),
    e.title? el('div',{className:'comment',textContent:e.title}) : null,
    e.component? el('div',{className:'comment'},[ t('screen.component')+' ',
      el('a',{className:'id clickable',textContent:e.component,title:t('src.open.title'),
        onclick:()=>srcOf('screen:'+path)}) ]) : null,
    // A SERVER-RENDERED PAGE has no component: it has the template file the
    // view resolver found, and the route(s) whose handler renders it.
    e.template? el('div',{className:'comment'},[ t('screen.template')+' ',
      el('a',{className:'id clickable',textContent:e.template,title:t('src.open.title'),
        onclick:()=>srcOf('screen:'+path)}),
      e.engine? el('span',{className:'tag',textContent:e.engine}) : null ]) : null,
    (e.routes&&e.routes.length)? el('div',{className:'comment'},
      [ t('screen.renderedby')+' '+e.routes.join(', ') ]) : null,
    // Impact is not a button here and the card says why, rather than leaving a
    // reader to wonder where the other half of the pair went.
    el('div',{className:'comment',textContent:t('screen.noimpact')}),
  ]);
  const fnPanel=listPanel(t('screen.renders'), ovTotal(r,'webFunctions',(a.webFunctions||[]).length), a.webFunctions||[],
    (w)=> el('li',{},[
      el('a',{className:'id clickable',textContent:w.short,title:w.id,onclick:()=>srcOf('symbol:'+w.id)}),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        el('span',{className:'tag',
          title:t(senders.has('symbol:'+w.id)?'screen.sends.title':'screen.leadsto.title'),
          textContent:t(senders.has('symbol:'+w.id)?'screen.sends':'screen.leadsto')}),
        badge(w.grade) ]) ]), a.empty, 'webFunctions');
  const epPanel=listPanel(t('screen.endpoints'), ovTotal(r,'endpoints',(a.endpoints||[]).length), a.endpoints||[],
    (x)=> el('li',{},[
      epName(x, el('a',{className:'id clickable',textContent:x.id,title:flowRowTitle(x),onclick:()=>openFlowFor(x, x.id)})),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        x.observed? el('span',{className:'tag',title:t('chain.tag.seen.title'),textContent:t('chain.tag.seen')}) : null,
        badge(x.grade) ]) ]), a.empty, 'endpoints');
  const tblPanel=listPanel(t('screen.tables'), ovTotal(r,'tables',(a.tables||[]).length), a.tables||[],
    (x)=> el('li',{},[
      el('a',{className:'id clickable',textContent:x.table,title:t('btn.table.title'),onclick:()=>showTable(x.table)}),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        el('span',{className:'count',textContent:x.access||''}),
        badge(x.grade) ]) ]), a.empty, 'tables');
  view.replaceChildren(head, el('div',{className:'cols'},[fnPanel, epPanel]), tblPanel, honesty(r, 'explore'));
  refreshShowAll();
}
async function doSearch(q) {
  if (!q || q.length<2) return;
  view.replaceChildren(el('div',{className:'panel', textContent:t('load.search')}));
  try {
    const r = await api('search',{query:q}); const a = r.answer;
    const mk = (title, arr, key, click) => listPanel(title, null, arr,
      (x)=> el('li',{}, [ click ? el('a',{className:'id', textContent:x[key], onclick:()=>click(x[key])}) : el('span',{className:'id',textContent:x[key]}),
        x.comment? el('span',{className:'comment', textContent:x.comment}):null ]), a.empty, title.toLowerCase());
    view.replaceChildren(mk('Columns', a.columns||[], 'column', (c)=>showColumn(c)),
      mk('Tables', a.tables||[], 'table', (t)=>showTable(t)),
      mk('Statements', a.statements||[], 'statement', null), honesty(r, 'explore'));
  } catch(e){ if(stale(e)) return; view.replaceChildren(errPanel(e)); }
}
async function showEdits() {
  view.replaceChildren(el('div',{className:'panel', textContent:t('load.edits')}));
  try {
    const r = await api('changed_impact',{}); const a = r.answer;
    // The overlay header: WHICH session answered, and how much of the tree it
    // actually re-parsed. Without it a provisional row has no provenance.
    const o = a.overlay || null;
    const provSyms = new Set((o&&o.provisionalIds&&o.provisionalIds.symbols||[]).map(x=>x.replace(/^symbol:/,'')));
    const ovPanel = o ? el('div',{className:'panel'},[
      el('h2',{textContent: o.applied ? 'working-tree overlay '+String(o.overlaySessionId||'').slice(0,12) : 'overlay NOT applied ('+o.state+')'}),
      el('p',{className:'hint', textContent: o.applied
        ? ('re-parsed '+(o.parsedFiles.length+(o.parsedWebFiles||[]).length)+' file(s), dropped '
           +(o.droppedFiles.length+(o.droppedWebFiles||[]).length)+' — '
           +(o.provisionalIds.symbols.length+o.provisionalIds.endpoints.length+o.provisionalIds.statements.length)
           +' provisional node(s), '+o.provisionalEdges+' provisional edge(s)'
           +(o.timingsMs? '  ['+o.timingsMs.total+' ms: java '+o.timingsMs.java+', web '+(o.timingsMs.web||0)+', sql '+o.timingsMs.sql+', graph '+o.timingsMs.build+']':''))
        : (o.reason||'')}),
      o.applied && (o.parsedFiles.length+(o.parsedWebFiles||[]).length) ? el('ul',{className:'list'}, [...o.parsedFiles, ...(o.parsedWebFiles||[])].sort().map(f=>el('li',{},[
        el('span',{className:'id',textContent:f}),
        el('span',{className:'tag',textContent:'re-parsed'+(o.docVersions&&o.docVersions[f]? ' @'+String(o.docVersions[f]).slice(0,8):'')})]))) : null
    ]) : null;
    const files = el('div',{className:'panel'},[
      el('h2',{textContent:'changed files ('+a.changedFiles+')'}),
      el('ul',{className:'list'}, (a.files.matched.length?a.files.matched:['—']).map(f=>el('li',{},[el('span',{className:'id',textContent:f}), el('span',{className:'tag',textContent:'matched'})]))),
      a.files.unmatched.length ? el('ul',{className:'list'}, a.files.unmatched.map(f=>el('li',{},[el('span',{className:'id',textContent:f}), el('span',{className:'tag warn',textContent:t('edits.nonode')})]))) : null,
      // A frontend file the lane READ that carries no HTTP call is not "impact
      // unknown": it was looked at, and there was nothing in it.
      (a.files.readNoFacts||[]).length ? el('ul',{className:'list'}, a.files.readNoFacts.map(f=>el('li',{},[el('span',{className:'id',textContent:f}), el('span',{className:'tag',textContent:t('edits.readnofacts')})]))) : null
    ]);
    const totalOf = (field, fallback)=>{
      const f=(r.truncated&&r.truncated.fields||[]).find(x=>x.field===field);
      return f? f.total : fallback;
    };
    const tsym = a.touched.symbols||[];
    const symPanel = tsym.length ? listPanel(t('edits.methods'), tsym.length, tsym,
      (s)=> el('li',{className: provSyms.has(s)?'prov':''}, [ el('a',{className:'id clickable', textContent:s, title:'view source', onclick:()=>showSource('symbol:'+s)}), provSyms.has(s)? el('span',{className:'tag prov',textContent:'provisional'}):null ]), {}, 'symbols') : null;
    // The frontend functions in the edited files. Their blast radius runs the
    // other way, so they get their own panel and their own list beside it.
    const wsym = a.touched.webSymbols||[];
    const webPanel = wsym.length ? listPanel(t('edits.web'), wsym.length, wsym,
      (s)=> el('li',{className: provSyms.has(s)?'prov':''}, [ el('a',{className:'id clickable', textContent:s, title:'view source', onclick:()=>showSource('symbol:'+s)}), provSyms.has(s)? el('span',{className:'tag prov',textContent:'provisional'}):null ]), {}, 'webSymbols') : null;
    // The SCREENS those functions are drawn on: editing a component changes a
    // screen, and that is the answer a reader of a `.vue` diff is after.
    const tscr = a.touched.screens||[];
    const screenPanel = tscr.length ? listPanel(t('edits.screens'), tscr.length, tscr,
      (s)=> el('li',{}, [ el('span',{className:'id', textContent:s}) ]), {}, 'screens') : null;
    const eps = a.upstreamEndpoints||[];
    const epPanel = listPanel(t('edits.upstream'), totalOf('upstreamEndpoints', eps.length), eps,
      (e)=> el('li',{className:e.provisional?'prov':''}, [ el('a',{className:'id clickable',textContent:e.id, title:'view handler source', onclick:()=>showSource('endpoint:'+e.id)}), badge(e.grade),
        // How many frontend functions call this route: an edit here reaches them too.
        e.frontendCalls? el('span',{className:'tag', title:t('edits.frontendcalls.title'), textContent:t('edits.frontendcalls',{n:e.frontendCalls})}):null,
        e.provisional? el('span',{className:'tag prov',textContent:'provisional'}):null ]), a.empty, 'upstreamEndpoints');
    const called = a.calledEndpoints||[];
    const calledPanel = wsym.length ? listPanel(t('edits.called'), totalOf('calledEndpoints', called.length), called,
      (e)=> el('li',{className:e.provisional?'prov':''}, [ el('a',{className:'id clickable',textContent:e.id, title:'view handler source', onclick:()=>showSource('endpoint:'+e.id)}), badge(e.grade), e.provisional? el('span',{className:'tag prov',textContent:'provisional'}):null ]), a.empty, 'calledEndpoints') : null;
    const cols = a.downstreamColumns||[];
    const colPanel = listPanel(t('edits.downstream'), totalOf('downstreamColumns', cols.length), cols,
      (c)=> el('li',{className:c.provisional?'prov':''}, [ el('a',{className:'id',textContent:c.id, onclick:()=>showColumn('column:'+c.id)}), badge(c.grade), c.provisional? el('span',{className:'tag prov',textContent:'provisional'}):null ]), a.empty, 'downstreamColumns');
    setKids(view, ovPanel, files, symPanel, webPanel, screenPanel, calledPanel, el('div',{className:'cols'},[epPanel,colPanel]), honesty(r, 'edits'));
  } catch(e){ if(stale(e)) return; view.replaceChildren(errPanel(e)); }
}
// WHICH END OF THE ROUND TRIP the Flow rail lists, remembered per project. A
// reader working on a frontend opens Flow on the screens; a reader working on
// the API opens it on the routes, and neither should have to say so twice. It
// is per project because it is a fact about the project, not about the browser.
const LS_FLOWKIND = 'cascade.viewer.flowkind.';
const railRememberedKind = (tab) => (tab === 'flow' && STATE.project)
  ? lsGet(LS_FLOWKIND + STATE.project) : null;
function railRememberKind(tab, kind){
  if (tab === 'flow' && STATE.project) lsSet(LS_FLOWKIND + STATE.project, kind);
}
/** Which of the three tabs is on screen, or null. */
function railVisibleTab(){
  for (const tab of RAILTABS) if (!byId('tab-'+tab).classList.contains('hidden')) return tab;
  return null;
}
/**
 * WHAT THE READER TYPED into this tab's box, and nothing else.
 *
 * A PICK IS NOT A FILTER. On Flow and Impact the box does double duty: it
 * filters the rail AND names the chain to draw, so `openFlow`, a restore from
 * `#…&pick=`, and a hand-off from another tab all WRITE the picked id into it.
 * Reading the box back as the filter turned every one of those into a filter:
 * a reload on a pick showed `1 shown of 239` and one row, with the list the
 * reader came for thrown away. So the filter lives here, set only by the box's
 * own `input` event, and text the PAGE puts in the box narrows nothing.
 */
function railTyped(tab){ return RAIL[tab].typed || ''; }
/** Take the box's text as a filter. Called from its `input` event, and nowhere else. */
function railTakeTyped(tab){
  const input = byId(RAILDEF[tab].inputId);
  RAIL[tab].typed = input && input.value ? String(input.value).trim() : '';
}
const railId = (kind, row) => String(row[RAIL_IDFIELD[kind]]);
/**
 * What a row is CALLED on screen.
 *
 * A route reads "METHOD /path". A STATEMENT and a METHOD read SHORT: the rail
 * is 320px wide, and `com.macro.mall.dao.PmsProductDao.getUpdateInfo` spends
 * all of it on a package prefix every row on the list shares, so every row
 * ellipsized to `com.macro.mall.dao.PmsProduct…` and the part that tells them
 * apart was the part that was cut. The short form is the SAME rule the chain
 * lanes and the graph cards use (`shortId`), so one thing has one name on this
 * page; the full id is in the row's `title` and is what a filter matches.
 */
function railLabel(kind, row){
  if (kind === 'endpoint') return (row.httpMethod ? row.httpMethod + ' ' : '') + (row.path || row.endpoint);
  if (kind === 'statement' || kind === 'symbol') return shortId(kind + ':' + railId(kind, row));
  // A screen's LABEL is whatever the profile's pathRule made of its path, and
  // the path itself when there is no rule. The path is under it when the two
  // differ, so nothing about the route is lost to the shortening.
  if (kind === 'screen') return row.label || row.screen;
  return railId(kind, row);
}
/** The text a filter matches: the id plus the row's own second line. */
function railHay(kind, row){
  if (kind === 'table') return (row.table + ' ' + (row.comment || '')).toLowerCase();
  if (kind === 'column') return (row.column + ' ' + (row.comment || '')).toLowerCase();
  if (kind === 'statement') return (row.statement + ' ' + (row.file || '')).toLowerCase();
  if (kind === 'endpoint') return ((row.httpMethod || '') + ' ' + (row.path || '') + ' ' + (row.handlerShort || '')).toLowerCase();
  if (kind === 'screen') return (row.screen + ' ' + (row.label || '') + ' ' + (row.title || '') + ' ' + (row.component || '') + ' ' + (row.template || '')).toLowerCase();
  return String(row.symbol || '').toLowerCase();
}

// ---- asking, once per tab ---------------------------------------------------
async function railLoad(tab, append){
  const R = RAIL[tab];
  const args = { kind:R.kind, limit:RAIL_PAGE };
  if (R.sort) args.sort = R.sort;
  if (append) args.offset = R.rows.length;
  if (R.kind === 'symbol') {
    // The one kind the server will not list whole. Until two letters are typed
    // the rail says so instead of asking for ten thousand rows.
    const q = railTyped(tab);
    if (q.length < 2) { R.resp = null; R.rows = []; R.hays = []; R.more = false; R.needQuery = true; railRender(tab); return; }
    args.query = q;
  }
  R.needQuery = false;
  R.loading = true;
  const mine = ++R.seq;
  let r;
  try { r = await api('browse', args); }
  catch(e){ if (stale(e) || mine !== R.seq) return; R.loading = false; R.error = e; railRender(tab); return; }
  if (mine !== R.seq) return;
  R.loading = false; R.error = null; R.resp = r;
  const items = r.answer.items || [];
  R.rows = append ? R.rows.concat(items) : items.slice();
  R.hays = R.rows.map((row) => railHay(R.kind, row));
  R.counts = r.answer.counts || R.counts;
  R.more = ((r.truncated && r.truncated.fields) || []).some((f) => f.field === 'items' && f.nextOffset != null);
  railRender(tab);
  railIdle(tab);
}
/** A tab coming on screen: draw what is in memory, and ask ONCE if there is none. */
function railOpenTab(tab){
  const R = RAIL[tab];
  // The remembered kind is applied HERE and not in railFresh: this rail is
  // built before the page knows which project it is looking at, and the
  // preference belongs to the project.
  if (!R.resp && !R.loading) {
    const want = railRememberedKind(tab);
    if (want && want !== R.kind && RAILDEF[tab].kinds.includes(want)) {
      R.kind = want;
      R.sort = railDefaultSort(tab, want);
    }
  }
  railRender(tab);
  if (!R.resp && !R.loading && !R.needQuery) railLoad(tab, false);
  else railIdle(tab);
  railPaneApply(tab);
}
function railSetKind(tab, kind){
  const R = RAIL[tab];
  if (R.kind === kind) return;
  railStash(tab);
  railRememberKind(tab, kind);
  R.kind = kind;
  R.sort = railDefaultSort(tab, kind);
  R.sel = null; R.selKind = null; R.openTables.clear(); R.cols.clear(); R.closedGroups.clear();
  // A list this rail has already been shown is drawn again from memory. Only a
  // kind it has never asked for is a request.
  if (railUnstash(tab, kind)) { railRender(tab); railIdle(tab); return; }
  R.rows = []; R.hays = []; R.shown = []; R.resp = null; R.more = false;
  railLoad(tab, false);
}
/** Put the list on screen aside, under the kind it is a list of. */
function railStash(tab){
  const R = RAIL[tab];
  if (!R.resp && !R.needQuery) return;
  R.byKind.set(R.kind, { resp:R.resp, rows:R.rows, hays:R.hays, more:R.more,
    sort:R.sort, needQuery:R.needQuery });
}
/** Take one back. False when this rail has never asked for that kind. */
function railUnstash(tab, kind){
  const R = RAIL[tab];
  const kept = R.byKind.get(kind);
  if (!kept) return false;
  R.resp = kept.resp; R.rows = kept.rows; R.hays = kept.hays;
  R.more = kept.more; R.sort = kept.sort; R.needQuery = kept.needQuery;
  R.error = null; R.loading = false;
  return true;
}

// ---- drawing it -------------------------------------------------------------
function railRender(tab){
  railApplyFilter(tab);
  railRenderChips(tab);
  railRenderSort(tab);
  railRenderCount(tab);
  railRenderRows(tab);
  railRenderMore(tab);
  refreshShowAll();
}
/** The filter: a substring test over the rows already here. No request. */
function railApplyFilter(tab){
  const R = RAIL[tab];
  const q = railTyped(tab).toLowerCase();
  R.q = q;
  R.shown = q ? R.rows.filter((row, i) => R.hays[i].includes(q)) : R.rows.slice();
  // Flow reads by module, so its rows sit under the API group the SERVER put on
  // each of them. A stable sort by that label keeps the server's order inside
  // every group.
  if (tab === 'flow') {
    const order = [];
    for (const row of R.shown) if (!order.includes(row.group)) order.push(row.group);
    R.shown = R.shown.slice().sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  }
}
function railRenderChips(tab){
  const D = RAILDEF[tab];
  if (!D.chipsId) return;
  const R = RAIL[tab];
  const box = byId(D.chipsId);
  // FLOW'S SWITCH IS ONLY A SWITCH WHERE THERE IS SOMETHING TO SWITCH TO. On a
  // pack with no frontend the `Screens` half would list nothing for ever, so
  // the whole control stands down rather than offering a dead half. Read off
  // the answer's own kind census, never guessed.
  if (tab === 'flow') {
    // Not yet answered counts as "no": a control that appears and then vanishes
    // under the pointer is worse than one that arrives with its own numbers.
    const none = R.counts == null || !R.counts.screen;
    box.classList.toggle('hidden', none);
    if (none) { box.replaceChildren(); return; }
  }
  box.title = tab === 'flow' ? t('rail.flowkind.title') : '';
  box.replaceChildren(...D.kinds.map((k) => el('button', {
    className: k === R.kind ? 'on' : '',
    title: k === 'symbol' ? t('rail.kind.symbol.hint') : (k === 'endpoint' ? (railOutboundNote(tab) || '') : ''),
    onclick: () => railSetKind(tab, k),
  }, [
    t(RAIL_KIND_KEY[k]),
    // Methods carry no total: they cannot be listed until two letters are typed,
    // so a number beside them would promise a list this rail will not show.
    (k !== 'symbol' && R.counts && R.counts[k] != null)
      ? el('span', { className:'brn', textContent: ovNum(R.counts[k]) }) : null,
  ])));
}
/**
 * The masthead says `endpoints 978` on jeecg and this rail says `969`, and a
 * reader who sees both is looking at a bug report until somebody connects them.
 * BOTH numbers are answered: the census on the Overview counts every endpoint
 * node, `browse` counts the ones this pack SERVES, and the nine in between are
 * routes it calls and does not serve. The only arithmetic here is the
 * difference between two answers already on the screen, and it is only said
 * when there IS one.
 * @returns {string|null}
 */
function railOutboundNote(tab){
  const R = RAIL[tab];
  const served = R.counts && R.counts.endpoint;
  const a = OV.resp && OV.resp.answer;
  if (served == null || !a) return null;
  const node = (a.nodes || []).find((n) => n.kind === 'endpoint');
  if (!node || node.count == null) return null;
  const extra = node.count - served;
  if (!(extra > 0)) return null;
  return t('rail.count.outbound', { n: served, m: extra });
}
function railRenderSort(tab){
  const R = RAIL[tab], sel = byId(RAILDEF[tab].sortId);
  const sorts = RAIL_SORTS[R.kind];
  const cur = R.sort || railDefaultSort(tab, R.kind);
  sel.replaceChildren(...sorts.map((s) => el('option', { value:s, textContent:t(RAIL_SORT_KEY[s]), selected:s === cur })));
  sel.value = cur;
  sel.classList.toggle('hidden', sorts.length < 2);
}
function railRenderCount(tab){
  const R = RAIL[tab];
  const box = byId(RAILDEF[tab].countId);
  if (!R.resp) { box.replaceChildren(); box.classList.remove('brwide'); return; }
  const note = R.kind === 'endpoint' ? railOutboundNote(tab) : null;
  box.classList.toggle('brwide', !!note);
  setKids(box, t('rail.count', { n:R.shown.length, m:R.resp.answer.total }),
    note ? el('span', { className:'brout', textContent:note }) : null);
}
function railRenderMore(tab){
  const R = RAIL[tab], foot = byId(RAILDEF[tab].moreId);
  if (!R.more) { foot.replaceChildren(); return; }
  foot.replaceChildren(
    el('button', { className:'mini', textContent:t('rail.more'), title:t('rail.more.title'),
      onclick: () => railLoad(tab, true) }),
    el('span', { className:'brcount', textContent:String(R.rows.length) }));
}
function railRenderRows(tab){
  const R = RAIL[tab], list = byId(RAILDEF[tab].listId);
  R.rowEls = [];
  if (R.needQuery) { list.replaceChildren(el('div', { className:'empty', textContent:t('rail.kind.symbol.hint') })); return; }
  if (R.error) { list.replaceChildren(errPanel(R.error)); return; }
  if (!R.resp) { list.replaceChildren(el('div', { className:'empty', textContent:t('load.search') })); return; }
  if (!R.shown.length) {
    // Two different silences, and they must not borrow each other's words. Rows
    // ON SCREEN that the filter cut is the PAGE's doing, so the page says so and
    // names what was typed. A list that came back empty BEFORE anybody typed is
    // the engine's, so it keeps the engine's own reason ("not shipped" for a
    // lane that never ran, never "nothing here").
    list.replaceChildren(el('div', { className:'empty', textContent: R.rows.length
      ? t('rail.filter.none', { q: railTyped(tab) })
      : emptyText(R.resp.answer.empty, 'items') }));
    return;
  }
  const kids = [];
  if (tab === 'flow') railGroupNodes(tab, kids);
  else for (const row of R.shown) railRowNodes(tab, R.kind, row, kids, false);
  list.replaceChildren(...kids);
  railSetCur(tab, railInitialCur(tab));
  // A picked row forty rows down is a row the reader cannot see. Bring it into
  // the list's own scroll, WITHOUT taking the focus: a restored pick should be
  // where the reader left it, not somewhere they have to hunt for.
  if (R.sel !== null && R.cur >= 0 && R.rowEls[R.cur]) {
    const node = R.rowEls[R.cur].el;
    if (node.scrollIntoView) node.scrollIntoView({ block:'nearest' });
  }
  refreshShowAll();
}
/**
 * Which row the highlight lands on after a re-render: the PICKED one if it is
 * in this list, then an exact match for what was typed, else the first row.
 */
function railInitialCur(tab){
  const R = RAIL[tab];
  if (!R.rowEls.length) return -1;
  if (R.sel !== null) {
    const i = R.rowEls.findIndex((x) => x.kind === R.selKind && railId(x.kind, x.row) === R.sel);
    if (i >= 0) return i;
  }
  if (R.q) {
    const i = R.rowEls.findIndex((x) => railId(x.kind, x.row).toLowerCase() === R.q);
    if (i >= 0) return i;
  }
  return 0;
}
function railGroupNodes(tab, kids){
  const R = RAIL[tab];
  const order = [], byGroup = new Map();
  for (const row of R.shown) {
    const g = row.group == null ? '' : String(row.group);
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    byGroup.get(g).push(row);
  }
  const screens = R.kind === 'screen';
  for (const g of order) {
    const rows = byGroup.get(g);
    const closed = R.closedGroups.has(g);
    // Both numbers are counted over rows the SERVER sent, never re-derived: how
    // many rows this group has here, and how many of them reach the next lane
    // down (SQL for a route, an API route for a screen).
    const reach = rows.filter((row) => (screens ? row.endpoints : row.statements) > 0).length;
    kids.push(el('button', { className:'brgroup', onclick: () => {
      if (closed) R.closedGroups.delete(g); else R.closedGroups.add(g);
      railRenderRows(tab);
    } }, [
      el('span', { className:'brgname', textContent:(closed ? '▸ ' : '▾ ') + g }),
      el('span', { className:'brgn', textContent:t(screens ? 'rail.group.screens' : 'rail.group.endpoints', { n:rows.length }) }),
      el('span', { className:'brgn', textContent:t(screens ? 'rail.group.reachapi' : 'rail.group.reach', { n:reach }) }),
    ]));
    if (closed) continue;
    for (const row of rows) railRowNodes(tab, R.kind, row, kids, false);
  }
}
function railRowNodes(tab, kind, row, kids, child){
  const R = RAIL[tab];
  const id = railId(kind, row);
  const picked = R.sel === id && R.selKind === kind;
  const btn = el('button', {
    className: 'brrow' + (child ? ' brchild' : '') + (picked ? ' on' : ''),
    title: id,
    onclick: () => railPick(tab, kind, row),
  }, [
    el('div', { className:'brline' }, [
      // A column UNDER its own table does not repeat the table's name.
      el('span', { className:'brid',
        textContent: (child && kind === 'column') ? id.slice(String(row.table || '').length + 1) : railLabel(kind, row) }),
      el('span', { className:'brstats' }, railStats(kind, row)),
    ]),
    railSub(kind, row),
  ]);
  btn.setAttribute('role', 'option');
  btn.setAttribute('aria-selected', picked ? 'true' : 'false');
  btn.addEventListener('keydown', (ev) => railRowKey(tab, ev));
  // Impact opens a table into its own columns. The caret is its OWN control, so
  // the row beside it still picks the table.
  if (tab === 'impact' && kind === 'table') {
    const open = R.openTables.has(id);
    const caret = el('button', { className:'brcaret', textContent: open ? '▾' : '▸',
      title:t('rail.tree.title'), onclick: () => railToggleTable(tab, id) });
    caret.setAttribute('aria-expanded', open ? 'true' : 'false');
    kids.push(el('div', { className:'brwrap' }, [caret, btn]));
    R.rowEls.push({ el:btn, row, kind });
    if (open) kids.push(railChildren(tab, id));
    return;
  }
  kids.push(btn);
  R.rowEls.push({ el:btn, row, kind });
}
/** A stat chip: a LABEL, the number, and a title saying what it counts.
    The rows used to read `◆ 22 ▶ 29` — two glyphs and two numbers, which is a
    legend the reader does not have and cannot guess. They now read `sql 22`
    and `api 29`. The labels are the ENGINE's own nouns and are the same in
    every language: translating `sql` would be inventing a word for a thing the
    engine already named. The sentence is still in the chip's title. */
function railStat(label, n, key, cls){
  return el('span', { className:'brstat' + (cls ? ' ' + cls : ''), title:t(key) },
    [el('i', { className:'brlbl', textContent:label }), String(n)]);
}
function railFlag(text, title){
  return el('span', { className:'brflag', title, textContent:text });
}
function railStats(kind, row){
  // `scr` is on a row only when the ANSWER carries it. On a pack with no
  // frontend the field is absent, and a `scr 0` there would read as "no screen
  // touches this table" when the truth is that no frontend was analyzed.
  if (kind === 'table') return [
    railStat('sql', row.statementsRead + row.statementsWrite, 'rail.stat.statements.title'),
    railStat('api', row.endpoints, 'rail.stat.endpoints.title'),
    row.screens != null ? railStat('scr', row.screens, 'rail.stat.screens.title') : null,
  ].filter(Boolean);
  if (kind === 'column') return [
    row.pk ? railFlag('pk', t('rail.stat.pk.title')) : null,
    railStat('r', row.reads, 'rail.stat.reads.title', 'read'),
    railStat('w', row.writes, 'rail.stat.writes.title', 'write'),
    railStat('api', row.endpoints, 'rail.stat.endpoints.title'),
    row.screens != null ? railStat('scr', row.screens, 'rail.stat.screens.title') : null,
  ].filter(Boolean);
  if (kind === 'screen') return [
    // A PAGE, not a router screen (RM48): a reader scanning the list has to be
    // able to tell the two apart without opening either.
    row.kind === 'page' ? railFlag(t('screen.kind.page'), t('screen.kind.page.title')) : null,
    row.observed ? railFlag(t('rail.stat.seen'), t('rail.stat.seen.title')) : null,
    railStat('api', row.endpoints, 'rail.stat.screenapi.title'),
    railStat('tbl', row.tables, 'rail.stat.screentables.title'),
  ].filter(Boolean);
  if (kind === 'statement') return [
    row.hasStringSubst ? railFlag('${}', t('rail.stat.subst.title')) : null,
    row.hasUnresolved ? railFlag('?', t('rail.stat.unresolved.title')) : null,
    railStat('tbl', row.tables, 'rail.stat.tables.title'),
    railStat('api', row.endpoints, 'rail.stat.endpoints.title'),
  ].filter(Boolean);
  if (kind === 'endpoint') return [
    row.handlers > 1 ? railFlag('x' + row.handlers, t('rail.stat.handlers.title')) : null,
    railStat('sql', row.statements, 'rail.stat.statements.title'),
    railStat('tbl', row.tables, 'rail.stat.tables.title'),
  ].filter(Boolean);
  return [
    row.transactional ? railFlag('tx', t('ov.code.tx.title')) : null,
    row.mapperMethod ? railFlag('sql', t('ov.code.mapper.title')) : null,
    row.external ? railFlag('ext', t('ov.code.external.title')) : null,
  ].filter(Boolean);
}
function railSub(kind, row){
  let s;
  if (kind === 'table' || kind === 'column') s = row.comment || '';
  else if (kind === 'statement') s = [row.type, row.file].filter(Boolean).join('  ');
  else if (kind === 'endpoint') s = row.handlerShort || '';
  // The route itself when the label is a shortening of it, then the title the
  // router's own `meta` gave the screen. A SERVER-RENDERED page's label is its
  // view name, so what goes under it is the template the resolver found (RM48):
  // the file a reader would open.
  else if (kind === 'screen') s = [row.label === row.screen ? null : row.screen, row.template, row.title]
    .filter(Boolean).join('  ');
  else s = row.owner || '';
  return s ? el('div', { className:'brsub', textContent:s }) : null;
}

// ---- picking ----------------------------------------------------------------
// The existing renderers take over from here, unchanged: this only says WHICH
// one and with what.
function railPick(tab, kind, row){
  const R = RAIL[tab], id = railId(kind, row);
  R.sel = id; R.selKind = kind;
  railCloseDrawer(tab);
  railMarkSel(tab);
  if (tab === 'explore') {
    if (kind === 'screen') { showScreen(id); return; }
    if (kind === 'statement' || kind === 'symbol') {
      // A statement or a method IS its source, so picking one IS the request
      // for the pane. The pane and the pick are ONE history entry: the URL
      // carries both.
      srcOpen(kind + ':' + id, { tab:'explore', push:false });
      pickSet('explore', kind + ':' + id);
      return;
    }
    if (kind === 'table') showTable(id); else showColumn(id);
    // A pane already open follows the pick; a closed one stays closed.
    if (srcIsOpen()) srcOpen(kind + ':' + id, { tab:'explore', push:false });
    return;
  }
  if (tab === 'flow') { openFlow(kind === 'screen' ? { screen:id } : { endpoint:id }); return; }
  const arg = {};
  arg[kind] = id;
  openImpact(arg);
}
/** Re-mark the picked row without re-rendering the list under the reader. */
function railMarkSel(tab){
  const R = RAIL[tab];
  for (const x of R.rowEls) {
    const on = R.sel === railId(x.kind, x.row) && R.selKind === x.kind;
    x.el.classList.toggle('on', on);
    x.el.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

// ---- the keyboard -----------------------------------------------------------
function railSetCur(tab, i){
  const R = RAIL[tab];
  R.cur = i;
  R.rowEls.forEach((x, k) => x.el.classList.toggle('cur', k === i));
}
/**
 * Move the highlight and scroll it into view. `takeFocus` is true when the move
 * came from a ROW (the focus walks the list with the highlight) and false when
 * it came from the FILTER BOX, where stealing the focus would stop the reader
 * typing the next letter.
 */
function railMove(tab, d, takeFocus){
  const R = RAIL[tab], n = R.rowEls.length;
  if (!n) return;
  const next = R.cur < 0 ? (d > 0 ? 0 : n - 1) : (R.cur + d + n) % n;
  railSetCur(tab, next);
  const node = R.rowEls[next].el;
  if (takeFocus && node.focus) node.focus();
  if (node.scrollIntoView) node.scrollIntoView({ block:'nearest' });
}
function railEnter(tab){
  const R = RAIL[tab];
  if (R.cur < 0 || !R.rowEls[R.cur]) return false;
  const x = R.rowEls[R.cur];
  railPick(tab, x.kind, x.row);
  return true;
}
function railRowKey(tab, ev){
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    if (ev.preventDefault) ev.preventDefault();
    railMove(tab, ev.key === 'ArrowDown' ? 1 : -1, true);
    return;
  }
  // Said out loud rather than left to the browser's own button activation, so
  // one rule answers Enter whether the focus is on the row or in the filter.
  if (ev.key === 'Enter' || ev.key === ' ') {
    if (ev.preventDefault) ev.preventDefault();
    railEnter(tab);
  }
}
/** Typing: filter what is already here, and ask nothing (kind=symbol excepted). */
function railFilterInput(tab){
  const R = RAIL[tab];
  railTakeTyped(tab);
  clearTimeout(R.timer);
  R.timer = setTimeout(() => { R.timer = null; railFilterNow(tab); },
    R.kind === 'symbol' ? RAIL_SYMBOL_MS : RAIL_FILTER_MS);
}
function railFilterNow(tab){
  const R = RAIL[tab];
  clearTimeout(R.timer); R.timer = null;
  if (R.kind === 'symbol') { railLoad(tab, false); return; }
  railRender(tab);
}

// ---- what the right-hand side says before anything is picked ----------------
// Not a grey box telling you to type. One sentence, and five rows off the top of
// the list already loaded, so the first click is one click away. No request.
function railIdle(tab){
  if (!railIsIdle(tab)) return;
  const R = RAIL[tab], D = RAILDEF[tab];
  const host = tab === 'explore' ? view : byId(tab === 'flow' ? 'flowwrap' : 'impactwrap');
  const picks = R.rows.slice(0, 5);
  const lead = (tab === 'flow' && R.kind === 'screen') ? 'rail.lead.flow.screen' : D.lead;
  const card = el('div', { className:'panel brlead' }, [
    el('div', { className:'comment', textContent:t(lead) }),
    picks.length ? el('h2', { textContent:t('rail.picks'), style:'margin-top:12px' }) : null,
    picks.length ? el('ul', { className:'brpicks' }, picks.map((row) => el('li', {}, [
      el('button', { className:'brpick', title:railId(R.kind, row), onclick: () => railPick(tab, R.kind, row) }, [
        el('span', { className:'brid', textContent:railLabel(R.kind, row) }),
        el('span', { className:'brstats' }, railStats(R.kind, row)),
      ]),
    ]))) : null,
  ]);
  if (tab !== 'explore') host.classList.remove('layersmode');
  host.replaceChildren(card);
}
function railIsIdle(tab){
  // Explore's right-hand side is idle while it is EMPTY, or while THIS card is
  // still the thing standing on it (so a language switch re-draws it). A table,
  // a search result or the edits panel is an answer, and this must not land on
  // one of those.
  if (tab === 'explore') {
    if (RAIL.explore.sel !== null) return false;
    return !view.hasChildNodes() || view.querySelector('.brlead') != null;
  }
  const v = tab === 'flow' ? FLOWV : IMPACTV;
  return !v.resp && !railTyped(tab);
}

// ---- the drawer, under 1100px -----------------------------------------------
function railOpenDrawer(tab){
  byId(RAILDEF[tab].railId).classList.add('open');
  byId('brscrim').classList.add('on');
  RAILOPEN = tab;
}
function railCloseDrawer(tab){
  byId(RAILDEF[tab].railId).classList.remove('open');
  byId('brscrim').classList.remove('on');
  if (RAILOPEN === tab) RAILOPEN = null;
}

// ---- the height, measured the way the Graph pane is (RM25) -------------------
const RAIL_PANE_MIN = 420;
const RAIL_PANE_GAP = 14;
const RAIL_PANE_PASSES = 3;
function railPaneApply(tab){
  const box = byId(RAILDEF[tab].railId);
  if (!box || typeof box.getBoundingClientRect !== 'function') return null;
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1400;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
  // As a DRAWER it is floor to ceiling and owns its own height; releasing the
  // measured one here is what lets the stylesheet do that.
  if (vw <= 1100) { box.style.height = ''; return null; }
  let h = null;
  for (let pass = 0; pass < RAIL_PANE_PASSES; pass++) {
    box.style.height = '';
    const top = box.getBoundingClientRect().top;
    h = Math.max(RAIL_PANE_MIN, Math.round(vh - top - RAIL_PANE_GAP));
    box.style.height = h + 'px';
    const now = box.getBoundingClientRect().top;
    if (!(Math.abs(now - top) >= 1)) break;
  }
  return h;
}

// ---- wiring -----------------------------------------------------------------
// Called from the wiring block at the foot of this script, not here: `byId` is
// declared below and a top-level call would run before it exists.
function railWire(){
  for (const tab of RAILTABS) {
    const D = RAILDEF[tab];
    byId(D.sortId).onchange = (e) => { RAIL[tab].sort = e.target.value; railLoad(tab, false); };
    byId(D.drawerId).onclick = () => railOpenDrawer(tab);
    byId(D.closeId).onclick = () => railCloseDrawer(tab);
  }
  byId('brscrim').onclick = () => { if (RAILOPEN) railCloseDrawer(RAILOPEN); };
  // `/` puts the cursor in the filter from anywhere on the tab. Escape is NOT
  // handled here: the page has one Escape rule (escapeRule), so no two handlers
  // can disagree about what the key means.
  document.addEventListener('keydown', (e) => {
    const tab = railVisibleTab();
    if (!tab) return;
    if (e.key !== '/') return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.preventDefault) e.preventDefault();
    const input = byId(RAILDEF[tab].inputId);
    if (input && input.focus) input.focus();
  });
}
