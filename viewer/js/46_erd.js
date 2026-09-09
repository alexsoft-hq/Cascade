// 46_erd.js — the ERD tab: one whole-schema picture, click to spotlight.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// ---------- ERD tab — one whole-schema graph; click to spotlight (Obsidian-style) ----------
let erdData=null, erdSelectFn=null, erdClearFn=null, erdResetFn=null;
function openErd(table){
  activateTab('erd'); // auto-loads on first open
  document.getElementById('etable').value = table||'';
  if(erdData){ table? (erdSelectFn&&erdSelectFn(table)) : (erdClearFn&&erdClearFn()); } // already loaded → just select
}
async function drawErd(){
  document.getElementById('ehonesty').replaceChildren(el('div',{className:'honesty',textContent:t('load.erd')}));
  let r; try { r = await api('erd', {}); }
  catch(e){ if(stale(e)) return;
    document.getElementById('ehonesty').replaceChildren(el('div',{className:'honesty',textContent:t('err.generic',{message:e.message})})); return; }
  erdData=r.answer;
  renderErdGraph(r.answer);
  renderErdSideOverview();
  document.getElementById('ehonesty').replaceChildren(honesty(r, 'erd'));
  const q=document.getElementById('etable').value.trim();
  if(q && erdSelectFn) erdSelectFn(q);
}
function erdDegrees(a){ const d=new Map(); a.tables.forEach(t=>d.set(t.table,0)); a.relationships.forEach(r=>{ d.set(r.from,(d.get(r.from)||0)+1); d.set(r.to,(d.get(r.to)||0)+1); }); return d; }
// A name prefix is a NAMING CONVENTION, not a fact the engine found — so it no
// longer gets a colour of its own. It groups the legend and nothing else; every
// table on the sheet is one ink rectangle, and the picture says what it knows.
// A witnessed join, its crow's foot and its cardinality label all carry the ONE
// hue this picture has -- `--join` -- and a table is drawn in `--k-table`.
const erdLine=()=> cssVar('--join');
const erdInk=()=> cssVar('--k-table');
// The SAME rule the map uses, on the ERD's own scale: a table's radius is the
// square root of how many relationships touch it, clamped so a one-join table
// is still a rectangle you can hit and a hub does not swallow its neighbours.
const ERD_R_MIN=4, ERD_R_MAX=20;
const erdRadius=(deg)=> Math.max(ERD_R_MIN, Math.min(ERD_R_MAX, 3.2+Math.sqrt(Math.max(0, deg||0))*3.6));
// Labels follow size here too, so the hubs read first.
const ERD_LABEL_MIN=10, ERD_LABEL_MAX=14.5;
const erdLabelSize=(r)=> ERD_LABEL_MIN
  + (ERD_LABEL_MAX-ERD_LABEL_MIN)*Math.max(0, Math.min(1, (r-ERD_R_MIN)/(ERD_R_MAX-ERD_R_MIN)));
// A name prefix is a NAMING CONVENTION, not a boundary the engine found, so it
// may never carry a hue that reads as a fact. In the SIGNAL theme it earns a
// TINT instead: the kind palette, pulled most of the way towards the sheet, so
// the five biggest families separate at a glance without any of them shouting.
// The legend row already lists the prefixes with their counts, so the colour
// has a key. The drawing theme stays ink - it is a drawing, and a draughtsman
// does not colour a plan by filename.
const ERD_FAMILY_TINTS=5;
const ERD_TINT_MIX=0.55;     // how far towards the sheet each hue is pulled
function mixHex(a, b, t){
  const pa=/^#([0-9a-f]{6})$/i.exec(String(a||'').trim());
  const pb=/^#([0-9a-f]{6})$/i.exec(String(b||'').trim());
  if(!pa || !pb) return a;
  const na=parseInt(pa[1],16), nb=parseInt(pb[1],16);
  const mix=(sh)=> Math.round(((na>>sh)&255)*(1-t) + ((nb>>sh)&255)*t);
  const hex=(v)=> v.toString(16).padStart(2,'0');
  return '#'+hex(mix(16))+hex(mix(8))+hex(mix(0));
}
const erdTints=()=> themeGlows()
  ? ['--k-table','--k-endpoint','--k-group','--k-statement','--k-column']
      .map((k)=> mixHex(cssVar(k), cssVar('--t2'), ERD_TINT_MIX))
  : [];
/**
 * Which colour each family is drawn in. In the drawing theme every table is one
 * ink, and this returns it whatever the prefix; in the signal theme the five
 * largest named families take a tint each and everything else stays ink.
 * @returns {(name:string)=>string}
 */
function erdFamilyColor(fams){
  const tints=erdTints();
  if(!tints.length) return ()=> erdInk();
  const named=(fams||[]).filter((f)=>f.family!==null).slice(0, ERD_FAMILY_TINTS).map((f)=>f.family);
  const byFamily=familyPalette(named, tints);
  return (name)=> byFamily.get(nameFamily(name)) || erdInk();
}
// How loud a relationship line is: quiet at rest, full inside a spotlight, and
// ERD_DIM for everything the spotlight left out (nodes and lines alike).
const ERD_REST_ALPHA=0.35, ERD_DIM=0.15;
const ERD_GAP=16;            // clear air the layout leaves between two table discs
// The layout is a FUNCTION of the pack, so it takes a seed — and always the same
// one. The same schema must draw the same picture on every load: a reader who
// learned where the order tables sit should not have to find them again.
const ERD_SEED=20260904;
// Zoomed in this far, the picture shows its detail. The crow's feet are always
// drawn (they are the shape of the relationship); the cardinality labels wait
// until there is room to read them, or until something is spotlighted.
const ERD_DETAIL_K=1.05;
// Up to this many drawn tables, EVERY one is named at rest: a drawing of thirty
// anonymous rectangles answers nothing, and the placer below already drops a
// name that would land on another. Past it the picture keeps the hub-only level
// of detail — and the stats line above the canvas says so, rather than letting
// the reader think the unnamed tables have no names.
const ERD_LABEL_ALL_MAX=60;

