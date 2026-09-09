// 42_flow.js — the Flow tab, and the chain renderer the Impact tab walks the other way.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// Which lanes each direction draws, left→right; how each row is rendered; and
// which lane is DERIVED rather than walked (so the layer census can say which
// nodes at a hop are rows and which are folded away).
// THE ROUND TRIP HAS TWO MORE LANES ON A PACK WITH A FRONTEND (RM31). Down
// from a screen the chain opens with the browser's own functions and the routes
// they call; up from a column it closes with the same two in reverse. Both are
// drawn ONLY where the answer carries them: `flow` writes a lane onto the
// answer exactly when its walk has one, so a lane that is absent here was never
// analyzed, and an empty column would have read as "no screen reaches this".
const CHAIN_LANES = {
  down: { entryTitle:'chain.lane.entry', end:'tables', derived:null, lanes:[
    ['webFunctions','chain.lane.webFunctions',(v,x)=>flowWebFnRow(v,x),true],
    ['endpoints','chain.lane.endpoints',(v,x)=>flowEndpointRow(v,x),true],
    ['services','chain.lane.services',(v,x)=>flowServiceRow(v,x),true],
    ['statements','chain.lane.statements',(v,x)=>flowStatementRow(v,x),true],
    ['tables','chain.lane.tables',(v,x)=>flowTableRow(v,x),false] ] },
  up: { entryTitle:'chain.lane.target', end:'endpoints', derived:'endpoints', lanes:[
    ['statements','chain.lane.statements',(v,x)=>flowStatementRow(v,x),true],
    ['services','chain.lane.services',(v,x)=>flowServiceRow(v,x),true],
    ['endpoints','chain.lane.endpoints',(v,x)=>flowEndpointRow(v,x),false],
    ['webFunctions','chain.lane.webFunctions',(v,x)=>flowWebFnRow(v,x),true],
    ['screens','chain.lane.screens',(v,x)=>flowScreenRow(v,x),true] ] },
};
// The depth each tab's control OPENS on (the `selected` option in the markup),
// and the depth a screen entry needs: the same 8 `flow` defaults a screen to.
const CHAIN_DEPTH_DEFAULT = { down:6, up:8 };
const CHAIN_SCREEN_DEPTH = 8;
/** The lanes THIS answer has, in the order the page draws them left to right. */
function chainLanes(v, a){
  return CHAIN_LANES[v.direction].lanes.filter(([field]) => Array.isArray(a[field]));
}
/**
 * The END of the chain, for the by-hop view's closing block: the last lane this
 * answer actually has. Walking up that is the screens on a pack with a frontend
 * and the endpoints without one; walking down it is the tables either way.
 */
function chainEndField(v, a){
  const lanes = chainLanes(v, a);
  return lanes.length ? lanes[lanes.length - 1][0] : CHAIN_LANES[v.direction].end;
}
// The same naming rule the engine uses (core/chain.mjs nodeLabel), for the path
// list — where the server sends ids, not labels.
function shortId(id){
  const i=String(id).indexOf(':'), kind=String(id).slice(0,i), key=String(id).slice(i+1);
  if(kind==='symbol'){ const h=key.lastIndexOf('#'); const dot=key.lastIndexOf('.',h); return h>=0?key.slice(dot+1):key; }
  if(kind==='statement'||kind==='column'){ const p=key.split('.'); return p.slice(-2).join('.'); }
  return key;
}
// Close the typeahead for good: cancel the pending keystroke query AND bump the
// sequence, so an answer already in flight cannot re-open the box over the
// picture the user just asked for.
function closeSug(v){
  clearTimeout(v.sugTimer);
  v.sugSeq++;
  v.sugItems=[]; v.sugRows=[]; v.sugCur=-1; v.sugMoved=false;
  const box=byId(v.sugId);
  box.replaceChildren();
  box.classList.add('hidden');
}
function openFlow(arg){
  activateTab('flow');
  // WHICH END the caller meant, carried explicitly. A screen path and a route
  // both start with a slash, and the page must never have to guess back out of
  // the text which of the two a handoff was about.
  const kind=['endpoint','symbol','screen'].find(k=>arg&&arg[k]);
  byId('fentry').value = (kind?arg[kind]:'')||'';
  FLOWV.pick = kind ? {kind, value:arg[kind]} : null;
  closeSug(FLOWV);
  drawChain(FLOWV);
}
/**
 * Follow ONE ROUTE down its chain, in the project that SERVES it.
 *
 * A federated row on a list names another pack: asking THIS project for that
 * route gets `unknown-endpoint` back, because this project does not serve it.
 * So the page goes there instead, through the same hash the address bar
 * carries: the project switches, the Flow tab opens, and the walk is asked of
 * the pack that answers the call. A row with no project is this project's own
 * and is opened exactly as it always was.
 * @param {object} row  the answer row (its `project`, when it has one)
 * @param {string} id   the route's key, "METHOD /path"
 */
