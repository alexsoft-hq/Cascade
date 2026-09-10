// 45_graph.js — the Graph tab: the whole map, one node's neighborhood, and the pane they share.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// ---------- the shared canvas machinery ----------
// Both graph pictures on this page — the ERD's whole schema and the Graph tab's
// `Around <node>` hop rings — are drawn by the SAME vendored canvas renderer the
// map uses (viewer/vendor/force-graph.min.js). One renderer for three pictures:
// a fix to the panning, the hit-testing or the tooltip fixes all three, and a
// schema of thousands of tables becomes one canvas the browser composites
// instead of thousands of SVG elements it must lay out and hit-test.
//
// The LAYOUT, though, is OURS. The library's own d3 forces repel every node from
// every other one, which pushes clusters that share no edge hundreds of pixels
// apart — the exact drift this page fixed by settling each component on its own
// and packing the results. So every position is computed up front by the pure
// helpers above (settleComponents for the ERD, ringLayout for the rings) and
// handed over as FIXED coordinates: fx/fy on every node, cooldownTicks(0) and
// d3AlphaDecay(1) so not one simulation tick ever runs. The library renders,
// pans, zooms, hit-tests and drags; it never decides where anything goes. That
// also makes the picture STILL when nothing is happening — no rAF loop, no
// physics warming up under a reader trying to read a name.
const gfHas2D=()=> typeof window.ForceGraph!=='undefined';
function gfMount(host, w, h){
  const made=new window.ForceGraph();
  const g=(typeof made==='function') ? made(host) : made;   // kapsule builds either way
  g.width(w).height(h)
    // The hit disc IS the drawn disc: the shadow canvas the library hit-tests on
    // paints sqrt(nodeVal) x nodeRelSize, so val=r² and nodeRelSize=1 make the
    // two the same circle whatever nodeCanvasObject then draws on top.
    .nodeRelSize(1).nodeVal((n)=>n.val)
    .cooldownTicks(0).d3AlphaDecay(1).warmupTicks(0)
    .minZoom(0.02).maxZoom(12);
  return g;
}
// A node the layout placed. `fx/fy` is what makes the library leave it alone —
// and what makes a DRAG stick: it clears fx/fy at drag end only for a node that
// had none to begin with, so a node dropped somewhere stays exactly there.
const gfPin=(n,x,y)=>{ n.x=x; n.y=y; n.fx=x; n.fy=y; return n; };
// Re-setting a draw prop is how a canvas that has gone still is told to paint
// again: `autoPauseRedraw` stops the loop when nothing moves, which is the whole
// point of a layout that does not animate, so a highlight has to say so.
const gfRepaint=(g, draw)=>{ if(!g) return; try{ g.nodeCanvasObject(draw); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } };
// One monospace face, one place. `size` is in SCREEN pixels: the canvas is
// scaled by the zoom, so everything drawn at a fixed screen size divides by it.
const gfFont=(size, weight)=> (weight?weight+' ':'')+size+'px "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
// Two boxes in the same space overlap?
const gfHits=(a,b)=> a.x<b.x+b.w && a.x+a.w>b.x && a.y<b.y+b.h && a.y+a.h>b.y;
// A palette token plus an alpha, as one canvas colour. The palette lives in CSS
// variables (#rrggbb) and a canvas stroke carries its own alpha, so a line that
// is drawn at 0.6 — and at 0.07 when something else is spotlighted — says so
// here rather than through a separate opacity the canvas does not have.
function gfAlpha(color, a){
  const m=/^#([0-9a-f]{6})$/i.exec(String(color==null?'':color).trim());
  if(!m || !(a>=0 && a<1)) return color;
  const n=parseInt(m[1],16);
  return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';
}

// --- the instant tooltip ----------------------------------------------------
// One div for the whole page, shown on hover with the text a native <title>
// would carry — native tooltips wait about a second to appear, far too slow for
// a picture you read by sweeping the pointer over it. The canvas has no
// per-node element to hang a mouseenter on, so the pointer is tracked on the
// host and the RENDERER says what is under it.
const gtip=(()=>{
  const at={x:0, y:0};
  const box=()=>{ let t=document.getElementById('gtip');
    if(!t){ t=document.createElement('div'); t.id='gtip'; document.body.append(t); } return t; };
  const place=()=>{ const t=box(), pad=14, r=t.getBoundingClientRect();
    let x=at.x+pad, y=at.y+pad;
    if(x+r.width>window.innerWidth-8) x=Math.max(8, at.x-r.width-pad);
    if(y+r.height>window.innerHeight-8) y=Math.max(8, at.y-r.height-pad);
    t.style.left=x+'px'; t.style.top=y+'px'; };
  const hide=()=>{ box().style.display='none'; };
  const show=(text)=>{ if(!text){ hide(); return; } const t=box();
    t.textContent=text; t.style.display='block'; place(); };
  // The pointer LEAVING the canvas is the one thing the renderer cannot report:
  // it hit-tests where the pointer was, and a pointer that is no longer over the
  // canvas never moves again as far as it is concerned. So the host says so, and
  // the caller uses that to put its hover preview back the way it was — without
  // it, a picture stayed dimmed around whatever the pointer last brushed past.
  const follow=(host, onLeave)=>{
    host.addEventListener('mousemove',(e)=>{ at.x=e.clientX; at.y=e.clientY;
      if(box().style.display==='block') place(); });
    host.addEventListener('mouseleave',()=>{ hide(); if(onLeave) onLeave(); });
  };
  return { show, hide, follow };
})();

// --- the collision-free label placer ----------------------------------------
// Labels that overlap are worse than no label: two names on top of each other
// read as a third, wrong one. So the names wanted this frame are placed in
// priority order and any whose box would land on a box already taken — or on a
// node disc, because a name written across the circles of its neighbours is
// just as unreadable — is DROPPED. A dropped name is not lost: its node is
// still there, still hoverable, and the rail still lists it.
//
// It runs ONCE per frame, in `onRenderFramePre`, and the drawing then only reads
// what it decided. Everything is in GRAPH units with the screen-constant sizes
// divided by the zoom, which is the same comparison as screen space (the pan is
// a translation both boxes share) without a coordinate conversion per box.
// @returns Map(id -> {x, y, size}) — the baseline point to draw the name at.
function gfPlaceLabels(ctx, k, nodes, want, rank){
  const cand=nodes.filter(want);
  cand.sort((a,b)=> rank(b)-rank(a) || (a.id<b.id?-1:a.id>b.id?1:0));
  const taken=nodes.map((n)=>({x:n.x-n.r, y:n.y-n.r, w:2*n.r, h:2*n.r}));
  const out=new Map();
  for(const n of cand){
    const size=(n.fontSize||10)/k;
    ctx.font=gfFont(size, n.fontWeight);
    const w=ctx.measureText(n.label==null?n.id:n.label).width, h=size;
    const y=n.y+3.5/k, top=y-h;
    const free=(x)=>{ for(const b of taken) if(gfHits({x, y:top, w, h}, b)) return false; return true; };
    // The right of the node first, and if that side is taken its MIRROR on the
    // left (anchored at its far end, so it grows away from the node). Only ever
    // going right left every label on the left half of a ring one candidate
    // place, in the busiest direction there is — straight at the middle.
    const right=n.x+n.r+4/k, left=n.x-n.r-4/k-w;
    const x = free(right) ? right : (free(left) ? left : null);
    if(x==null) continue;
    taken.push({x, y:top, w, h});
    out.set(n.id, {x, y, size});
  }
  return out;
}
// Which names are drawn at REST — before any zoom or spotlight asks for more.
// A budget filled from the ranking, but every COMPONENT reserves its
// best-connected node first: ranked globally, a two-table island never
// out-ranks a 60-table hub's spokes and whole clusters were drawn as anonymous
// dots. A picture may not show a cluster it refuses to name.
function gfAlwaysLabel(nodes){
  const best=new Map();
  for(const n of nodes){ const b=best.get(n.comp); if(!b || n.rank>b.rank) best.set(n.comp, n); }
  const set=new Set([...best.values()].map(n=>n.id));
  const budget=Math.min(28, Math.max(8, Math.ceil(nodes.length*0.12)));
  for(const n of [...nodes].sort((a,b)=> b.rank-a.rank || (a.id<b.id?-1:a.id>b.id?1:0))){
    if(set.size>=budget) break;
    set.add(n.id);
  }
  return set;
}
// One name, with the white halo that lets it survive crossing a line.
function gfDrawLabel(ctx, at, text, weight, fill){
  ctx.font=gfFont(at.size, weight);
  ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  ctx.lineWidth=at.size*0.28; ctx.strokeStyle=cssVar('--halo');
  ctx.strokeText(text, at.x, at.y);
  ctx.fillStyle=fill; ctx.fillText(text, at.x, at.y);
}
// A line says three things at once: its GRADE (solid / dashed / dotted — the
// same vocabulary Flow and Impact use), its DIRECTION (the arrowhead), and, when
// it is a read or a write, WHICH (the read/write hues the tags use everywhere
// else). An edge with no access keeps its grade's colour.
const gAccessColor=(a)=> a==='read' ? cssVar('--read') : (a==='write'||a==='delete') ? cssVar('--write') : null;
// Where the access LIVES depends on the edge: a statement→table EXECUTES edge
// carries it as evidence, while READS / WRITES say it in the type itself. Both
// are read here, so a read is blue and a write red wherever the engine put it.
const GTYPEACCESS={READS:'read', WRITES:'write'};
// The dash IS the grade — GRADE_DASH, the one table at the top of this file, is
// what every line on this page reads. A relation the engine could not resolve
// keeps the muted ink of its grade and never borrows an access hue: it must not
// look like one that was proved.
const GWEAK=new Set(['RUNTIME_ONLY','UNRESOLVED']);
// A CAPTURE OF THE RUNNING SYSTEM adds a FOURTH thing, and only to the weight:
// an edge a trace saw run is drawn heavier and less faded, and keeps its
// grade's colour and its grade's dash. That is the whole rule. A runtime-only
// edge stays dotted in its muted ink and simply gets that weight on top, so it
// still reads as the below-every-floor thing it is. Nothing here promotes an
// edge: `observed` says the call RAN, never that it is surer, and an edge
// without it was not visited by that capture rather than dead.
function gEdgeStyle(e){
  const access = e.access || GTYPEACCESS[e.type] || null;
  const weak = GWEAK.has(e.grade);
  const seen = e.observed===true;
  return { color: (weak? null : gAccessColor(access)) || gradeColor(e.grade),
    width: (e.grade==='EXACT'?1.5:1.2) + (seen?1.4:0), dash: gradeDash(e.grade),
    opacity: seen?0.95:0.6, observed: seen };
}
// One inline sample of what a grade's line looks like, for the legend the hint
// points at — drawn with the very table above, so the two cannot disagree.
function gradeLineSample(grade, weight){
  const s=svgEl('svg',{width:30, height:8, viewBox:'0 0 30 8','aria-hidden':'true'});
  const ln=svgEl('line',{x1:0, y1:4, x2:30, y2:4, stroke:gradeColor(grade), 'stroke-width':weight||1.5});
  if(gradeDash(grade)) ln.setAttribute('stroke-dasharray', gradeDash(grade));
  s.append(ln); return s;
}
// The drill-down: `Around <node>`. Every handoff into the Graph tab lands here
// (a node someone already named has a neighbourhood, not a map), and the
// `‹ back to map` button is what returns.
function openGraph(nodeId){
  activateTab('graph');
  // ONE BOX, TWO QUESTIONS. The entry field is the map's "find a node" and
  // Around's "which node", and the drill-down used to leave its own query
  // sitting in it: `‹ back to map` returned to the map with the drilled-down
  // node id (`endpoint:POST ...`) still typed in the map's own find box. So the
  // map's text is put aside on the way in and given back on the way out.
  if(GRAPHV.mode==='map') GMAP.find=byId('gfocus').value;
  graphMode('around');
  byId('gfocus').value = nodeId||'';
  // A full id needs no resolving — it IS the node. Anything else goes through
  // the same resolution the typeahead uses.
  GRAPHV.pick = (nodeId && nodeId.includes(':')) ? {kind:'node', value:nodeId} : null;
  closeSug(GRAPHV);
  drawGraph();
  if(nodeId && nodeId.includes(':')) pickSet('graph', nodeId);
}
// Which tool argument this entry box means. A full "<kind>:<key>" is the node
// itself; a '#' is a method; "GET /path" is a route; otherwise the ENGINE says
// which kind carries this key (the same rule the Impact box follows) — the page
// never guesses a kind from the dots in a name.
async function graphArgs(raw){
  const i=raw.indexOf(':');
  if(i>0 && KINDS.includes(raw.slice(0,i))) return {node:raw};
  if(raw.includes('#')) return {symbol:raw};
  if(GRAPHV.pick && GRAPHV.pick.value===raw) return {[GRAPHV.pick.kind]:raw};
  if(/^[A-Z]+\s+\//.test(raw)) return {endpoint:raw};
  try{
    const s=(await api('search',{query:raw, limit:100})).answer;
    if((s.tables||[]).some(t=>t.table===raw)) return {table:raw};
    if((s.columns||[]).some(c=>c.column===raw)) return {column:raw};
    if((s.statements||[]).some(x=>x.statement===raw)) return {statement:raw};
  }catch(e){ /* fall through to the shape rule, so the ENGINE names what it cannot find */ }
  return raw.split('.').length>=2 ? {column:raw} : {table:raw};
}
async function drawGraph(){
  const raw=byId('gfocus').value.trim();
  const side=byId('gside'), counts=byId('gcounts');
  if(!raw){
    stopAround(); byId('gchips').replaceChildren(); side.replaceChildren();
    counts.replaceChildren(t('graph.empty'));
    GRAPHV.resp=null; return;
  }
  counts.replaceChildren(t('load.around'));
  // A late answer is NEVER the current answer: every request carries a sequence
  // number and drops itself if a newer Draw has started since.
  const mine=++GRAPHV.seq;
  let args;
  try{ args=await graphArgs(raw); }
  catch(e){ if(stale(e)||mine!==GRAPHV.seq) return; counts.replaceChildren();
    side.replaceChildren(errPanel(e)); return; }
  if(mine!==GRAPHV.seq) return;
  args.direction=byId('gdir').value;
  args.hops=Number(byId('ghops').value);
  args.limit=220;
  let r;
  try{ r=await api('neighborhood',args); }
  catch(e){ if(stale(e)||mine!==GRAPHV.seq) return; counts.replaceChildren();
    stopAround(); byId('gchips').replaceChildren();
    side.replaceChildren(errPanel(e)); return; }
  if(mine!==GRAPHV.seq) return;
  GRAPHV.resp=r; GRAPHV.sel=null;
  // Along the direction the answer walked. `neighborhood` collects nodes by
  // direction but returns EVERY edge between them, so an undirected BFS finds
  // shortcuts the walk never took and puts a node three steps up on ring 1.
  GRAPHV.hop=hopsFrom(r.answer.focus, r.answer.edges, r.answer.direction);
  // Columns are the bulk of the hairball when the focus is a table or a
  // statement, so they start hidden — the chip still says how many there are. A
  // NEW focus resets the chips; redrawing the same focus keeps them.
  if(GRAPHV.hiddenFor!==r.answer.focus){
    GRAPHV.hiddenFor=r.answer.focus;
    const fk=r.answer.focus.slice(0, r.answer.focus.indexOf(':'));
    GRAPHV.hidden=new Set((fk==='table'||fk==='statement') ? ['column'] : []);
  }
  renderGraph();
}
function renderGraph(){
  const r=GRAPHV.resp; if(!r) return;
  const a=r.answer;
  const kinds=new Map();
  for(const n of a.nodes) kinds.set(n.kind,(kinds.get(n.kind)||0)+1);
  renderGraphChips(kinds);
  // A hidden kind takes its edges with it: a line is drawn only when BOTH ends
  // are on screen.
  // …but never the focus itself: hiding the kind you asked about would leave the
  // picture with no centre.
  const vis=a.nodes.filter(n=> n.id===a.focus || !GRAPHV.hidden.has(n.kind));
  const on=new Set(vis.map(n=>n.id));
  const edges=a.edges.filter(e=>on.has(e.from)&&on.has(e.to));
  const deg=new Map(vis.map(n=>[n.id,0]));
  for(const e of edges){ deg.set(e.from,(deg.get(e.from)||0)+1); deg.set(e.to,(deg.get(e.to)||0)+1); }
  // The hop is measured on the WHOLE answer, not on what is visible: hiding a
  // kind must not silently move a node to a different ring. A node the walk never
  // reached (the cap cut its path) is parked on one ring past the last — and that
  // ring says `unreached`, never "hop N+1": it is a parking space, not a distance
  // anything measured.
  let far=0, unreached=false;
  for(const n of vis){ if(GRAPHV.hop.has(n.id)) far=Math.max(far, GRAPHV.hop.get(n.id)); else unreached=true; }
  const parked = unreached ? far+1 : null;
  const hopOf=(id)=> GRAPHV.hop.has(id)? GRAPHV.hop.get(id) : far+1;
  // Same kind, same arc: ordering a ring by kind makes the ring itself readable.
  const order=[...vis].sort((x,y)=> hopOf(x.id)-hopOf(y.id)
    || (x.kind<y.kind?-1:x.kind>y.kind?1:0) || (x.id<y.id?-1:x.id>y.id?1:0));
  const wrap=byId('gwrap'), W=wrap.clientWidth||900, H=wrap.clientHeight||620;
  const lay=ringLayout(order.map(n=>n.id), hopOf, {cx:W/2, cy:H/2, step:GRING.step, gap:GRING.gap, nodeR:GRING.nodeR});
  const pos=new Map(lay.nodes.map(p=>[p.id,p]));
  let maxDeg=1; for(const d of deg.values()) if(d>maxDeg) maxDeg=d;
  const nodes=order.map(n=>{
    const p=pos.get(n.id), d=deg.get(n.id)||0, isFocus=n.id===a.focus;
    const r= isFocus?11:(3.6+Math.sqrt(d)*2.3);
    return gfPin({ id:n.id, kind:n.kind, label:n.label||n.id, deg:d, isFocus,
      r, val:r*r, color:kindColor(n.kind), hop:p.hop, ring:p.radius,
      fontSize: isFocus?12:(9+3*Math.min(1,d/maxDeg)), fontWeight:(isFocus||d>=maxDeg*0.5)?500:400,
      rank: isFocus?1e9:d, comp:0,
      tip: n.kind+'\u00a0\u00a0'+n.id+(n.comment?('  —  '+n.comment):'')
        +'  ['+hopRingLabel(p.hop, null, parked)+(p.hop===parked?' — no path of this slice reaches it':'')+'\u00a0\u00a0'+d+' edges drawn]' },
      p.x, p.y);
  });
  // A line says three things at once, and the canvas draws all three: its GRADE
  // (the dash pattern, via linkLineDash), its DIRECTION (the arrowhead the
  // library puts at the target's edge) and its ACCESS (the hue).
  const links=edges.map((e,i)=>{ const st=gEdgeStyle(e);
    return { i, sid:e.from, tid:e.to, source:e.from, target:e.to,
      // `style` is kept so a THEME change can re-read this line's own colour
      // without the answer being walked again.
      style:{ color:()=>gEdgeStyle(e).color, opacity:st.opacity },
      // Lighting a line must never make it FAINTER than it was at rest, and an
      // observed one already sits at 0.95.
      colOn:gfAlpha(st.color, st.opacity), colLit:gfAlpha(st.color, Math.max(0.9, st.opacity)), w:st.width,
      dash: st.dash ? st.dash.split(' ').map(Number) : null,
      observed:st.observed,
      // The mark is SAID as well as drawn: a heavier line is a hint until the
      // hover names it, and the capture's own coverage note comes with it.
      tip:shortId(e.from)+' → '+shortId(e.to)+'\u00a0\u00a0'+e.type+'\u00a0\u00a0'+e.grade+(e.access?('\u00a0\u00a0'+e.access):'')
        +(st.observed?('\u00a0\u00a0'+t('chain.tag.seen')+(runtimeNote(r)?('\u00a0\u00a0'+runtimeNote(r)):'')):'') }; });
  GA.nodes=nodes; GA.links=links;
  GA.byId=new Map(nodes.map(n=>[n.id,n]));
  GA.incident=new Map(nodes.map(n=>[n.id,[]]));
  for(const l of links){ GA.incident.get(l.sid).push(l.i); GA.incident.get(l.tid).push(l.i); }
  GA.plan=lay.plan; GA.cx=W/2; GA.cy=H/2; GA.parked=parked;
  GA.always=gfAlwaysLabel(nodes);
  GA.hover=null; GA.lit=null; GA.labels=new Map(); GA.fitDone=false; GA.lastClick={id:null,at:0};
  stopAround();
  if(!gfHas2D()){
    byId('garound').append(el('div',{className:'gmapmsg',textContent:
      'viewer/vendor/force-graph.min.js did not load — this picture needs it. Serve this page with `cascade view` (it publishes /vendor), or check the browser console for the request that failed.'}));
  } else {
    mountAround(byId('garound'), W, H);
  }
  renderGraphCounts(r, a, vis.length, edges.length);
  renderGraphSide();
}

function mountAround(host, w, h){
  const g=gfMount(host, w, h);
  g.nodeCanvasObject(aroundDrawNode).nodeCanvasObjectMode(()=>'replace')
    .linkColor(aroundLinkColor).linkWidth((l)=>l.w).linkLineDash((l)=>l.dash)
    // The arrowhead is the library's, at relPos 1 — which lands its tip on the
    // target node's own radius, the same place the hand-drawn one used to sit.
    .linkDirectionalArrowLength(6.5).linkDirectionalArrowRelPos(1).linkDirectionalArrowColor(aroundLinkColor)
    .onRenderFramePre(aroundFramePre)
    .onNodeHover(aroundHover).onNodeClick(aroundClick).onBackgroundClick(()=>aroundClear())
    .onLinkHover((l)=>gtip.show(l?l.tip:null))
    // A node may be dragged, but only AROUND ITS RING: the radius is the hop,
    // and a picture whose rings mean "this far from the focus" must not let a
    // drag move a node to a distance nothing measured.
    .onNodeDrag(aroundDragToRing).onNodeDragEnd(aroundDragToRing)
    .onEngineStop(()=>{ if(GA.fitDone || GA.api!==g) return; GA.fitDone=true;
      try{ g.zoomToFit(0, 40); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } })
    .graphData({nodes:GA.nodes, links:GA.links});
  if(!host.__tipbound){ host.__tipbound=true; gtip.follow(host, ()=>aroundHover(null)); }
  GA.api=g;
  return g;
}
function stopAround(){
  if(GA.api){
    try{ GA.api.pauseAnimation(); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
    try{ GA.api._destructor(); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
  }
  GA.api=null;
  const h=byId('garound'); if(h) h.replaceChildren();
  gtip.hide();
}
const aroundLinkColor=(l)=> !GA.lit ? l.colOn : (GA.lit.links.has(l.i) ? l.colLit : gaDimLink());
const aroundRepaint=()=> gfRepaint(GA.api, aroundDrawNode);
// The spotlight: a node, the lines that touch it and the far ends of those
// lines. Everything else is DIMMED, never removed — the picture must not
// pretend the rest of the slice is not there.
function aroundSetLit(id){
  if(!id || !GA.byId.has(id)){ GA.lit=null; return; }
  const nodes=new Set([id]), links=new Set();
  for(const i of (GA.incident.get(id)||[])){ links.add(i); nodes.add(GA.links[i].sid); nodes.add(GA.links[i].tid); }
  GA.lit={id, nodes, links};
}
function aroundSelect(id){
  if(!GA.byId.has(id)) return;
  GRAPHV.sel=id; GA.hover=null; aroundSetLit(id); aroundRepaint(); renderGraphSide();
}
function aroundClear(){
  GRAPHV.sel=null; GA.hover=null; GA.lastClick={id:null,at:0};
  aroundSetLit(null); aroundRepaint(); renderGraphSide();
}
function aroundHover(n){
  const id=n?n.id:null;
  if(GA.hover===id) return;
  GA.hover=id; gtip.show(n?n.tip:null);
  // Hover PREVIEWS; a click sticks. On the way out the picture goes back to
  // whatever is selected, not to nothing.
  aroundSetLit(id || GRAPHV.sel); aroundRepaint();
}
function aroundClick(n){
  if(!n){ aroundClear(); return; }
  const now=Date.now();
  // The renderer has no double-click event, so it is measured here: two clicks
  // on the SAME node inside 400ms re-centre the rings on it.
  if(GA.lastClick.id===n.id && now-GA.lastClick.at<400){ GA.lastClick={id:null,at:0}; openGraph(n.id); return; }
  GA.lastClick={id:n.id, at:now};
  if(GRAPHV.sel===n.id) aroundClear(); else aroundSelect(n.id);
}
function aroundDragToRing(n){
  if(!n.ring){ gfPin(n, GA.cx, GA.cy); return; }   // the centre has no ring to slide along
  const ang=Math.atan2(n.y-GA.cy, n.x-GA.cx);
  gfPin(n, GA.cx+n.ring*Math.cos(ang), GA.cy+n.ring*Math.sin(ang));
}
// Everything drawn UNDER the picture, once a frame: the hop rings and their
// names, then the whole-frame label decision.
function aroundFramePre(ctx, k){
  GA.frame={labels:0};
  ctx.save();
  ctx.strokeStyle=cssVar('--hair'); ctx.lineWidth=1.2/k; ctx.setLineDash([3/k, 6/k]);
  for(const p of GA.plan){ if(!p.radius) continue;
    ctx.beginPath(); ctx.arc(GA.cx, GA.cy, p.radius, 0, 2*Math.PI); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.font=gfFont(11/k); ctx.textAlign='center'; ctx.textBaseline='alphabetic'; ctx.fillStyle=cssVar('--t3');
  for(const p of GA.plan){ if(!p.radius) continue;
    ctx.fillText(hopRingLabel(p.hop, p.count, GA.parked), GA.cx, GA.cy-p.radius-7/k); }
  ctx.restore();
  GA.labels=gfPlaceLabels(ctx, k, GA.nodes,
    (n)=> GA.lit ? GA.lit.nodes.has(n.id) : (GA.always.has(n.id) || n.r*k>12),
    (n)=> (GA.lit && n.id===GA.lit.id) ? 1e12 : n.rank);
}
// A node is a FILLED DISC in its kind's hue, the same grammar the map and the
// ERD use: size is degree, colour is kind. Something else under the spotlight
// drops this one to a quarter, and the focus keeps its dashed ring.
function aroundDrawNode(n, ctx, k){
  const on = !GA.lit || GA.lit.nodes.has(n.id);
  const sel = GRAPHV.sel===n.id;
  const col=kindFill(n.kind), ink=cssVar('--t1');
  ctx.save();
  ctx.globalAlpha = on ? 1 : 0.25;
  if(n.isFocus){
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r+5, 0, 2*Math.PI);
    ctx.strokeStyle=col; ctx.lineWidth=1.2/k; ctx.setLineDash([2/k, 2/k]); ctx.stroke(); ctx.setLineDash([]);
  }
  const lit = sel || n.isFocus || !!(GA.lit && GA.lit.id===n.id);
  gfDot(ctx, n.x, n.y, n.r, k, { color:col, lit, glow:true });
  if(sel){
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r+4.5, 0, 2*Math.PI);
    ctx.strokeStyle=col; ctx.lineWidth=2/k; ctx.stroke();
  }
  const at=on ? GA.labels.get(n.id) : null;
  if(at){ gfDrawLabel(ctx, at, n.label, n.fontWeight, ink); GA.frame.labels++; }
  ctx.restore();
}
function renderGraphChips(kinds){
  const rows=[...kinds.entries()].sort((x,y)=> y[1]-x[1] || (x[0]<y[0]?-1:1));
  byId('gchips').replaceChildren(el('span',{className:'count',textContent:t('chip.kinds')}), ...rows.map(([k,n])=>{
    const off=GRAPHV.hidden.has(k);
    const b=el('button',{className:'chip'+(off?' off':''),
      title:(off?'show the ':'hide the ')+n+' '+k+' node(s)',
      onclick:()=>{ if(off) GRAPHV.hidden.delete(k); else GRAPHV.hidden.add(k); renderGraph(); }},
      [ kindDot(k, 11), k+' '+n ]);
    b.setAttribute('aria-pressed', String(!off));
    return b; }));
}
function renderGraphCounts(r, a, shownNodes, shownLinks){
  // Kept so a language switch can write this line again from the answer that is
  // already on screen, without asking the server for it a second time.
  GRAPHV.counts={r, a, shownNodes, shownLinks};
  const say=(key,params)=> el('span',{}, richNodes(t(key,params)));
  const hidden=[...GRAPHV.hidden];
  const kids=[ say('gcount.nodes',{n:shownNodes}), '\u00a0\u00a0', say('gcount.links',{n:shownLinks}) ];
  if(shownNodes!==a.nodes.length || shownLinks!==a.edges.length)
    kids.push('\u00a0\u00a0'+t('gcount.ofanswer',{nodes:a.nodes.length, links:a.edges.length})
      +(hidden.length?(' — '+t('gcount.hidden',{kinds:hidden.join(', ')})):''));
  kids.push('\u00a0\u00a0'+t('gcount.hops',{hops:a.hops, dir:a.direction}));
  // The cut is the server's, and its REASON stays in the server's own words.
  const cap=(r.limits||[]).find(l=>l.scope==='neighborhood');
  if(cap) kids.push(el('span',{className:'tag warn', style:'margin-left:8px', title:cap.reason, textContent:t('gcount.nodecap')}));
  byId('gcounts').replaceChildren(...kids);
}
function graphNodeOf(a, id){
  return a.nodes.find(n=>n.id===id) || {id, kind:id.slice(0, id.indexOf(':')), label:id, comment:null};
}
// The map's cards and Around's cards open the SAME pane every other tab does:
// a node on a picture is a claim, and the code behind it is read at reading
// size beside the picture, not in a 300px box under three buttons.
function graphSourceButton(id){
  return el('button',{className:'mini', textContent:'Source', title:t('src.open.title'),
    onclick:()=> srcOpen(id, {tab:'graph'})});
}
function renderGraphSide(){
  refreshShowAll();
  const r=GRAPHV.resp; if(!r) return;
  const kids=[graphFocusCard(r.answer)];
  if(GRAPHV.sel) kids.push(graphSpotlightCard(r.answer, GRAPHV.sel));
  kids.push(honesty(r, 'around'));
  setKids(byId('gside'), ...kids);
}
function graphFocusCard(a){
  const n=graphNodeOf(a, a.focus), key=a.focus.slice(a.focus.indexOf(':')+1);
  const btns=el('div',{style:'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap'},[graphSourceButton(a.focus)]);
  if(n.kind==='endpoint'||n.kind==='symbol')
    btns.append(el('button',{className:'mini', textContent:'Flow', title:t('btn.flow.title'),
      onclick:()=>openFlow(n.kind==='endpoint'?{endpoint:key}:{symbol:key})}));
  if(['column','table','statement','symbol'].includes(n.kind))
    btns.append(el('button',{className:'mini', textContent:'Impact', title:t('btn.impact.title'),
      onclick:()=>openImpact({[n.kind]:key})}));
  if(n.kind==='table')
    btns.append(el('button',{className:'mini', textContent:'ERD', title:t('btn.erd.title'), onclick:()=>openErd(key)}));
  return el('div',{className:'panel fcard'},[
    el('div',{className:'srchead'},[
      el('span',{},[ el('span',{className:'tag',textContent:n.kind}), ' ', el('span',{className:'count',textContent:'focus'}) ]),
      el('span',{className:'count',textContent:'hop 0'}) ]),
    el('code',{className:'id', style:'display:block;word-break:break-all;margin:7px 0 4px'},[key]),
    n.comment? el('div',{className:'comment',textContent:'“'+n.comment+'”'}) : null,
    btns ]);
}
// The spotlight: what this node is joined to IN THIS PICTURE, each edge named by
// its type and graded. Clicking a row spotlights that node if it is on screen;
// if the chips hid it, the click re-centres on it instead of doing nothing.
function graphSpotlightCard(a, id){
  const n=graphNodeOf(a, id), key=id.slice(id.indexOf(':')+1);
  const rows=a.edges.filter(e=>e.from===id||e.to===id);
  const on=new Set(a.nodes.filter(x=> x.id===a.focus || !GRAPHV.hidden.has(x.kind)).map(x=>x.id));
  return el('div',{className:'panel fcard'},[
    el('div',{className:'srchead'},[
      el('span',{},[ el('span',{className:'tag',textContent:n.kind}), ' ',
        el('span',{className:'count',
          title: GRAPHV.hop.has(id)? t('around.hop.title')
            : t('around.unreached.title'),
          textContent: GRAPHV.hop.has(id)? ('hop '+GRAPHV.hop.get(id)) : 'unreached'}) ]),
      el('button',{className:'mini', textContent:'Clear', onclick:()=>aroundClear()}) ]),
    el('code',{className:'id', style:'display:block;word-break:break-all;margin:7px 0 4px'},[key]),
    n.comment? el('div',{className:'comment',textContent:'“'+n.comment+'”'}) : null,
    el('div',{style:'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap'},[
      el('button',{className:'mini', textContent:'Re-centre', title:t('btn.recentre.title'), onclick:()=>openGraph(id)}),
      graphSourceButton(id) ]),
    el('h2',{style:'margin-top:12px'},['edges ', el('span',{className:'count',textContent:'('+rows.length+')'})]),
    el('ul',{className:'list'}, rows.length? rows.map(e=>{
      const other = e.from===id ? e.to : e.from, out = e.from===id;
      return el('li',{},[
        el('span',{className:'grow'},[
          el('span',{className:'count',textContent: out?'→':'←'}),
          el('a',{className:'id clickable', title:other+(on.has(other)?' — spotlight':' — hidden by a chip; re-centres'),
            textContent:shortId(other),
            onclick:()=>{ if(on.has(other)&&GA.byId.has(other)) aroundSelect(other); else openGraph(other); }}) ]),
        el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
          e.access? el('span',{className:'tag '+(e.access==='read'?'read':'write'),textContent:e.access}) : null,
          el('span',{className:'count',textContent:e.type}), badge(e.grade) ]) ]);
    }) : [el('li',{className:'empty',textContent:t('around.noedge')})]) ]);
}