// ---- the connected projects on the ERD (RM45) -------------------------------
// A sibling's tables are ITS tables: they are namespaced here for the same
// reason the map namespaces its nodes, so two services that both have an
// `orders` table are two rectangles and never one.
const erdFedId=(project, table)=> project+'|'+table;
const erdViaId=(project, route)=> 'via:'+project+'|'+route;
// The reader's own switch, remembered. The DEFAULT depends on the answer: a
// project with no table of its own would otherwise open on an empty sheet, so
// there the connected projects start ON; a project with a schema of its own
// opens on that schema, because that is what the reader asked to see.
const ERD_FED_KEY='cascade.viewer.erdconnected';
function erdFedOn(a){
  if(!((a && a.federated) || []).length) return false;
  const v=lsGet(ERD_FED_KEY);
  if(v==='on' || v==='off') return v==='on';
  return (a.tables||[]).length===0;
}
function erdFedToggle(){
  const a=ERD.answer; if(!a) return;
  lsSet(ERD_FED_KEY, erdFedOn(a) ? 'off' : 'on');
  renderErdGraph(a);
  renderErdSideOverview();
}
/** One entry per connected project the reader has switched on. */
function erdClusters(a){
  if(!erdFedOn(a)) return [];
  return (a.federated||[]).map((f)=>({
    project:f.project, buildDigest:f.buildDigest||null,
    tables:f.tables||[], relationships:f.relationships||[], via:f.via||[],
    color:null, box:null,
  }));
}
/** A cluster's rectangles and its route markers. */
function erdClusterNodes(c){
  const deg=new Map((c.tables||[]).map((x)=>[x.table,0]));
  for(const r of c.relationships){ deg.set(r.from,(deg.get(r.from)||0)+1); deg.set(r.to,(deg.get(r.to)||0)+1); }
  for(const v of c.via) for(const tb of (v.tables||[])) deg.set(tb,(deg.get(tb)||0)+1);
  const out=[];
  for(const x of c.tables){
    const d=deg.get(x.table)||0, r=erdRadius(d);
    out.push({ id:erdFedId(c.project, x.table), label:x.table, comment:x.comment, cols:x.columnCount,
      deg:d, rank:d, r, val:r*r, color:c.color, project:c.project, table:x.table, comp:0, x:0, y:0,
      fontSize:erdLabelSize(r), fontWeight:d>=3?500:400,
      tip:x.table+'  ['+c.project+']'+(x.comment?'  '+x.comment:'')+'  ['+x.columnCount+' cols\u00a0\u00a0'+d+' rel]' });
  }
  for(const v of c.via){
    const route=v.route.method+' '+v.route.path;
    const r=ERD_R_MIN+1;
    out.push({ id:erdViaId(c.project, route), label:route, comment:null, cols:0,
      deg:(v.tables||[]).length, rank:0, r, val:r*r, color:c.color, project:c.project,
      marker:true, route, grade:v.grade, fromEndpoint:v.fromEndpoint, ambiguous:v.ambiguous===true,
      comp:0, x:0, y:0, fontSize:ERD_LABEL_MIN, fontWeight:500,
      tip:route+'  ['+c.project+']  '+t('erd.via.tip',{grade:v.grade}) });
  }
  return out;
}
/** A cluster's own joins, and the dashed connectors that are the HTTP call. */
function erdClusterLinks(c, topWitness){
  const out=[];
  for(const r of c.relationships){
    const sid=erdFedId(c.project, r.from), tid=erdFedId(c.project, r.to);
    out.push({ sid, tid, source:sid, target:tid, project:c.project,
      cardinality:r.cardinality||'?:?', columns:r.columns||[], statements:r.statements,
      w:witnessWidth(r.statements||1, topWitness, 1, 3),
      tip:r.from+' '+(r.cardinality||'?:?')+' '+r.to+'  ['+(r.columns||[]).join(', ')+']  ('+r.statements+' stmt)  ['+c.project+']' });
  }
  for(const v of c.via){
    const route=v.route.method+' '+v.route.path;
    for(const tb of (v.tables||[])){
      const sid=erdViaId(c.project, route), tid=erdFedId(c.project, tb);
      out.push({ sid, tid, source:sid, target:tid, project:c.project, via:true, label:route,
        grade:v.grade, cardinality:null, columns:[], statements:0, w:1.2,
        tip:route+' \u2192 '+tb+'  ['+c.project+']  '+t('erd.via.tip',{grade:v.grade}) });
    }
  }
  return out;
}

function renderErdGraph(a){
  const wrap=byId('erdwrap');
  const W=wrap.clientWidth||900, H=wrap.clientHeight||620;
  ERD.answer=a; ERD.W=W; ERD.H=H;
  const deg=erdDegrees(a);
  // Grouping by the name prefix before the first underscore. It is a naming
  // convention, not a boundary the engine found, and the legend says so.
  const fams=familyCounts(a.tables.map(t=>t.table));
  // The prefix groups the legend, and - in the signal theme only - tints the
  // rectangles that share it. `famColor` is the ONE place that decides, so the
  // legend, the nodes and the isolated strip can never disagree.
  const famColor=erdFamilyColor(fams);
  ERD.famColor=famColor;
  // A table no witnessed join touches cannot be laid out by joins: it goes to
  // the strip under the canvas rather than being dropped on the floor.
  const joined=a.tables.filter(t=>(deg.get(t.table)||0)>0);
  const isolated=a.tables.filter(t=>!(deg.get(t.table)||0));
  // THE CONNECTED PROJECTS, decided once here so the nodes, the lines, the
  // frames and the legend all read the same list.
  const clusters=erdClusters(a);
  ERD.clusters=clusters;
  ERD.fedColor=fedRingColor(clusters.map((c)=>c.project));
  for(const c of clusters) c.color=ERD.fedColor(c.project);

  ERD.nodes=joined.map(t=>{ const d=deg.get(t.table)||0, r=erdRadius(d);
    return { id:t.table, label:t.table, comment:t.comment, cols:t.columnCount, deg:d, rank:d,
      r, val:r*r, color:famColor(t.table), comp:0, x:0, y:0,
      fontSize:erdLabelSize(r), fontWeight:d>=3?500:400,
      tip:t.table+(t.comment?' — '+t.comment:'')+'  ['+t.columnCount+' cols\u00a0\u00a0'+d+' rel]' }; });
  for(const c of clusters) ERD.nodes.push(...erdClusterNodes(c));
  ERD.byId=new Map(ERD.nodes.map(n=>[n.id,n]));
  // How many statements witness a join is evidence, and the line says so: one
  // statement draws the thinnest line, the best-witnessed join the thickest.
  // Counted over EVERY cluster, so one scale reads across the whole sheet.
  const topWitness=[a.relationships, ...clusters.map((c)=>c.relationships)]
    .reduce((m,rs)=> rs.reduce((k,r)=>Math.max(k, r.statements||1), m), 1);
  const rawLinks=a.relationships
    .filter(r=>ERD.byId.has(r.from) && ERD.byId.has(r.to))
    .map((r)=>({ sid:r.from, tid:r.to, source:r.from, target:r.to,
      cardinality:r.cardinality||'?:?', columns:r.columns||[], statements:r.statements,
      w:witnessWidth(r.statements||1, topWitness, 1, 3),
      tip:r.from+' '+(r.cardinality||'?:?')+' '+r.to+'  ['+(r.columns||[]).join(', ')+']  ('+r.statements+' stmt)' }));
  for(const c of clusters) {
    for(const l of erdClusterLinks(c, topWitness)) if(ERD.byId.has(l.sid) && ERD.byId.has(l.tid)) rawLinks.push(l);
  }
  ERD.links=rawLinks.map((l,i)=>({ ...l, i }));
  ERD.incident=new Map(ERD.nodes.map(n=>[n.id,[]]));
  for(const l of ERD.links){ ERD.incident.get(l.sid).push(l.i); ERD.incident.get(l.tid).push(l.i); }
  erdLayout();
  ERD.always=gfAlwaysLabel(ERD.nodes);
  ERD.labelAll = ERD.nodes.length<=ERD_LABEL_ALL_MAX;
  ERD.placed=null;
  ERD.sel=null; ERD.hover=null; ERD.lit=null; ERD.labels=new Map();
  ERD.fitDone=false; ERD.frames=0;
  erdStop();
  if(!gfHas2D()){
    byId('erdcanvas').append(el('div',{className:'gmapmsg',textContent:
      'viewer/vendor/force-graph.min.js did not load — this picture needs it. Serve this page with `cascade view` (it publishes /vendor), or check the browser console for the request that failed.'}));
  } else {
    mountErd(byId('erdcanvas'), W, H);
  }
  erdSelectFn=erdSelect; erdClearFn=erdClear; erdResetFn=erdReset;
  renderErdLegend(a, fams, joined.length, isolated.length, topWitness);
  // Kept so `applyChrome()` can redraw the strip in another language without
  // asking the server for the same answer again.
  ERD.iso=isolated;
  renderErdIsolated(isolated);
}
// Where every table goes. ONE pure call: the same pack in, the same picture out,
// on every load — and the renderer is handed the answer as fixed coordinates
// rather than a simulation to run under the reader.
// The air a cluster's frame leaves around its own tables, the deeper strip at
// its TOP that the project's name sits in, and the air between two regions on
// the sheet. The title is inside its frame, so the frame has to leave room for
// it: drawn above the frame it was the first thing the canvas edge cut off.
const ERD_CLUSTER_PAD=22, ERD_CLUSTER_TOP=32, ERD_REGION_GAP=34;
// Clear air inside the pane, on every side, that no frame may sit in.
const ERD_FIT_MARGIN=24;
// The smallest a table may be drawn once the fit has shrunk it. Under this it
// stops being a rectangle you can point at.
const ERD_R_MIN_FIT=2;
function erdLayout(){
  const clusters=ERD.clusters||[];
  if(!clusters.length){
    erdPlaceIn(ERD.nodes, ERD.links, {cx:0, cy:0, w:ERD.W, h:ERD.H});
    ERD.fitBox=null;
    return;
  }
  // EVERY CLUSTER IS INSIDE THE PANE, exactly as this project's own tables are.
  // Each region is settled ON ITS OWN - two services share no foreign key, so
  // there is nothing between them for a layout to solve, and settling them
  // together would let the collision sweep shuffle two schemas into one cloud -
  // and then the regions are PACKED and the whole drawing is fitted to the pane
  // with its frames and its route markers inside the fit. Placing them at fixed
  // fractions of the pane instead put the second cluster off the bottom edge of
  // a 1190 by 650 pane and left the middle of the sheet empty.
  const own=ERD.nodes.filter((n)=>!n.project);
  const regions=[];
  if(own.length){
    erdPlaceIn(own, ERD.links.filter((l)=>!l.project), {cx:0, cy:0, w:ERD.W*0.55, h:ERD.H});
    regions.push({nodes:own, pad:0, top:0});
  }
  for(const c of clusters){
    const nodes=ERD.nodes.filter((n)=>n.project===c.project);
    const links=ERD.links.filter((l)=>l.project===c.project);
    // THE BOX A CLUSTER IS SETTLED IN FOLLOWS ITS OWN SIZE, not a share of the
    // pane: two tables spread across half a screen is mostly empty screen.
    const side=Math.max(160, Math.sqrt(Math.max(1, nodes.length))*110);
    erdPlaceIn(nodes, links, {cx:0, cy:0, w:side, h:side});
    regions.push({nodes, pad:ERD_CLUSTER_PAD, top:ERD_CLUSTER_TOP, cluster:c});
  }
  erdPackRegions(regions, ERD.W, ERD.H);
}
/**
 * Lay the settled regions out beside each other and fit the result to the pane.
 *
 * Rows when the pane is wider than it is tall, columns when it is not, wrapping
 * when a line is full: the same shelf the component packer uses, on regions
 * rather than components.
 */