function openFlowFor(row, id){
  const p = row && row.project;
  if(!p || p===STATE.project){ openFlow({endpoint:id}); return; }
  location.hash = hashFor({ project:p, tab:'flow', pick:'endpoint:'+id });
}
/** What "follow this route" MEANS on this row: here, or over in that project. */
function flowRowTitle(row){
  return (row && row.project && row.project!==STATE.project)
    ? t('btn.flow.other.title',{p:row.project}) : t('btn.flow.title');
}
/** The Flow button on a list row, addressed to whichever project serves it. */
function flowRowButton(row, id){
  return el('button',{className:'mini', textContent:'Flow',
    title:flowRowTitle(row), onclick:()=>openFlowFor(row, id)});
}
// Which tool arguments this entry box means. Walking down that is one rule (a
// '#' is a method, anything else a route). Walking up, WHICH KIND carries this
// key is the engine's answer, not a guess from the dots in the name — the same
// text can be a column here and a statement there.
async function chainArgs(v, raw){
  if(v.direction==='down'){
    if(raw.includes('#')) return {symbol:raw};
    // A pick already SAYS which end of the round trip it is — from the rail,
    // from the typeahead, or from a handoff — so nothing is guessed here.
    if(v.pick && v.pick.value===raw && (v.pick.kind==='screen'||v.pick.kind==='endpoint')) return {[v.pick.kind]:raw};
    // Hand-typed: a route id carries its METHOD ("GET /order/list"), a screen
    // is the path on its own, so a bare path is the screen end.
    if(raw.startsWith('/')) return {screen:raw};
    return {endpoint:raw};
  }
  const a={direction:'up'};
  if(raw.includes('#')){ a.symbol=raw; return a; }
  if(v.pick && v.pick.value===raw){ a[v.pick.kind]=raw; return a; }
  try{
    const s=(await api('search',{query:raw, limit:100})).answer;
    if((s.tables||[]).some(t=>t.table===raw)) a.table=raw;
    else if((s.columns||[]).some(c=>c.column===raw)) a.column=raw;
    else if((s.statements||[]).some(x=>x.statement===raw)) a.statement=raw;
  }catch(e){ /* the shape rule below, so the ENGINE names what it cannot find */ }
  if(!a.table&&!a.column&&!a.statement){ if(raw.split('.').length>=2) a.column=raw; else a.table=raw; }
  return a;
}
async function drawChain(v, keepLimit){
  const raw=byId(v.entryId).value.trim();
  const wrap=vwrap(v), side=vside(v);
  if(!raw){
    // Not a grey box telling the reader to type: the lead sentence and five
    // rows off the top of the list the rail already holds.
    wrap.classList.remove('layersmode');
    side.replaceChildren(); v.resp=null;
    railIdle(v.name);
    return;
  }
  if(!keepLimit) v.limit=40;
  wrap.replaceChildren(el('div',{className:'empty',textContent: t(v.direction==='up' ? 'load.impact' : 'load.flow')}));
  const mine=++v.seq;
  let args;
  try{ args=await chainArgs(v, raw); }
  catch(e){ if(stale(e)||mine!==v.seq) return; wrap.replaceChildren(errPanel(e)); side.replaceChildren(); return; }
  if(mine!==v.seq) return;
  args.mode=byId(v.modeId).value;
  // A SCREEN IS FURTHER OUT THAN A ROUTE. Its own function, the api function it
  // calls, the route, the handler, the service, the mapper and the statement is
  // seven hops before a table is in sight — which is why `flow` itself defaults
  // a screen entry to 8. This tab's control opens on 6, which is right for a
  // route and stops a screen chain dead among the services, and the two lanes
  // below it would then read "none" when the truth is the cap. So a screen
  // entry raises the CONTROL to the engine's own screen default, where the
  // reader can see the number that was used and can still change it: a value
  // the reader has already chosen is left exactly as they set it.
  const depthSel=byId(v.depthId);
  if(args.screen!=null && Number(depthSel.value)===CHAIN_DEPTH_DEFAULT[v.direction]){
    depthSel.value=String(CHAIN_SCREEN_DEPTH);
  }
  args.depth=Number(depthSel.value);
  args.limit=v.limit;
  let r; try{ r=await api('flow',args); }
  catch(e){ if(stale(e)||mine!==v.seq) return; wrap.replaceChildren(errPanel(e)); side.replaceChildren(); return; }
  if(mine!==v.seq) return;   // a newer Draw is in flight — this answer is stale
  v.resp=r; v.sel=null;
  renderChain(v, r);
  // WHICH pick this picture is of, said the way the URL says it: the kind is
  // the one the tool was actually asked with, never guessed back out of the
  // name. The answer is kept so the Back button can re-draw it for nothing.
  const argKind=['endpoint','screen','symbol','table','column','statement'].find((k)=>args[k]!=null);
  if(argKind){
    const id=argKind+':'+args[argKind];
    pickRemember(v.name, id, { r, raw, limit:v.limit });
    pickSet(v.name, id);
  }
}
function renderChain(v, r){
  refreshShowAll();
  v.rows.clear(); v.linkSpecs=[]; v.paths=[];
  const tf={}; for(const f of (r.truncated&&r.truncated.fields)||[]) tf[f.field]=f;
  if(v.view==='layers') renderChainLayers(v, r, tf); else renderChainLanes(v, r, tf);
  flowApplySel(v);
  renderChainSide(v);
}
function renderChainLanes(v, r, tf){
  const a=r.answer, wrap=vwrap(v), spec=CHAIN_LANES[v.direction];
  wrap.classList.remove('layersmode');
  const svg=svgEl('svg',{class:'flowsvg'});
  const cols=[flowColumn(v, spec.entryTitle, null, [a.entry], null, a, (e)=>flowEntryRow(v,e))];
  for(const [field,title,mk,grouped] of chainLanes(v, a))
    cols.push(flowColumn(v, title, field, a[field]||[], tf[field], a, (x)=>mk(v,x), grouped));
  wrap.replaceChildren(svg, ...cols);
  drawChainLinks(v);
}
// Re-apply the current selection after any re-render (expanding a layer
// rebuilds the rows; the open card must not silently lose its highlight).
function flowApplySel(v){
  for(const [k,row] of v.rows) for(const e of row.els) e.classList.toggle('sel', k===v.sel);
}
// One lane. `grouped` rows are bucketed per hop, and inside a hop the confirmed
// rows come first, then a dashed divider that NAMES the candidate band — so a
// candidate is never read as a confirmed call.
function flowColumn(v, title, field, items, tf, a, mkRow, grouped){
  const box=el('div',{className:'fcol'},[
    el('div',{className:'fcolhead'},[ el('span',{className:'fcoltitle',textContent:t(title)}),
      el('span',{className:'count',textContent: tf? (tf.shown+' / '+tf.total) : String(items.length)}) ])
  ]);
  if(tf && tf.nextOffset!=null){
    const capped=v.limit>=200;
    box.append(el('div',{className:'fcolsub'},[
      el('button',{className:'moreb',textContent: capped?'Cap reached':'More', disabled:capped, title:t('chain.cap.more.title'),
        onclick:()=>{ v.limit = v.limit<140?140:200; drawChain(v, true); }}),
      el('span',{className:'count',textContent:'order: '+tf.order})
    ]));
    if(capped) box.append(el('div',{className:'count',style:'margin-bottom:8px',textContent:t('chain.cap')}));
  }
  if(!items.length){ box.append(flowEmptyNote(v, a, field)); return box; }
  if(!grouped){ for(const it of items) box.append(mkRow(it)); return box; }
  const hops=[]; for(const it of items) if(!hops.includes(it.hops)) hops.push(it.hops);
  for(const h of hops){
    box.append(el('div',{className:'fhop',textContent:t('chain.hop',{n:h})}));
    const inHop=items.filter(i=>i.hops===h);
    for(const g of ['EXACT','SOUND_SET','HEURISTIC']){
      const rows=inHop.filter(i=>i.grade===g);
      if(!rows.length) continue;
      // a statement is not "called" — it is reached through a candidate call
      if(g==='SOUND_SET') box.append(el('div',{className:'fdiv',
        textContent:t(field==='statements'?'chain.band.candidate.stmt':'chain.band.candidate',{n:rows.length})}));
      if(g==='HEURISTIC') box.append(el('div',{className:'fdiv fheur',textContent:t('chain.band.heuristic',{n:rows.length})}));
      for(const it of rows) box.append(mkRow(it));
    }
    // any other grade (RUNTIME_ONLY / UNRESOLVED) is still shown, never dropped
    for(const it of inHop.filter(i=>!['EXACT','SOUND_SET','HEURISTIC'].includes(i.grade))) box.append(mkRow(it));
  }
  return box;
}
function flowEmptyNote(v, a, field){
  const cut=(a.walk&&a.walk.cut)||{};
  // "not in this axis" is the ENGINE's word for a lane the target sits on the
  // wrong side of (nothing upstream of a statement is a statement). It is not
  // an absence and not the mode, so it is said first and plainly.
  const reason=a.empty&&a.empty[field];
  if(reason==='not-in-this-axis'){
    return el('ul',{className:'list'},[el('li',{className:'empty',
      textContent:t('chain.empty.notinaxis')})]);
  }
  if(cut.byMode>0){
    // Offer the mode that would look WIDER than this one. Under heuristic there
    // is none: those links are below every floor, so what is missing is what the
    // analyzer could not resolve — telling the reader to "try conservative"
    // there would send them backwards.
    const mode=a.walk.mode;
    const wider = mode==='strict' ? 'conservative' : mode==='conservative' ? 'heuristic' : null;
    if(!wider){
      return el('div',{className:'empty',textContent:t('chain.empty.nomode',{n:cut.byMode})});
    }
    return el('div',{className:'empty'},[
      t('chain.empty.bymode',{mode, n:cut.byMode}),
      el('button',{className:'mini',textContent:t('chain.empty.switch',{mode:wider}),onclick:()=>{ byId(v.modeId).value=wider; drawChain(v); }})
    ]);
  }
  return el('ul',{className:'list'},[emptyNote(a.empty, field)]);
}
// ---------- the observed mark ------------------------------------------------
// A capture of the running system reaches this page as `observed: true` on a
// row and on the drawn link beside it, and as one `basis.runtimeEvidence` block
// saying HOW MUCH was captured. Both halves are needed to read the mark
// honestly, so the mark is built in one place and the coverage note travels
// with it: the tag says this row RAN, and the note says a row without the tag
// was not visited by that capture rather than dead. It is never a grade, so it
// changes no badge, no dash and no band, and an unmarked sibling is drawn today
// exactly as it was drawn yesterday.
/** The capture's own coverage block on an answer, or null when none was read. */
const runtimeEvidenceOf=(resp)=> (resp && resp.basis && resp.basis.runtimeEvidence) || null;
/** That block's coverage note, verbatim: the engine's sentence, not the page's. */
function runtimeNote(resp){
  const re=runtimeEvidenceOf(resp);
  return re && re.note ? String(re.note) : '';
}
/** The one seen tag this page draws, wherever a capture reached. */
function seenTag(resp){
  return el('span',{className:'tag',
    title:[t('chain.tag.seen.title'), runtimeNote(resp)].filter((x)=>x).join('  '),
    textContent:t('chain.tag.seen')});
}
/** Did a capture see the DRAWN LINK into this row run, end to end? */
const linkObserved=(o)=> !!(o && o.link && o.link.observed===true);
// ---------- a row from ANOTHER project (RM44) --------------------------------
// A server that serves several projects can follow an HTTP call out of this
// pack into the project that answers it, and the rows it brings back carry
// `project`. Two things follow for this page.
//   IDENTITY. Two projects can both have a `types` table, so a row's key here
//   is scoped by the project it came from. An in-pack row keeps the bare node
//   id, so nothing about a single-project page changes.
//   WHERE THE LINE COMES FROM. A federated row hangs off a row in its own
//   project, except the first one on the far side of a crossing: that one
//   hangs off the CALLER over here, and the server says so with
//   `link.fromProject`.
const fkey=(row,id)=> (row&&row.project)? row.project+' '+id : id;
// The node id inside a key, whichever of the two shapes it is. A project id is
// a slug and carries no colon, so a first word without one is the scope.
function keyNodeId(k){
  const s=String(k), i=s.indexOf(' ');
  return (i>0 && !s.slice(0,i).includes(':')) ? s.slice(i+1) : s;
}
function flinkKey(row,id){
  if(id==null) return null;
  const p=(row&&row.link&&row.link.fromProject)||(row&&row.project)||null;
  return p? p+' '+id : id;
}
/**
 * The chip a federated row wears AFTER its name. The name is what the reader is
 * looking for, so it comes first and keeps the width; this chip shrinks. The
 * whole project id is in the tooltip, because the chip itself may be cut.
 */
const projTag=(row)=> (row&&row.project)
  ? el('span',{className:'tag fproj',title:row.project+'  '+t('chain.tag.project.title'),textContent:row.project})
  : null;