// ---------- Graph tab, MAP mode — the whole pack in one picture ----------
// The Graph tab opens on the WHOLE relation map (the `map` tool: API groups →
// endpoints → the tables they reach, plus the joins the SQL witnesses), not on
// an empty box waiting for a focus. `Around <node>` — the hop rings above — is
// the drill-down you reach from it.
//
// The drawing is done by the two vendored MIT bundles (viewer/vendor, served by
// /vendor): `ForceGraph` on a 2D canvas and `ForceGraph3D` on WebGL. They own
// the layout, the pan/zoom and the hit-testing; this page owns what a node and
// a line MEAN. The renderers are interchangeable on purpose — the same node and
// link view models feed both, and the positions carry across the switch — so
// "2D or 3D" never changes the answer, only the projection.
//
// Everything drawn here comes from ONE answer. The page computes nothing the
// engine did not send except a radius, a colour and which labels fit.
const gmapDimNode=()=> cssVar('--dim-node');
// The clicked node and its 1-hop get names; past 30 the rail lists the rest —
// thirty labels is already the most a picture can carry without becoming text.
const GMAP_LABEL_CAP=30;
// At rest only the skeleton is named: every group, and the tables busy enough
// to be landmarks. This cap keeps the 3D label plane cheap on a big pack.
const GMAP_REST_CAP=80;
// Past this many links the 3D view draws lines instead of cylinders: ten
// thousand meshes is a slideshow, and a line says the same thing.
const GMAP_3D_CYLINDER_MAX=2000;
const GMAP_ROW_CAP=80;   // connections listed per kind in the rail
// The count line names the edge kinds it counted, and the rail heads each list
// with the kind it holds. Both are spelled out for the same reason kindName is.
const LINK_KIND_KEY={ aggregate:'link.aggregate', member:'link.member',
  touches:'link.touches', executes:'link.executes', joins:'link.joins', calls:'link.calls' };
const CARD_LIST_KEY={ group:'map.card.group', endpoint:'map.card.endpoint',
  statement:'map.card.statement', table:'map.card.table', screen:'map.card.screen',
  project:'map.card.projectlist' };
// ---- ONE size model, for both renderers ------------------------------------
// A node's radius is sqrt(its degree): the reader's eye compares AREA, so the
// square root is what makes "twice as connected" look twice as big instead of
// four times. Clamped at both ends — under 3 px a node stops being a node, and
// past 18 px the busiest table swallows its own neighbourhood. The 3D spheres
// take the same number (val3 = r³ against nodeRelSize), so the two projections
// agree about which node is the landmark.
const GMAP_R_MIN=3, GMAP_R_MAX=18;
const mapRadius=(degree)=> Math.max(GMAP_R_MIN, Math.min(GMAP_R_MAX, 2.2+Math.sqrt(Math.max(0, degree||0))*2.6));
// A SATELLITE IS SMALL. An unfolded group puts two dozen endpoints inside the
// space its own name needs, and at the size the degree model would give them
// they swallow the group they hang off. So an endpoint and the statement under
// it are capped: still sized by degree, inside a band that reads as detail
// rather than as another landmark.
const GMAP_R_SAT=4.5;
const mapNodeRadius=(kind, degree)=> (kind==='endpoint' || kind==='statement')
  ? Math.min(GMAP_R_SAT, mapRadius(degree)) : mapRadius(degree);
// Labels follow size: the smallest node that carries a name gets 11 px, the
// biggest 15, so the picture has a reading order before a word is read.
const GMAP_LABEL_MIN=11, GMAP_LABEL_MAX=15;
const mapLabelSize=(n)=> GMAP_LABEL_MIN
  + (GMAP_LABEL_MAX-GMAP_LABEL_MIN)*Math.max(0, Math.min(1, ((n.r||GMAP_R_MIN)-GMAP_R_MIN)/(GMAP_R_MAX-GMAP_R_MIN)));
// At rest a name is drawn for every GROUP (the skeleton you navigate by) and
// for any node in the top 40% by radius. Zoomed in past this, every node in
// view is named — at that magnification there is room, and the reader has
// asked for detail.
const GMAP_LABEL_PCTL=0.6;
const GMAP_LABEL_ZOOM=1.6;
// The three link alphas. Quiet at rest so the NODES read first — 0.18 on the
// dark sheet, 0.28 on the light one, where the same ink over paper reads
// fainter. A spotlit chain draws at full strength and everything else drops to
// 0.12: at 0.06 the rest of the map was gone, and a spotlight with nothing
// around it says nothing about where in the system the answer sits.
const GMAP_LINK_DIM=0.12;
const GMAP_LINK_FADE=0.07;   // an aggregate line whose group is unfolded
const GMAP_LINK_W_MIN=0.6, GMAP_LINK_W_MAX=3;
const mapLinkRestAlpha=()=> themeGlows() ? 0.18 : 0.28;
const mapClampW=(w)=> Math.max(GMAP_LINK_W_MIN, Math.min(GMAP_LINK_W_MAX, w));
// A little curvature separates two lines that run between the same pair of
// clusters; at 0.15 it is a bow, not an arc.
const GMAP_CURVE=0.15;
const mapCurvature=(kind)=> kind==='member' ? 0 : GMAP_CURVE;
// Strongest-first, for folding several endpoint touches into one line.
const GMAP_GRADE_RANK={EXACT:4, SOUND_SET:3, HEURISTIC:2, RUNTIME_ONLY:1, UNRESOLVED:0};
const mapGradeRank=(g)=> GMAP_GRADE_RANK[g] ?? -1;
// ONE preference, one key. The map's dots and the Flow/Impact lanes' dots are
// the same statement — "show me which way the call goes" — so they are the same
// switch, stored once and honoured by every picture that can move. The three
// buttons (Graph, Flow, Impact) are three handles on it, not three settings.
const FED_KEY='cascade.viewer.connected';
function fedPrefLoad(){
  const v=lsGet(FED_KEY);
  if(v==='on' || v==='off') GMAP.fed=(v==='on');
}
const FLOW_KEY='cascade.viewer.flow';
function flowPrefLoad(){
  const v=lsGet(FLOW_KEY);
  if(v==='on' || v==='off'){ GMAP.flow=(v==='on'); GMAP.flowTouched=true; }
}
function flowToggle(){
  GMAP.flow=!GMAP.flow;
  GMAP.flowTouched=true;
  lsSet(FLOW_KEY, GMAP.flow?'on':'off');
  renderMapFlowNote();
  mapRefresh();
  laneFlowRefresh();
}
/** The settled layout of one dimension. */
const mapCache=(dim)=> dim==='3d' ? GMAP.pos3 : GMAP.pos;
/** A NEW ANSWER describes a different graph: every layout it settled goes. */
function mapForgetLayout(){
  GMAP.pos=new Map(); GMAP.pos3=new Map(); GMAP.posDim=0;
  GMAP.fit={'2d':false, '3d':false}; GMAP.view2d=null; GMAP.layout='full';
  GMAP.r3d=1; GMAP.sized3d=0;
}
const GMAP_LOCAL_TICKS=60;    // the short run a handful of new satellites get
const mapTicks=()=> GMAP.layout==='none' ? 0
  : (GMAP.layout==='local' ? GMAP_LOCAL_TICKS : null);   // null: the mount's own number

const esc=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// The pane the picture fills, and the element the renderer mounts into.
const mapWrapEl=()=> byId(GMAP.where==='overview' ? 'ovmap' : 'gwrap');
const mapHostEl=()=> byId(GMAP.where==='overview' ? 'ovmapwrap' : 'gmapwrap');
/** Move the live map to the other pane, keeping the answer and the layout. */
function mapMoveTo(where){
  if(GMAP.where===where) return;
  stopMap();              // saves the settled positions on the way out
  GMAP.where=where;
}
// Every node on this map is INK: what a node IS, is said by its glyph (a group
// a large ring, an endpoint a triangle, a statement a diamond, a table a
// rectangle), never by a hue.
// Reads blue, writes and deletes red — the same two hues the .tag.read/.write
// chips use everywhere else. An aggregated access ("delete+read") counts as a
// write: the strongest thing that happens on that line is what it must show.
const mapAccessColor=(access)=> (access && /write|delete/.test(access)) ? cssVar('--write') : cssVar('--read');

function mapLinkBaseColor(l){
  if(l.kind==='member') return cssVar('--t3');
  if(l.kind==='joins') return cssVar('--join');
  // A screen calling a route is neither a read nor a write: it is a REQUEST, so
  // it is drawn in the screen's own hue rather than borrowing the access
  // colours, which mean something else on every other line here.
  // A CROSSING is a request too, and it is drawn in the hue of the project it
  // lands in, because that is the one thing a reader needs from it.
  if(l.kind==='calls') return l.federated ? (GMAP.fedColor(l.project) || cssVar('--k-screen')) : cssVar('--k-screen');
  return mapAccessColor(l.access);
}
// Width is WEIGHT, in one narrow band (0.6–3 px) so that no line ever shouts
// over a node: a member hairline, a join by how many statements witness it, an
// aggregate by how many endpoints stand behind it, a single touch by the
// statements that carry it.
function mapLinkWidth(l){
  if(l.kind==='member') return GMAP_LINK_W_MIN;
  if(l.kind==='joins') return mapClampW(0.8 + Math.log2(1+(l.witness||1))*0.8);
  if(l.kind==='calls') return mapClampW(0.6 + Math.sqrt(l.routes||1)*0.7);
  if(l.kind==='aggregate') return mapClampW(0.6 + Math.sqrt(l.endpoints||1)*0.8);
  return mapClampW(0.8 + (l.statements||1)*0.35);
}
function mapNodeTip(n){
  const bits=['<b>'+esc(kindName(n.kind))+'</b> '+esc(n.label)];
  const fed=mapFedOf(n);
  if(fed && n.kind!=='project') bits.push(esc(t('tip.fedproject',{p:fed})));
  if(n.kind==='project') bits.push(esc(t('tip.fedskeleton',{n:n.endpoints||0})));
  if(n.kind==='endpoint'){ if(n.handlerShort) bits.push(esc(n.handlerShort)); bits.push(esc(t('tip.ingroup',{g:n.group}))); }
  if(n.kind==='table'){ if(n.comment) bits.push('“'+esc(n.comment)+'”'); bits.push(esc(t('tip.columns',{n:n.columnCount}))); }
  if(n.kind==='statement'&&n.statementType) bits.push(esc(n.statementType));
  if(n.kind==='screen'){
    if(n.title) bits.push(esc(n.title));
    bits.push(esc(t('tip.screenapi',{n:n.endpoints})));
    bits.push(esc(t('tip.screentables',{n:n.tables})));
    if(n.observed) bits.push(esc(t('tip.seen')));
  }
  // Two facts, two sentences: how many endpoints stand inside this group, and
  // what a group IS. The second one used to hang off the first behind a dash,
  // which read as though the count were being explained.
  if(n.kind==='group'){ bits.push(esc(t('tip.endpoints',{n:n.endpoints}))); bits.push(esc(t('tip.groupnote'))); }
  bits.push(esc(t('tip.connections',{n:n.degree})));
  return bits.join('<br>');
}
function mapLinkTip(l){
  const bits=[esc(shortId(l.source))+' → '+esc(shortId(l.target)), '<b>'+esc(l.kind)+'</b>'];
  if(l.access) bits.push('access '+esc(l.access));
  // An aggregate line stands for several endpoint touches, so it must say how
  // many — and how the access splits, because "dominant write" is a colour and
  // a colour is not evidence.
  if(l.kind==='aggregate') bits.push(l.endpoints+' endpoint(s) — reads '+l.reads+' / writes '+l.writes);
  if(l.kind==='calls' && l.federated) bits.push(esc(t('tip.crossing',{p:l.project})),
    ...(l.route ? [esc(l.route)] : []), ...(l.ambiguous ? [esc(t('tip.crossing.ambiguous'))] : []));
  else if(l.kind==='calls' && l.routes!=null) bits.push(esc(t('tip.screenapi',{n:l.routes})));
  if(l.statements!=null) bits.push(l.statements+' statement(s) carry it');
  if(l.witness!=null) bits.push(l.witness+' statement(s) witness this join');
  bits.push('grade '+esc(l.grade)+(l.grade==='SOUND_SET'?' — a candidate chain, not a proof':''));
  return bits.join('<br>');
}