function erdPackRegions(regions, W, H){
  const boxes=[];
  for(const r of regions){
    const b=erdBoxOf(r.nodes, r.pad, r.top);
    if(b) boxes.push({ nodes:r.nodes, b, w:b.x2-b.x1, h:b.y2-b.y1 });
  }
  if(!boxes.length){
    ERD.fitBox={x1:-W/2, y1:-H/2, x2:W/2, y2:H/2}; ERD.fitMargin=ERD_FIT_MARGIN; ERD.fitScale=1;
    return;
  }
  const across = W>=H;
  const limit = across ? W : H;
  let along=0, line=0, thickest=0;
  for(const x of boxes){
    const size = across ? x.w : x.h;
    if(along>0 && along+ERD_REGION_GAP+size>limit){ line += thickest+ERD_REGION_GAP; along=0; thickest=0; }
    const tx = across ? along : line;
    const ty = across ? line : along;
    const dx = tx-x.b.x1, dy = ty-x.b.y1;
    for(const n of x.nodes) gfPin(n, n.x+dx, n.y+dy);
    along += size+ERD_REGION_GAP;
    thickest = Math.max(thickest, across ? x.h : x.w);
  }
  erdFitAll(regions, W, H);
  // The frames are measured LAST, off the placed and fitted nodes, so what the
  // canvas draws is what the fit was computed against.
  for(const r of regions) if(r.cluster) r.cluster.box=erdBoxOf(r.nodes, r.pad, r.top);
}
/**
 * THE WHOLE DRAWING, CENTRED ON THE PANE AND SHRUNK ONLY IF IT HAS TO BE.
 *
 * FIT, NEVER MAGNIFY. A drawing smaller than the pane is centred at 1:1 and
 * left at the size it was laid out to be read at. Blown up to fill the pane
 * instead, two tiny clusters put their frames on both pane edges at once and
 * pushed each cluster's own name off the canvas.
 *
 * The pads are drawn in graph units and do not scale with the content, so they
 * are taken OFF the budget rather than scaled with it: that is what keeps a
 * frame inside the margin however far the content had to shrink. Where it does
 * shrink, the radii shrink with the distances, so the gaps the collision sweep
 * opened stay open and "a bigger table has more relationships" still reads.
 */