function flowMakeRow(v, key, kind, grade, kids, data){
  const e=el('div',{className:'frow',tabIndex:0},kids);
  e.setAttribute('role','button');
  e.addEventListener('mouseenter',()=>flowHover(v,key));
  e.addEventListener('click',()=>flowSelect(v,key));
  // same affordances from the keyboard: focus lights the chain, Enter/Space opens the card
  e.addEventListener('focus',()=>flowHover(v,key));
  e.addEventListener('blur',()=>flowClearHover(v));
  e.addEventListener('keydown',(ev)=>{ if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); flowSelect(v,key); } });
  // In layers mode one node can be drawn twice (inside its hop AND in the
  // end-of-chain list). Both copies answer to the same key, so hover and
  // select light them together instead of the last one winning.
  const prev=v.rows.get(key);
  if(prev) prev.els.push(e);
  else v.rows.set(key,{els:[e],kind,grade,data});
  return e;
}
function flowEntryRow(v, entry){
  const title = entry.kind==='endpoint' ? (entry.httpMethod+' '+entry.path) : (entry.short||entry.id);
  // A lane is 180px wide and a shortened name is what fits in it; the FULL one
  // is what a reader hovers for, so the row carries both.
  const full = entry.kind==='endpoint' ? title : (entry.id||title);
  const sub = entry.kind==='endpoint' ? (entry.handlerShort||'')
    : entry.kind==='statement' ? (entry.statementType||'sql')
    : (entry.comment||entry.owner||'');
  // Build the row's data EXPLICITLY. Spreading the entry would put the route
  // string on `path`, where the card reads a list of walked edges — and the
  // route "/product/update/{id}" has a .length, so it passed that test and blew
  // up on .map. The route lives on `route`; the entry has no walked path.
  // The start carries no grade either (the server sends none for hop 0), so it
  // gets none here rather than a made-up EXACT.
  return flowMakeRow(v, entry.start,'entry',null,[
    el('div',{className:'frowtop'},[
      kindGlyph(entry.kind, 12),
      v.direction==='up'? el('span',{className:'tag',textContent:entry.kind}) : null,
      el('span',{className:'fname',title:full,textContent:title})]),
    el('div',{className:'fsub'},[el('span',{className:'comment',title:sub,textContent:sub})])
  ],{ hops:0, kind:entry.kind, route:entry.path??null, httpMethod:entry.httpMethod??null,
      handler:entry.handler??null, handlerShort:entry.handlerShort??null, short:entry.short??null,
      owner:entry.owner??null, transactional:entry.transactional===true,
      comment:entry.comment??null, statementType:entry.statementType??null,
      table:entry.kind==='table'?entry.id:null, column:entry.kind==='column'?entry.id:null,
      tables:entry.tables??null,   // a statement TARGET carries its tables, like a statement row
      file:entry.file??null, line:entry.line??null, start:entry.start });
}
function flowServiceRow(v, s){
  v.linkSpecs.push({from:flinkKey(s,(s.link&&s.link.from)||null), to:fkey(s,'symbol:'+s.id), grade:s.grade, observed:linkObserved(s)});
  return flowMakeRow(v, fkey(s,'symbol:'+s.id),'service',s.grade,[
    el('div',{className:'frowtop'},[kindGlyph('symbol',12), el('span',{className:'fhopn kh-service',textContent:String(s.hops)}), el('span',{className:'fname',title:s.id,textContent:s.short}), projTag(s), badge(s.grade)]),
    el('div',{className:'fsub'},[
      s.handler? el('span',{className:'tag',title:t('chain.tag.handler.title'),textContent:'handler'}) : null,
      s.external? el('span',{className:'tag warn',title:t('chain.tag.ext.title'),textContent:'ext'}) : null,
      s.transactional? el('span',{className:'tag',title:'@Transactional boundary',textContent:'@Tx'}) : null,
      // A trace saw THIS implementation run. Beside the grade, never inside it:
      // the candidate band above is untouched and an unmarked sibling stands
      // where it stood.
      s.observed? seenTag(v.resp) : null,
      el('span',{className:'comment',title:s.owner||'',textContent:s.owner||''}) ])
  ],s);
}
function flowStatementRow(v, s){
  v.linkSpecs.push({from:flinkKey(s,(s.link&&s.link.from)||null), to:fkey(s,'statement:'+s.id), grade:s.grade, observed:linkObserved(s)});
  // NAMED `stype`, NOT `t`. `t` is the catalogue lookup every row in this file
  // calls, and a local of that name shadows it for the whole function: the
  // `columnsRuntimeOnly` tag below asks the catalogue for its words, and with
  // the shadow in place that call threw `t is not a function` and took the
  // whole lane strip down with it.
  const stype=String(s.statementType||'').toLowerCase();
  // A statement type is EITHER a SQL verb the analyzer read (`select`, `update`)
  // or the NAME OF THE RULE that generated it (`derived`, `builtin`, `jpql`,
  // `mp-builtin`). Colouring the second kind as a write was simply wrong — a
  // `derived` findBy… and an `mp-builtin` selectList are both reads. For those
  // the access comes from the statement's own EXECUTES edges, which say it.
  const verbCls = {select:'tag read', insert:'tag write', update:'tag write', delete:'tag write'};
  const acc = (s.tables||[]).map(x=>x&&x.access).filter(Boolean);
  const cls = verbCls[stype] || (acc.length===0 ? 'tag' : (acc.some(a=>a!=='read') ? 'tag write' : 'tag read'));
  return flowMakeRow(v, fkey(s,'statement:'+s.id),'statement',s.grade,[
    el('div',{className:'frowtop'},[kindGlyph('statement',12), el('span',{className:'fhopn kh-statement',textContent:String(s.hops)}), el('span',{className:'fname',title:s.id,textContent:s.short}), projTag(s), badge(s.grade)]),
    el('div',{className:'fsub'},[ el('span',{className:cls,textContent:s.statementType||'sql'}),
      el('span',{className:'count',textContent:(s.tables||[]).length+' tbl'}),
      // Never hide a lower bound behind a tidy row.
      s.columnsRuntimeOnly? el('span',{className:'tag',title:t('chain.tag.runtime.title'),textContent:t('chain.tag.runtime')}) : null,
      // A trace saw this statement RUN. Same mark, same words and the same
      // coverage note as every other row that carries one.
      s.observed? seenTag(v.resp) : null ]),
    // the mapper method is folded into this row — name it, or the hop vanishes
    s.symbol? el('div',{className:'fsub'},[el('span',{className:'comment',title:s.symbol,textContent:'via '+shortId('symbol:'+s.symbol)})]) : null
  ],s);
}
function flowTableRow(v, x){
  v.linkSpecs.push({from:fkey(x,'statement:'+x.via), to:fkey(x,'table:'+x.table), grade:x.grade});
  return flowMakeRow(v, fkey(x,'table:'+x.table),'table',x.grade,[
    el('div',{className:'frowtop'},[kindGlyph('table',12), el('span',{className:'fname',title:x.table,textContent:x.table}), projTag(x), badge(x.grade)]),
    el('div',{className:'fsub'},[el('span',{className:'count',title:'via '+x.via,
      textContent:t('chain.hop',{n:x.hops})+'\u00a0\u00a0via '+x.viaShort})]),
    el('div',{className:'fsub'},[
      x.writes? el('span',{className:'tag write',title:'distinct columns written',textContent:'W '+x.writes}) : null,
      x.reads? el('span',{className:'tag read',title:'distinct columns read',textContent:'R '+x.reads}) : null,
      el('span',{className:'count',textContent:x.access}) ])
  ],x);
}
// A ROUTE, from either side. Walking UP it is DERIVED from its handler's
// HANDLES edge, not walked, so it hangs off that method's row and carries that
// method's path grade. Walking DOWN from a screen it IS a step of the chain:
// the frontend function called it, so its line comes off that function. One
// row, two ways of arriving at it, and the row says which by where it hangs.
function flowEndpointRow(v, e){
  const from = (e.link && e.link.from) || (e.handler ? 'symbol:'+e.handler : null);
  const via = (e.link && e.link.fromShort) || e.handlerShort || (e.handler ? shortId('symbol:'+e.handler) : '');
  v.linkSpecs.push({from:flinkKey(e,from), to:fkey(e,'endpoint:'+e.id), grade:e.grade, observed:linkObserved(e)});
  return flowMakeRow(v, fkey(e,'endpoint:'+e.id),'endpoint',e.grade,[
    el('div',{className:'frowtop'},[kindGlyph('endpoint',12), el('span',{className:'fname',title:e.id,textContent:e.id}), projTag(e), badge(e.grade)]),
    el('div',{className:'fsub'},[el('span',{className:'count',title: from ? ('via '+from.slice(from.indexOf(':')+1)) : '',
      textContent:t('chain.hop',{n:e.hops})+'\u00a0\u00a0'+via})]),
    // Two things a route on a pack with a frontend owes the reader: how much of
    // the browser calls it, and whether a recording ever saw that call happen.
    // The recording is a MARKER beside the grade and never a grade: no walk
    // follows a RUNTIME_ONLY edge, so nothing here was drawn from one.
    (e.frontendCalls || e.observed) ? el('div',{className:'fsub'},[
      e.frontendCalls? el('span',{className:'count',title:t('chain.tag.frontend.title'),
        textContent:t('chain.tag.frontend',{n:e.frontendCalls})}) : null,
      e.observed? seenTag(v.resp) : null,
    ]) : null
  // On an endpoint row the server's `path` is the ROUTE and the walked edges are
  // `walkedPath`; the card draws a path list from `path`, like every other row.
  ],{...e, route:e.path??null, path:e.walkedPath||null});
}
// A FRONTEND FUNCTION. Its id is `file#function`, a path and a name glued
// together and far too long for a 180px lane, so the row shows the short form
// the ENGINE made and puts the file's own name under it. The tag says which of
// the two kinds it is: declared in the file the route mounts as its screen, or
// in a module that file imports.
function flowWebFnRow(v, w){
  v.linkSpecs.push({from:flinkKey(w,(w.link&&w.link.from)||null), to:fkey(w,'symbol:'+w.id), grade:w.grade, observed:linkObserved(w)});
  const file=String(w.file||'');
  const base=file.slice(file.lastIndexOf('/')+1);
  return flowMakeRow(v, fkey(w,'symbol:'+w.id),'webfn',w.grade,[
    el('div',{className:'frowtop'},[kindGlyph('webfn',12), el('span',{className:'fhopn kh-webfn',textContent:String(w.hops)}),
      el('span',{className:'fname',title:w.id,textContent:w.short}), projTag(w), badge(w.grade)]),
    el('div',{className:'fsub'},[
      el('span',{className:'tag',title:t(w.component?'chain.tag.component.title':'chain.tag.api.title'),
        textContent:t(w.component?'chain.tag.component':'chain.tag.api')}),
      el('span',{className:'comment',title:file,textContent:base}) ])
  ],w);
}
// A SCREEN: the far end of the round trip. It is a route the BROWSER shows, so
// its name is the composed path, and what stands under it is what the router's
// own declaration said: the group its first segment puts it in, and the title
// its `meta` gave it.
function flowScreenRow(v, s){
  v.linkSpecs.push({from:flinkKey(s,(s.link&&s.link.from)||null), to:fkey(s,'screen:'+s.id), grade:s.grade, observed:linkObserved(s)});
  return flowMakeRow(v, fkey(s,'screen:'+s.id),'screen',s.grade,[
    el('div',{className:'frowtop'},[kindGlyph('screen',12), el('span',{className:'fhopn kh-screen',textContent:String(s.hops)}),
      el('span',{className:'fname',title:s.id,textContent:s.short||s.id}), projTag(s), badge(s.grade)]),
    el('div',{className:'fsub'},[
      s.group? el('span',{className:'tag',textContent:s.group}) : null,
      s.observed? seenTag(v.resp) : null,
      el('span',{className:'comment',title:s.title||'',textContent:s.title||''}) ])
  // A screen row's walked edges are `walkedPath`, like an endpoint's: `path` on
  // this row would be the route the browser shows, and one field cannot be both.
  ],{...s, route:s.id, path:s.walkedPath||null});
}
// ---------- second rendering: LAYERS ----------
// The same answer, folded per hop: how deep this chain goes and how wide each
// hop is. Server-computed (`answer.layers`) — the page re-derives nothing, so
// the silhouette cannot disagree with the lanes beside it.
function renderChainLayers(v, r, tf){
  const a=r.answer, wrap=vwrap(v), spec=CHAIN_LANES[v.direction];
  const lanes=chainLanes(v, a);
  wrap.classList.add('layersmode');
  const layers=a.layers||[];
  const box=el('div',{});
  const maxNodes=layers.reduce((m,l)=>Math.max(m,l.nodes),0);
  const widest=layers.find(l=>l.nodes===maxNodes);
  // A hop can hold NO walked node and still hold rows: the end lane is DERIVED
  // from a reached node's own edges (endpoints from the handler's HANDLES edges
  // walking up, tables from a statement's EXECUTES edges walking down). Those
  // hops used to draw a 0%-wide bar next to "13" — a picture that says the
  // opposite of the truth. They get their own hatched bar, sized by the derived
  // count, on the same scale as the walked ones.
  // The DERIVED lane is the one the walk never stepped onto: walking up that is
  // the endpoints (read off a handler's HANDLES edges), walking down the tables
  // (read off a statement's EXECUTES edges). It is not the same as the LAST
  // lane, which on a pack with a frontend is the screens, and those ARE walked.
  const derivedField=spec.derived || spec.end;
  const derivedAt=(l)=> l.nodes===0 ? (l[derivedField]||0) : 0;
  const scale=layers.reduce((m,l)=>Math.max(m, l.nodes||derivedAt(l)), 0);
  box.append(el('div',{className:'lyrlead',textContent: layers.length
    ? (layers.length+' layers\u00a0\u00a0widest hop '+(widest?widest.hops:0)+' ('+maxNodes+' nodes)\u00a0\u00a0walked '+(a.walk.walked||0))
    : t('chain.nolayers')}));
  if(!layers.length) box.append(flowEmptyNote(v,a,'layers'));
  else {
    box.append(el('div',{className:'lyr lyrhead'},[ el('span',{textContent:'hop'}), el('span',{textContent:'nodes by link grade'}),
      ...lanes.map(([f])=> el('span',{textContent:f})), el('span',{}) ]));
    for(const l of layers){
      const open=v.layerOpen.has(l.hops);
      const derived=derivedAt(l);
      const what=derived? t('chain.derived.what',{n:derived, field:derivedField})
        : t('chain.hop.nodes',{n:l.nodes});
      box.append(el('div',{className:'lyr'},[
        el('span',{className:'lyrhop',textContent:t('chain.hop',{n:l.hops})}),
        el('div',{className:'lyrcell'},[ layerBar(l, scale, derived),
          derived? el('span',{className:'lyrderivedlbl',title:what,textContent:t('chain.derived.label')}) : null ]),
        ...lanes.map(([f])=> el('span',{className:'count',textContent:String(l[f]||0)})),
        el('button',{className:'mini',textContent: open?'Hide':(derived?'Derived':'Show'), title:what,
          onclick:()=>{ if(open) v.layerOpen.delete(l.hops); else v.layerOpen.add(l.hops); renderChain(v, v.resp); }})
      ]));
      if(open) box.append(layerBody(v, a, tf, l));
    }
  }
  // The end of the chain gets its own block: every row of the last lane that
  // came back, whatever hop it sits at — including the ones no layer covers.
  const endField=chainEndField(v, a);
  const endRow=spec.lanes.find(([f])=>f===endField)[2];
  const endRows=a[endField]||[];
  const end=el('div',{className:'lyrend'},[
    el('div',{className:'fcolhead'},[ el('span',{className:'fcoltitle',textContent:t('chain.end.title',{field:endField})}),
      el('span',{className:'count',textContent: tf[endField]? (tf[endField].shown+' / '+tf[endField].total) : String(endRows.length)}) ])
  ]);
  const beyond=(a.walk&&a.walk.beyond)||{};
  if(beyond[endField]>0){
    end.append(el('div',{className:'count',style:'margin-bottom:8px',
      textContent:t('chain.beyond',{n:beyond[endField], unit:endField.replace(/s$/,'')})}));
  }
  if(!endRows.length) end.append(flowEmptyNote(v,a,endField));
  else for(const t of endRows) end.append(endRow(v,t));
  box.append(end);
  const svg=svgEl('svg',{class:'flowsvg'});   // kept so a resize has nothing to redraw
  wrap.replaceChildren(svg, box);
  v.linkSpecs=[]; v.paths=[];                 // layers draw no links
}
// One hop's width, as a share of the widest hop, split left→right by the link
// grade of the nodes at that hop (the same grades the lanes colour their lines).
// A hop bar is 12px tall, which is no room for a stroke — so the grade's DASH
// PATTERN becomes the fill: the same solid / dashed / dash-dot / dotted rhythm
// the lines carry, printed as vertical bars. Still ink, still no hue.
function gradeFill(g){
  const ink=cssVar('--edge'), d=gradeDash(g);
  if(!d) return ink;
  const step=d.split(' ').map(Number);
  let at=0; const stops=[];
  for(let i=0;i<step.length;i++){ const on=i%2===0;
    stops.push((on?ink:'transparent')+' '+at.toFixed(2)+'px '+(at+step[i]).toFixed(2)+'px'); at+=step[i]; }
  return 'repeating-linear-gradient(90deg,'+stops.join(',')+')';
}
function layerBar(l, scale, derived){
  // A derived hop has no link grades to split — nothing was walked into it — so
  // it gets one hatched accent bar, never a grade colour it did not earn.
  if(derived){
    const w=(scale>0?(derived/scale*100):0).toFixed(2);
    return el('div',{className:'lyrbar', title:'derived — not walked\u00a0\u00a0'+derived},
      [el('div',{className:'lyrbarfill lyrderived', style:'width:'+w+'%'})]);
  }
  const fill=el('div',{className:'lyrbarfill', style:'width:'+(scale>0?(l.nodes/scale*100):0).toFixed(2)+'%'});
  let drawn=0;
  for(const g of ['EXACT','SOUND_SET','HEURISTIC']){
    const n=l.byLinkGrade[g]||0; if(!n) continue;
    drawn+=n;
    fill.append(el('i',{style:'flex:'+n+';background:'+gradeFill(g), title:g+' '+n}));
  }
  // a node whose link carries another grade still takes up its share of the bar
  if(l.nodes>drawn) fill.append(el('i',{style:'flex:'+(l.nodes-drawn)+';background:'+gradeFill('RUNTIME_ONLY'), title:'other '+(l.nodes-drawn)}));
  return el('div',{className:'lyrbar', title:l.nodes+' node(s) at hop '+l.hops}, [fill]);
}
// The rows at one hop, drawn by the SAME renderers the lanes use, so hover,
// select and the card keep working. `shown / total` is honest per group: the
// lanes were cut by `limit`, the layer census was not.
function layerBody(v, a, tf, l){
  const spec=CHAIN_LANES[v.direction];
  const derivedField=spec.derived || spec.end;
  const body=el('div',{className:'lyrbody'});
  let listed=0, walkedRows=0;
  for(const [field,title,mk] of chainLanes(v, a)){
    const total=l[field]||0;
    const inHop=(a[field]||[]).filter(x=>x.hops===l.hops);
    // The DERIVED lane is the one nothing was walked ONTO, so its rows are not
    // among the nodes this hop counts. Walking down there is none: a table the
    // walk stepped on is in both counts, and taking it out here would report it
    // as folded away.
    if(field!==spec.derived) walkedRows+=total;
    if(!total && !inHop.length) continue;
    listed+=inHop.length;
    body.append(el('div',{className:'fhop'},[t(title)+' ', el('span',{className:'count',textContent:inHop.length+' / '+total})]));
    if(inHop.length<total){
      body.append(el('div',{className:'count',style:'margin-bottom:6px'},[
        t('chain.cut',{n:total-inHop.length}),
        el('button',{className:'mini',textContent:t('chain.cut.raise'), disabled:v.limit>=200,
          onclick:()=>{ v.limit = v.limit<140?140:200; drawChain(v, true); }})
      ]));
    }
    for(const it of inHop) body.append(mk(v,it));
  }
  // A hop can hold nodes that are no lane row: a mapper method is folded into
  // the statement beside it. Say so rather than showing an empty box.
  const folded=l.nodes-walkedRows;
  if(folded>0) body.append(el('div',{className:'comment',textContent:t('chain.folded',{n:folded})}));
  if(l.nodes===0 && (l[derivedField]||0)>0){
    body.append(el('div',{className:'comment',textContent:t('chain.derived.note',{field:derivedField})}));
  }
  if(!listed && folded<=0) body.append(el('div',{className:'empty',textContent:t('chain.norows')}));
  return body;
}
// Measure the rendered rows and lay one cubic bezier per link. Rect DIFFS are
// scroll-invariant (both ends move with the content), so no scroll math here.
function drawChainLinks(v){
  const wrap=vwrap(v), svg=vsvg(v);
  if(!wrap||!svg) return;
  // A hidden tab has no layout: every rect would read 0 and every bezier would
  // collapse to M0,0. Leave the picture alone and redraw when the tab is shown.
  if(wrap.offsetParent===null) return;
  svg.replaceChildren(); v.paths=[];
  svg.setAttribute('width', wrap.scrollWidth); svg.setAttribute('height', wrap.scrollHeight);
  const wr=wrap.getBoundingClientRect();
  for(const l of v.linkSpecs){
    const a=l.from&&v.rows.get(l.from), b=v.rows.get(l.to);
    if(!a||!b) continue;
    const ar=a.els[0].getBoundingClientRect(), br=b.els[0].getBoundingClientRect();
    // A link inside ONE lane (hop-1 interface → hop-2 impl in the service lane)
    // has no gap to cross: drawn right-edge → left-edge it doubles back across
    // the rows between them. Run it down the left gutter instead.
    const sameLane = a.els[0].closest('.fcol') && a.els[0].closest('.fcol')===b.els[0].closest('.fcol');
    const y1=ar.top-wr.top+ar.height/2, y2=br.top-wr.top+br.height/2;
    let x1, x2, cx1, cx2;
    if(sameLane){
      x1=ar.left-wr.left; x2=br.left-wr.left;
      cx1=x1-22; cx2=x2-22;
    } else {
      x1=ar.right-wr.left; x2=br.left-wr.left;
      const dx=Math.max(26,(x2-x1)*0.5);
      cx1=x1+dx; cx2=x2-dx;
    }
    const cy1=y1, cy2=y2;
    const d='M'+x1+','+y1+' C'+cx1+','+cy1+' '+cx2+','+cy2+' '+x2+','+y2;
    // The GRADE is the colour and the dash, exactly as before. `obs` adds
    // WEIGHT and nothing else, so the eye finds the hops a capture really ran
    // through without any line changing what it claims.
    const p=svgEl('path',{class:'flink'+(l.observed?' obs':''), d, stroke:gradeColor(l.grade)});
    if(l.grade==='SOUND_SET') p.setAttribute('stroke-dasharray','5 3');
    else if(l.grade==='HEURISTIC') p.setAttribute('stroke-dasharray','1.5 3');
    // The connector needs a name of its own, because an <mpath> can only point
    // at one by id. Scoped to the view, so Flow and Impact never collide.
    const id='fp-'+v.name+'-'+v.paths.length;
    p.setAttribute('id', id);
    svg.append(p);
    const rec={from:l.from, to:l.to, el:p, id, len:laneCurveLength(x1,y1,cx1,cy1,cx2,cy2,x2,y2), dots:null, arrow:null};
    v.paths.push(rec);
    laneDecorate(v, svg, rec);
  }
  laneFlowVisibility(v);
}
// ---- direction on the lanes -------------------------------------------------
// The connectors already say WHICH ROWS are joined; what they cannot say
// standing still is WHICH WAY the call runs. So a few small circles travel each
// one, in the call direction: left to right on Flow (endpoint out to the
// tables) and right to left on Impact, where the same call is drawn backwards.
//
// The motion is SMIL — one <animateMotion> with an <mpath> per dot, riding the
// very path the connector is drawn from. That is deliberate: no rAF loop, no
// second copy of the geometry to keep in step with the first, and the browser
// stops the whole thing for us when the tab goes away.
const LANE_DOT_R=2.2;
const LANE_SPEED=90;          // px a second, whatever the path's length
const LANE_PER_DOT=190;       // one more dot for every this many px of path
const LANE_DOTS_MAX=3;
/** The length of one cubic, by sampling it. Pure maths: no layout, no DOM. */
function laneCurveLength(x1,y1,cx1,cy1,cx2,cy2,x2,y2, steps){
  const n=steps||16;
  const at=(t)=>{ const u=1-t;
    return [u*u*u*x1 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x2,
            u*u*u*y1 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y2]; };
  let len=0, prev=at(0);
  for(let i=1;i<=n;i++){ const q=at(i/n); len+=Math.hypot(q[0]-prev[0], q[1]-prev[1]); prev=q; }
  return len;
}
/** How many dots a path of this length carries: one per 190px, 1 to 3. */
const laneDotCount=(len)=> Math.max(1, Math.min(LANE_DOTS_MAX, Math.round((len||0)/LANE_PER_DOT) || 1));
/**
 * What colour a dot on this connector is. A statement reaching a TABLE is an
 * access, and carries the access hue the whole page uses for one; every other
 * connector is a call, and calls are drawn in the edge ink.
 */