// Does the browser actually have WebGL, and did the 3D bundle load? Asked once.
// A "no" is not hidden: the toolbar says the picture fell back to 2D.
function mapWebglOk(){
  if(GMAP.webgl!=null) return GMAP.webgl;
  let ok;
  try{
    const c=document.createElement('canvas');
    ok=!!(window.WebGLRenderingContext && (c.getContext('webgl2')||c.getContext('webgl')||c.getContext('experimental-webgl')));
  }catch(e){ ok=false; }
  GMAP.webgl = ok && typeof window.ForceGraph3D!=='undefined';
  return GMAP.webgl;
}
const mapHas2D=()=> typeof window.ForceGraph!=='undefined';

// ---- the answer, indexed ----------------------------------------------------
// The aggregation needs three things the answer states but does not tabulate:
// which group each endpoint belongs to, which endpoints each group holds, and
// what each endpoint ENDS AT. The last one has two shapes in the answer — the
// endpoint→table shortcut, or, with the statements layer on, the two real steps
// through the SQL — and this flattens both to the same table: endpoint → table
// → {access, statements}. Nothing is inferred; every entry comes off a link the
// engine sent.
function mapIndexAnswer(){
  const a=GMAP.resp.answer;
  const epGroup=new Map(), groupEps=new Map(), epTables=new Map(), stmtOut=new Map();
  // The screens layer, indexed the same way: which routes each screen reaches,
  // with the grade the engine put on that pair. Empty unless the layer is on.
  const screenEps=new Map();
  for(const l of a.links){
    // A CROSSING is a `calls` line too, and it is not a screen calling a route:
    // it is this project's endpoint calling another project's. It is folded by
    // its own rule below, so it must not land in the screen index here.
    if(l.kind==='calls' && !l.federated){
      let m=screenEps.get(l.source);
      if(!m){ m=new Map(); screenEps.set(l.source, m); }
      m.set(l.target, l.grade);
    }
    if(l.kind==='member'){
      epGroup.set(l.target, l.source);
      const list=groupEps.get(l.source);
      if(list) list.push(l.target); else groupEps.set(l.source, [l.target]);
    } else if(l.kind==='executes' && String(l.source).startsWith('statement:')){
      const arr=stmtOut.get(l.source);
      if(arr) arr.push(l); else stmtOut.set(l.source, [l]);
    }
  }
  const add=(ep, table, access, statements, grade)=>{
    let m=epTables.get(ep);
    if(!m){ m=new Map(); epTables.set(ep, m); }
    const cur=m.get(table);
    if(!cur){ m.set(table, {access:access||'read', statements:statements||1, grade}); return; }
    cur.statements += (statements||1);
    // The STRONGEST thing that happens on this pair is what it must show, both
    // for the access hue and for the grade — the same rule core/map.mjs uses.
    if(/write|delete/.test(access||'')) cur.access=access;
    if(mapGradeRank(grade)>mapGradeRank(cur.grade)) cur.grade=grade;
  };
  for(const l of a.links){
    if(l.kind==='touches') add(l.source, l.target, l.access, l.statements, l.grade);
    else if(l.kind==='executes' && String(l.target).startsWith('statement:')){
      for(const e of (stmtOut.get(l.target)||[])) add(l.source, e.target, e.access, 1, e.grade);
    }
  }
  GMAP.epGroup=epGroup; GMAP.groupEps=groupEps; GMAP.epTables=epTables; GMAP.screenEps=screenEps;
  GMAP.answerById=new Map(a.nodes.map(n=>[n.id,n]));
  GMAP.endpointsTotal=a.nodes.reduce((n,x)=> n+(x.kind==='endpoint'?1:0), 0);
}
// One line per (group, table): how many of that group's endpoints touch the
// table, how that splits between reads and writes, and how many statements
// carry it. The split is the EVIDENCE — the colour is only the dominant half of
// it, and a colour on its own would hide the other half.
function mapAggregates(){
  const agg=new Map();
  for(const [ep, tables] of GMAP.epTables){
    const g=GMAP.epGroup.get(ep);
    if(!g) continue;
    for(const [tid, t] of tables){
      const k=g+' '+tid;   // ids carry no space, so this pair is unambiguous
      let x=agg.get(k);
      if(!x){ x={source:g, target:tid, kind:'aggregate', endpoints:0, reads:0, writes:0, statements:0, grade:t.grade}; agg.set(k, x); }
      x.endpoints += 1;
      x.statements += t.statements;
      if(/write|delete/.test(t.access||'')) x.writes += 1; else x.reads += 1;
      if(mapGradeRank(t.grade)>mapGradeRank(x.grade)) x.grade=t.grade;
    }
  }
  // A tie goes to the write: one endpoint that deletes out of a group of two is
  // not a read line.
  for(const x of agg.values()) x.access = (x.writes>0 && x.writes>=x.reads) ? 'write' : 'read';
  return [...agg.values()];
}
// WHERE A NODE THE PICTURE HAS NEVER PLACED STARTS. The library's own seed is a
// phyllotaxis disc about the origin, which is round - and this pane is half as
// tall as it is wide, so a round settle leaves a third of the sheet empty and
// shrinks every node to fit the height. The charge here is deliberately local
// (distanceMax 250), so the SHAPE of the seed largely survives the settle: seed
// it on an ellipse of the pane's own proportions and the finished map fills the
// pane instead of a column down the middle. Deterministic - the same map opens
// the same way every time.
function mapSeedSpread(m, i, n, W, H){
  const t=n>1 ? i/(n-1) : 0;
  const ang=i*2.39996;                 // the golden angle: no arms, no rings
  const rad=Math.sqrt(t);
  m.x=Math.cos(ang)*rad*W*0.42;
  m.y=Math.sin(ang)*rad*H*0.42;
}
// WHERE A CONNECTED PROJECT'S CLUSTER STARTS. This project's own map keeps the
// sheet it has always had, and every node it has already placed holds still
// (RM25's rule); a sibling's cluster seeds on its own smaller ellipse to the
// RIGHT of it, one band per sibling down the pane. The picture then reads as
// "our map, and over there what it calls" instead of two systems shuffled into
// one. Deterministic, like every other seed here: the same server opens the
// same way every time.
const GMAP_FED_CX=0.55, GMAP_FED_RX=0.15, GMAP_FED_RY=0.18, GMAP_FED_SPREAD=0.62;
function mapSeedFederated(m, band, bands, i, n, W, H){
  const t=n>1 ? i/(n-1) : 0;
  const ang=i*2.39996;                 // the golden angle, the same one mapSeedSpread uses
  const rad=Math.sqrt(t);
  const cy=bands>1 ? (band/(bands-1)-0.5)*H*GMAP_FED_SPREAD : 0;
  m.x=W*GMAP_FED_CX+Math.cos(ang)*rad*W*GMAP_FED_RX;
  m.y=cy+Math.sin(ang)*rad*H*GMAP_FED_RY;
  m.z=0;
}
/** Which connected project a node belongs to, or null for one of our own. */
const mapFedOf=(n)=> (n.kind==='project' ? (n.label||null) : (n.project||null));
// Where an endpoint that has never been drawn before starts: on a small ring
// around ITS OWN group, at an angle derived from its id, so unfolding opens a
// star rather than flinging 24 nodes in from the origin — and so the same group
// opens the same way twice.
function mapSeedSatellite(m, anchorId, cache){
  const g=(cache||GMAP.pos).get(anchorId);
  if(!g || !Number.isFinite(g.x)) return;
  let h=0; for(let i=0;i<m.id.length;i++) h=(h*31+m.id.charCodeAt(i))>>>0;
  const ang=(h%3600)/3600*2*Math.PI, d=52+(h%7)*7;
  m.x=g.x+Math.cos(ang)*d; m.y=g.y+Math.sin(ang)*d; m.z=g.z||0;
}
// WHICH ROUTES AND STATEMENTS ARE OPEN, from the groups the reader unfolded. A
// statement is drawn only when one of the endpoints that runs it is open, and it
// hangs off that endpoint's group.
function mapOpenSets(a){
  const openEps=new Set();
  for(const g of GMAP.open) for(const ep of (GMAP.groupEps.get(g)||[])) openEps.add(ep);
  const openStmts=new Set(), stmtAnchor=new Map();
  for(const l of a.links){
    if(l.kind==='executes' && openEps.has(l.source)){
      openStmts.add(l.target);
      if(!stmtAnchor.has(l.target)) stmtAnchor.set(l.target, GMAP.epGroup.get(l.source));
    }
  }
  return { openEps, openStmts, stmtAnchor };
}
// ---- degree, from what this picture actually DRAWS -----------------------
function mapDegreeRule(aggregates, openEps){
  const groupTables=new Map();
  for(const x of aggregates){
    const s=groupTables.get(x.source);
    if(s) s.add(x.target); else groupTables.set(x.source, new Set([x.target]));
  }
  const tableTouchers=new Map();
  const touch=(tid, who)=>{ const s=tableTouchers.get(tid); if(s) s.add(who); else tableTouchers.set(tid, new Set([who])); };
  for(const x of aggregates) if(!GMAP.open.has(x.source)) touch(x.target, x.source);
  for(const ep of openEps) for(const tid of (GMAP.epTables.get(ep)||new Map()).keys()) touch(tid, ep);
  return (n)=>{
    // A node from another pack keeps the degree the ANSWER gave it: this
    // picture never folds that cluster, so the drawing and the answer cannot
    // disagree about how connected it is. A project skeleton stands for the
    // routes hanging off it, exactly as a folded group stands for its
    // endpoints.
    if(n.kind==='project') return n.endpoints||0;
    if(n.project) return n.degree||0;
    // A SCREEN'S SIZE IS WHAT IT REACHES, and that is the answer's own number:
    // how many routes the forward walk found, whether or not their groups are
    // open. Counting the LINES instead would shrink a screen every time the
    // reader folded a group, which is a change in the drawing, not in the fact.
    if(n.kind==='screen') return n.endpoints||0;
    if(n.kind==='group') return GMAP.open.has(n.id)
      ? (groupTables.get(n.id)||new Set()).size          // unfolded: the tables it reaches
      : (n.endpoints||0);                                // folded: the endpoints it stands for
    if(n.kind==='table') return (tableTouchers.get(n.id)||new Set()).size;
    if(n.kind==='endpoint') return (GMAP.epTables.get(n.id)||new Map()).size;
    return n.degree||0;   // a statement keeps the degree the answer gave it
  };
}
// One drawn node per visible answer node: its size, its colour, and where it
// sits. A node this picture has already placed comes back PINNED, which is the
// whole of the stability rule: the forces cannot move it, so an unfold, a fold,
// a spotlight or a trip through Around leaves it exactly where the reader last
// saw it, and a click aimed at it lands on it.
function mapDrawnNodes(vis, dim, cache, degreeOf, stmtAnchor, paneW, paneH){
  // One band per connected project, in the order their hues were assigned, and
  // a running index inside each band so a cluster seeds as one ellipse.
  const fedBand=new Map(GMAP.fedProjects.map((x, i)=>[x, i]));
  const fedSize=new Map(), fedSeq=new Map();
  for(const n of vis){ const f=mapFedOf(n); if(f) fedSize.set(f, (fedSize.get(f)||0)+1); }
  return vis.map((n, i)=>{
    const p=cache.get(n.id);
    const degree=degreeOf(n);
    const r=mapNodeRadius(n.kind, degree);
    // THE PROJECT CHIP IS PART OF THE NAME on a picture, because a picture has
    // no room for a second element beside a five-pixel disc. The skeleton node
    // is already named after its project and does not repeat it.
    const fed=mapFedOf(n);
    const label=(fed && n.kind!=='project') ? n.label+'  ['+fed+']' : n.label;
    const m={ id:n.id, kind:n.kind, label, degree, data:n, fed,
      r, val:r*r, val3:r*r*r, col:kindColor(n.kind), fill:kindFill(n.kind),
      ring:fed ? GMAP.fedColor(fed) : null, tip:mapNodeTip({...n, degree}) };
    if(p){
      m.x=p.x; m.y=p.y; m.z=p.z||0;
      if(p.pin){ m.fx=p.x; m.fy=p.y; if(dim==='3d') m.fz=p.z||0; }
    }
    else if(fed){
      const k=fedSeq.get(fed)||0; fedSeq.set(fed, k+1);
      mapSeedFederated(m, fedBand.get(fed)||0, fedBand.size, k, fedSize.get(fed)||1, paneW, paneH);
    }
    else if(n.kind==='endpoint') mapSeedSatellite(m, GMAP.epGroup.get(n.id), cache);
    else if(n.kind==='statement') mapSeedSatellite(m, stmtAnchor.get(n.id), cache);
    if(!Number.isFinite(m.x)) mapSeedSpread(m, i, vis.length, paneW, paneH);
    // The round trip reads TOP TO BOTTOM here: the browser above, the routes
    // and the tables it reaches below. A screen starts above the sheet and the
    // bias force keeps it there; it is a bias and not a lane, so a screen still
    // settles beside the group it actually calls.
    if(n.kind==='screen') m.y=-paneH*0.55+((i%7)-3)*8;
    return m;
  });
}
// ---- the line set --------------------------------------------------------
// A SCREEN'S LINES AND A CROSSING FOLD THE WAY THE ENDPOINT LINES DO. While a
// group is closed, a screen that calls routes inside it points at the GROUP and
// the line says how many routes it stands for; opening the group moves the line
// onto the routes themselves. One rule for both, so the picture never shows a
// line leaving or entering a box that is not there.
function mapRawLinks(a, aggregates, openEps, openStmts){
  const raw=[];
  for(const x of aggregates) raw.push(x);
  const screenLinks=new Map();
  for(const [sid, eps] of (GMAP.screenEps||new Map())){
    for(const [ep, grade] of eps){
      const target = openEps.has(ep) ? ep : (GMAP.epGroup.get(ep) || ep);
      const k=sid+' '+target;
      let x=screenLinks.get(k);
      if(!x){ x={source:sid, target, kind:'calls', routes:0, grade}; screenLinks.set(k,x); }
      x.routes+=1;
      if(mapGradeRank(grade)>mapGradeRank(x.grade)) x.grade=grade;
    }
  }
  for(const x of screenLinks.values()) raw.push(x);
  const crossings=new Map();
  for(const l of a.links){
    if(l.kind!=='calls' || !l.federated) continue;
    const source = openEps.has(l.source) ? l.source : (GMAP.epGroup.get(l.source) || l.source);
    const k=source+' '+l.target;
    let x=crossings.get(k);
    if(!x){ x={...l, source, routes:0}; crossings.set(k, x); }
    x.routes+=1;
    if(mapGradeRank(l.grade)>mapGradeRank(x.grade)) x.grade=l.grade;
  }
  for(const x of crossings.values()) raw.push(x);
  for(const l of a.links){
    if(l.kind==='calls' && l.federated) continue;   // already folded, above
    // A connected project's own line is drawn whenever its cluster is, because
    // that cluster is never folded.
    if(l.project) raw.push(l);
    else if(l.kind==='joins') raw.push(l);
    else if(l.kind==='member'){ if(openEps.has(l.target)) raw.push(l); }
    else if(l.kind==='touches'){ if(openEps.has(l.source)) raw.push(l); }
    else if(l.kind==='executes'){ if(openEps.has(l.source) || openStmts.has(l.source)) raw.push(l); }
  }
  return raw;
}
// ---- the view model: one answer -> nodes and links the renderers understand ----
// AT REST the picture is the SKELETON: one node per API group, one per table,
// and one line per (group, table) that folds every endpoint touch under it.
// That is 32 + 49 nodes on mall instead of 320, and the reader can see the
// shape before deciding where to look. Unfolding a group (a click on it, its
// chip, or the `endpoints` control) puts its endpoints back as satellites with
// their own lines; the aggregate line stays, faded, so the two readings never
// contradict each other. The ANSWER is untouched: this is a rendering, and the
// census still counts every endpoint.
function buildMapModel(dim){
  const cache=mapCache(dim||'2d');
  const a=GMAP.resp.answer;
  mapIndexAnswer();
  for(const id of [...GMAP.open]) if(!GMAP.answerById.has(id)) GMAP.open.delete(id);
  const { openEps, openStmts, stmtAnchor }=mapOpenSets(a);
  const aggregates=mapAggregates();
  // WHAT CAME FROM ANOTHER PACK IS NEVER FOLDED. A connected project's cluster
  // is one route and what that route reaches, which is the whole point of
  // drawing it; folding it into its skeleton would hide exactly the thing the
  // reader opened the map for. So it is drawn whole, or not at all.
  GMAP.fedProjects=[...new Set(a.nodes.map(mapFedOf).filter(Boolean))].sort();
  GMAP.fedColor=fedRingColor(GMAP.fedProjects);
  const wanted=a.nodes.filter((n)=>
    mapFedOf(n) ? GMAP.fed
      : (n.kind==='group' || n.kind==='table' || n.kind==='screen'
        || (n.kind==='endpoint' && openEps.has(n.id))
        || (n.kind==='statement' && openStmts.has(n.id))));
  const vis=wanted.filter(n=>!GMAP.hidden.has(n.kind));
  const on=new Set(vis.map(n=>n.id));
  const degreeOf=mapDegreeRule(aggregates, openEps);
  const pane=mapWrapEl();
  const paneW=(pane&&pane.clientWidth)||900, paneH=(pane&&pane.clientHeight)||620;
  GMAP.nodes=mapDrawnNodes(vis, dim, cache, degreeOf, stmtAnchor, paneW, paneH);
  // How many nodes this mount has to place. Nothing to place means nothing to
  // simulate: the picture is repainted, not laid out again.
  GMAP.loose=GMAP.nodes.reduce((n,x)=> n+(x.fx==null?1:0), 0);
  GMAP.byId=new Map(GMAP.nodes.map(n=>[n.id,n]));
  const raw=mapRawLinks(a, aggregates, openEps, openStmts);
  // A line is drawn only when BOTH its ends are on screen: a hidden kind takes
  // its links with it rather than leaving them hanging off nothing.
  GMAP.links=raw.filter(l=>on.has(l.source)&&on.has(l.target)).map((l,i)=>({
    i, sid:l.source, tid:l.target, source:l.source, target:l.target, data:l,
    col:mapLinkBaseColor(l), w:mapLinkWidth(l), curv:mapCurvature(l.kind),
    // The aggregate line of an OPEN group is not deleted - the satellites are
    // the same touches drawn one by one, and a reader mid-unfold must be able
    // to see that the two say the same thing - but it steps back to a whisper.
    faded: l.kind==='aggregate' && GMAP.open.has(l.source),
    // Grade is not drawable in 3D, so it lives in the tooltip and the rail in
    // both renderers; in 2D a candidate endpoint to table chain is also DASHED.
    dash:(l.kind!=='member' && l.kind!=='joins' && l.grade==='SOUND_SET') ? [4,3] : null,
    tip:mapLinkTip(l),
  }));
  // The flow's performance guard: a few thousand animated dots is a frame
  // budget spent on decoration, so past the cap the resting map is still and
  // only a lit node's own lines run. The toolbar says so.
  GMAP.directed=GMAP.links.reduce((n,l)=> n+(l.data.kind==='joins'?0:1), 0);
  GMAP.flowRest = GMAP.directed<=GMAP_FLOW_REST_MAX;
  GMAP.incident=new Map(GMAP.nodes.map(n=>[n.id,[]]));
  for(const l of GMAP.links){ GMAP.incident.get(l.sid).push(l.i); GMAP.incident.get(l.tid).push(l.i); }
  // Which names stand at rest: every group, and every node in the top 40% by
  // radius. Sized by degree, they read as a table of contents rather than as
  // 300 equal words.
  GMAP.labelR=mapLabelFloor(GMAP.nodes);
  GMAP.restLabels=new Set(GMAP.nodes.filter(mapRestLabel).map(n=>n.id));
  mapSetLit(GMAP.sel);
}
// A SATELLITE CARRIES NO NAME AT REST. Unfolding a group puts two dozen small
// discs inside the space its own label needs, and every one of them wanted a
// route string beside it: the group's name disappeared under its own children.
// So an endpoint (and a statement, which hangs off one) is named only when it is
// lit or when the reader has zoomed in far enough to have room - until then the
// group's name stands for the whole cluster, which is what a fold is for.
const mapLabelEligible=(n)=> n.kind!=='endpoint' && n.kind!=='statement';
/** The radius the 60th percentile of the NAMEABLE nodes sits at. */
function mapLabelFloor(nodes){
  const radii=nodes.filter(mapLabelEligible).map(n=>n.r).sort((a,b)=>a-b);
  if(!radii.length) return 0;
  return radii[Math.min(radii.length-1, Math.floor(radii.length*GMAP_LABEL_PCTL))];
}
// A PORTAL IS ALWAYS NAMED. It is another project's route, and the route string
// is the whole of what that node says. The label-follows-size rule hides it,
// because an endpoint is a satellite and satellites are small - which left the
// one node on the map that explains why a second project is there with no name
// on it. There is one portal per crossing, so naming every one costs nothing.
const mapIsPortal=(n)=> !!(n && n.data && n.data.portal === true);
const mapRestLabel=(n)=> n.kind==='group' || n.kind==='project' || mapIsPortal(n)
  || (mapLabelEligible(n) && n.r>=(GMAP.labelR||0));