function erdFitAll(regions, W, H){
  const M=ERD_FIT_MARGIN;
  ERD.fitBox={x1:-W/2, y1:-H/2, x2:W/2, y2:H/2};
  ERD.fitMargin=M;
  ERD.fitScale=1;
  let x1=Infinity, y1=Infinity, x2=-Infinity, y2=-Infinity;
  let padX=0, padTop=0, padBottom=0;
  for(const r of regions){
    for(const n of r.nodes){
      x1=Math.min(x1, n.x-n.r); y1=Math.min(y1, n.y-n.r);
      x2=Math.max(x2, n.x+n.r); y2=Math.max(y2, n.y+n.r);
    }
    padX=Math.max(padX, r.pad||0);
    padTop=Math.max(padTop, r.top||0);
    padBottom=Math.max(padBottom, r.pad||0);
  }
  if(!Number.isFinite(x1)) return;
  // A node that shrinks past ERD_R_MIN_FIT keeps that much of itself, so the
  // budget leaves room for it: without the reserve a heavily shrunk cluster
  // overflowed the margin by exactly the floored radius.
  const roomW=Math.max(1, W-2*M-2*padX-2*ERD_R_MIN_FIT);
  const roomH=Math.max(1, H-2*M-padTop-padBottom-2*ERD_R_MIN_FIT);
  const s=Math.min(1, roomW/Math.max(1, x2-x1), roomH/Math.max(1, y2-y1));
  const cx=(x1+x2)/2, cy=(y1+y2)/2;
  // The title strip sits at the TOP of a frame only, so centring the content
  // would leave the FRAME low by half of it.
  const shift=(padTop-padBottom)/2;
  for(const r of regions) for(const n of r.nodes){
    gfPin(n, (n.x-cx)*s, (n.y-cy)*s+shift);
    if(s<1){ n.r=Math.max(ERD_R_MIN_FIT, n.r*s); n.val=n.r*n.r; }
  }
  ERD.fitScale=s;
}
/** Settle these nodes on their own and centre the result on the box. */
function erdPlaceIn(nodes, links, box){
  if(!nodes.length) return;
  const lay=settleComponents(
    nodes.map(n=>({id:n.id, r:n.r})),
    links.map(l=>({from:l.sid, to:l.tid})),
    {width:box.w, height:box.h, gap:ERD_GAP, seed:ERD_SEED});
  const at=new Map(lay.nodes.map(p=>[p.id,p]));
  let x1=Infinity, y1=Infinity, x2=-Infinity, y2=-Infinity;
  for(const n of nodes){ const p=at.get(n.id); if(!p) continue;
    x1=Math.min(x1,p.x-n.r); y1=Math.min(y1,p.y-n.r);
    x2=Math.max(x2,p.x+n.r); y2=Math.max(y2,p.y+n.r); }
  if(!Number.isFinite(x1)) return;
  const dx=box.cx-(x1+x2)/2, dy=box.cy-(y1+y2)/2;
  for(const n of nodes){ const p=at.get(n.id); if(p){ n.comp=p.comp; gfPin(n, p.x+dx, p.y+dy); } }
}
/**
 * The rectangle a set of settled nodes occupies, with `pad` of air around it
 * and `top` of air above it (the strip a cluster's own name is written in).
 */