function laneDotColor(v, rec){
  // Either end: Flow draws statement -> table, Impact draws the same fact the
  // other way round, and it is the same access either way.
  const tid = keyNodeId(rec.to).startsWith('table:') ? rec.to
    : (keyNodeId(rec.from).startsWith('table:') ? rec.from : null);
  if(tid){
    const row=v.rows.get(tid);
    return mapAccessColor(row && row.data && row.data.access);
  }
  return cssVar('--edge');
}
// The dots for one connector, or - for a reader who asked their system for less
// motion - a static arrowhead at the end instead, so the direction is still
// said, just not by moving.
function laneDecorate(v, svg, rec){
  if(reducedMotion()){ rec.arrow=laneArrow(v, svg, rec); return; }
  if(!GMAP.flow) return;
  const col=laneDotColor(v, rec);
  const dur=Math.max(0.6, (rec.len||1)/LANE_SPEED);
  const n=laneDotCount(rec.len);
  const g=svgEl('g',{class:'fdots'});
  // WHERE EACH DOT IS WHEN THE PICTURE OPENS. Spread evenly along its own path,
  // and the whole path offset again by a phase taken from its index - without
  // that second term every one-dot connector in a fan leaves its row at the
  // same instant and the lanes march in lockstep instead of flowing.
  const phase=((v.paths.length-1)*0.37)%1;
  for(let i=0;i<n;i++){
    const c=svgEl('circle',{r:LANE_DOT_R, fill:col});
    const a=svgEl('animateMotion',{dur:dur+'s', repeatCount:'indefinite',
      // Impact draws the chain backwards, so its dots run backwards along the
      // path - the CALL still goes endpoint to table either way.
      begin:(-((i/n)+phase)*dur)+'s'});
    if(v.direction==='up'){ a.setAttribute('keyPoints','1;0'); a.setAttribute('keyTimes','0;1'); a.setAttribute('calcMode','linear'); }
    const mp=svgEl('mpath',{href:'#'+rec.id});
    // Older engines want the namespaced form; setting both is harmless.
    if(typeof mp.setAttributeNS==='function') mp.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href','#'+rec.id);
    a.append(mp);
    c.append(a);
    g.append(c);
  }
  svg.append(g);
  rec.dots=g;
}
/** The still form of the same statement: one arrowhead at the head of the run. */
function laneArrow(v, svg, rec){
  const el0=rec.el;
  const d=String(el0.getAttribute('d')||'');
  const m=d.match(/M([-\d.]+),([-\d.]+) C([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/);
  if(!m) return null;
  const n=m.slice(1).map(Number);
  // Where it points: the last control point into the end, or - on Impact - the
  // first control point back into the start.
  const [tipX,tipY,fromX,fromY] = v.direction==='up'
    ? [n[0],n[1],n[2],n[3]]
    : [n[6],n[7],n[4],n[5]];
  const ang=Math.atan2(tipY-fromY, tipX-fromX);
  const w=4.5, h=3.2;
  const pt=(dx,dy)=> (tipX+dx*Math.cos(ang)-dy*Math.sin(ang))+','+(tipY+dx*Math.sin(ang)+dy*Math.cos(ang));
  const tri=svgEl('path',{class:'farrow', fill:laneDotColor(v, rec),
    d:'M'+pt(0,0)+' L'+pt(-w,h)+' L'+pt(-w,-h)+' Z'});
  svg.append(tri);
  return tri;
}
// Only the connectors the reader can actually see are allowed to move: a lane
// that has been scrolled past is a few dozen SMIL timelines burning a frame
// budget on a picture nobody is looking at. The lane wrap is the viewport here,
// because that is the box the connectors scroll inside.
function laneFlowVisibility(v){
  const wrap=vwrap(v); if(!wrap) return;
  const box=wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
  if(!box) return;
  const top=-box.top, bottom=top+(window.innerHeight||900);
  for(const rec of v.paths){
    if(!rec.dots) continue;
    const d=String(rec.el.getAttribute('d')||'');
    const ys=[...d.matchAll(/,(-?[\d.]+)/g)].map((x)=>Number(x[1]));
    const lo=Math.min(...ys), hi=Math.max(...ys);
    const seen = !(hi<top-80 || lo>bottom+80);
    rec.dots.classList.toggle('off', !seen);
  }
}
/** Re-read the shared Flow preference on both lane views, without re-asking. */
function laneFlowRefresh(){
  for(const v of [FLOWV, IMPACTV]) if(v.resp && v.view==='lanes') drawChainLinks(v);
}
// The tab going away stops every dot on the page: SMIL keeps its own clock, and
// an <svg> can be told to hold it.
function laneFlowPause(hidden){
  for(const v of [FLOWV, IMPACTV]){
    const svg=vsvg(v); if(!svg) continue;
    try{ if(hidden) svg.pauseAnimations(); else svg.unpauseAnimations(); }catch(e){ /* a browser with no SMIL control: the dots keep running, which is not worth an error */ }
  }
}
// The chain THROUGH a row: what led to it, and what it leads to — not
// everything connected to it. Growing both ways at once leaks sideways: from a
// table back up to its statement and down again to every OTHER table that
// statement touches, until one hover lights the whole picture.
function flowHover(v, key){
  const keep=new Set([key]);
  const walk=(down)=>{ const seen=new Set([key]);
    for(let i=0;i<8;i++){ let grew=false;
      for(const l of v.paths){
        const a = down ? l.from : l.to, b = down ? l.to : l.from;
        if(seen.has(a)&&!seen.has(b)){ seen.add(b); keep.add(b); grew=true; } }
      if(!grew) break; } };
  walk(true);   // descendants
  walk(false);  // ancestors
  for(const [k,row] of v.rows) for(const e of row.els){ e.classList.toggle('hot',keep.has(k)); e.classList.toggle('dim',!keep.has(k)); }
  for(const l of v.paths){ const on=keep.has(l.from)&&keep.has(l.to); l.el.classList.toggle('hot',on); l.el.classList.toggle('dim',!on);
    // The chain being read owns the motion: its dots brighten and the rest
    // stop, so the eye follows one call instead of the whole picture.
    if(l.dots){ l.dots.classList.toggle('hot',on); l.dots.classList.toggle('off',!on); } }
}
function flowClearHover(v){
  for(const [,row] of v.rows) for(const e of row.els) e.classList.remove('hot','dim');
  for(const l of v.paths){ l.el.classList.remove('hot','dim');
    if(l.dots) l.dots.classList.remove('hot','off'); }
  laneFlowVisibility(v);
}
function flowSelect(v, key){
  v.sel = (v.sel===key) ? null : key;
  flowApplySel(v);
  renderChainSide(v);
}
function flowLineSample(g){
  const s=svgEl('svg',{width:38,height:9,'aria-hidden':'true'});
  const ln=svgEl('line',{x1:1,y1:4.5,x2:37,y2:4.5,stroke:gradeColor(g),'stroke-width':1.5});
  if(gradeDash(g)) ln.setAttribute('stroke-dasharray', gradeDash(g));
  s.append(ln); return s;
}
function renderChainSide(v){
  const r=v.resp; if(!r) return;
  const w=r.answer.walk||{}, side=vside(v);
  const kids=[];
  if(v.sel && v.rows.has(v.sel)) kids.push(flowCard(v, v.sel, v.rows.get(v.sel)));
  const counts=w.byLinkGrade||{};
  kids.push(el('div',{className:'panel'},[
    el('h2',{textContent:t('chain.legend.title')}),
    // The grade name and its badge are the ENGINE's; only the sentence beside
    // each one belongs to the page and is translated.
    el('ul',{className:'list'}, [['EXACT','chain.legend.exact'],['SOUND_SET','chain.legend.sound'],['HEURISTIC','chain.legend.heuristic']].map(([g,key])=>
      el('li',{},[ el('span',{style:'display:flex;align-items:center;gap:7px'},[flowLineSample(g), badge(g), el('span',{className:'comment',textContent:t(key)})]),
        el('span',{className:'count',textContent:t('chain.legend.links',{n:counts[g]||0})}) ]))),
    // `other` is only mentioned when there IS one — a reached node this view
    // has no lane for (an injected type, an outbound call, a screen).
    el('div',{className:'comment',style:'margin-top:8px',textContent:t('chain.walk.note',{walked:w.walked||0, depth:w.depth, mode:w.mode})
      +(w.other>0? t('chain.walk.other',{n:w.other}) : '')}),
    w.note? el('div',{className:'honesty',textContent:w.note}) : null
  ]));
  // The other view of the SAME target: Explore answers "which statements and
  // endpoints touch this column/table" in lists, where this tab draws it.
  const entry=r.answer.entry||{};
  if(v.direction==='up' && (entry.kind==='column'||entry.kind==='table')){
    kids.push(el('div',{className:'panel'},[
      el('div',{className:'comment'},[ t('chain.other.view'),
        el('button',{className:'mini',textContent:t('chain.other.explore'),title:t('chain.other.explore.title'),
          onclick:()=>{ activateTab('explore');
            entry.kind==='column' ? showColumn(entry.id) : showTable(entry.id); }}) ])
    ]));
  }
  kids.push(honesty(r, v.direction==='down'?'flow':'impact'));
  side.replaceChildren(...kids);
}
function flowCard(v, key, row){
  const d=row.data||{}, kind=row.kind;
  // The entry row's KIND is what the user is looking at (a statement target is a
  // statement, not a generic "entry"): treatments keyed on the kind must read
  // this, or the target of an Impact walk is the one row shown without its SQL.
  const cardKind = kind==='entry' ? (d.kind||'entry') : kind;
  const panel=el('div',{className:'panel fcard'});
  panel.append(el('div',{className:'srchead'},[
    el('span',{},[ el('span',{className:'tag',textContent: kind==='entry'? (d.kind||'entry') : kind}), ' ', row.grade?badge(row.grade):null ]),
    el('button',{className:'mini',textContent:'Clear',onclick:()=>flowSelect(v,key)}) ]));
  panel.append(el('code',{className:'id',style:'display:block;word-break:break-all;margin:7px 0 4px'},[key.slice(key.indexOf(':')+1)]));
  const meta=[ d.hops!=null?('hop '+d.hops):null,
    (kind==='entry'&&d.route)? ((d.httpMethod||'')+' '+d.route).trim() : null,
    (kind==='endpoint'&&d.handler)? ('handler '+(d.handlerShort||shortId('symbol:'+d.handler))) : null,
    // A screen has no file of its own: what a router declares is the COMPONENT
    // it mounts, and that is the file the Source button opens.
    (cardKind==='screen'&&d.component)? d.component : null,
    (cardKind==='screen'&&d.group)? ('group '+d.group) : null,
    (cardKind==='screen'&&d.title)? d.title : null,
    d.comment||null, d.owner||null,
    // WHICH PROJECT this row is in. Absent on every row of this project's own
    // walk, so a single-project page reads exactly as it always did.
    d.project? ('project '+d.project) : null,
    d.file? (d.file+(d.line?(':'+d.line):'')) : (kind==='service'&&d.external?t('chain.nosource'):null) ].filter(Boolean);
  if(meta.length) panel.append(el('div',{className:'comment',textContent:meta.join('\u00a0\u00a0')}));
  const body=el('div',{});
  const btns=el('div',{style:'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap'});
  // WHY this code is in the answer: the last edge of the walked path is the one
  // that led here, and the pane's footer carries its grade and its basis, so a
  // reader looking at the SQL does not have to come back for the reason.
  const led = Array.isArray(d.path) && d.path.length ? d.path[d.path.length-1] : null;
  const why = led ? ((led.evidence&&led.evidence.basis) || led.type || null) : null;
  // The card keeps a SIX-LINE excerpt, cut from the very answer the pane asked
  // for; it no longer holds a scrolling code box of its own.
  const showSrc=()=> srcOpen(key, {tab:v.name, grade:row.grade||null, basis:why, excerpt:body});
  if(kind==='table'){
    btns.append(el('button',{className:'mini',textContent:'ERD',onclick:()=>openErd(d.table)}),
      el('button',{className:'mini',textContent:'Table',onclick:()=>{ activateTab('explore'); showTable(d.table); }}),
      el('button',{className:'mini',textContent:'Graph',onclick:()=>openGraph(key)}));
  } else {
    btns.append(el('button',{className:'mini',textContent:'Source',onclick:showSrc}),
      el('button',{className:'mini',textContent:'Graph',onclick:()=>openGraph(key)}));
  }
  // The round trip: from a route back down the chain it runs through.
  if(kind==='endpoint') btns.append(el('button',{className:'mini',textContent:'Flow',title:t('btn.flow.title'),onclick:()=>openFlow({endpoint:d.id})}));
  // ...and from a SCREEN, the whole trip: the browser's own functions, the
  // routes they call, and the tables the request ends at. Impact is not offered
  // on a screen because a screen is the top of the chain: nothing is above it.
  if(kind==='screen') btns.append(el('button',{className:'mini',textContent:'Flow',title:t('btn.flow.screen.title'),onclick:()=>openFlow({screen:d.id})}));
  // …and the other way: from a row of the forward chain to "what else reaches
  // this?". Only offered on the Flow tab — on Impact you are already there.
  if(v.direction==='down'){
    const target = kind==='service'? {symbol:d.id} : kind==='statement'? {statement:d.id}
      : kind==='table'? {table:d.table} : (kind==='entry'&&d.kind==='symbol')? {symbol:key.slice(key.indexOf(':')+1)} : null;
    if(target) btns.append(el('button',{className:'mini',textContent:'Impact',title:t('btn.impact.title'),onclick:()=>openImpact(target)}));
  }
  // A ROW FROM ANOTHER PROJECT answers to another pack. Its source, its graph
  // and its impact are that project's questions, and every button here would
  // ask THIS project and get the wrong file or nothing at all. So the card says
  // where the row lives and how to go there, instead of offering a wrong answer.
  if(d.project) panel.append(el('div',{className:'comment',style:'margin-top:8px',textContent:t('chain.card.otherproject',{p:d.project})}));
  else panel.append(btns);
  if(cardKind==='statement' && d.tables && d.tables.length){
    panel.append(el('div',{className:'fsub',style:'margin-top:7px'}, d.tables.map(t=>
      el('span',{className:'tag '+(t.access==='read'?'read':'write'),title:t.access,textContent:t.table}))));
  }
  // THE PANE IS AN IDE PREVIEW, NOT A POPUP. It opens when the reader ASKS for
  // it (the button above, an Explore statement or method row, or a `src=` in
  // the link they followed) and then FOLLOWS every row they pick, in place. It
  // does not open itself over the card and the evidence rail the reader was
  // about to read, and one the reader has closed stays closed.
  if(srcIsOpen()) showSrc();
  if(Array.isArray(d.path)&&d.path.length){
    panel.append(el('h2',{style:'margin-top:12px',textContent: t(v.direction==='up' ? 'chain.path.up' : 'chain.path.down')}));
    panel.append(el('ol',{className:'fpath'}, d.path.map(e=>{
      const ev=e.evidence||{};
      const why=[ ev.iface?('iface '+ev.iface):null, ev.receiver?('receiver '+ev.receiver):null, ev.basis||null ].filter(Boolean).join('\u00a0\u00a0');
      return el('li',{},[
        el('div',{},[ el('span',{className:'id',textContent:shortId(e.from)+' → '+shortId(e.to)}), ' ', badge(e.grade) ]),
        el('div',{className:'comment',textContent:e.type+(why?('\u00a0\u00a0'+why):'')})
      ]);
    })));
  }
  panel.append(body);
  return panel;
}
// The typeahead. Walking down it lists ENDPOINTS (the tool's own list mode);
// walking up it flattens `search`'s three lists — a target can be a column, a
// table or a statement, and the chip says which so the kind is never guessed.
// WHAT the box would show for `q` — no DOM, no sequence, no side effects, so a
// caller that needs the list itself (the Draw button) can ask for it without
// racing the dropdown that is being closed under it. null = too short to search.
async function chainSuggestFetch(v, q){
  if(v.direction==='down'){
    // BOTH ENDS of the round trip, from the tool's own two list modes: the
    // routes a chain can be walked from, and the screens that call them. A
    // pack with no frontend answers the second with nothing, and the box then
    // reads exactly as it always did.
    const hasScreens=!!(OV.resp && OV.resp.answer && OV.resp.answer.screens);
    const [eps, scr]=await Promise.all([
      api('flow', q? {query:q, limit:50} : {limit:20}).then(r=>r.answer.entries||[], ()=>[]),
      hasScreens
        ? api('flow', q? {kind:'screen', query:q, limit:20} : {kind:'screen', limit:8}).then(r=>r.answer.entries||[], ()=>[])
        : Promise.resolve([]),
    ]);
    const items=[
      ...scr.map(s=>({value:s.screen, kind:'screen', sub:s.title||s.component||''})),
      ...eps.map(e=>({value:e.id, kind:'endpoint', sub:e.handlerShort||''})),
    ];
    // What you TYPED, if it is an id, is what you meant — whichever end it is.
    const hit=(x)=> x.value.toLowerCase()===String(q||'').toLowerCase() ? 0 : 1;
    items.sort((x,y)=> hit(x)-hit(y));   // stable: each list keeps its own order
    return items;
  }
  // The Graph tab focuses on ANY node, so its box offers both lists at once:
  // the endpoints (the flow tool's own list) and search's tables / columns /
  // statements. A method is typed as owner#name — nothing lists those.
  if(v.direction==='graph'){
    const q2=(q||'').trim();
    const [eps, s]=await Promise.all([
      api('flow', q2? {query:q2, limit:12} : {limit:8}).then(r=>r.answer.entries||[], ()=>[]),
      q2.length>=2 ? api('search',{query:q2, limit:12}).then(r=>r.answer, ()=>({})) : Promise.resolve({}),
    ]);
    const items=[
      ...(s.tables||[]).map(t=>({value:t.table, kind:'table', sub:t.comment||''})),
      ...(s.columns||[]).map(c=>({value:c.column, kind:'column', sub:c.comment||''})),
      ...eps.map(e=>({value:e.id, kind:'endpoint', sub:e.handlerShort||''})),
      ...(s.statements||[]).map(x=>({value:x.statement, kind:'statement', sub:''})),
    ];
    const GRANK={table:0, column:1, endpoint:2, statement:3};
    const hit=(x)=> x.value.toLowerCase()===q2.toLowerCase() ? 0 : 1;
    items.sort((x,y)=> (hit(x)-hit(y)) || (GRANK[x.kind]-GRANK[y.kind]));
    return items;
  }
  if(!q || q.length<2) return null;
  const s=(await api('search',{query:q, limit:20})).answer;
  const items=[
    ...(s.tables||[]).map(t=>({value:t.table, kind:'table', sub:t.comment||''})),
    ...(s.columns||[]).map(c=>({value:c.column, kind:'column', sub:c.comment||''})),
    ...(s.statements||[]).map(x=>({value:x.statement, kind:'statement', sub:''})),
  ];
  // What you TYPED, if it is an id, is what you meant — whatever kind it is.
  // Then the widest thing first: a table, then its columns, then statements.
  // (Typing "pms_product" used to bury the table itself under 20 of its own
  // columns, off the bottom of the box.)
  const KRANK={table:0, column:1, statement:2};
  const exact=(x)=> x.value.toLowerCase()===q.toLowerCase() ? 0 : 1;
  items.sort((x,y)=> (exact(x)-exact(y)) || (KRANK[x.kind]-KRANK[y.kind]));   // stable: keeps each list's own order
  return items;
}
// Put a resolved list ON SCREEN. Row 0 is marked `.cur` because Enter and Draw
// take it: whatever they would substitute is visible BEFORE it is taken.
function chainShowSug(v, items, q){
  const box=byId(v.sugId);
  // Kept past closeSug, tagged with the text it answered: the Draw button must
  // resolve the same way Enter does even after the box has closed — but never
  // from a list that answered some OTHER text.
  v.sugItems=items; v.sugCur=-1; v.sugRows=[]; v.sugMoved=false; v.sugLast={q, items};
  if(!items.length){ box.replaceChildren(); box.classList.add('hidden'); return; }
  // The kind chip is there whenever the list holds more than one kind: walking
  // down that is a pack with a frontend, where a screen path and a route both
  // start with a slash and the chip is the only thing telling them apart.
  const kinds=new Set(items.map(x=>x.kind));
  const sayKind = v.direction!=='down' || kinds.size>1;
  v.sugRows=items.map(it=> el('div',{className:'sugrow',onclick:()=>{
    byId(v.entryId).value=it.value; v.pick={kind:it.kind, value:it.value}; closeSug(v); chainDraw(v); }},[
    el('span',{className:'id',textContent:it.value}),
    el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
      el('span',{className:'comment',textContent:it.sub}),
      sayKind? el('span',{className:'tag',textContent:it.kind}) : null ]) ]));
  box.replaceChildren(...v.sugRows);
  box.classList.remove('hidden');
  v.sugCur=0; v.sugRows[0].classList.add('cur');
}
async function chainSuggest(v, q){
  const box=byId(v.sugId);
  const mine=++v.sugSeq;
  try{
    const items=await chainSuggestFetch(v, q);
    if(mine!==v.sugSeq) return;   // a later keystroke owns the dropdown now
    if(items===null){ box.replaceChildren(); box.classList.add('hidden'); return; }
    chainShowSug(v, items, q);
  }catch(e){ if(mine===v.sugSeq) box.classList.add('hidden'); }
}
function chainSugMove(v, d){
  const n=v.sugRows.length; if(!n) return;
  v.sugCur = v.sugCur<0 ? (d>0?0:n-1) : (v.sugCur+d+n)%n;
  v.sugMoved=true;   // an ARROWED row wins over the exact match below
  v.sugRows.forEach((row,i)=> row.classList.toggle('cur', i===v.sugCur));
  if(v.sugRows[v.sugCur].scrollIntoView) v.sugRows[v.sugCur].scrollIntoView({block:'nearest'});
}
// Commit whatever is in the entry box, ONE rule for Enter and for the Draw
// button: a partial value takes what the dropdown already resolved — typing
// "product/update/{" and pressing either must not query an id that cannot exist,
// and must never send that fragment as a GUESSED kind.
// (A value containing '#' is a method key, which the dropdown never lists.)
// Which picture a committed entry draws: the lane tabs redraw their chain, the
// Graph tab its neighbourhood. One typeahead, three tabs.
function chainDraw(v){ return v.draw ? v.draw(v) : drawChain(v); }
async function chainCommit(v){
  const input=byId(v.entryId);
  let raw=input.value.trim();
  let open=!byId(v.sugId).classList.contains('hidden');
  // Committing an EMPTY box asks for nothing. Taking the dropdown's first row
  // here would draw a target the user never typed or picked.
  if(!raw){ closeSug(v); chainDraw(v); return; }
  // Already resolved — a clicked row, or a handoff from another tab — commits
  // as it stands: re-resolving it would spend a request to learn what the kind
  // chip already says.
  const picked = !!(v.pick && v.pick.value===raw);
  // The open box if there is one; else the last list that answered THIS text
  // (the Draw button's own click closes the box before it runs).
  let list = (open && v.sugItems.length) ? v.sugItems
    : (v.sugLast && v.sugLast.q===raw ? v.sugLast.items : []);
  let seen = open;   // was the list about to be used ever ON SCREEN for this text?
  // …but the rows ON SCREEN may still be answering an EARLIER keystroke (the
  // 150ms debounce has not fired yet). Resolve against what was actually TYPED:
  // otherwise Draw right after typing "pms_product.pri" walks `pms_product`.
  if(!raw.includes('#') && !picked && !(v.sugLast && v.sugLast.q===raw)){
    // Typing ON while the answer is in flight used to DROP the Draw silently.
    // The text that is in the box when the answer lands is the one to resolve —
    // so resolve that one, rather than throwing the click away.
    for(let guard=0; guard<4; guard++){
      clearTimeout(v.sugTimer);
      let fresh;
      try{ fresh=await chainSuggestFetch(v, raw); }catch(e){ fresh=null; }
      const now=byId(v.entryId).value.trim();
      if(now===raw){ list=fresh||[]; v.sugLast={q:raw, items:list}; seen=false; open=false; break; }
      if(!now){ closeSug(v); chainDraw(v); return; }   // emptied while we waited
      raw=now;
      if(v.sugLast && v.sugLast.q===raw){ list=v.sugLast.items; seen=false; open=false; break; }
    }
  }
  let pick=null;
  if(list.length && !raw.includes('#')){
    // An ARROWED row wins; else the row that IS what was typed (so its kind chip
    // is kept and the engine is not asked to resolve the kind a second time).
    pick = (open && v.sugMoved && v.sugCur>=0) ? v.sugItems[v.sugCur] : (list.find(it=>it.value===raw) || null);
    if(!pick){
      // The text is still a fragment. Substituting the first match from a list
      // the user has NEVER SEEN draws somebody else's chain under their typing:
      // show the list instead, row 0 marked, and let the next Enter take it.
      if(!seen){ chainShowSug(v, list, raw); return; }
      pick = list[0];
    }
  }
  if(pick){ input.value=pick.value; v.pick={kind:pick.kind, value:pick.value}; }
  closeSug(v);   // …and the query still in flight cannot re-open it over the answer
  chainDraw(v);
}
// Every control of one lane tab, wired once for both.
function wireChainToolbar(v){
  byId(v.name==='flow'?'fdraw':'idraw').onclick = ()=>chainCommit(v);
  const input=byId(v.entryId);
  input.addEventListener('keydown', e=>{
    const box=byId(v.sugId), open=!box.classList.contains('hidden');
    // The dropdown owns the arrows while it is up. Closed, they belong to the
    // rail beside the picture.
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      if(open){ e.preventDefault(); chainSugMove(v, e.key==='ArrowDown'?1:-1); }
      else { e.preventDefault(); railMove(v.name, e.key==='ArrowDown'?1:-1); }
      return;
    }
    if(e.key!=='Enter') return;
    chainCommit(v);
  });
  // ONE box, two jobs: it still resolves what you type through the typeahead,
  // and it filters the rail from the rows already loaded, asking nothing.
  input.addEventListener('input', ()=>{ v.pick=null; clearTimeout(v.sugTimer); v.sugTimer=setTimeout(()=>chainSuggest(v, input.value.trim()),150);
    railFilterInput(v.name); });
  input.addEventListener('focus', ()=>{ if(!input.value.trim()) chainSuggest(v, ''); });
  byId(v.modeId).onchange = ()=>drawChain(v);
  byId(v.depthId).onchange = ()=>drawChain(v);
  // lanes | layers — two renderings of the SAME answer: no re-query on toggle.
  document.querySelectorAll('#'+v.segId+' button').forEach(b=> b.onclick=()=>{
    if(v.view===b.dataset.view) return;
    v.view=b.dataset.view;
    document.querySelectorAll('#'+v.segId+' button').forEach(x=> x.classList.toggle('on', x===b));
    if(v.resp) renderChain(v, v.resp);
  });
  vwrap(v).addEventListener('mouseleave', ()=>flowClearHover(v));
  document.addEventListener('click', (ev)=>{ if(!ev.target.closest('#'+v.sugId) && ev.target.id!==v.entryId) closeSug(v); });
}