// The highlight: a node, the links that touch it, and the neighbours on their
// far ends. Everything else is dimmed — never removed, so the picture never
// pretends the rest of the system is not there.
function mapSetLit(id){
  if(!id || !GMAP.byId.has(id)){ GMAP.lit=null; GMAP.litLabels=new Set(); return; }
  const nodes=new Set([id]), links=new Set();
  for(const i of (GMAP.incident.get(id)||[])){
    links.add(i);
    nodes.add(GMAP.links[i].sid); nodes.add(GMAP.links[i].tid);
  }
  GMAP.lit={id, nodes, links};
  const near=[...nodes].filter(x=>x!==id).map(x=>GMAP.byId.get(x)).filter(Boolean)
    .sort((x,y)=> (x.kind==='group'?0:1)-(y.kind==='group'?0:1) || y.degree-x.degree || (x.id<y.id?-1:1));
  GMAP.litLabels=new Set([id, ...near.slice(0,GMAP_LABEL_CAP-1).map(n=>n.id)]);
}
// Which names this frame wants. At rest the percentile set — unless the reader
// has zoomed in past 1.6×, where there is room for every node in view and the
// zoom itself is the request for detail. Under a spotlight only the lit
// neighbourhood is named, however far in the picture is zoomed.
// A satellite is named only under a spotlight. Zooming in used to name every
// endpoint of an open group as well, and thirty-two route strings inside one
// cluster is the collision this round set out to remove: the group's name is
// what stands for the cluster until the reader lights one of them.
const mapWantsLabel=(n, k)=> GMAP.lit ? GMAP.litLabels.has(n.id)
  : (GMAP.restLabels.has(n.id)
     || (k!=null && k>=GMAP_LABEL_ZOOM && mapLabelEligible(n)));
// Every picture draws its nodes as filled discs, so what a node needs from the
// theme is its kind's FILL, not the ink the rail writes its name in. Under a
// spotlight everything the answer does not touch drops to a twelfth of its
// strength: enough to keep the shape of the system visible under the answer,
// not enough to compete with it.
const GMAP_NODE_DIM=0.12;
const mapNodeFill=(n)=> (!GMAP.lit || GMAP.lit.nodes.has(n.id)) ? (n.fill||n.col) : gfAlpha(n.fill||n.col, GMAP_NODE_DIM);
// Quiet at rest, loud where the reader is looking. The alpha rides on the
// COLOUR because a canvas line carries its own; the token stays the access hue
// either way, so nothing changes meaning when it fades.
const mapLinkColor=(l)=>{
  if(!GMAP.lit) return gfAlpha(l.col, l.faded ? GMAP_LINK_FADE : mapLinkRestAlpha());
  if(GMAP.lit.links.has(l.i)) return l.col;
  return gfAlpha(l.col, GMAP_LINK_DIM);
};
const mapLinkW=(l)=> (GMAP.lit && GMAP.lit.links.has(l.i)) ? l.w+1 : l.w;
const mapArrow=(l)=> l.data.kind==='joins' ? 0 : 2.6;   // a join is undirected

// ---- the flow: which way the call actually runs -----------------------------
// The links already point the way a call goes — group → endpoint (member),
// endpoint → table (touches), endpoint → statement → table (executes) — so the
// particles need no direction of their own: they ride source → target. A join
// is a fact about two tables, not a call, and carries none.
//
// Density is what the line already says: one dot per statement behind a touch,
// capped at four, because past four the dots merge into a moving dashed line
// and stop counting anything. Speed is a fraction of the link per frame, slow
// enough to read as a flow rather than a blur, and varied a little from link to
// link so the whole map does not march in lockstep.
const GMAP_FLOW_REST_MAX=2500;   // directed links past which the resting map is still
const mapFlowN=(l)=> l.data.kind==='member' ? 1 : Math.min(4, 1+(l.data.statements||0));
// THE RESTING MAP DOES NOT MOVE. A dot on every one of the 111 aggregate lines
// is exactly the clutter this round set out to remove: in a still frame it reads
// as speckle, not as direction. So the map animates at rest only when the reader
// has actually pressed the toggle on - the theme's own default is not a request
// for motion on a picture this size. A LIT node is different: that is one chain,
// it is the thing being answered, and its lines flow whatever the toggle says.
const mapFlowsAtRest=()=> GMAP.flow && GMAP.flowTouched;
function mapParticles(l){
  // A reader who asked their system for less motion has already answered, and
  // that answer outranks a spotlight.
  if(reducedMotion()) return 0;
  if(l.data.kind==='joins') return 0;
  // A lit node OWNS the animation: its own lines flow and every other line is
  // still, so the eye follows the selection instead of the whole picture.
  if(GMAP.lit) return GMAP.lit.links.has(l.i) ? mapFlowN(l) : 0;
  if(!mapFlowsAtRest()) return 0;
  return GMAP.flowRest ? mapFlowN(l) : 0;
}
const mapFlowSpeed=(l)=> 0.004+((l.i%3)*0.001);
const mapFlowColor=(l)=> l.col;
// Twice the line, never under two pixels — a dot the width of a hairline is a
// flicker, not a direction. In 3D the same number is scaled to the layout's own
// span, exactly as the link cylinders are, or it is a speck at fit distance.
const mapFlowW=(l)=> Math.max(2, l.w*2);
const map3dFlowW=(l)=> mapFlowW(l)*(GMAP.scale3d||1);

// Re-reading the accessors is how both renderers are told the highlight moved
// (the 3D one rebuilds its materials from them; the 2D one repaints).
function mapRefresh(){
  const g=GMAP.api; if(!g) return;
  GMAP.labelAt=0;   // the 3D label plane re-places itself on the very next frame
  try{ g.nodeColor(mapNodeFill).linkColor(mapLinkColor).linkWidth(GMAP.drawn==='3d' ? map3dWidth : mapLinkW)
        .linkDirectionalParticles(mapParticles)
        .linkDirectionalParticleWidth(GMAP.drawn==='3d' ? map3dFlowW : mapFlowW); }
  catch(e){ /* a renderer torn down mid-hover has nothing to refresh */ }
}
// A 3D layout spreads over a VOLUME, so at fit-distance the same radius that
// reads well on the 2D canvas is a dot. Both the spheres and the link cylinders
// are scaled up here to land at roughly the 2D weight on screen; past the
// cylinder cap the links fall back to plain lines (width 0), because ten
// thousand meshes is a slideshow and a line says the same thing.
//
// This number is BOTH ends of a trade and cannot be chosen from taste. It sets
// how big a sphere is drawn, and — through map3dLinkD and the collide radii —
// how much room the layout gives each one; overlap in the finished picture
// moves with it almost one for one (measured on mall, discs overlapping
// another: 2.6 → 33.5%, 1.9 → 16.5%, 1.6 → 19.6% with a shorter member
// spring). It came down from 2.6 because at that size the whole map read as a
// handful of solid blobs; it stopped at 2.0 because below it the spheres fall
// under three pixels across at fit distance and stop being nodes at all.
const GMAP_3D_NODE_SCALE=2.0;
// A 2D canvas draws a line in graph units but never thinner than a hairline, so
// a 0.7-unit link is still visible; a WebGL CYLINDER of the same radius is a
// third of a pixel and simply is not there. So the 3D widths are scaled to the
// layout's own span (measured at mount, so it holds on a pack of any size) and
// floored, and the ramp from "one statement" to "eight" survives.
function map3dScale(){
  let lo=Infinity, hi=-Infinity;
  for(const n of GMAP.nodes) if(Number.isFinite(n.x)){ if(n.x<lo) lo=n.x; if(n.x>hi) hi=n.x; }
  return Math.max(1, (hi>lo ? hi-lo : 600)/420);
}
const map3dWidth=(l)=> GMAP.links.length>GMAP_3D_CYLINDER_MAX ? 0 : Math.max(1.2, mapLinkW(l))*(GMAP.scale3d||1);
// THE RADIUS A SPHERE IS DRAWN AT, in layout units, and the nodeVal that asks
// the library for it: force-graph paints a sphere of nodeRelSize x cbrt(val), so
// a multiplier on the radius is that multiplier cubed on the value.
const map3dR=(n)=> (n.r||GMAP_R_MIN)*GMAP_3D_NODE_SCALE*(GMAP.r3d||1);
const map3dVal=(n)=> n.val3*Math.pow(GMAP.r3d||1, 3);