function erdBoxOf(nodes, pad, top){
  const p=pad||0, tp=(top==null ? p : top);
  let x1=Infinity, y1=Infinity, x2=-Infinity, y2=-Infinity;
  for(const n of nodes){
    x1=Math.min(x1,n.x-n.r); y1=Math.min(y1,n.y-n.r);
    x2=Math.max(x2,n.x+n.r); y2=Math.max(y2,n.y+n.r);
  }
  if(!Number.isFinite(x1)) return null;
  return {x1:x1-p, y1:y1-tp, x2:x2+p, y2:y2+p};
}
function mountErd(host, w, h){
  const g=gfMount(host, w, h);
  g.nodeCanvasObject(erdDrawNode).nodeCanvasObjectMode(()=>'replace')
    .linkCanvasObject(erdDrawLink).linkCanvasObjectMode(()=>'replace')
    .onRenderFramePre(erdFramePre)
    .onNodeHover(erdHover).onNodeClick(erdClick).onBackgroundClick(()=>erdClear())
    .onLinkHover((l)=>gtip.show(l?l.tip:null))
    // A dragged node keeps its fx/fy, so it simply stays where it was dropped —
    // there is no simulation to pull it back, and none to fight.
    .onNodeDragEnd((n)=>{ gfPin(n, n.x, n.y); erdRepaint(); })
    .onEngineStop(()=>{ if(ERD.fitDone || ERD.api!==g) return; ERD.fitDone=true;
      try{ erdFitView(g); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ } })
    .graphData({nodes:ERD.nodes, links:ERD.links});
  if(!host.__tipbound){ host.__tipbound=true; gtip.follow(host, ()=>erdHover(null)); }
  ERD.api=g;
  return g;
}
function erdStop(){
  if(ERD.api){
    try{ ERD.api.pauseAnimation(); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
    try{ ERD.api._destructor(); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
  }
  ERD.api=null;
  const h=byId('erdcanvas'); if(h) h.replaceChildren();
  gtip.hide();
}
/**
 * FIT THE VIEW, AND NEVER MAGNIFY PAST 1:1 WHERE A CONNECTED PROJECT IS DRAWN.
 *
 * `zoomToFit` scales a SMALL drawing up until it fills the pane. On a project
 * whose whole sheet is two clusters of one table that put both frames on the
 * pane's own edges and drove each cluster's name off the canvas. The federated
 * layout is already fitted to the pane in graph units (erdFitAll), so there is
 * nothing left for a magnification to add.
 *
 * A pack drawing its OWN schema keeps the old behaviour exactly: a six-table
 * schema is meant to fill the sheet, and that picture is unchanged.
 */
function erdFitView(g){
  g.zoomToFit(0, 40);
  if(!(ERD.clusters||[]).length) return;
  const k = typeof g.zoom==='function' ? g.zoom() : null;
  if(typeof k==='number' && k>1) g.zoom(1, 0);
}
const erdRepaint=()=> gfRepaint(ERD.api, erdDrawNode);
// The spotlight: a table, the joins that touch it, and the tables on their far
// ends. Everything else is DIMMED, never removed.
function erdSetLit(id){
  if(!id || !ERD.byId.has(id)){ ERD.lit=null; return; }
  const nodes=new Set([id]), links=new Set();
  for(const i of (ERD.incident.get(id)||[])){ links.add(i); nodes.add(ERD.links[i].sid); nodes.add(ERD.links[i].tid); }
  ERD.lit={id, nodes, links};
}
function erdSelect(id){
  if(!ERD.byId.has(id)) return;
  ERD.sel=id; ERD.hover=null; erdSetLit(id); erdRepaint(); renderErdSideTable(id);
  pickSet('erd', 'table:'+id);
}
function erdClear(){
  ERD.sel=null; ERD.hover=null; erdSetLit(null); erdRepaint();
  if(erdData) renderErdSideOverview();
  refreshShowAll();
}
function erdHover(n){
  const id=n?n.id:null;
  if(ERD.hover===id) return;
  ERD.hover=id; gtip.show(n?n.tip:null);
  // Hover PREVIEWS the neighbourhood; a click sticks it. On the way out the
  // picture goes back to whatever is selected, not to nothing.
  erdSetLit(id || ERD.sel); erdRepaint();
}
function erdClick(n){
  if(!n){ erdClear(); return; }
  if(ERD.sel===n.id) erdClear(); else erdSelect(n.id);
}
// Reset view: lay the schema out again from the top and refit. The layout is
// deterministic, so this really does undo every drag — the picture that comes
// back is the one the tab opened on.
function erdReset(){
  if(!ERD.api) return;
  erdLayout();
  erdRepaint();
  try{ ERD.api.zoomToFit(400, 40); }catch(e){ /* the renderer is gone or not mounted yet: there is nothing to undo */ }
}
// The whole-frame decisions, once per frame, before anything is drawn: how much
// detail this zoom carries, and which names fit without landing on each other.
function erdFramePre(ctx, k){
  ERD.frames++;
  ERD.frame={labels:0, glyphs:0, cards:0};
  ERD.detail = k>=ERD_DETAIL_K || !!ERD.lit;
  erdDrawClusterFrames(ctx, k);
  ERD.labels=gfPlaceLabels(ctx, k, ERD.nodes,
    // A ROUTE MARKER IS ALWAYS NAMED. It is the only thing on the sheet that
    // says HOW the cluster beside it was reached, and an unnamed one is a dot
    // with three dashed lines coming out of it.
    (n)=> ERD.lit ? ERD.lit.nodes.has(n.id) : (n.marker || ERD.labelAll || ERD.always.has(n.id) || n.r*k>12),
    (n)=> (ERD.lit && n.id===ERD.lit.id) ? 1e12 : (n.marker ? 1e9 : n.rank));
  erdCountPlaced();
}
// THE FRAME AROUND A CONNECTED PROJECT. Drawn UNDER everything (this runs
// before the links and the nodes), in that project's own hue, with its name at
// the top left. The frame is what says "these tables are not ours": without it
// two schemas on one sheet read as one schema in two clouds.
function erdDrawClusterFrames(ctx, k){
  for(const c of (ERD.clusters||[])){
    const b=c.box; if(!b) continue;
    ctx.save();
    ctx.globalAlpha = ERD.lit ? ERD_DIM : 0.55;
    ctx.strokeStyle=c.color; ctx.lineWidth=1.2/k;
    ctx.setLineDash([6/k, 4/k]);
    ctx.strokeRect(b.x1, b.y1, b.x2-b.x1, b.y2-b.y1);
    ctx.setLineDash([]);
    ctx.globalAlpha = ERD.lit ? ERD_DIM : 1;
    // THE NAME IS INSIDE ITS OWN FRAME, in the strip the box reserves for it.
    // Drawn above the frame it was the first thing the canvas edge cut off, and
    // `customers-service` read as `mers-service`.
    ctx.font=gfFont(11/k, 600);
    ctx.textAlign='left'; ctx.textBaseline='top'; ctx.fillStyle=c.color;
    ctx.fillText(c.project, b.x1+7/k, b.y1+6/k);
    ctx.restore();
  }
}
// How many of the names this mode PROMISES actually landed, counted off the map
// the placer just returned. Only at REST: a spotlight asks for a different set
// of names entirely, and the stats line describes the picture the reader sees
// before they touch it. Each mode counts against its own promise — every drawn
// table below the cap, the hub set above it — so the number can never exceed
// the one beside it, whatever a deep zoom adds.
function erdCountPlaced(){
  if(ERD.lit) return;
  const wanted = ERD.labelAll ? ERD.nodes.length : ERD.always.size;
  const placed = ERD.labelAll ? ERD.labels.size
    : [...ERD.always].filter((id)=>ERD.labels.has(id)).length;
  const p=ERD.placed;
  if(p && p.wanted===wanted && p.placed===placed) return;
  ERD.placed={wanted, placed};
  // The line is beside the canvas, not on it: writing it here costs one DOM
  // update on the frames where the count really moved, and none after it settles.
  redrawErdLegend();
}
// The stats line again, from the answer and the census already in memory —
// nothing is re-asked. Both callers (a frame whose count moved, a language
// switch) want exactly this.
function redrawErdLegend(){
  if(!ERD.legend) return;
  const g=ERD.legend;
  renderErdLegend(g.a, g.fams, g.drawn, g.isolated, g.topWitness);
}
// A table is a RECTANGLE — the same glyph the map and the hop rings use for one
// — in ink on the drafting grid, filled when it is spotlighted.
function erdDrawNode(n, ctx, k){
  const on = !ERD.lit || ERD.lit.nodes.has(n.id);
  const sel = ERD.sel===n.id;
  const ink = n.color || erdInk();
  ctx.save();
  ctx.globalAlpha = on ? 1 : ERD_DIM;
  ctx.beginPath(); ctx.arc(n.x, n.y, n.r+1.4/k, 0, 2*Math.PI);
  ctx.fillStyle=cssVar('--g1'); ctx.fill();
  const lit = sel || !!(ERD.lit && ERD.lit.id===n.id);
  // A ROUTE MARKER IS NOT A TABLE. It is the HTTP call the cluster was reached
  // through, so it wears the endpoint's own glyph, the one every other picture
  // on this page draws a route with.
  gfGlyph(ctx, n.marker ? 'endpoint' : 'table', n.x, n.y, n.r, k, { color:ink, filled:lit || !!n.marker, glow:lit });
  if(sel){
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r+5, 0, 2*Math.PI);
    ctx.strokeStyle=ink; ctx.lineWidth=2/k; ctx.stroke();
  }
  const at=on ? ERD.labels.get(n.id) : null;
  if(at){ gfDrawLabel(ctx, at, n.label, n.fontWeight, cssVar('--t1')); ERD.frame.labels++; }
  ctx.restore();
}
// A relationship: the line, a crow's-foot glyph at each end, and — once there is
// room to read it — the cardinality at the middle.
function erdDrawLink(l, ctx, k){
  const s=l.source, t=l.target;
  if(!s || !t || !Number.isFinite(s.x) || !Number.isFinite(t.x)) return;
  const on = !ERD.lit || ERD.lit.links.has(l.i);
  // A `via` connector is NOT a relationship and must never be drawn as one: it
  // is an HTTP call, so it is DASHED, carries no crow's feet and no
  // cardinality, and is named by the route it is. The legend says as much in
  // words, because a dash on its own is not an explanation.
  if(l.via){
    ctx.save();
    ctx.globalAlpha = on ? (ERD.lit ? 1 : ERD_REST_ALPHA) : ERD_DIM;
    ctx.strokeStyle=ERD.fedColor(l.project) || erdLine(); ctx.lineWidth=l.w/k;
    ctx.setLineDash([5/k, 4/k]);
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }
  ctx.save();
  // Quiet at rest so the TABLES read first; full strength once a neighbourhood
  // is spotlit, and everything else at ERD_DIM - still there, no longer loud.
  ctx.globalAlpha = on ? (ERD.lit ? 1 : ERD_REST_ALPHA) : ERD_DIM;
  const dx=t.x-s.x, dy=t.y-s.y, d=Math.hypot(dx,dy)||1, ang=Math.atan2(dy,dx);
  ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y);
  ctx.strokeStyle=erdLine(); ctx.lineWidth=l.w/k; ctx.stroke();
  const p=String(l.cardinality).split(':');
  erdCrowGlyph(ctx, k, s.x+dx/d*(s.r+1), s.y+dy/d*(s.r+1), ang, p[0]);
  erdCrowGlyph(ctx, k, t.x-dx/d*(t.r+1), t.y-dy/d*(t.r+1), ang+Math.PI, p[1]);
  ERD.frame.glyphs+=2;
  if(ERD.detail){
    ctx.font=gfFont(9/k, 500);
    ctx.textAlign='center'; ctx.textBaseline='alphabetic'; ctx.fillStyle=erdLine();
    ctx.fillText(l.cardinality, (s.x+t.x)/2, (s.y+t.y)/2 - 2/k);
    ERD.frame.cards++;
  }
  ctx.restore();
}
// One end symbol, in local coordinates with +x pointing from the table OUTWARD
// along the edge: "N" is the foot (its prongs spread at the table), "1" a single
// bar, anything else an open circle — a cardinality the engine could not name.
// The 1/k scale makes one local unit one SCREEN pixel, so the glyph stays the
// same size at every zoom, the way the SVG one did inside its scaled viewport.
function erdCrowGlyph(ctx, k, x, y, ang, side){
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang); ctx.scale(1/k, 1/k);
  ctx.strokeStyle=erdLine();
  if(side==='N'){
    ctx.lineWidth=1.3; ctx.beginPath();
    for(const yy of [-6, 0, 6]){ ctx.moveTo(10, 0); ctx.lineTo(1, yy); }
    ctx.stroke();
  } else if(side==='1'){
    ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(6, -5); ctx.lineTo(6, 5); ctx.stroke();
  } else {
    ctx.lineWidth=1.2; ctx.beginPath(); ctx.arc(6, 0, 3, 0, 2*Math.PI);
    ctx.fillStyle=cssVar('--g1'); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
// What the picture is and what its colours mean, above the canvas: the counts
// first (how much of the schema is actually drawn), then the families.
function renderErdLegend(a, fams, drawn, isolated, topWitness){
  // Kept so a language switch can write this line again from the answer already
  // on screen — nothing here is re-asked.
  ERD.legend={a, fams, drawn, isolated, topWitness};
  const box=document.getElementById('erdleg');
  const say=(key,params)=> richNodes(t(key,params));
  const kids=[ el('span',{},[ ...say('erdleg.drawn',{n:drawn}), '\u00a0\u00a0',
    ...say('erdleg.rels',{n:a.relationships.length}), '\u00a0\u00a0',
    ...say('erdleg.nojoin',{n:isolated}) ]) ];
  // Which tables carry a name at rest — counted off what the placer DREW.
  // Below the cap every drawn table is asked for, so the line speaks up only
  // when some name would not fit; above it the picture keeps the hub-only level
  // of detail and says so, with the number that really landed. Either way a
  // reader must not read an unnamed rectangle as a table with nothing to say.
  const p=ERD.placed;
  if(!ERD.labelAll){
    kids.push(el('span',{textContent: (p && p.placed<p.wanted)
      ? t('erdleg.hublabels.some',{n:ERD.always.size, m:p.placed})
      : t('erdleg.hublabels',{n:ERD.always.size})}));
  } else if(p && p.placed<p.wanted){
    kids.push(el('span',{textContent:t('erdleg.somelabelled',{n:p.wanted, m:p.placed})}));
  }
  if(topWitness>1) kids.push(el('span',{title:t('erdleg.thickness.title'),
    textContent:t('erdleg.thickness',{n:topWitness})}));
  const named=fams.filter(f=>f.family!==null);
  if(named.length){
    kids.push(el('span',{title:t('erdleg.prefixes.title'), textContent:t('erdleg.prefixes')}));
    // In the signal theme the biggest families are TINTED on the sheet, so the
    // row that names them carries the swatch: a colour with no key is decoration.
    const famColor=ERD.famColor || (()=>erdInk());
    for(const f of fams){
      const col=f.family===null ? erdInk() : famColor(f.family+'_');
      kids.push(el('span',{},[
        col!==erdInk() ? el('span',{className:'erdswatch', style:'background:'+col}) : null,
        (f.family===null?t('erdleg.noprefix'):f.family)+' ',
        el('span',{className:'count',textContent:String(f.count)}) ].filter(Boolean)));
    }
  } else {
    kids.push(el('span',{textContent:t('erdleg.nogroups')}));
  }
  // THE CONNECTED PROJECTS. The switch is offered wherever the answer carries
  // one, whether it is on or off, because a reader who cannot see the clusters
  // must still be able to find out that there are some.
  const fedList=(a && a.federated) || [];
  if(fedList.length){
    const on=erdFedOn(a);
    const b=el('button',{className:'chip'+(on?'':' off'),
      title:t(on?'erdleg.connected.on.title':'erdleg.connected.off.title',{n:fedList.length}),
      onclick:()=>erdFedToggle()},
      [kindDot('project', 11), t(on?'erdleg.connected.on':'erdleg.connected.off',{n:fedList.length})]);
    b.setAttribute('aria-pressed', String(on));
    kids.push(b);
    if(on){
      for(const c of (ERD.clusters||[])) kids.push(el('span',{title:t('erdleg.connected.title',{p:c.project})},[
        el('span',{className:'fedring',style:'border-color:'+c.color}), ' '+c.project ]));
      kids.push(el('span',{title:t('erdleg.via.title'), textContent:t('erdleg.via')}));
    }
  }
  box.replaceChildren(...kids);
}
// The tables the join layout cannot place. Hiding them made the schema look
// smaller than it is; showing them says exactly what is and is not known.
function renderErdIsolated(iso){
  const box=document.getElementById('erdiso');
  if(!iso.length){ box.replaceChildren(); return; }
  box.replaceChildren(el('div',{className:'panel'},[
    el('h2',{},[t('erd.iso.title')+' ', el('span',{className:'count',textContent:t('erd.iso.count',{n:iso.length})})]),
    fold('erd.iso.body', [t('erd.iso.brief')],
      ()=> [el('div',{className:'comment',textContent:t('erd.iso.body')})]),
    el('div',{className:'isogrid'}, iso.map(t=>el('button',{className:'isochip',
      title:t.table+(t.comment?' — '+t.comment:'')+'  ['+t.columnCount+' cols]\u00a0\u00a0open in Explore',
      onclick:()=>{ activateTab('explore'); showTable(t.table); }},
      [ kindGlyph('table', 12), t.table ])))
  ]));
}
function hubPanel(a){
  const deg=erdDegrees(a);
  const ranked=[...deg.entries()].filter(e=>e[1]>0).sort((x,y)=>y[1]-x[1]||(x[0]<y[0]?-1:1)).slice(0,12);
  if(!ranked.length) return null;
  const max=ranked[0][1];
  return el('div',{className:'panel'},[ el('h2',{},[t('erd.side.hubs')+' ',el('span',{className:'count',textContent:t('erd.side.hubs.by')})]),
    el('ul',{className:'list'}, ranked.map(([t,d])=>el('li',{},[
      el('a',{className:'id clickable',textContent:t,onclick:()=>openErd(t)}),
      el('span',{style:'display:flex;align-items:center;gap:6px'},[
        el('span',{style:`display:inline-block;height:7px;border-radius:3px;width:${Math.round(46*d/max)}px;background:var(--k-table)`}),
        el('span',{className:'count',textContent:d}) ]) ]))) ]);
}
function renderErdSideOverview(){
  refreshShowAll();
  const a=erdData; const side=document.getElementById('erdside'); side.replaceChildren();
  const deg=erdDegrees(a);
  const iso=a.tables.filter(t=>!(deg.get(t.table)||0)).length;
  const fedList=(a.federated||[]);
  side.append(el('div',{className:'panel'},[el('h2',{textContent:t('erd.side.map')}),
    // The two counts are the GLANCE and they are the fold's own lead; what the
    // sizes and thicknesses mean is behind it.
    fold('erd.side.map.body', [t('erd.side.map.brief',{tables:a.tables.length, relationships:a.relationships.length})],
      ()=> [el('div',{className:'comment',textContent:t('erd.side.map.body')})]),
    iso? el('div',{className:'comment',style:'margin-top:6px',textContent:t('erd.side.map.isolated',{n:iso})}) : null,
    // A PROJECT WITH NO SCHEMA OF ITS OWN is not a project with nothing to
    // show: an api gateway holds no table, and its requests still end in two
    // other projects' tables. Saying "none" alone would be true of this pack
    // and useless to the reader.
    (a.tables.length===0 && fedList.length)
      ? el('div',{className:'comment',style:'margin-top:6px',
        textContent:t('erd.side.map.fedonly',{n:fedList.length, p:fedList.map((f)=>f.project).join(', ')})})
      : null ]));
  if(fedList.length) side.append(erdFedPanel(a, fedList));
  const hp=hubPanel(a); if(hp) side.append(hp);
}
/** One row per connected project: what it holds here, and the way in. */
function erdFedPanel(a, fedList){
  const on=erdFedOn(a);
  const color=fedRingColor(fedList.map((f)=>f.project));
  return el('div',{className:'panel'},[
    el('h2',{},[t('erd.side.connected')+' ', el('span',{className:'count',textContent:'('+fedList.length+')'})]),
    el('div',{className:'comment',textContent:t('erd.side.connected.note')}),
    el('ul',{className:'list'}, fedList.map((f)=>el('li',{},[
      el('span',{className:'grow'},[
        el('span',{className:'fedring',style:'border-color:'+color(f.project)}),
        // The whole id rides in the tooltip, because the name is the thing that
        // may be cut on a narrow rail.
        el('a',{className:'id clickable fedname',
          title:f.project+'  '+t('erd.side.connected.open',{p:f.project}),
          textContent:f.project, onclick:()=>switchProject(f.project, {tab:'erd'})}) ]),
      el('span',{className:'count fedcount',
        title:t('erd.side.connected.counts',{tables:f.tables.length, rels:f.relationships.length}),
        textContent:t('erd.side.connected.counts',{tables:f.tables.length, rels:f.relationships.length})}) ]))),
    on ? null : el('div',{className:'cpnote',textContent:t('erd.side.connected.hidden')}),
  ]);
}

async function renderErdSideTable(id){
  const a=erdData; const side=document.getElementById('erdside');
  // A ROUTE MARKER is not a table: its card is the crossing itself.
  const picked=ERD.byId.get(id);
  if(picked && picked.marker){ side.replaceChildren(erdViaCard(picked)); return; }
  // A table from a CONNECTED PROJECT is that project's own: its relationships
  // live in that cluster, and its columns have to be asked of the pack that
  // has them. Nothing here is asked of the project on screen.
  if(picked && picked.project){ await renderErdSideFedTable(picked); return; }
  const rels=a.relationships.filter(r=>r.from===id||r.to===id).map(r=>{ const out=r.from===id; return {other:out?r.to:r.from, card:out?r.cardinality:r.cardinality.split(':').reverse().join(':'), columns:r.columns, statements:r.statements}; }).sort((x,y)=>x.other<y.other?-1:1);
  const t0=a.tables.find(t=>t.table===id);
  const fam=nameFamily(id);
  const header=el('div',{className:'srchead',style:'margin-bottom:8px'},[
    el('span',{className:'grow'},[
      kindGlyph('table', 12),
      el('span',{className:'id',style:'font-weight:500',textContent:id}) ]),
    el('button',{textContent:t('erd.side.clear'),onclick:()=>erdClearFn&&erdClearFn()}) ]);
  const relPanel=el('div',{className:'panel'},[ header,
    el('div',{className:'comment',textContent:[ fam?('prefix '+fam):null, t0&&t0.comment?('“'+t0.comment+'”'):null,
      rels.length+' relationship(s)' ].filter(Boolean).join('\u00a0\u00a0')}),
    el('div',{style:'margin-top:7px;display:flex;gap:6px;flex-wrap:wrap'},[
      el('button',{className:'mini',textContent:'Table',title:t('btn.table.title'),
        onclick:()=>{ activateTab('explore'); showTable(id); }}),
      el('button',{className:'mini',textContent:'Impact',title:t('btn.impact.table.title'),onclick:()=>openImpact({table:id})}),
      el('button',{className:'mini',textContent:'Graph',onclick:()=>openGraph('table:'+id)}) ]),
    el('h2',{style:'margin-top:12px'},[t('erd.side.rels')+' ',el('span',{className:'count',textContent:t('erd.side.count',{n:rels.length})})]),
    el('ul',{className:'list'}, rels.length? rels.map(r=>el('li',{},[
      el('span',{className:'grow'},[
        kindGlyph('table', 12),
        el('a',{className:'id clickable',textContent:r.other,title:'spotlight '+r.other,onclick:()=>erdSelectFn&&erdSelectFn(r.other)}) ]),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        el('span',{className:'card',title:t('erd.card.title'),textContent:r.card}),
        el('span',{className:'count',title:r.statements+' statement(s) witness this join',textContent:r.statements+'×'}) ]) ]))
      : [el('li',{className:'empty',textContent:t('erd.side.rels.none')})]),
    // the join columns are the evidence: one line per relationship, under the list
    rels.length? el('div',{className:'comment',style:'margin-top:7px'},
      rels.map(r=>el('div',{},[ el('span',{className:'id',textContent:r.other}), '\u00a0\u00a0', r.columns.join(', ') ])) ) : null ]);
  const colPanel=el('div',{className:'panel'},[ el('h2',{textContent:t('erd.side.cols')}), el('div',{className:'comment',textContent:t('erd.side.cols.loading')}) ]);
  side.replaceChildren(relPanel, colPanel);
  // A second click while the first table's columns are still in flight must not
  // fill this panel with the wrong table's columns.
  const mine=++ERD.sideSeq;
  // The columns are CACHED per table. Re-drawing this panel — which a language
  // switch does — must not put a second request on the wire for an answer the
  // page already has (and the engine's own words in it do not change anyway).
  let cols=ERD.cols.get(id);
  if(!cols){
    try { const rr=await api('erd',{table:id}); const tb=rr.answer.tables.find(x=>x.table===id); cols=(tb&&tb.columns)||[]; } catch(e){ cols=[]; }
    if(mine!==ERD.sideSeq) return;
    ERD.cols.set(id, cols);
  }
  colPanel.replaceChildren(el('h2',{},[t('erd.side.cols')+' ',el('span',{className:'count',textContent:t('erd.side.count',{n:cols.length})})]),
    el('ul',{className:'list'+(cols.length>12?' colgrid2':'')}, cols.map(c=>el('li',{},[ el('span',{className:'id'},[ c.pk?el('span',{className:'pk',title:'primary key',textContent:'✦ '}):'', c.column ]), el('span',{className:'comment',textContent:(c.type||'')+(c.comment?'\u00a0\u00a0'+c.comment:'')}) ]))));
}

/**
 * THE CARD FOR ONE CROSSING: the route this project called, where it landed,
 * and what it reaches over there. It is the only thing on this sheet that
 * connects two clusters, and it is an HTTP call and not a key.
 */
function erdViaCard(n){
  const cluster=(ERD.clusters||[]).find((c)=>c.project===n.project);
  const entry=(cluster ? cluster.via : []).find((v)=> (v.route.method+' '+v.route.path)===n.route) || {tables:[]};
  return el('div',{className:'panel'},[
    el('div',{className:'srchead',style:'margin-bottom:8px'},[
      el('span',{className:'grow'},[ kindGlyph('endpoint', 12),
        el('span',{className:'id',style:'font-weight:500',textContent:n.route}) ]),
      el('button',{textContent:t('erd.side.clear'),onclick:()=>erdClearFn&&erdClearFn()}) ]),
    el('div',{className:'fsub'},[
      el('span',{className:'tag fproj',title:n.project+'  '+t('chain.tag.project.title'),textContent:n.project}),
      badge(n.grade),
      n.ambiguous ? el('span',{className:'tag warn',textContent:t('erd.via.ambiguous')}) : null ]),
    el('div',{className:'comment',style:'margin-top:7px',textContent:t('erd.via.body')}),
    entry.fromEndpoint ? el('div',{className:'comment',style:'margin-top:6px'},[
      el('span',{className:'id',textContent:String(entry.fromEndpoint).replace(/^endpoint:/,'')}) ]) : null,
    el('h2',{style:'margin-top:12px'},[t('erd.via.tables')+' ',
      el('span',{className:'count',textContent:t('erd.side.count',{n:(entry.tables||[]).length})})]),
    el('ul',{className:'list'}, (entry.tables||[]).map((tb)=>el('li',{},[
      el('span',{className:'grow'},[ kindGlyph('table', 12),
        el('a',{className:'id clickable',textContent:tb,
          onclick:()=>erdSelectFn&&erdSelectFn(erdFedId(n.project, tb))}) ]) ]))),
    el('div',{style:'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap'},[
      el('button',{className:'mini',textContent:t('map.card.open',{p:n.project}),
        title:t('map.card.open.title',{p:n.project}),
        onclick:()=>{ location.hash = hashFor({ project:n.project, tab:'flow', pick:'endpoint:'+n.route }); }}) ]),
  ]);
}