function mapSavePositions(){
  const cache=mapCache(GMAP.drawn||'2d');
  for(const n of GMAP.nodes){
    if(Number.isFinite(n.x) && Number.isFinite(n.y)){
      cache.set(n.id,{x:n.x, y:n.y, z:Number.isFinite(n.z)?n.z:0, pin:n.fx!=null});
    }
  }
  if(GMAP.drawn) GMAP.posDim = GMAP.drawn==='3d' ? 3 : 2;
}
// PIN EVERY NODE WHERE IT STOPPED. Called once the layout has settled and again
// after a drag, so from then on the only thing that moves the picture is the
// reader asking it to.
function mapPinAll(){
  for(const n of GMAP.nodes){
    if(!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    n.fx=n.x; n.fy=n.y;
    if(GMAP.drawn==='3d' && Number.isFinite(n.z)) n.fz=n.z;
  }
}
/** …and the way back, for the one thing that lays the picture out again. */
function mapUnpinAll(){
  for(const n of GMAP.nodes){ n.fx=null; n.fy=null; n.fz=null; }
}
// The reader's own zoom and centre, remembered across a mount. Only the 2D
// canvas has a zoom this page can read back; the 3D camera is the library's.
function mapSaveView(){
  if(GMAP.drawn!=='2d' || !GMAP.api) return;
  try{
    const c=GMAP.api.centerAt(), k=GMAP.api.zoom();
    if(c && Number.isFinite(c.x) && Number.isFinite(k)) GMAP.view2d={x:c.x, y:c.y, k};
  }catch(e){ /* a renderer torn down mid-frame has no view to save */ }
}
function mapRestoreView(){
  const v=GMAP.view2d;
  if(GMAP.drawn!=='2d' || !GMAP.api || !v) return;
  try{ GMAP.api.centerAt(v.x, v.y, 0); GMAP.api.zoom(v.k, 0); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
}
// `keepPositions:false` when the ANSWER is being replaced — the old x/y describe
// a different graph, and carrying them over would seed the new one with a layout
// nothing measured.
function stopMap(keepPositions){
  if(GMAP.labelRaf){ cancelAnimationFrame(GMAP.labelRaf); GMAP.labelRaf=null; }
  if(GMAP.fitTimer){ clearTimeout(GMAP.fitTimer); GMAP.fitTimer=null; }
  if(GMAP.api){
    if(keepPositions!==false){ mapSavePositions(); mapSaveView(); }
    try{ if(GMAP.api.pauseAnimation) GMAP.api.pauseAnimation(); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
    try{ if(GMAP.api._destructor) GMAP.api._destructor(); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
  }
  GMAP.api=null; GMAP.drawn=null;
  // Whatever host it was MOUNTED in, not whichever one is current: the two are
  // different exactly when the picture is being moved between the panes. With
  // nothing mounted it is the current one that has to be emptied — that is the
  // pane holding the "the renderer did not load" note, or the label plane the
  // markup ships.
  const h=GMAP.mounted || mapHostEl();
  if(h) h.replaceChildren();
  GMAP.mounted=null;
}

// ---- the two renderers ------------------------------------------------------
// The force tweaks. The d3 defaults are tuned for a few dozen nodes: at 230
// (let alone a few thousand) the charge is too weak and the springs too short,
// and the map collapses into one unreadable knot with every label on top of
// every other. A group→endpoint spring is kept short on purpose — a group
// should read as a CLUSTER, its endpoints gathered round it.
//
// 2D and 3D do NOT share the numbers. They used to, near enough, and the 3D
// picture was the worse for it — mapTune3D below says what a volume needs that
// a plane does not.
//
// Every number here is now a function of the RADIUS, because the radius is a
// function of the degree: a hub pushes harder than a leaf and asks for more
// room around it, which is what stops a 39-connection table from being drawn
// inside the cluster it anchors. Charge grows with the radius; a spring is the
// two discs plus 30 units of clear air; and a collide force — the 2D bundle
// exposes none, so mapCollide2D below is one — keeps 4 units between any two
// discs whether or not a line joins them.
// These are SMALL on purpose, and the reason is the collide force below. The old
// map had none, so the charge had to do the separating and was set to -115 flat;
// at that strength the resting layout settles about 1300 units wide inside a
// 990-pixel pane and the fit then draws every 18-unit hub as a four-pixel dot -
// the size model becomes a promise the picture does not keep. With a collide
// holding the discs apart, the charge only has to keep the CLUSTERS off each
// other, and it still rises with the radius, so a hub owns more of the sheet
// than a leaf. Measured on mall at rest: 660 x 581 units in that pane, a zoom of
// 0.95 (so a "pixel" radius really is one), 0 overlapping pairs.
const GMAP_CHARGE_BASE=2, GMAP_CHARGE_PER_R=0.6, GMAP_CHARGE_MAX_D=600;
// A spring is the two discs plus clear air, times a spread. The spread is what
// opens the busiest cluster: at 1.0 the core of the mall map settles into a knot
// a quarter of the pane wide with no room for a single name inside it; at 2.2 it
// breathes and the placer can write into it. Larger again buys nothing - the
// picture is refitted either way, so past this only the OUTLYING groups grow.
const GMAP_LINK_AIR=30, GMAP_LINK_SPREAD=2.2, GMAP_COLLIDE_PAD=4;
const mapNodeR=(id)=>{ const n=GMAP.byId.get(id); return (n&&n.r)||GMAP_R_MIN; };
const mapLinkD2D=(l)=> (mapNodeR(l.sid)+mapNodeR(l.tid)+GMAP_LINK_AIR)*GMAP_LINK_SPREAD;
function mapTuneForces(g, three){
  if(three){ mapTune3D(g); return; }
  try{
    const charge=g.d3Force('charge');
    if(charge && charge.strength) charge.strength((n)=> -(GMAP_CHARGE_BASE+(n.r||GMAP_R_MIN)*GMAP_CHARGE_PER_R)).distanceMax(GMAP_CHARGE_MAX_D);
    const link=g.d3Force('link');
    if(link && link.distance) link.distance(mapLinkD2D);
    g.d3Force('collide', mapCollide2D());
    g.d3Force('screenlift', mapScreenLift());
  }catch(e){ /* a renderer without d3 forces keeps its own defaults */ }
}
// A GENTLE VERTICAL BIAS for the screens layer. The round trip reads top to
// bottom on this picture: the browser above, the routes it calls and the tables
// they end at below. This pulls the screens towards a line a little above the
// rest of the map and leaves everything else alone.
//
// It is a BIAS, not a lane. The springs still hold a screen beside the group it
// actually calls, so the reader can see WHICH part of the system a screen talks
// to; all this does is stop the screens settling in among the tables, where the
// picture would say the browser and the database are the same kind of thing.
const GMAP_SCREEN_LIFT=0.35;   // of the map's own height, above its top edge
const GMAP_SCREEN_PULL=0.35;   // how hard, per tick, against alpha
function mapScreenLift(){
  let ns=[];
  const force=(alpha)=>{
    if(!ns.length) return;
    let lo=Infinity, hi=-Infinity;
    for(const n of GMAP.nodes){
      if(n.kind==='screen' || !Number.isFinite(n.y)) continue;
      if(n.y<lo) lo=n.y;
      if(n.y>hi) hi=n.y;
    }
    if(!(hi>lo)) return;
    const target=lo-(hi-lo)*GMAP_SCREEN_LIFT;
    for(const n of ns){
      if(n.fy!=null || !Number.isFinite(n.y)) continue;
      n.vy=(n.vy||0)+(target-n.y)*alpha*GMAP_SCREEN_PULL;
    }
  };
  force.initialize=(nodes)=>{ ns=(nodes||[]).filter((n)=>n.kind==='screen'); };
  return force;
}
// The 2D bundle does not export d3-force's own forceCollide (the 3D one does
// not either — mapCollide3D says so at length), so this is one: the same
// uniform spatial hash, one dimension shorter. Two discs closer than the sum of
// their radii plus GMAP_COLLIDE_PAD are pushed apart, O(n) a tick.
function mapCollide2D(){
  let ns=[], rad=[], cell=1;
  const key=(a,b)=> a+':'+b;
  const force=()=>{
    if(ns.length<2) return;
    const grid=new Map();
    for(let i=0;i<ns.length;i++){
      const n=ns[i];
      const k=key(Math.floor((n.x||0)/cell), Math.floor((n.y||0)/cell));
      const b=grid.get(k); if(b) b.push(i); else grid.set(k,[i]);
    }
    const k2=0.35;   // half the push to each of the pair
    for(let i=0;i<ns.length;i++){
      const a=ns[i];
      const gx=Math.floor((a.x||0)/cell), gy=Math.floor((a.y||0)/cell);
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
        const b=grid.get(key(gx+dx, gy+dy)); if(!b) continue;
        for(let m=0;m<b.length;m++){
          const j=b[m]; if(j<=i) continue;
          const c=ns[j];
          const want=rad[i]+rad[j]+GMAP_COLLIDE_PAD;
          let x=(c.x||0)-(a.x||0), y=(c.y||0)-(a.y||0);
          const d2=x*x+y*y;
          if(d2>=want*want) continue;
          let d=Math.sqrt(d2);
          // Two nodes at one point have no direction to part along, so one is
          // derived from the pair's indices: the same split on every run.
          if(d<1e-6){ x=((i%5)-2)||1; y=((j%5)-2)||1; d=Math.sqrt(x*x+y*y); }
          const p=((want-d)/d)*k2, px=x*p, py=y*p;
          a.vx=(a.vx||0)-px; a.vy=(a.vy||0)-py;
          c.vx=(c.vx||0)+px; c.vy=(c.vy||0)+py;
        }
      }
    }
  };
  force.initialize=(nodes)=>{
    ns=nodes||[];
    rad=ns.map(n=> n.r||GMAP_R_MIN);
    let m=0; for(const r of rad) if(r>m) m=r;
    cell=Math.max(1, m*2+GMAP_COLLIDE_PAD);
  };
  return force;
}
// The 3D layout is NOT the 2D one with a third axis bolted on, and leaving it
// on the library's defaults is what made the blob: the default charge is a
// fraction of what this map is tuned to and the default spring is one length
// for every kind of line, so the whole thing collapses inward (measured on mall
// at fit distance: 87% of the node discs overlapping another one). Every force
// is therefore set here, by name.
//
// Charge is scaled to the node count — a big pack needs proportionally more
// room, or the extra nodes fill the same volume — and clamped at both ends.
// The numbers are ABOVE the 2D map's own -115, not below it: a volume swallows
// repulsion that a plane concentrates (measured on mall, discs overlapping
// another at fit distance: -62 → 52%, -200 → 36%, -400 → 33%). Past that the
// layout only grows and the nodes shrink with it, which flatters the number
// without making the picture any easier to read, so the ramp stops there.
const GMAP_3D_CHARGE_LO=200, GMAP_3D_CHARGE_HI=600;   // at 200 nodes / at 2000+
const GMAP_3D_CHARGE_MAX=1200;   // past this two nodes stop repelling at all
// A spring per KIND, so the picture has a hierarchy: a group holds its
// endpoints close (that is what makes it read as a cluster), a statement sits
// between its endpoint and its table, and a table hangs furthest out.
//
// These are the CLEAR AIR asked for between two spheres, not the distance
// between their centres — the 3D view draws every node at GMAP_3D_NODE_SCALE
// times its layout radius, so the busiest group's sphere has a radius of 33
// layout units on its own, and a spring that ignored that parked every one of
// its endpoints INSIDE it (measured: 76% of the discs overlapping another;
// adding the radii took that to 52% with nothing else changed).
//
// The member gap is the LARGEST, which looks backwards for the spring that is
// meant to hold a cluster together: it is what turns a group from a burr into a
// star you can count the arms of. The endpoints still have nothing else pulling
// them anywhere, so the cluster survives the stand-off — and on screen it went
// from 10 px between an endpoint and its own group node to 17.
const GMAP_3D_LINK_D={member:70, executes:60, joins:70, touches:90};
const map3dNodeR=(id)=>{ const n=GMAP.byId.get(id); return ((n&&n.r)||3)*GMAP_3D_NODE_SCALE; };
const map3dLinkD=(l)=> map3dNodeR(l.sid) + map3dNodeR(l.tid) + (GMAP_3D_LINK_D[l.data && l.data.kind] || 70);
const GMAP_3D_COLLIDE_PAD=6;     // layout units of clear air between two spheres
function map3dCharge(n){
  const t=Math.min(1, Math.max(0, (n-200)/1800));
  return GMAP_3D_CHARGE_LO + (GMAP_3D_CHARGE_HI-GMAP_3D_CHARGE_LO)*t;
}
function mapTune3D(g){
  try{
    const charge=g.d3Force('charge');
    if(charge && charge.strength) charge.strength(-map3dCharge(GMAP.nodes.length)).distanceMax(GMAP_3D_CHARGE_MAX);
    const link=g.d3Force('link');
    if(link && link.distance) link.distance(map3dLinkD);
    // Weak on purpose: the centre force TRANSLATES the whole layout, so at full
    // strength it fights every tick of the spread it is supposed to hold still.
    const centre=g.d3Force('center');
    if(centre && centre.strength) centre.strength(0.06);
    g.d3Force('collide', mapCollide3D());
    if(g.d3VelocityDecay) g.d3VelocityDecay(0.3);
  }catch(e){ /* a renderer without d3 forces keeps its own defaults */ }
}
// The bundle does not expose d3-force-3d, so there is no forceCollide to
// borrow: this is one. Same idea — two nodes closer than the sum of their DRAWN
// radii plus a little air are pushed apart — done over a uniform spatial hash
// whose cell is the largest interaction distance there can be, so each node only
// ever looks at the 27 cells around it: O(n) a tick, not O(n²).
function mapCollide3D(){
  let ns=[], rad=[], cell=1;
  const key=(a,b,c)=> a+':'+b+':'+c;
  const force=()=>{
    if(ns.length<2) return;
    const grid=new Map();
    for(let i=0;i<ns.length;i++){
      const n=ns[i];
      const k=key(Math.floor((n.x||0)/cell), Math.floor((n.y||0)/cell), Math.floor((n.z||0)/cell));
      const b=grid.get(k); if(b) b.push(i); else grid.set(k,[i]);
    }
    // NOT scaled by alpha: d3's own forceCollide is not either, and a
    // separation that fades as the layout cools never gets to separate
    // anything — it was measured doing nothing at all (76.1% of the discs
    // overlapping with it, 76.5% without).
    const k2=0.35;        // half the push goes to each of the pair
    for(let i=0;i<ns.length;i++){
      const a=ns[i];
      const gx=Math.floor((a.x||0)/cell), gy=Math.floor((a.y||0)/cell), gz=Math.floor((a.z||0)/cell);
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(let dz=-1;dz<=1;dz++){
        const b=grid.get(key(gx+dx, gy+dy, gz+dz)); if(!b) continue;
        for(let m=0;m<b.length;m++){
          const j=b[m]; if(j<=i) continue;   // every pair once, from the lower index
          const c=ns[j];
          const want=rad[i]+rad[j]+GMAP_3D_COLLIDE_PAD;
          let x=(c.x||0)-(a.x||0), y=(c.y||0)-(a.y||0), z=(c.z||0)-(a.z||0);
          const d2=x*x+y*y+z*z;
          if(d2>=want*want) continue;
          let d=Math.sqrt(d2);
          // Two nodes at the very same point have no direction to part along,
          // so one is derived from the pair's own indices: the same split every
          // run, rather than a different picture on every reload.
          if(d<1e-6){ x=((i%5)-2)||1; y=((j%5)-2)||1; z=(((i+j)%5)-2)||1; d=Math.sqrt(x*x+y*y+z*z); }
          const p=((want-d)/d)*k2, px=x*p, py=y*p, pz=z*p;
          a.vx=(a.vx||0)-px; a.vy=(a.vy||0)-py; a.vz=(a.vz||0)-pz;
          c.vx=(c.vx||0)+px; c.vy=(c.vy||0)+py; c.vz=(c.vz||0)+pz;
        }
      }
    }
  };
  // d3 hands a force the live node array whenever the simulation's nodes change.
  force.initialize=(nodes)=>{
    ns=nodes||[];
    rad=ns.map(n=> (n.r||3)*GMAP_3D_NODE_SCALE);
    let m=0; for(const r of rad) if(r>m) m=r;
    cell=Math.max(1, m*2+GMAP_3D_COLLIDE_PAD);
  };
  return force;
}
// A 2D layout has no third dimension, so a cache built from one seeds every
// node at z=0 — and a force engine handed a flat sheet keeps it nearly flat
// (measured: a 2664 × 2417 map only 611 deep, with 87% of its node discs
// overlapping another at fit distance). So the switch to 3D does two things to
// the cached layout before a single 3D force runs.
//
// It BLOWS IT UP, because the same nodes need more room in a volume than they
// did on a plane. And it gives z a real spread — a quarter of the span either
// way, derived from each node's OWN id, so the same map lifts the same way on
// every reload and the depth is proportional to the picture at any pack size.
// Neither is the final say: the forces below move the layout a long way from
// this seed. It is a STARTING SHAPE, and starting from the 2D picture is what
// keeps the 3D one recognisable as the same map.
//
// It runs ONCE, the FIRST time 3D is opened: after that the volume has a
// settled layout of its own (GMAP.pos3) and is restored from it, so a chip
// toggle inside 3D does not blow the map up again.
const GMAP_3D_SPREAD=1.4;
function mapSeed3D(){
  let lox=Infinity, hix=-Infinity, loy=Infinity, hiy=-Infinity, seeded=0;
  for(const n of GMAP.nodes){
    if(!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    seeded++;
    if(n.x<lox) lox=n.x; if(n.x>hix) hix=n.x;
    if(n.y<loy) loy=n.y; if(n.y>hiy) hiy=n.y;
  }
  // Nothing cached — 3D is the first renderer to mount. The forces lay the
  // whole thing out from nothing, which is what they are tuned to do.
  if(!seeded) return;
  const span=(Math.max(hix-lox, hiy-loy) || 600)*GMAP_3D_SPREAD;
  const cx=(lox+hix)/2, cy=(loy+hiy)/2, amp=span/4;
  for(const n of GMAP.nodes){
    if(!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    n.x=cx+(n.x-cx)*GMAP_3D_SPREAD;
    n.y=cy+(n.y-cy)*GMAP_3D_SPREAD;
    let h=0; for(let i=0;i<n.id.length;i++) h=(h*31+n.id.charCodeAt(i))>>>0;
    n.z=((h%2001)/1000-1)*amp;
    // The 2D layout arrives PINNED. This is the one move that is allowed to
    // relocate it, and the settle after it needs the nodes free.
    n.fx=null; n.fy=null; n.fz=null;
  }
}
// AND THE WAY BACK IS NOT A TRANSFORM AT ALL any more. The blow-up above used
// to be undone by dividing the 3D layout down again, which was arithmetic
// standing in for a memory: the two seeds compounded (measured over
// 2D→3D→2D→3D the span went 2627, 4017, 5773) and the 2D view refitted every
// time, so a reader who had zoomed into one corner lost it on every switch.
// Each dimension now keeps its OWN settled layout (GMAP.pos and GMAP.pos3), so
// returning to 2D restores the exact picture that was left, pins and zoom
// included, and neither direction reheats the other.
function mountMap2D(host, w, h){
  const made=new window.ForceGraph();
  const g=(typeof made==='function') ? made(host) : made;   // kapsule builds either way
  mapTuneForces(g, false);
  g.width(w).height(h)
    .nodeRelSize(1).nodeVal(n=>n.val)
    .nodeColor(mapNodeFill).nodeLabel(n=>n.tip)
    .linkColor(mapLinkColor).linkLabel(l=>l.tip).linkWidth(mapLinkW)
    .linkLineDash(l=>l.dash).linkCurvature(l=>l.curv)
    .linkDirectionalArrowLength(mapArrow).linkDirectionalArrowRelPos(1).linkDirectionalArrowColor(mapLinkColor)
    .linkDirectionalParticles(mapParticles).linkDirectionalParticleSpeed(mapFlowSpeed)
    .linkDirectionalParticleWidth(mapFlowW).linkDirectionalParticleColor(mapFlowColor)
    // 'after': the library draws the line, then this adds the signal theme's
    // glow to the lit chain only. Everything else returns immediately.
    .linkCanvasObjectMode(()=>'after').linkCanvasObject(mapDrawLinkGlow)
    // 'replace', not 'after': the page draws the node itself now, because a
    // node's KIND is a glyph and the library only knows how to draw a disc.
    .nodeCanvasObjectMode(()=>'replace').nodeCanvasObject(mapDrawNode2D)
    .onRenderFramePre((ctx, k)=>mapFrameReset(ctx, k))
    .cooldownTicks(mapTicks() ?? 160)
    .onNodeClick((n)=>mapClick(n))
    .onNodeHover((n)=>mapHover(n))
    .onBackgroundClick(()=>mapClear())
    // A DRAG IS A DECISION. The node stays where it was dropped, pinned like
    // every other, so the picture the reader arranged is the picture they keep.
    .onNodeDragEnd((n)=>{ if(n){ n.fx=n.x; n.fy=n.y; } mapSavePositions(); })
    // The reader's own zoom and pan are the picture from here on: they are
    // remembered, and nothing refits until the fit button asks.
    .onZoomEnd(()=>mapSaveView())
    .onEngineStop(()=>mapSettled())
    .graphData({nodes:GMAP.nodes, links:GMAP.links});
  return g;
}
// The label pass the canvas renderer runs after each node: the text is drawn in
// GRAPH units divided by the zoom, so a name stays the same size on screen at
// every zoom level, with a white halo so it survives crossing a line.
//
// Labels that overlap are worse than no label: two names on top of each other
// read as a third, wrong one. So each frame keeps a list of the boxes already
// taken and a name that would land on one is DROPPED (its node is still there,
// still hoverable, and the rail still names it). Nodes are drawn in the
// answer's own order — groups first, then endpoints, then tables — so the
// skeleton of the map wins the ties.
// Every frame starts with the NODE DISCS already claimed, so a name is never
// written across a neighbour's glyph - the same rule the shared placer uses on
// the ERD and the hop rings. A name that cannot find a clear box is dropped; its
// node is still there, still hoverable, and the rail still lists it.
function mapFrameReset(ctx, k){
  const boxes=[];
  const zoom=k||1;
  for(const n of GMAP.nodes){
    if(!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    // EVERY disc, however small. The old rule let anything under six screen
    // pixels through as "not an obstacle", and since most of this map is under
    // six pixels that is exactly where the names landed: on the nodes. A name
    // that cannot find clear air is dropped instead, and the rail still has it.
    boxes.push({x:n.x-n.r, y:n.y-n.r, w:2*n.r, h:2*n.r});
  }
  // A pad in SCREEN pixels, so a name never touches a disc at any zoom.
  const pad=GMAP_LABEL_PAD/zoom;
  for(const b of boxes){ b.x-=pad; b.y-=pad; b.w+=2*pad; b.h+=2*pad; }
  GMAP.discs=boxes.length;
  GMAP.placed=boxes;
  // THE VISIBLE SHEET, in graph units. The placer may flip a name to the left of
  // its node, and a name flipped off the edge of the pane is a name the reader
  // never sees but that still took the space. So the window is measured once a
  // frame and a box outside it is refused like any other collision.
  GMAP.view=null;
  const g=GMAP.api;
  if(g && typeof g.screen2GraphCoords==='function'){
    const cv=ctx.canvas;
    try{
      const a=g.screen2GraphCoords(0,0), b=g.screen2GraphCoords(cv.width, cv.height);
      if(a && b && Number.isFinite(a.x) && Number.isFinite(b.x)){
        GMAP.view={x0:Math.min(a.x,b.x), y0:Math.min(a.y,b.y), x1:Math.max(a.x,b.x), y1:Math.max(a.y,b.y)};
      }
    }catch(e){ /* a renderer mid-teardown has no transform to ask */ }
  }
}
// One node: a filled disc in its kind's hue, outlined and glowing when the
// spotlight is on it, and then its name. FILLED AT REST is the point of the
// change: the hollow rings this used to draw disappeared under the lines at
// four pixels across, and the only frame of the old map that read well was the
// LIT one, which was filled.
function mapDrawNode2D(n, ctx, k){
  const lit=!!(GMAP.lit && GMAP.lit.nodes.has(n.id));
  gfDot(ctx, n.x, n.y, n.r, k, { color:mapNodeFill(n), lit, glow:true });
  mapDrawFedRing(n, ctx, k);
  mapDrawLabel2D(n, ctx, k);
}
// THE RING THAT SAYS "THIS CAME FROM ANOTHER PACK" (RM45). The disc keeps its
// KIND's fill, so a table still reads as a table; the ring around it carries
// that project's own hue. It is drawn outside the disc's own ground hairline,
// so two nodes that have settled against each other still part cleanly, and it
// dims with everything else under a spotlight.
function mapDrawFedRing(n, ctx, k){
  if(!n.ring) return;
  const on = !GMAP.lit || GMAP.lit.nodes.has(n.id);
  ctx.save();
  ctx.globalAlpha = on ? 1 : GMAP_NODE_DIM;
  ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(0.6, n.r)+2.4/k, 0, 2*Math.PI);
  ctx.lineWidth=1.6/k; ctx.strokeStyle=n.ring; ctx.stroke();
  ctx.restore();
}
// The glow the signal theme gives a LIT line — the canvas equivalent of the
// `--glow` shadow the CSS uses. Drawn over the library's own stroke, along the
// same curve (the renderer parks its control point on the link), so the two
// coincide exactly. In the drawing theme, and on every line that is not lit,
// this returns before it touches the context.
function mapDrawLinkGlow(l, ctx, k){
  if(!GMAP.lit || !GMAP.lit.links.has(l.i) || !themeGlows()) return;
  const s=l.source, t=l.target;
  if(!s || !t || !Number.isFinite(s.x) || !Number.isFinite(t.x)) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  const cp=l.__controlPoints;
  if(cp && cp.length>=2) ctx.quadraticCurveTo(cp[0], cp[1], t.x, t.y); else ctx.lineTo(t.x, t.y);
  ctx.strokeStyle=l.col; ctx.lineWidth=mapLinkW(l);
  ctx.shadowColor=l.col; ctx.shadowBlur=8/k;
  ctx.stroke();
  ctx.restore();
}
// A NAME NEVER SITS ON A NODE OR ON ANOTHER NAME. The frame starts with every
// node's disc already claimed (mapFrameReset), and a name tries the right of
// its own node first, then the left; if neither side is clear it is dropped.
// Its node is still there, still hoverable, and the rail still lists it. Only
// the lit node's own name is written whatever it lands on, because that is the
// thing being answered.
function mapDrawLabel2D(n, ctx, k){
  if(!mapWantsLabel(n, k)) return;
  const fs=mapLabelSize(n)/k;
  ctx.font=gfFont(fs);
  ctx.textAlign='left'; ctx.textBaseline='middle';
  const w=ctx.measureText(n.label).width, top=n.y-fs*0.62, h=fs*1.24;
  const boxes=GMAP.placed||(GMAP.placed=[]);
  const forced=!!(GMAP.lit && GMAP.lit.id===n.id);
  const v=GMAP.view;
  const clear=(x,y)=>{
    if(v && (x<v.x0 || x+w>v.x1)) return false;
    for(let i=0;i<boxes.length;i++){ const b=boxes[i];
      if(x<b.x+b.w && x+w>b.x && y<b.y+b.h && y+h>b.y) return false; }
    return true;
  };
  const right=n.x+n.r+3/k, left=n.x-n.r-3/k-w;
  let x=right, y=top;
  if(!clear(x,y)){
    // THE LIT NODE'S NAME IS THE ANSWER and is never dropped, so where the
    // others have two places to stand it looks all the way round: an open group
    // rings itself with satellites and both sides of it are taken, so the name
    // steps out along whichever bearing has room first.
    const tries=[[left, top]];
    if(forced){
      for(let ring=1; ring<=3; ring++){
        const d=n.r+(3+ring*h*0.9)/1;
        for(let a=0; a<16; a++){
          const ang=a*Math.PI/8;
          tries.push([n.x+Math.cos(ang)*d-(Math.cos(ang)<0?w:0), n.y+Math.sin(ang)*d-h/2]);
        }
      }
      tries.push([right, top]);   // nowhere is clear: it stands where it always did
    }
    let put=null;
    for(const c of tries) if(clear(c[0], c[1])){ put=c; break; }
    if(!put && !forced) return;
    if(put){ x=put[0]; y=put[1]; }
    else { x=right; y=top; }
  }
  boxes.push({x, y, w, h});
  // A halo of the canvas ground under every name, so one that has to cross a
  // line is still one word rather than two halves.
  ctx.lineJoin='round';
  ctx.lineWidth=GMAP_LABEL_HALO/k; ctx.strokeStyle=cssVar('--halo');
  const baseline=y+h/2;
  ctx.strokeText(n.label, x, baseline);
  ctx.fillStyle=forced ? cssVar('--t1') : cssVar('--t2');
  ctx.fillText(n.label, x, baseline);
}
function mountMap3D(host, w, h){
  let g=new window.ForceGraph3D(host, {controlType:'orbit'});
  if(typeof g==='function') g=g(host);
  mapTuneForces(g, true);
  g.width(w).height(h)
    .backgroundColor(cssVar('--g0')).showNavInfo(false)
    .nodeRelSize(GMAP_3D_NODE_SCALE).nodeVal(map3dVal).nodeResolution(10).nodeOpacity(0.95)
    .nodeColor(mapNodeFill).nodeLabel(n=>n.tip)
    .linkColor(mapLinkColor).linkLabel(l=>l.tip).linkWidth(map3dWidth).linkOpacity(0.75)
    .linkCurvature(l=>l.curv)
    .linkDirectionalArrowLength(mapArrow).linkDirectionalArrowRelPos(1)
    .linkDirectionalParticles(mapParticles).linkDirectionalParticleSpeed(mapFlowSpeed)
    .linkDirectionalParticleWidth(map3dFlowW).linkDirectionalParticleColor(mapFlowColor)
    // Longer than the 2D settle: the volume has further to open out, and the
    // collide force only starts doing anything once the springs have spread it.
    .cooldownTicks(mapTicks() ?? 200)
    .onNodeClick((n)=>mapClick(n))
    .onNodeHover((n)=>mapHover(n))
    .onBackgroundClick(()=>mapClear())
    .onNodeDragEnd((n)=>{ if(n){ n.fx=n.x; n.fy=n.y; n.fz=n.z; } mapSavePositions(); })
    .onEngineStop(()=>mapSettled())
    .graphData({nodes:GMAP.nodes, links:GMAP.links});
  return g;
}
// WebGL has no text, so the 3D view's labels are an HTML plane over the canvas,
// projected through the renderer's own graph→screen transform. Purely
// decorative: pointer-events are off, so a label never eats a click.
//
// The SAME greedy rule the 2D canvas uses applies here, because the failure is
// the same and worse in 3D: perspective piles the middle of the graph into a
// small patch of screen, and the names land on top of one another (measured on
// mall at fit distance: 61 labels, 108 overlapping pairs). So each pass places
// names in priority order and DROPS any whose box would land on a box already
// taken — or on a node disc big enough to swallow it. A dropped name is not
// lost: its node is still there, still hoverable, and the rail lists it.
//
// Priority: the lit node first and never dropped (it is the thing being
// answered), then the rest by degree, groups before tables at equal degree.
const GMAP_LABEL_DISC_MIN=6;   // px — in 3D, a disc smaller than this is not an obstacle
const GMAP_LABEL_PAD=2;        // px of clear air a name keeps from every disc
const GMAP_LABEL_HALO=2;       // px of canvas ground stroked under every name
const GMAP_LABEL_CHAR_W=6.7;   // px per char of the 11px monospace face, until measured
const GMAP_LABEL_H=15;         // px, likewise
const GMAP_LABEL_MS=55;        // relayout at most this often while orbiting

function mapLabelOrder3D(){
  const set=GMAP.lit ? GMAP.litLabels : GMAP.restLabels;
  const KR={group:0, project:1, table:2, statement:3, endpoint:4};
  const out=[];
  for(const id of set){ const n=GMAP.byId.get(id); if(n) out.push(n); }
  // The skeleton of a connected project and its portals go FIRST, whatever
  // their degree: they are few, and the cap below is 80. A portal that lost its
  // name to a busier table would leave the reader a cluster with no route on it.
  const first=(n)=> (n.kind==='project' || mapIsPortal(n)) ? 0 : 1;
  out.sort((a,b)=> (first(a)-first(b)) || (b.degree-a.degree) || ((KR[a.kind]??9)-(KR[b.kind]??9)) || (a.id<b.id?-1:a.id>b.id?1:0));
  if(GMAP.lit){ const i=out.findIndex(n=>n.id===GMAP.lit.id); if(i>0) out.unshift(out.splice(i,1)[0]); }
  return out.slice(0, GMAP_REST_CAP);
}
// One pass: project, place greedily, hide the losers. `taken` starts with the
// node discs, so a name is never written across a sphere.
function mapPlaceLabels3D(g, host, els){
  const order=mapLabelOrder3D();
  const inSet=new Set(order.map(n=>n.id));
  for(const [id,e] of els) if(!inSet.has(id)){ e.remove(); els.delete(id); }
  // Pixels per graph unit, from ONE reference segment near the origin. It is an
  // approximation under perspective (a node nearer the camera is bigger than
  // this says), and it is only ever used to decide whether a disc is an
  // obstacle — never to draw anything.
  let ppu=0;
  try{
    const a=g.graph2ScreenCoords(0,0,0), b=g.graph2ScreenCoords(100,0,0);
    if(a&&b&&Number.isFinite(a.x)&&Number.isFinite(b.x)) ppu=Math.abs(b.x-a.x)/100;
  }catch(e){ ppu=0; }
  const W=host.clientWidth||0, H=host.clientHeight||0;
  const pos=new Map(), taken=[];
  for(const n of order){
    let p;
    try{ p=g.graph2ScreenCoords(n.x||0, n.y||0, n.z||0); }catch(e){ p=null; }
    if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) p=null;
    pos.set(n.id, p);
    if(!p) continue;
    const rpx=map3dR(n)*ppu;
    if(rpx>=GMAP_LABEL_DISC_MIN) taken.push({x:p.x-rpx, y:p.y-rpx, w:rpx*2, h:rpx*2});
  }
  const hits=(x,y,w,h)=>{ for(const b of taken) if(x<b.x+b.w && x+w>b.x && y<b.y+b.h && y+h>b.y) return true; return false; };
  for(const n of order){
    const p=pos.get(n.id);
    let e=els.get(n.id);
    if(!e){
      e=el('div',{className:'gmaplbl', textContent:n.label});
      host.append(e);
      els.set(n.id,e);
      // Measured once, when the label is born: an estimate from the character
      // count is close but a name of wide glyphs would still collide.
      const r=e.getBoundingClientRect();
      if(r.width>0){ e.dataset.w=String(r.width); e.dataset.h=String(r.height); }
    }
    if(!p || p.x<-300 || p.y<-300 || p.x>W+300 || p.y>H+300){ e.style.display='none'; continue; }
    const w=Number(e.dataset.w)||(String(n.label).length*GMAP_LABEL_CHAR_W+2);
    const h=Number(e.dataset.h)||GMAP_LABEL_H;
    const top=p.y-h/2;
    const forced=!!(GMAP.lit && GMAP.lit.id===n.id);
    // The right of the node first, and if that side is taken its MIRROR on the
    // left (anchored at its far end, so it grows away from the node) — the same
    // two chances the 2D placer gives a name. Only ever going right left every
    // label on the left half of a cluster one candidate place, in the busiest
    // direction there is: straight at the middle.
    const right=p.x+7, left=p.x-7-w;
    let x=null;
    if(forced) x=right;
    else if(!hits(right, top, w, h)) x=right;
    else if(!hits(left, top, w, h)) x=left;
    if(x===null){ e.style.display='none'; continue; }
    taken.push({x, y:top, w, h});
    e.style.display=''; e.style.left=x+'px'; e.style.top=p.y+'px';
    e.classList.toggle('on', forced);
  }
}
function mapStartLabelLoop(g){
  const host=byId('gmaplabels'); if(!host) return;
  const els=new Map();
  GMAP.labelAt=0;
  const step=()=>{
    GMAP.labelRaf=requestAnimationFrame(step);
    if(GMAP.drawn!=='3d' || GMAP.api!==g) return;
    // Throttled: the placement is a whole-set decision, so it must not be run
    // per frame while the camera orbits — but a highlight change forces it (the
    // caller zeroes labelAt), so a click never waits for the next slot.
    const now=(window.performance&&performance.now)?performance.now():Date.now();
    if(now-GMAP.labelAt < GMAP_LABEL_MS) return;
    GMAP.labelAt=now;
    mapPlaceLabels3D(g, host, els);
  };
  GMAP.labelRaf=requestAnimationFrame(step);
}
// ---- the measured fit ------------------------------------------------------
// zoomToFit leaves the picture much too small, and it is worth saying exactly
// why rather than dialling the padding until it looks right. The library's
// fitToBbox measures the layout's extent ABOUT THE WORLD ORIGIN, not about the
// picture's own centre, and then divides by `Math.atan(fov')` where the geometry
// wants `tan(fov'/2)` — on this pane that alone puts the camera about a third
// further back than the fit it is asked for. Measured on mall: the map sat at
// 0.44 of the pane's width and 0.61 of its height, every sphere a three-pixel
// dot, while the 2D map fills 0.64 × 0.88 of the same box.
//
// A negative padding fixes the symptom on ONE pack and clips the next one. So
// the fit is measured instead: let zoomToFit do its (positive-padded) thing,
// then project every node, see what the picture actually covers, and close the
// gap by sliding the camera along its own view vector — the look-at is kept, so
// nothing rotates and nothing is re-laid-out.
//
// What is measured is NOT the plain bounding box but the picture's reach from
// the PANE CENTRE, doubled: fitToBbox always looks at the world origin, so an
// off-centre layout stays off-centre, and a bbox fraction of 0.9 could still
// hang a node over one edge. Half-extent-from-centre cannot: at 0.9 the
// furthest disc sits nine tenths of the way to the edge, whichever side it is
// on. For a centred picture the two numbers are the same.
const GMAP_3D_FIT_FILL=0.9;                       // of the pane, at the widest
const GMAP_3D_FIT_MIN=0.85, GMAP_3D_FIT_MAX=0.95; // in band: leave it alone
const GMAP_3D_FIT_TRIES=2;                        // one correction, then at most one more
// A sanity bound on ONE move. Clamping can only ever make a move SMALLER than
// the measurement asked for, so it cannot overshoot — the cost of a tight bound
// is a picture left too small, which is the failure worth having.
//
// It stays at 3 on evidence, not caution. Raising it to 8 was tried, to cover a
// deliberately pathological layout (four times deeper than wide) whose first
// fit lands so far out that two moves of 3 only reach 0.15 of the pane. It made
// that case WORSE, not better (0.11): one eighth of the distance puts the
// camera inside the cloud, and from in there the projection is no longer 1/d at
// all. Two moves of 3 leave that shape small and whole; nothing this map
// actually produces needs more than one move.
const GMAP_3D_FIT_STEP=3;
function map3dProjFill(g, host){
  const W=host.clientWidth||0, H=host.clientHeight||0;
  if(!(W>0 && H>0)) return null;
  const cam=g.camera(); if(!cam) return null;
  if(cam.updateMatrixWorld) cam.updateMatrixWorld();
  // The camera's own right vector: a node's DRAWN radius is a length in the
  // world, and this is the direction that length is widest on screen.
  const e=cam.matrixWorld.elements, rx=e[0], ry=e[1], rz=e[2];
  // …and the way it is pointing. A camera looks down its own −z, so a node with
  // a negative depth is BEHIND it, and graph2ScreenCoords hands back a mirrored
  // point for such a node. Measuring one would tell the correction the picture
  // is enormous and send the camera flying; they are skipped.
  const fx=-e[8], fy=-e[9], fz=-e[10];
  const cp=cam.position;
  let lox=Infinity, hix=-Infinity, loy=Infinity, hiy=-Infinity, seen=0;
  for(const n of GMAP.nodes){
    if(!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    const R=map3dR(n);
    if((n.x-cp.x)*fx + (n.y-cp.y)*fy + ((n.z||0)-cp.z)*fz <= 0) continue;
    let p, q=null;
    try{ p=g.graph2ScreenCoords(n.x, n.y, n.z||0);
         q=g.graph2ScreenCoords(n.x+rx*R, n.y+ry*R, (n.z||0)+rz*R); }catch(err){ p=null; }
    if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const rp=(q && Number.isFinite(q.x)) ? Math.hypot(q.x-p.x, q.y-p.y) : 0;
    seen++;
    if(p.x-rp<lox) lox=p.x-rp; if(p.x+rp>hix) hix=p.x+rp;
    if(p.y-rp<loy) loy=p.y-rp; if(p.y+rp>hiy) hiy=p.y+rp;
  }
  if(!seen) return null;
  const cx=W/2, cy=H/2;
  return { W, H,
    bboxW:(hix-lox)/W, bboxH:(hiy-loy)/H,                       // what the picture covers
    reachW:2*Math.max(cx-lox, hix-cx)/W,                        // …and how near the edge it gets
    reachH:2*Math.max(cy-loy, hiy-cy)/H };
}
// A SPHERE MUST BE A SPHERE ON SCREEN, not in layout units. The size model says
// radius goes as the square root of the degree, and in 2D that is what the
// reader sees, because the flat fit rescales the layout so one unit is one
// pixel. In 3D the camera decides: at fit distance on mall the median sphere
// came out 3.1 pixels across and the busiest group 8.3, so a model that
// promises "twice as connected looks twice as big" was being kept at a size
// where nothing looked like anything.
//
// So the drawn radius is measured and corrected, once, after the camera lands:
// project every sphere, take the median and the biggest group, and scale until
// both clear their targets. It is a DRAWING multiplier, not a layout one - the
// forces have already stopped and re-running them would move the picture - so
// it is capped, and the cost is paid in spheres that touch. Measured on mall
// headless: at 1.0, six pairs of the 81 discs overlap; at the 1.69 this asks
// for, seventeen. Three-pixel dots that overlap nothing are the worse picture.
const GMAP_3D_R_MED=4;      // px, the median sphere at the fitted camera
const GMAP_3D_R_GROUP=14;   // px, the busiest group
const GMAP_3D_R_MAX_K=1.8;  // past this the map is spheres with a graph behind it
const GMAP_3D_R_TRIES=2;
/** The projected radius of every sphere in front of the camera, in pixels. */
function map3dPixelRadii(g){
  const cam=g.camera(); if(!cam) return null;
  if(cam.updateMatrixWorld) cam.updateMatrixWorld();
  const e=cam.matrixWorld.elements, rx=e[0], ry=e[1], rz=e[2];
  const fx=-e[8], fy=-e[9], fz=-e[10], cp=cam.position;
  const all=[]; let groupMax=0;
  for(const n of GMAP.nodes){
    if(!Number.isFinite(n.x)) continue;
    if((n.x-cp.x)*fx + (n.y-cp.y)*fy + ((n.z||0)-cp.z)*fz <= 0) continue;
    const R=map3dR(n);
    let p, q=null;
    try{ p=g.graph2ScreenCoords(n.x, n.y, n.z||0);
         q=g.graph2ScreenCoords(n.x+rx*R, n.y+ry*R, (n.z||0)+rz*R); }catch(err){ p=null; }
    if(!p || !q || !Number.isFinite(p.x) || !Number.isFinite(q.x)) continue;
    const rp=Math.hypot(q.x-p.x, q.y-p.y);
    all.push(rp);
    if(n.kind==='group' && rp>groupMax) groupMax=rp;
  }
  if(all.length<2) return null;
  all.sort((a,b)=>a-b);
  return { median:all[Math.floor(all.length/2)], groupMax };
}
function map3dSizeCorrect(g){
  if(GMAP.api!==g || GMAP.drawn!=='3d') return;
  if(GMAP.sized3d>=GMAP_3D_R_TRIES) return;
  const m=map3dPixelRadii(g);
  if(!m || !(m.median>0.01)) return;
  let want=Math.max(GMAP_3D_R_MED/m.median, m.groupMax>0.01 ? GMAP_3D_R_GROUP/m.groupMax : 1);
  want=Math.min(want, GMAP_3D_R_MAX_K/(GMAP.r3d||1));
  if(!(want>1.02)) return;
  GMAP.sized3d++;
  GMAP.r3d=(GMAP.r3d||1)*want;
  try{ g.nodeVal(map3dVal); }catch(err){ return; }
  // Bigger spheres reach further out of the pane, so the fit is asked again
  // with the new radius in it.
  map3dFitSoon(g, 1, 380);
}
function map3dFitCorrect(g, tries){
  if(GMAP.api!==g || GMAP.drawn!=='3d') return;   // torn down while we waited
  const host=mapHostEl(); if(!host) return;
  const f=map3dProjFill(g, host);
  if(!f) return;
  const fill=Math.max(f.reachW, f.reachH);
  if(!Number.isFinite(fill) || fill<=0.001) return;
  if(fill>=GMAP_3D_FIT_MIN && fill<=GMAP_3D_FIT_MAX){ map3dSizeCorrect(g); return; }
  // Perspective size goes as 1/distance, so the distance wants the same factor
  // the picture is out by.
  const k=Math.min(GMAP_3D_FIT_STEP, Math.max(1/GMAP_3D_FIT_STEP, fill/GMAP_3D_FIT_FILL));
  let t; try{ t=g.controls && g.controls().target; }catch(err){ t=null; }
  const tx=t?t.x:0, ty=t?t.y:0, tz=t?t.z:0;
  const cam=g.camera();
  const dx=cam.position.x-tx, dy=cam.position.y-ty, dz=cam.position.z-tz;
  if(!(Math.hypot(dx,dy,dz)>1e-6)) return;
  try{ g.cameraPosition({x:tx+dx*k, y:ty+dy*k, z:tz+dz*k}, {x:tx, y:ty, z:tz}, 300); }
  catch(err){ return; }
  if(tries>1) map3dFitSoon(g, tries-1, 380);
  else setTimeout(()=>map3dSizeCorrect(g), 380);
}
// The camera is mid-tween when the fit is asked for, so the measurement waits
// for it to land. One timer, cancelled when the renderer goes away.
function map3dFitSoon(g, tries, ms){
  if(GMAP.fitTimer){ clearTimeout(GMAP.fitTimer); GMAP.fitTimer=null; }
  GMAP.fitTimer=setTimeout(()=>{ GMAP.fitTimer=null; map3dFitCorrect(g, tries); }, ms||520);
}

// One settle, then fit — once per data load, so a later reheat (a drag) does
// not yank the view out from under the reader.
// A RADIUS IN PIXELS ONLY MEANS SOMETHING AT ZOOM 1. The 2D canvas draws a node
// in graph units and then the fit divides the whole picture by whatever it takes
// to get it into the pane - so a layout that settles 1300 units wide inside a
// 990-pixel pane draws its 18-unit hub as a four-pixel dot, and the size model
// above is a promise the picture does not keep. The forces cannot be tuned to
// land on the pane's size for every pack, so the layout is RESCALED once it
// stops: the same picture, its units chosen so that one unit is one pixel at the
// fit. Nothing moves relative to anything else; only the ruler changes.
const GMAP_FIT_FILL=0.9;
const GMAP_STRETCH_MAX=1.8;
function mapNormalise2D(){
  const wrap=mapWrapEl(); if(!wrap) return;
  const W=wrap.clientWidth||900, H=wrap.clientHeight||620;
  let lox=Infinity, hix=-Infinity, loy=Infinity, hiy=-Infinity, seen=0;
  for(const n of GMAP.nodes){
    if(!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    seen++;
    if(n.x<lox) lox=n.x; if(n.x>hix) hix=n.x;
    if(n.y<loy) loy=n.y; if(n.y>hiy) hiy=n.y;
  }
  if(seen<2) return;
  let sx=hix-lox; const sy=hiy-loy;
  if(!(sx>1 || sy>1)) return;
  // THE PANE IS TWICE AS WIDE AS IT IS TALL; the settle is not. The forces are
  // isotropic, so they produce a roughly square cloud, and a square picture fit
  // into a 2:1 pane fills half of it and leaves two columns of empty sheet on
  // either side. Measured on mall at 1440x900 before this: the ink covered 0.53
  // of the pane's width against 0.85 of its height. So the layout is stretched
  // along x about its own centroid until its proportions are the pane's, capped
  // at 1.8 because past that the clusters read as smeared rather than as spread.
  // Nothing crosses anything: a monotone stretch on one axis preserves order,
  // and the relax pass below puts back the clear air the stretch cannot.
  const aspect=(W>0&&H>0) ? W/H : 1, bbox=sx/Math.max(sy,1);
  if(bbox<aspect && sy>1){
    const st=Math.min(aspect/bbox, GMAP_STRETCH_MAX);
    const mx=(lox+hix)/2;
    for(const n of GMAP.nodes){ if(Number.isFinite(n.x)) n.x=mx+(n.x-mx)*st; }
    lox=mx+(lox-mx)*st; hix=mx+(hix-mx)*st; sx=hix-lox;
  }
  const k=Math.min(W/Math.max(sx,1), H/Math.max(sy,1))*GMAP_FIT_FILL;
  if(!(k>0) || !Number.isFinite(k)) return;
  const cx=(lox+hix)/2, cy=(loy+hiy)/2;
  if(Math.abs(k-1)>=0.02){
    for(const n of GMAP.nodes){
      if(!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      n.x=cx+(n.x-cx)*k; n.y=cy+(n.y-cy)*k;
      if(n.fx!=null) n.fx=n.x;
      if(n.fy!=null) n.fy=n.y;
    }
  }
  // Pulling a layout IN pushes discs through each other, and the collide force
  // has already stopped and cannot separate them again. So the same rule is
  // applied here directly, on positions rather than velocities: each overlapping
  // pair is pushed apart by half its overlap, a few passes, until none is left.
  // It converges in a handful of rounds because the scale change is small.
  // The stretch above needs it for the same reason: pulling one axis out pushes
  // nothing through anything, but the fit that follows can.
  mapRelax(GMAP_RELAX_ROUNDS);
}
const GMAP_RELAX_ROUNDS=24;
// The same push, applied to the NEW nodes only. A local run drops a handful of
// satellites into a layout that is already settled, and two of them can land on
// each other or on a table; nudging them apart is fine, moving anything that
// was already there is not, so the pinned nodes act as walls.
function mapRelaxLoose(rounds){
  const ns=GMAP.nodes.filter((n)=>Number.isFinite(n.x)&&Number.isFinite(n.y));
  const loose=ns.filter((n)=>n.fx==null);
  if(!loose.length) return;
  for(let round=0; round<rounds; round++){
    let hits=0;
    for(const a of loose){
      for(const c of ns){
        if(c===a) continue;
        const want=a.r+c.r+GMAP_COLLIDE_PAD;
        let x=c.x-a.x, y=c.y-a.y;
        const d2=x*x+y*y;
        if(d2>=want*want) continue;
        let d=Math.sqrt(d2);
        if(d<1e-6){ x=1; y=1; d=Math.SQRT2; }
        hits++;
        // The whole push goes to the loose node when the other is pinned, and
        // half each when both are new.
        const both=c.fx==null;
        const push=(want-d)/d*(both?0.5:1);
        a.x-=x*push; a.y-=y*push;
        if(both){ c.x+=x*push; c.y+=y*push; }
      }
    }
    if(!hits) break;
  }
}
function mapRelax(rounds){
  const ns=GMAP.nodes.filter((n)=>Number.isFinite(n.x)&&Number.isFinite(n.y));
  if(ns.length<2) return;
  let cell=0;
  for(const n of ns) cell=Math.max(cell, n.r);
  cell=Math.max(1, cell*2+GMAP_COLLIDE_PAD);
  for(let round=0; round<rounds; round++){
    const grid=new Map();
    for(let i=0;i<ns.length;i++){
      const key=Math.floor(ns[i].x/cell)+':'+Math.floor(ns[i].y/cell);
      const b=grid.get(key); if(b) b.push(i); else grid.set(key,[i]);
    }
    let hits=0;
    for(let i=0;i<ns.length;i++){
      const a=ns[i];
      const gx=Math.floor(a.x/cell), gy=Math.floor(a.y/cell);
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
        const b=grid.get((gx+dx)+':'+(gy+dy)); if(!b) continue;
        for(const j of b){
          if(j<=i) continue;
          const c=ns[j];
          const want=a.r+c.r+GMAP_COLLIDE_PAD;
          let x=c.x-a.x, y=c.y-a.y;
          const d2=x*x+y*y;
          if(d2>=want*want) continue;
          let d=Math.sqrt(d2);
          if(d<1e-6){ x=((i%5)-2)||1; y=((j%5)-2)||1; d=Math.sqrt(x*x+y*y); }
          hits++;
          const push=(want-d)/d/2, px=x*push, py=y*push;
          a.x-=px; a.y-=py; c.x+=px; c.y+=py;
        }
      }
    }
    if(!hits) break;
  }
  for(const n of ns){ if(n.fx!=null) n.fx=n.x; if(n.fy!=null) n.fy=n.y; }
}
// THE VOLUME HAS THE SAME PROBLEM THE PLANE HAD. The forces are isotropic, so a
// settled 3D cloud is roughly round, and the camera looks at it down its own z:
// fitted into a pane twice as wide as it is tall, a round cloud fills the height
// and leaves the sides empty (measured on mall, headless: the projection covered
// 0.43 of the pane's width against 0.84 of its height, and every sphere was
// three pixels across). So the same stretch the flat map gets is applied here,
// on x about the centroid. A monotone stretch on one axis can only ADD clear air
// between two spheres, so nothing that was separate collides afterwards.
function mapNormalise3D(){
  const wrap=mapWrapEl(); if(!wrap) return;
  const W=wrap.clientWidth||900, H=wrap.clientHeight||620;
  let lox=Infinity, hix=-Infinity, loy=Infinity, hiy=-Infinity, seen=0;
  for(const n of GMAP.nodes){
    if(!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    seen++;
    if(n.x<lox) lox=n.x; if(n.x>hix) hix=n.x;
    if(n.y<loy) loy=n.y; if(n.y>hiy) hiy=n.y;
  }
  if(seen<2) return;
  const sx=hix-lox, sy=hiy-loy;
  if(!(sy>1)) return;
  const aspect=(W>0&&H>0) ? W/H : 1, bbox=sx/sy;
  if(!(bbox<aspect)) return;
  const st=Math.min(aspect/bbox, GMAP_STRETCH_MAX);
  const mx=(lox+hix)/2;
  for(const n of GMAP.nodes){ if(Number.isFinite(n.x)) n.x=mx+(n.x-mx)*st; }
}
function mapSettled(){
  // A full settle is the only thing allowed to rescale the picture. A local run
  // placed a handful of new satellites INSIDE a layout whose units are already
  // the pane's, and rescaling it would move every node the reader was looking
  // at, which is exactly what this is here to stop.
  if(GMAP.layout==='full' && GMAP.drawn==='2d') mapNormalise2D();
  else if(GMAP.layout==='full' && GMAP.drawn==='3d') mapNormalise3D();
  else if(GMAP.layout==='local' && GMAP.drawn==='2d') mapRelaxLoose(GMAP_RELAX_ROUNDS);
  mapPinAll();
  mapSavePositions();
  // The 3D widths are a fraction of the layout's span, and the span the mount
  // measured was the SEEDED one — what the forces settled to can be a good deal
  // wider. Re-measure once it stops, and only redraw if it actually moved.
  if(GMAP.drawn==='3d' && GMAP.api){
    const sc=map3dScale();
    if(Math.abs(sc-(GMAP.scale3d||1)) > (GMAP.scale3d||1)*0.15){ GMAP.scale3d=sc; mapRefresh(); }
  }
  if(GMAP.layout!=='full') return;    // nothing was laid out, so nothing to fit
  if(GMAP.fitDone || !GMAP.api) return;
  GMAP.fitDone=true;
  GMAP.fit[GMAP.drawn]=true;
  try{ GMAP.api.zoomToFit(400, GMAP.drawn==='3d'?20:40); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
  if(GMAP.drawn==='2d') setTimeout(()=>{ if(GMAP.drawn==='2d') mapSaveView(); }, 520);
  // …and then the fit is CHECKED, because the library's own is not enough. See
  // map3dFitCorrect.
  if(GMAP.drawn==='3d' && GMAP.api) map3dFitSoon(GMAP.api, GMAP_3D_FIT_TRIES);
}

// ---- fold and unfold --------------------------------------------------------
// Opening or closing a group changes WHICH NODES EXIST, so the picture is
// rebuilt and the forces are given a fresh settle (renderMap saves the
// positions on its way out, so everything already placed comes back where it
// was and only the new satellites move). The answer is not re-asked: the
// endpoints were always in it.
function mapRebuild(){
  if(!GMAP.resp) return;
  renderMap();
}
function mapToggleGroup(id, want){
  if(!GMAP.groupEps.has(id) && !GMAP.answerById.has(id)) return false;
  const open = want===undefined ? !GMAP.open.has(id) : !!want;
  if(open===GMAP.open.has(id)) return false;
  if(open) GMAP.open.add(id); else GMAP.open.delete(id);
  return true;
}
function mapFoldAll(){
  if(!GMAP.open.size) return false;
  GMAP.open=new Set();
  return true;
}
function mapUnfoldAll(){
  const before=GMAP.open.size;
  GMAP.open=new Set([...GMAP.groupEps.keys()]);
  return GMAP.open.size!==before;
}
/** Which of the two words the control is standing on — or neither, part-open. */
const mapFoldState=()=> GMAP.open.size===0 ? 'folded'
  : (GMAP.open.size===GMAP.groupEps.size ? 'endpoints' : 'some');
function renderMapFoldNote(){
  const seg=byId('gfold');
  if(!seg) return;
  const state=mapFoldState();
  seg.querySelectorAll('button').forEach((b)=> b.classList.toggle('on', b.dataset.fold===state));
}

// ---- interaction ------------------------------------------------------------
function mapClick(n){
  if(!n){ mapClear(); return; }
  const now=Date.now();
  // The renderers have no double-click event, so it is measured here: two
  // clicks on the SAME node inside 400ms drill into `Around <node>`.
  if(GMAP.lastClick.id===n.id && now-GMAP.lastClick.at<400){
    GMAP.lastClick={id:null,at:0};
    // From the Overview, a double-click is "show me this on the Graph tab":
    // the node stays selected and the map moves there with its own layout.
    if(GMAP.where==='overview'){ GMAP.sel=n.id; mapSetLit(n.id);
      activateTab('graph'); return; }
    // A group is this view's own bucket, not a node the engine holds — there is
    // no neighbourhood to draw around it, so it just stays selected.
    if(n.kind!=='group'){ openGraph(n.id); return; }
  }
  GMAP.lastClick={id:n.id, at:now};
  // A GROUP is a fold. Clicking it opens it into its endpoints (or closes it
  // again) as well as lighting it — that is the one gesture the picture needs
  // to go from "the shape of the system" to "what is actually in this box".
  if(n.kind==='group' && mapToggleGroup(n.id)){
    GMAP.sel=n.id; GMAP.hover=null;
    mapRebuild();
    return;
  }
  GMAP.sel=n.id; GMAP.hover=null;
  mapSetLit(n.id); mapRefresh(); renderMapSide();
}
function mapHover(n){
  if(GMAP.sel) return;                 // a sticky selection outranks the preview
  const id=n?n.id:null;
  if(GMAP.hover===id) return;
  GMAP.hover=id; mapSetLit(id); mapRefresh();
}
function mapClear(){
  GMAP.sel=null; GMAP.hover=null; GMAP.lastClick={id:null,at:0};
  mapSetLit(null); mapRefresh(); renderMapSide();
}
function mapFlyTo(id){
  const n=GMAP.byId.get(id); if(!n) return false;
  GMAP.sel=id; GMAP.hover=null;
  mapSetLit(id); mapRefresh(); renderMapSide();
  try{
    if(GMAP.drawn==='2d'){
      if(GMAP.api.centerAt) GMAP.api.centerAt(n.x, n.y, 600);
      if(GMAP.api.zoom) GMAP.api.zoom(2.4, 600);
    }else if(GMAP.drawn==='3d' && GMAP.api.cameraPosition){
      const d=90+n.r*6, r=Math.hypot(n.x||0, n.y||0, n.z||0)||1, f=1+d/r;
      GMAP.api.cameraPosition({x:(n.x||0)*f, y:(n.y||0)*f, z:(n.z||0)*f || d}, n, 700);
    }
  }catch(e){ /* the fly is a nicety; the selection is the answer */ }
  return true;
}
// What the entry box means on the map: the node it names, if the ANSWER holds
// it. A full id wins; then a group by name; then whatever kind the ENGINE says
// the text is (the same resolution the Around box uses). A folded endpoint
// counts as found — `mapReveal` below is what puts it on screen.
async function mapFindNode(raw){
  const here=(id)=> GMAP.byId.has(id) || GMAP.answerById.has(id);
  if(here(raw)) return raw;
  if(here('group:'+raw)) return 'group:'+raw;
  const args=await graphArgs(raw);
  for(const k of Object.keys(args)){
    const id = k==='node' ? args[k] : (k+':'+args[k]);
    if(here(id)) return id;
  }
  return null;
}
// Find lands on a node the picture may have folded away. Unfold its group
// first, then light it: a search that answers "it is in there somewhere" is not
// an answer.
function mapReveal(id){
  const g = GMAP.groupEps.has(id) ? id : (GMAP.byId.has(id) ? null : GMAP.epGroup.get(id));
  if(g && mapToggleGroup(g, true)){ GMAP.sel=id; mapRebuild(); }
  return mapFlyTo(id);
}
async function mapCommitSearch(){
  const raw=byId('gfocus').value.trim();
  if(!raw){ mapClear(); return; }
  const mine=++GMAP.findSeq;
  let id;
  try{ id=await mapFindNode(raw); }catch(e){ id=null; }
  if(mine!==GMAP.findSeq) return;
  if(id){ mapReveal(id); return; }
  // Not on the map — a column, or a table no endpoint reaches. The engine can
  // still answer it, as the drill-down; say why the map did not move.
  openGraph(raw);
}

// ---- the screens layer's default --------------------------------------------
// ON where there are few enough screens for a screen to be a thing you can see,
// OFF where there are so many that they would be the map. The number is the
// OVERVIEW answer's own screen census, never a count this page makes; until
// that answer has landed the layer stays UNDECIDED (null) rather than guessing,
// and the first map is asked for without it.
const GMAP_SCREEN_LAYER_MAX=300;
/** How many screens this pack has, or null while the overview has not answered. */
function mapScreenCount(){
  const a=OV.resp && OV.resp.answer;
  if(!a) return null;
  return a.screens ? (a.screens.screens||0) : 0;
}
/** Decide the layer once. Returns true when this call is what decided it. */
function mapScreensDecide(){
  if(GMAP.screens!==null) return false;
  const n=mapScreenCount();
  if(n==null) return false;
  GMAP.screens = n>0 && n<=GMAP_SCREEN_LAYER_MAX;
  return true;
}

// ---- draw / render ----------------------------------------------------------
async function drawMap(){
  const counts=byId('gcounts'), side=byId('gside');
  if(!mapHas2D()){
    stopMap();
    counts.replaceChildren(t('graph.norenderer'));
    mapHostEl().append(el('div',{className:'gmapmsg',textContent:
      t('graph.novendor')}));
    side.replaceChildren();
    return;
  }
  counts.replaceChildren(t('load.map'));
  const mine=++GMAP.seq;
  // …and WHICH SUB-MODE it was asked for. Every handoff into `Around <node>`
  // clicks the Graph tab first, and that click starts this request when no map
  // has been drawn yet; `graphMode('around')` then runs immediately after.
  // Mounting on arrival regardless left a second renderer alive inside the
  // hidden #gmapwrap — its own animation loop, its own canvas, behind a picture
  // the reader is not looking at.
  const forMode=GRAPHV.mode, forWhere=GMAP.where;
  mapScreensDecide();
  const args={ mode:byId('gmode').value, depth:Number(byId('gdepth').value) };
  const layers=[];
  if(GMAP.layers) layers.push('statements');
  if(GMAP.screens===true) layers.push('screens');
  if(layers.length) args.layers=layers;
  // WHAT THIS REQUEST WAS ASKED WITH, so the page can tell an answer drawn
  // before the screens layer was decided from one drawn after (see
  // renderOverview): on a deep link straight to this tab the map is asked for
  // before the overview has said how many screens there are.
  GMAP.askedScreens=GMAP.screens;
  let r;
  try{ r=await api('map', args); }
  catch(e){
    if(stale(e)||mine!==GMAP.seq) return;
    stopMap(); counts.replaceChildren();
    side.replaceChildren(errPanel(e));
    return;
  }
  if(mine!==GMAP.seq) return;
  GMAP.resp=r; GMAP.sel=null; GMAP.hover=null; GMAP.fitDone=false;
  // The cached positions describe the PREVIOUS answer and must go either way.
  mapForgetLayout();
  GMAP.nodes=[];
  // The tab left map mode while this was in flight: KEEP the answer — `‹ back to
  // map` will draw it without asking the server again — and mount nothing.
  if(forWhere!==GMAP.where) return;
  if(GMAP.where!=='overview' && (forMode!=='map' || GRAPHV.mode!=='map')) return;
  stopMap(false);
  renderMap();
}
function renderMap(){
  if(!GMAP.resp) return;
  // Tear the live renderer down FIRST, so the positions it settled and the zoom
  // the reader chose are saved before the model is rebuilt on top of them.
  stopMap();
  const wrap=mapWrapEl(), host=mapHostEl();
  // The Overview's cartography is always the 2D canvas: 2D/3D is a control on
  // the Graph tab, and a WebGL context behind the landing page would be a cost
  // nobody asked for.
  let want=GMAP.where==='overview' ? '2d' : GMAP.rend;
  if(want==='3d' && !mapWebglOk()){ want='2d'; GMAP.fellBack=true; }
  else if(want==='3d'){ GMAP.fellBack=false; }
  // The 3D view is SEEDED from the flat one the first time it is opened, so the
  // volume is recognisably the same map. After that it has a settled layout of
  // its own and the two dimensions no longer touch each other.
  const seed3d = want==='3d' && mapCache('3d').size===0;
  buildMapModel(seed3d ? '2d' : want);
  // WHAT THIS MOUNT DOES. Nothing placed means nothing to simulate; a handful
  // of new satellites get a short run and every settled node holds still; a
  // fresh answer (or the fit button) is the only thing that lays the whole
  // picture out again.
  GMAP.layout = mapCache(want).size===0 ? 'full' : (GMAP.loose>0 ? 'local' : 'none');
  if(seed3d) GMAP.layout='full';
  if(GMAP.refit){ GMAP.refit=false; GMAP.layout='full'; }
  // A FULL layout is the one case where the pins have to go: the forces are
  // being asked to lay the whole picture out again, and a pinned node cannot
  // move. Everything else keeps them, which is what holds the map still.
  if(GMAP.layout==='full') mapUnpinAll();
  renderMapChips();
  // The host may hold the label plane of an earlier mount (or, on the very
  // first render, the empty one the markup ships): one picture, one host.
  host.replaceChildren();
  const w=wrap.clientWidth||900, h=wrap.clientHeight||620;
  GMAP.drawn=want;
  GMAP.fitDone = GMAP.layout!=='full' && GMAP.fit[want];
  if(seed3d){ mapSeed3D(); GMAP.scale3d=map3dScale(); }
  else if(want==='3d') GMAP.scale3d=map3dScale();
  try{
    GMAP.api = want==='3d' ? mountMap3D(host, w, h) : mountMap2D(host, w, h);
  }catch(e){
    // A renderer that refuses to start is reported, never left as a blank box.
    GMAP.api=null; GMAP.drawn=null;
    host.append(el('div',{className:'gmapmsg',textContent:'the '+want.toUpperCase()+' renderer could not start: '+(e&&e.message||e)}));
  }
  GMAP.mounted=host;
  // The picture the reader had is put back exactly: no refit, so a map they
  // zoomed into is still zoomed in after a fold or a trip through Around.
  if(GMAP.layout!=='full') mapRestoreView();
  // The renderers EMPTY their host when they mount, so the label plane is built
  // afterwards — and last, so it paints over the canvas.
  host.append(el('div',{id:'gmaplabels'}));
  if(GMAP.drawn==='3d' && GMAP.api) mapStartLabelLoop(GMAP.api);
  renderMapRendNote();
  renderMapFlowNote();
  renderMapFoldNote();
  renderMapCounts();
  renderMapSide();
  renderOvMapChrome();
  // The map is the only answer that counts api groups, so the header's rail
  // fills its first lane the moment this picture exists.
  renderCascadeRail();
}
function renderMapRendNote(){
  const note=byId('grendnote');
  if(GMAP.fellBack && GMAP.rend==='3d'){
    note.textContent=t('graph.rend.fallback');
    note.title=t('graph.rend.fallback.title');
    note.classList.remove('hidden');
  }else{ note.textContent=''; note.classList.add('hidden'); }
}
// What the flow button says, and — when the map is too big for the resting
// animation — why the picture is still until something is lit.
function renderMapFlowNote(){
  const note=byId('gflownote');
  // The three buttons say the same word because they are the same preference.
  //
  // PRESSED IS NOT THE SAME AS ON. The lanes animate the moment the preference
  // is on, so their buttons are pressed when it is. The MAP is still until the
  // toggle has actually been touched (mapFlowsAtRest), so with nothing stored
  // its button said "Flow on", reported itself pressed, and nothing moved. The
  // Graph button now reports what its own picture does, which is what the note
  // beside it says in words.
  for(const id of ['gflow','fflow','iflow']){
    const x=byId(id); if(!x) continue;
    x.textContent=t(GMAP.flow ? 'graph.flow.on' : 'graph.flow.off');
    x.classList.toggle('off', !GMAP.flow);
    x.setAttribute('aria-pressed', String(id==='gflow' ? mapFlowsAtRest() : GMAP.flow));
    x.title = t(GMAP.flow ? 'graph.flow.title.on' : 'graph.flow.title.off');
  }
  // Two things the button alone cannot say: that the RESTING map is still until
  // the toggle is pressed (the preference is shared with the lane views, whose
  // handful of connectors do animate by default), and - once it is on - that a
  // map past the cap animates only what is lit.
  const quiet = mapFlowsAtRest() && !!GMAP.resp && !GMAP.flowRest;
  const rest = !quiet && !!GMAP.resp && !mapFlowsAtRest() && !reducedMotion();
  note.textContent = quiet ? t('graph.flow.quiet',{directed:GMAP.directed, max:GMAP_FLOW_REST_MAX})
    : (rest ? t('graph.flow.rest') : '');
  note.title = rest ? t('graph.flow.rest.title') : '';
  // …and it belongs to the map too. Around draws no resting animation, so the
  // note has nothing to explain there.
  note.classList.toggle('hidden', !(quiet || rest) || GRAPHV.mode!=='map');
}
function renderMapChips(){
  const a=GMAP.resp.answer;
  const total=new Map();
  for(const n of a.nodes) total.set(n.kind,(total.get(n.kind)||0)+1);
  const order=['group','screen','endpoint','table','statement'];
  const chips=[el('span',{className:'count',textContent:t('chip.kinds')})];
  for(const k of order){
    if(!total.has(k)) continue;
    const off=GMAP.hidden.has(k), n=total.get(k);
    const b=el('button',{className:'chip'+(off?' off':''),
      title:t(off?'chip.show.title':'chip.hide.title',{n, kind:k}),
      onclick:()=>{ if(off) GMAP.hidden.delete(k); else GMAP.hidden.add(k); GMAP.sel=null; renderMap(); }},
      [kindDot(k, 11), kindName(k)+' '+n]);
    b.setAttribute('aria-pressed', String(!off));
    chips.push(b);
  }
  // The statements chip is not a filter: without the layer the engine sent no
  // statement at all, so turning it on RE-ASKS for the map with that layer.
  const on=GMAP.layers;
  const sb=el('button',{className:'chip'+(on?'':' off'),
    title:t(on?'chip.sql.on.title':'chip.sql.off.title'),
    onclick:()=>{ GMAP.layers=!GMAP.layers; GMAP.hidden.delete('statement'); drawMap(); }},
    [kindDot('statement', 11),
     on ? t('chip.sql.on',{n:total.get('statement')||0}) : t('chip.sql.off')]);
  sb.setAttribute('aria-pressed', String(on));
  chips.push(sb);
  // ...and the CONNECTED PROJECTS, which is a filter and not a re-ask: the
  // answer already carries them (federate:false would be a different answer,
  // and this switch is about the drawing). Offered only where a crossing
  // actually reached something, so a project that talks to nobody has no dead
  // control on its toolbar.
  const f=a.summary.federated;
  if(f && f.nodes>0){
    const fon=GMAP.fed;
    const fb=el('button',{className:'chip'+(fon?'':' off'),
      title:t(fon?'chip.fed.on.title':'chip.fed.off.title',{n:f.nodes, k:f.projects.length}),
      onclick:()=>{ GMAP.fed=!fon; lsSet(FED_KEY, GMAP.fed?'on':'off'); GMAP.sel=null; renderMap(); }},
      [kindDot('project', 11),
       fon ? t('chip.fed.on',{n:f.nodes}) : t('chip.fed.off',{n:f.nodes})]);
    fb.setAttribute('aria-pressed', String(fon));
    chips.push(fb);
  }
  // …and the SCREENS layer, the same kind of control: without it the engine
  // sent no screen at all, so turning it on RE-ASKS. It is offered only where
  // this pack HAS a screen axis, which the overview answer says and this page
  // does not guess.
  const screenCount=mapScreenCount();
  if(screenCount) {
    const so=GMAP.screens===true;
    const cb=el('button',{className:'chip'+(so?'':' off'),
      title:t(so?'chip.screens.on.title':'chip.screens.off.title'),
      onclick:()=>{ GMAP.screens=!so; GMAP.hidden.delete('screen'); drawMap(); }},
      [kindDot('screen', 11),
       so ? t('chip.screens.on',{n:total.get('screen')||0}) : t('chip.screens.off')]);
    cb.setAttribute('aria-pressed', String(so));
    chips.push(cb);
  }
  byId('gchips').replaceChildren(...chips);
}
function renderMapCounts(){
  const r=GMAP.resp, s=r.answer.summary;
  // Each count is one catalogue sentence with its number in bold — so a
  // translation can put the number where its own grammar wants it, instead of
  // having the page glue an English word onto a digit.
  const say=(key,params)=> el('span',{}, richNodes(t(key,params)));
  const kids=[say('gcount.groups',{n:s.shown.groups}),'\u00a0\u00a0',
    say('gcount.endpoints',{n:s.shown.endpoints}),'\u00a0\u00a0',
    say('gcount.tables',{n:s.tablesTouched, total:s.tables})];
  if(s.statements!=null) kids.push('\u00a0\u00a0',say('gcount.statements',{n:s.shown.statements}));
  // Two numbers, because they answer two questions: how many screens this
  // picture drew, and how many the pack has. A screen that reaches no route is
  // not on the map, and the difference is said rather than left as a silence.
  if(s.screens!=null) kids.push('\u00a0\u00a0',say('gcount.screens',{n:s.screens, total:s.screensTotal}));
  // WHAT THE PICTURE FOLDED AWAY. The census above counts the answer; this
  // counts the drawing — the two differ exactly by the endpoints standing
  // inside their group node, and a reader must be told which they are reading.
  const drawnEps=GMAP.nodes.reduce((n,x)=> n+(x.kind==='endpoint'?1:0), 0);
  const folded=Math.max(0, GMAP.endpointsTotal-drawnEps);
  if(GMAP.endpointsTotal){
    kids.push('\u00a0\u00a0', drawnEps
      ? say('gcount.unfolded',{n:drawnEps, g:GMAP.open.size, n2:folded})
      : say('gcount.folded',{n:folded}));
  }
  // WHAT CAME FROM SOMEWHERE ELSE. Counted off the answer, so the line says the
  // same thing whether the layer is drawn or hidden, and it says which it is.
  const fed=s.federated;
  if(fed && fed.nodes>0){
    kids.push('\u00a0\u00a0', say('gcount.federated',{n:fed.nodes, k:fed.projects.length}));
    if(!GMAP.fed) kids.push(' '+t('gcount.federated.off'));
  }
  kids.push('\u00a0\u00a0',say('gcount.links',{n:GMAP.links.length}));
  const byKind={};
  for(const l of GMAP.links) byKind[l.data.kind]=(byKind[l.data.kind]||0)+1;
  const parts=[];
  for(const k of ['calls','aggregate','member','touches','executes','joins']) if(byKind[k]) parts.push(byKind[k]+' '+t(LINK_KIND_KEY[k]));
  if(parts.length) kids.push(' ('+parts.join('\u00a0\u00a0')+')');
  const hidden=[...GMAP.hidden];
  if(hidden.length) kids.push(' — '+t('gcount.hidden',{kinds:hidden.join(', ')}));
  // The node cap is the server's, in the server's own words; the numbers here
  // are what SURVIVED it, per kind.
  const cut=[];
  if(s.shown.endpoints<s.endpoints) cut.push('endpoints '+s.shown.endpoints+' / '+s.endpoints);
  if(s.shown.tables<s.tablesTouched) cut.push('tables '+s.shown.tables+' / '+s.tablesTouched);
  if(s.statements!=null && s.shown.statements<s.statements) cut.push('statements '+s.shown.statements+' / '+s.statements);
  if(s.screens!=null && s.shown.screens<s.screens) cut.push('screens '+s.shown.screens+' / '+s.screens);
  if(cut.length){
    const why=(r.limits||[]).find(l=>/node cap/.test(l.reason||''));
    kids.push(el('span',{className:'tag warn', style:'margin-left:8px',
      title:(why&&why.reason)||t('graph.nodecap.title'), textContent:'node cap: '+cut.join('\u00a0\u00a0')}));
  }
  if(GMAP.drawn) kids.push('\u00a0\u00a0', el('span',{className:'count',
    title:t('gcount.drawnin.title'), textContent:t('gcount.drawnin',{rend:GMAP.drawn.toUpperCase()})}));
  byId('gcounts').replaceChildren(...kids);
}
function renderMapSide(){
  refreshShowAll();
  if(!GMAP.resp){ byId('gside').replaceChildren(); return; }
  setKids(byId('gside'), GMAP.sel ? mapNodeCard(GMAP.sel) : mapLeadCard(), honesty(GMAP.resp, 'map'));
}
function mapLeadCard(){
  const s=GMAP.resp.answer.summary;
  const top=(kind,n)=> GMAP.nodes.filter(x=>x.kind===kind).sort((a,b)=>b.degree-a.degree||(a.id<b.id?-1:1)).slice(0,n);
  // A GROUP chip is the other way into the fold: it opens the group and flies
  // to it, so a reader who found the box in the rail lands inside it.
  const chip=(x)=> el('button',{className:'ovchip', title:t('map.lead.chip.title',{id:x.id, degree:x.degree}),
    textContent:x.label+'\u00a0\u00a0'+x.degree,
    onclick:()=> x.kind==='group' ? mapReveal(x.id) : mapFlyTo(x.id)});
  return el('div',{className:'panel fcard'},[
    el('h2',{},[t('map.lead.title')]),
    // The card's prose is READ level: one line on the page, the paragraph it
    // used to print behind the chevron.
    fold('map.lead.body', [t('map.lead.brief')],
      ()=> [el('div',{className:'comment'},[t('map.lead.body')])]),
    // The number beside a table is what REACHES it, and that changes with the
    // fold: groups while the map is folded, endpoints once it is open.
    el('h2',{style:'margin-top:12px'},[t(GMAP.open.size ? 'map.lead.tables.open' : 'map.lead.tables')]),
    el('div',{className:'ovchips'}, top('table',8).map(chip)),
    el('h2',{style:'margin-top:12px'},[t('map.lead.groups')]),
    el('div',{className:'ovchips'}, top('group',8).map(chip)),
    el('div',{className:'cpnote'},[
      s.tablesTouched<s.tables
        ? t('map.lead.unreached',{n:s.tables-s.tablesTouched, total:s.tables})
        : t('map.lead.allreached')]),
  ]);
}
function mapNodeCard(id){
  const n=GMAP.byId.get(id);
  if(!n) return el('div',{className:'panel',textContent:t('map.gone')});
  const d=n.data, key=id.slice(id.indexOf(':')+1);
  // A NODE FROM ANOTHER PACK IS NOT THIS PROJECT'S TO ANSWER. Every button
  // below asks the project on screen, and this project does not have that
  // file, that route or that table: it would come back "unknown". So the card
  // names the project and offers the one thing that IS true here, which is to
  // go there. The same handoff `openFlowFor` makes from a federated lane row.
  const fed=n.fed;
  if(fed) return mapFedCard(n, id, key, fed);
  const btns=el('div',{style:'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap'});
  if(n.kind!=='group'){
    btns.append(graphSourceButton(id));
    btns.append(el('button',{className:'mini', textContent:'Around',
      title:t('btn.around.title'), onclick:()=>openGraph(id)}));
  }
  if(n.kind==='endpoint') btns.append(el('button',{className:'mini', textContent:'Flow',
    title:t('btn.flow.title'), onclick:()=>openFlow({endpoint:key})}));
  // A SCREEN is a top: Flow walks down from it, and there is nothing above it
  // for Impact to answer.
  if(n.kind==='screen') btns.append(el('button',{className:'mini', textContent:'Flow',
    title:t('btn.flow.screen.title'), onclick:()=>openFlow({screen:key})}));
  if(n.kind==='table'||n.kind==='statement') btns.append(el('button',{className:'mini', textContent:'Impact',
    title:t('btn.impact.title'), onclick:()=>openImpact({[n.kind]:key})}));
  if(n.kind==='table') btns.append(el('button',{className:'mini', textContent:'ERD',
    title:t('btn.erd.title'), onclick:()=>openErd(key)}));
  const facts=[];
  if(n.kind==='group') facts.push(el('span',{className:'count',textContent:t('tip.endpoints',{n:d.endpoints})}));
  if(n.kind==='endpoint'){
    if(d.httpMethod) facts.push(el('span',{className:'tag',textContent:d.httpMethod}));
    facts.push(el('span',{className:'count',textContent:t('tip.ingroup',{g:d.group})}));
    if(d.handlerShort) facts.push(el('span',{className:'count',textContent:d.handlerShort}));
  }
  if(n.kind==='table') facts.push(el('span',{className:'count',textContent:t('tip.columns',{n:d.columnCount})}));
  if(n.kind==='screen'){
    if(d.group) facts.push(el('span',{className:'tag',textContent:d.group}));
    if(d.observed) facts.push(el('span',{className:'tag',title:t('chain.tag.seen.title'),textContent:t('chain.tag.seen')}));
    facts.push(el('span',{className:'count',textContent:t('tip.screenapi',{n:d.endpoints})}));
    facts.push(el('span',{className:'count',textContent:t('tip.screentables',{n:d.tables})}));
    if(d.title) facts.push(el('span',{className:'count',textContent:d.title}));
  }
  if(n.kind==='statement'&&d.statementType) facts.push(el('span',{className:'tag',textContent:d.statementType}));
  return el('div',{className:'panel fcard'},[
    el('div',{className:'srchead'},[
      el('span',{className:'count',textContent:t('map.card.head',{kind:kindName(n.kind), n:n.degree})}),
      el('button',{className:'mini', textContent:t('map.card.clear'), onclick:()=>mapClear()}) ]),
    el('code',{className:'id', style:'display:block;word-break:break-all;margin:7px 0 4px'},[key]),
    d.comment ? el('div',{className:'comment',textContent:'“'+d.comment+'”'}) : null,
    n.kind==='group' ? el('div',{className:'comment',textContent:t('map.group.note')}) : null,
    facts.length ? el('div',{className:'fsub'}, facts) : null,
    btns,
    ...mapConnectionLists(id),
  ]);
}
/**
 * The card for a node that came from another registered project.
 *
 * @param {object} n    the view model node
 * @param {string} id   its namespaced id on this picture
 * @param {string} key  the id it has IN ITS OWN PROJECT (the namespace and the
 *                      kind prefix stripped), which is what the hash carries
 * @param {string} project
 */
function mapFedCard(n, id, key, project){
  const d=n.data;
  // Which tab answers this kind over there. A route is a Flow question, a table
  // an ERD one, and anything else lands on that project's Overview, which is
  // the one page every project has.
  const to = n.kind==='endpoint' ? { tab:'flow', pick:'endpoint:'+key }
    : n.kind==='table' ? { tab:'erd', pick:'table:'+key }
      : n.kind==='statement' ? { tab:'explore', pick:'statement:'+key }
        : { tab:'overview', pick:null };
  const facts=[el('span',{className:'tag fproj',title:project+'  '+t('chain.tag.project.title'),textContent:project})];
  if(n.kind==='endpoint' && d.httpMethod) facts.push(el('span',{className:'tag',textContent:d.httpMethod}));
  if(n.kind==='endpoint' && d.portal) facts.push(el('span',{className:'count',textContent:t('map.card.portal')}));
  if(n.kind==='table') facts.push(el('span',{className:'count',textContent:t('tip.columns',{n:d.columnCount})}));
  if(n.kind==='project') facts.push(el('span',{className:'count',textContent:t('tip.fedskeleton',{n:d.endpoints||0})}));
  return el('div',{className:'panel fcard'},[
    el('div',{className:'srchead'},[
      el('span',{className:'count',textContent:t('map.card.head',{kind:kindName(n.kind), n:n.degree})}),
      el('button',{className:'mini', textContent:t('map.card.clear'), onclick:()=>mapClear()}) ]),
    el('code',{className:'id', style:'display:block;word-break:break-all;margin:7px 0 4px'},[key]),
    d.comment ? el('div',{className:'comment',textContent:'\u201c'+d.comment+'\u201d'}) : null,
    el('div',{className:'comment',textContent:t(n.kind==='project' ? 'map.card.project' : 'map.card.fedproject',{p:project})}),
    el('div',{className:'fsub'}, facts),
    el('div',{style:'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap'},[
      el('button',{className:'mini', textContent:t('map.card.open',{p:project}),
        title:t('map.card.open.title',{p:project}),
        onclick:()=>{ location.hash = hashFor({ project, tab:to.tab, pick:to.pick }); }}) ]),
    ...mapConnectionLists(id),
  ]);
}

// What this node is joined to IN THIS PICTURE, grouped by the far end's kind.
// Each row carries the link's own access and grade, so a candidate chain reads
// as a candidate here as well as in the tooltip.
function mapConnectionLists(id){
  const groups=new Map();
  for(const i of (GMAP.incident.get(id)||[])){
    const l=GMAP.links[i], other = l.sid===id ? l.tid : l.sid, out = l.sid===id;
    const on=GMAP.byId.get(other);
    const kind=on?on.kind:other.slice(0,other.indexOf(':'));
    let rows=groups.get(kind);
    if(!rows){ rows=[]; groups.set(kind,rows); }
    rows.push({l, other, out, label:on?on.label:shortId(other)});
  }
  const order=['screen','group','project','endpoint','statement','table'];
  const out=[];
  for(const kind of order){
    const rows=groups.get(kind); if(!rows) continue;
    rows.sort((a,b)=> (a.label<b.label?-1:a.label>b.label?1:0));
    const shown=rows.slice(0,GMAP_ROW_CAP);
    out.push(el('h2',{style:'margin-top:12px'},[
      CARD_LIST_KEY[kind] ? t(CARD_LIST_KEY[kind],{n:rows.length}) : (kind+'s ('+rows.length+')')]));
    out.push(el('ul',{className:'list'}, shown.map(r=>el('li',{},[
      el('span',{className:'grow'},[
        el('span',{className:'count',textContent: r.l.data.kind==='joins' ? '↔' : (r.out?'→':'←')}),
        el('a',{className:'id clickable', title:r.other+' — light it up', textContent:r.label,
          onclick:()=>mapFlyTo(r.other)}) ]),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        r.l.data.access ? el('span',{className:'tag '+(/write|delete/.test(r.l.data.access)?'write':'read'), textContent:r.l.data.access}) : null,
        r.l.data.statements!=null ? el('span',{className:'count',textContent:t('map.card.stmt',{n:r.l.data.statements})}) : null,
        r.l.data.witness!=null ? el('span',{className:'count',textContent:r.l.data.witness+' witness'}) : null,
        badge(r.l.data.grade) ]) ]))));
    if(rows.length>shown.length) out.push(el('div',{className:'cpnote',
      textContent:t('map.card.more',{n:rows.length-shown.length})}));
  }
  return out;
}

// ---- the canvas is the page -------------------------------------------------
// THE PICTURE ENDS WHERE THE WINDOW DOES. The Graph tab's pane used to be a
// flat 72vh with a 520px floor, under a toolbar, a hint, a legend, a chip row
// and a count line: on a 900px screen the canvas started at 301px and ran 97px
// past the bottom of the browser, and the wheel over it zooms the map, so there
// was no way to scroll to what had been cut off. The three chrome rows are now
// overlays inside the canvas, and the height is measured from this box's OWN
// top offset every time the layout can have moved.
const GMAP_PANE_MIN=420;   // px — under this the map stops being a picture
const GMAP_PANE_GAP=14;    // px of air under the canvas, so it does not touch the edge
const GMAP_ONE_COL=1100;   // px — the stylesheet's own single-column breakpoint
// A HEIGHT MEASURED FROM A TOP THAT THEN MOVES IS THE WRONG HEIGHT, and the
// window resize is exactly where the top moves: the masthead re-wraps at the
// new width and the pane starts a few pixels lower than it did when the
// measurement was taken. Measured in a real Chrome, 1440x900 to 1728x906: the
// top went 214 to 218, the height kept the old top's answer, and the pane's
// bottom landed at 910 in a 906px window. So the measurement CHECKS ITSELF:
// apply the height, read the top again, and if it has moved, measure once more.
// Two passes settle it, because the correction changes this box's height and
// nothing above it, so the second top is the final one.
const GMAP_PANE_PASSES=3;
function graphPaneResize(){
  const wrap=byId('gwrap');
  if(!wrap || typeof wrap.getBoundingClientRect!=='function') return null;
  const side=byId('gside');
  let h=null;
  for(let pass=0; pass<GMAP_PANE_PASSES; pass++){
    const vh=(typeof window!=='undefined' && window.innerHeight) || 900;
    const vw=(typeof window!=='undefined' && window.innerWidth) || 1400;
    // Measured with the height released, so this reads where the box STARTS
    // rather than where the last measurement left it.
    wrap.style.height='';
    const top=wrap.getBoundingClientRect().top;
    const avail=Math.round(vh-top-GMAP_PANE_GAP);
    // Narrow enough and the rail is UNDER the picture rather than beside it, so
    // the page scrolls anyway and a full-height canvas would push the rail out
    // of reach: there the old 72vh is the right answer, floor and all.
    const want = vw<=GMAP_ONE_COL ? Math.min(Math.round(vh*0.72), avail) : avail;
    h=Math.max(GMAP_PANE_MIN, want);
    wrap.style.height=h+'px';
    if(side) side.style.maxHeight=h+'px';
    const now=wrap.getBoundingClientRect().top;
    if(!(Math.abs(now-top)>=1)) break;   // the box is where it was measured
  }
  return h;
}
// The pane's top moves whenever anything above it does: a hint folded open, a
// toolbar wrapping onto a second line, a language with longer buttons, the
// MASTHEAD re-wrapping at a new window width. One observer over all of them,
// and the canvas is told its new size.
//
// The header is in this list because it is the one that was missing: a window
// resize re-wraps the dateline and the chips without changing the height of
// anything inside the Graph tab, so an observer that watched only the tab's own
// rows never fired for the very case that broke the layout.
function graphPaneWatch(){
  if(typeof ResizeObserver!=='function') return;
  const seen=[];
  for(const sel of ['header', '#crail', '#mchips', '#tab-graph .searchbar', '#ghintmap', '#ghintaround']){
    const el2=document.querySelector(sel); if(el2) seen.push(el2);
  }
  if(!seen.length) return;
  const ro=new ResizeObserver(()=>{ if(!byId('tab-graph').classList.contains('hidden')) graphPaneApply(); });
  for(const el2 of seen) ro.observe(el2);
}
/** Resize the pane and tell whichever renderer is mounted in it. */
function graphPaneApply(){
  const h=graphPaneResize();
  if(h==null) return;
  const wrap=byId('gwrap'), w=wrap.clientWidth||900;
  if(GA.api){ try{ GA.api.width(w).height(wrap.clientHeight||h); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } }
  if(GMAP.api && GMAP.where==='graph'){ try{ GMAP.api.width(w).height(wrap.clientHeight||h); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } }
}
// THE FIT BUTTON. After the reader has zoomed or panned, nothing puts the
// picture back on its own: this is the one control that does, and it lays the
// map out again from scratch so a picture that has drifted comes back whole.
function mapRefit(){
  if(!GMAP.resp) return;
  GMAP.refit=true;
  renderMap();
}
// THE OVERVIEW'S MAP IS ON A PAGE YOU SCROLL. A wheel over it used to zoom the
// map, so a reader scrolling past the landing page zoomed a picture they were
// not reading and could not get back. It now takes the wheel only once it has
// been clicked (or with ctrl/cmd held, which is the browser's own zoom gesture
// and never scrolls a page). The Graph tab's canvas fills its page and keeps
// plain wheel zoom.
function ovMapWheelGate(){
  const box=byId('ovmap'), note=byId('ovwheel');
  if(!box || box.__wheelgate) return;
  box.__wheelgate=true;
  const say=()=>{ if(note){ note.textContent=t('ov.map.wheel'); note.classList.toggle('hidden', !!box.__focused); } };
  box.addEventListener('wheel', (e)=>{
    if(box.__focused || e.ctrlKey || e.metaKey) return;
    e.stopPropagation();   // the page scrolls; the map does not zoom
    say();
  }, {capture:true, passive:true});
  box.addEventListener('mousedown', ()=>{ box.__focused=true; say(); }, {capture:true});
  box.addEventListener('mouseenter', say);
  box.addEventListener('mouseleave', ()=>{ if(note) note.classList.add('hidden'); });
}

// ---- the sub-mode switch ----------------------------------------------------
// Map or Around: one toolbar, one canvas area, one rail. Nothing is destroyed
// on the way out except the live renderer — the map's answer and the node
// positions are kept, so coming back is instant and the picture is the same one.
function graphMode(mode){
  if(GRAPHV.mode===mode) return;
  graphSetMode(mode);
  if(mode==='map'){
    stopAround();
    byId('gfocus').value = GMAP.find || '';
    closeSug(GRAPHV);
    renderMapRendNote();
    if(GMAP.resp) renderMap(); else drawMap();
  }else{
    // GRAPHV.mode is already 'around' by now, and that is what cancels a map
    // request still in flight: drawMap checks it on arrival, keeps the answer
    // for the next `‹ back to map` (so nothing is fetched twice) and mounts
    // nothing. All that is left here is tearing down what IS mounted.
    stopMap();
    byId('grendnote').classList.add('hidden');
  }
}
// Which controls the sub-mode shows, and nothing else — no request, no
// renderer. A project switch reuses it to put the tab back on the map without
// drawing anything into a pane the reader may not even be looking at.
function graphSetMode(mode){
  GRAPHV.mode=mode;
  const isMap = mode==='map';
  byId('gmapwrap').classList.toggle('hidden', !isMap);
  byId('garound').classList.toggle('hidden', isMap);
  byId('gback').classList.toggle('hidden', isMap);
  byId('grend').classList.toggle('hidden', !isMap);
  // The fit button belongs to the map: Around fits its own rings on every draw.
  byId('gfit').classList.toggle('hidden', !isMap);
  byId('gfold').classList.toggle('hidden', !isMap);
  byId('gflow').classList.toggle('hidden', !isMap);
  if(!isMap) byId('gflownote').classList.add('hidden');
  byId('gmode').classList.toggle('hidden', !isMap);
  byId('gdepth').classList.toggle('hidden', !isMap);
  byId('gdir').classList.toggle('hidden', isMap);
  byId('ghops').classList.toggle('hidden', isMap);
  byId('gmapleg').classList.toggle('hidden', !isMap);
  byId('klegend').classList.toggle('hidden', isMap);
  byId('glineleg').classList.toggle('hidden', isMap);
  byId('ghintmap').classList.toggle('hidden', !isMap);
  byId('ghintaround').classList.toggle('hidden', isMap);
  renderGraphChrome();
}
// What the Graph toolbar SAYS in the sub-mode it is in. Split out so a language
// switch re-labels it without touching the picture.
function renderGraphChrome(){
  const isMap = GRAPHV.mode==='map';
  byId('gload').textContent = isMap ? t('graph.find') : t('btn.draw');
  byId('gfocus').placeholder = isMap ? t('graph.focus.ph.map') : t('graph.focus.ph.around');
  renderLineLegend();
  renderMapFlowNote();
}
// WHAT A LINE ON THE `Around` PICTURE MEANS: one sample per grade, read off the
// same dash table the canvas draws from, and then the one line that is about
// WEIGHT rather than dash. It is a render function and not a start-up loop,
// because half of this row is the page's own words and a language switch has to
// move them. The head span is the markup's own (`data-t`), so it is kept.
function renderLineLegend(){
  const gll=byId('glineleg'); if(!gll) return;
  const head=gll.children[0]||null;
  gll.replaceChildren(...(head?[head]:[]));
  GRADES.forEach(g=> gll.append(el('span',{title:t('mapleg.grade.title',{grade:g})},[ gradeLineSample(g), ' '+g ])));
  // Drawn at the weight `gEdgeStyle` gives an observed EXACT edge, so the
  // legend and the picture cannot disagree about what heavier means.
  gll.append(el('span',{className:'gllobs',title:t('legend.observed.title')},
    [ gradeLineSample('EXACT', 2.9), ' '+t('legend.observed') ]));
}
function renderMapLegend(boxId){
  const box=byId(boxId||'gmapleg');
  if(!box) return;
  const dot=(k,label)=> el('span',{},[kindDot(k, 11), label]);
  const line=(color,label,dashed,tip)=> el('span',tip?{title:tip}:{},[
    el('span',{className:'swatch',style:'background:'+(dashed
      ? 'repeating-linear-gradient(90deg,'+color+','+color+' 4px,transparent 4px,transparent 7px)'
      : color)}), ' '+label]);
  box.replaceChildren(
    el('b',{textContent:t('mapleg.nodes')}),
    dot('screen',t('mapleg.screen')), dot('group',t('mapleg.group')), dot('endpoint',t('mapleg.endpoint')), dot('table',t('mapleg.table')), dot('statement',t('mapleg.statement')),
    el('b',{style:'margin-left:8px',textContent:t('mapleg.lines')}),
    line(cssVar('--t3'),t('mapleg.member')),
    line(cssVar('--read'),t('mapleg.reads')), line(cssVar('--write'),t('mapleg.writes')), line(cssVar('--join'),t('mapleg.join')),
    // The GRADE in this row is the engine's word and is interpolated, never
    // translated: a translated grade would be a grade this page invented.
    line(cssVar('--write'),t('mapleg.dashed',{grade:'SOUND_SET'}), true,
      t('mapleg.dashed.title',{grade:'SOUND_SET'})),
    // The connected-projects key, drawn only where this picture has one: a
    // colour with nothing wearing it is decoration.
    ...((GMAP.fedProjects||[]).length ? [
      el('b',{style:'margin-left:8px',textContent:t('mapleg.connected')}),
      el('span',{title:t('mapleg.fedring.title')},[kindDot('project',11), t('mapleg.project')]),
      ...GMAP.fedProjects.map((p)=> el('span',{title:t('mapleg.fedring.title')},[
        el('span',{className:'fedring',style:'border-color:'+GMAP.fedColor(p)}), ' '+p])),
    ] : []));
}
// The Graph tab's own Escape, UNCHANGED, called by the page's one Escape rule
// while that tab is the one on screen — so it cannot reach past a picture the
// user is not looking at.
function graphEscape(){
  if(!byId('gsug').classList.contains('hidden')){ closeSug(GRAPHV); return; }
  if(GRAPHV.mode!=='map'){ aroundClear(); return; }
  // Escape means "back to rest": the spotlight goes, and so does every group
  // the reader opened.
  if(mapFoldAll()){ GMAP.sel=null; GMAP.hover=null; mapRebuild(); refreshShowAll(); return; }
  mapClear();
  refreshShowAll();
}
// THE GRAPH PANE HAS ITS OWN RESIZE LISTENER, ahead of the shared one below,
// because its height is MEASURED rather than declared and everything else in
// that handler reads the size it produces. It runs twice: once when the resize
// stops, and once more a moment later, because the window manager can deliver
// the last `resize` event before the browser has settled on its final
// innerHeight and before the masthead has re-wrapped at the new width. The
// second pass is a style write and two measurements, and it is idempotent: when
// nothing moved it writes back the height that is already there.
let graphPaneTimer=null, graphPaneConfirm=null;
function graphPaneOnResize(){
  clearTimeout(graphPaneTimer);
  graphPaneTimer=setTimeout(()=>{
    graphPaneTimer=null;
    if(byId('tab-graph').classList.contains('hidden')) return;
    graphPaneApply();
    clearTimeout(graphPaneConfirm);
    graphPaneConfirm=setTimeout(()=>{
      graphPaneConfirm=null;
      if(!byId('tab-graph').classList.contains('hidden')) graphPaneApply();
    }, 220);
  }, 100);
}