/**
 * A TABLE IN ANOTHER PROJECT. Its relationships are the ones inside that
 * project's cluster, never a line to anything here; its columns come from that
 * project's own `erd` answer, asked of that project.
 */
async function renderErdSideFedTable(n){
  const side=document.getElementById('erdside');
  const cluster=(ERD.clusters||[]).find((c)=>c.project===n.project) || {relationships:[], via:[]};
  const rels=cluster.relationships.filter((r)=>r.from===n.table||r.to===n.table).map((r)=>{
    const out=r.from===n.table;
    return { other:out?r.to:r.from, card:out?r.cardinality:String(r.cardinality).split(':').reverse().join(':'),
      columns:r.columns, statements:r.statements };
  }).sort((x,y)=>x.other<y.other?-1:1);
  const routes=cluster.via.filter((v)=>(v.tables||[]).includes(n.table));
  const relPanel=el('div',{className:'panel'},[
    el('div',{className:'srchead',style:'margin-bottom:8px'},[
      el('span',{className:'grow'},[ kindGlyph('table', 12),
        el('span',{className:'id',style:'font-weight:500',textContent:n.table}) ]),
      el('button',{textContent:t('erd.side.clear'),onclick:()=>erdClearFn&&erdClearFn()}) ]),
    el('div',{className:'fsub'},[
      el('span',{className:'tag fproj',title:n.project+'  '+t('chain.tag.project.title'),textContent:n.project}) ]),
    el('div',{className:'comment',style:'margin-top:7px',textContent:t('erd.side.fed.body',{p:n.project})}),
    n.comment ? el('div',{className:'comment',textContent:'\u201c'+n.comment+'\u201d'}) : null,
    el('div',{style:'margin-top:7px;display:flex;gap:6px;flex-wrap:wrap'},[
      el('button',{className:'mini',textContent:t('map.card.open',{p:n.project}),
        title:t('map.card.open.title',{p:n.project}),
        onclick:()=>{ location.hash = hashFor({ project:n.project, tab:'erd', pick:'table:'+n.table }); }}) ]),
    el('h2',{style:'margin-top:12px'},[t('erd.side.rels')+' ',
      el('span',{className:'count',textContent:t('erd.side.count',{n:rels.length})})]),
    el('ul',{className:'list'}, rels.length? rels.map((r)=>el('li',{},[
      el('span',{className:'grow'},[ kindGlyph('table', 12),
        el('a',{className:'id clickable',textContent:r.other,
          onclick:()=>erdSelectFn&&erdSelectFn(erdFedId(n.project, r.other))}) ]),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        el('span',{className:'card',title:t('erd.card.title'),textContent:r.card}),
        el('span',{className:'count',textContent:r.statements+'\u00d7'}) ]) ]))
      : [el('li',{className:'empty',textContent:t('erd.side.fed.norels')})]),
    el('h2',{style:'margin-top:12px'},[t('erd.via.reached')+' ',
      el('span',{className:'count',textContent:t('erd.side.count',{n:routes.length})})]),
    el('ul',{className:'list'}, routes.map((v)=>el('li',{},[
      el('span',{className:'grow'},[ kindGlyph('endpoint', 12),
        el('a',{className:'id clickable',textContent:v.route.method+' '+v.route.path,
          onclick:()=>erdSelectFn&&erdSelectFn(erdViaId(n.project, v.route.method+' '+v.route.path))}) ]),
      badge(v.grade) ]))),
  ]);
  const colPanel=el('div',{className:'panel'},[ el('h2',{textContent:t('erd.side.cols')}),
    el('div',{className:'comment',textContent:t('erd.side.cols.loading')}) ]);
  side.replaceChildren(relPanel, colPanel);
  const mine=++ERD.sideSeq;
  const key=n.project+'|'+n.table;
  let cols=ERD.cols.get(key);
  if(!cols){
    try { const rr=await apiFor(n.project, 'erd', {table:n.table});
      const tb=rr.answer.tables.find((x)=>x.table===n.table); cols=(tb&&tb.columns)||[]; }
    catch(e){ cols=[]; }
    if(mine!==ERD.sideSeq) return;
    ERD.cols.set(key, cols);
  }
  colPanel.replaceChildren(
    el('h2',{},[t('erd.side.cols')+' ', el('span',{className:'count',textContent:t('erd.side.count',{n:cols.length})})]),
    el('div',{className:'comment',textContent:t('erd.side.fed.cols',{p:n.project})}),
    el('ul',{className:'list'+(cols.length>12?' colgrid2':'')}, cols.map((c)=>el('li',{},[
      el('span',{className:'id'},[ c.pk?el('span',{className:'pk',title:'primary key',textContent:'\u2726 '}):'', c.column ]),
      el('span',{className:'comment',textContent:(c.type||'')+(c.comment?'\u00a0\u00a0'+c.comment:'')}) ]))));
}
