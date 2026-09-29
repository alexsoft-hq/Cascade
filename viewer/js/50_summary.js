// 50_summary.js — the map on Start: routes in boxes named by the rule that made them, and the table families they reach.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// THE WAY IN (RM67-U2c). This picture used to be a fold on the Overview, closed
// until asked. It is now the map on Start, drawn once Start is on screen (the
// `summary` tool walks every route, and a reader who opened a link to one route
// should not wait for it). Two columns of boxes joined by one line per group
// and family, as thick as the tables behind it and dashed by the weakest grade
// on the way. The line over it says what the boxes are grouped by.
//   - A box opens IN PLACE into what it holds, and the picture keeps only the
//     lines that run through it.
//   - A route or a table inside an open box shows only the paths through THAT
//     node: the tool's own `through`, from the same walk as the boxes, so no
//     line is drawn that the walk did not take.
//   - The breadcrumb over the picture goes back a step at a time.
//   - Every route and table has a button into Trace with that target.
const SUM = { resp:null, seq:0, mode:'conservative', asking:null, byMode:new Map(), sel:null, node:null,
  through:new Map(), all:false, host:null, rowEls:new Map(), drawn:null };
// The folded box's name on both sides, as the engine writes it (src/core/summary.mjs OTHERS).
const SUM_OTHERS = '(others)';
const SUM_ROWS = 20;      // rows an open box lists before "show all"
const SUM_MEMBERS = 8;    // members a path lists beside the picture before its fold
const SUM_MODE_KEY = { strict:'mode.strict', conservative:'mode.conservative', heuristic:'mode.heuristic' };
const SUM_MODE_GRADE = { strict:'EXACT', conservative:'SOUND_SET', heuristic:'HEURISTIC' };
// WHAT A BOX ON THE LEFT IS CALLED (RM67-U2d), by the rule the answer names.
// The header counts API groups by path; a box grouped by where the handler
// code sits is a code area, one the profile declares a module, and a box cut
// from the path below a shared prefix a path area. None is a bare "group", so
// two numbers on one page never share one word. A path rule with no shared
// prefix to go below is the header's own API groups.
const SUM_NOUN = { 'code-path':['summary.noun.area','summary.nouns.area'], declared:['summary.noun.module','summary.nouns.module'],
  lane:['summary.noun.api','summary.nouns.api'], path:['summary.noun.path','summary.nouns.path'] };
/** The name of the boxes on the left in the answer on screen, as `{noun, nouns}` for a string to take. */
function summaryNouns(){
  const g=(SUM.resp && SUM.resp.answer.rule.groups) || {};
  const [one, many]=(g.kind==='path' && (!g.commonPath || g.commonPath==='/')) ? SUM_NOUN.lane : (SUM_NOUN[g.kind] || SUM_NOUN.path);
  return { noun:t(one), nouns:t(many) };
}

/** Start came on screen: ask for the map once, or draw the one in memory. */
function summaryOnScreen(){
  const host=byId('ovsummary');
  if(!host || SNAP) return;
  SUM.host=host;
  // One question in flight is enough: the landing answer and the place coming
  // on screen both call here, and neither may ask it twice.
  if(SUM.resp) renderSummary(); else if(SUM.asking!==SUM.mode) loadSummary();
}
async function loadSummary(){
  const mine=++SUM.seq, mode=SUM.mode;
  if(SUM.byMode.has(mode)){ SUM.resp=SUM.byMode.get(mode); renderSummary(); return; }
  SUM.asking=mode;
  SUM.host.replaceChildren(el('h2',{textContent:t('summary.title')}), el('div',{className:'empty',textContent:t('summary.loading')}));
  let r;
  try{ r=await api('summary',{ mode }); }
  catch(e){ if(stale(e)||mine!==SUM.seq) return; SUM.asking=null; SUM.host.replaceChildren(el('h2',{textContent:t('summary.title')}), errPanel(e)); return; }
  if(mine!==SUM.seq) return;
  SUM.asking=null; SUM.byMode.set(mode, r); SUM.resp=r;
  renderSummary();
}
/** Everything the map held for the project being left. */
function summaryReset(){
  SUM.seq++; SUM.resp=null; SUM.byMode.clear(); SUM.through.clear(); SUM.asking=null;
  SUM.sel=null; SUM.node=null; SUM.all=false; SUM.drawn=null; SUM.mode='conservative';
  if(SUM.host) SUM.host.replaceChildren();
}
/** Another mode is another walk: its own boxes, kept apart, asked once. */
function summarySetMode(mode){
  if(!Object.hasOwn(MODE_ADMITS, mode) || mode===SUM.mode) return;
  SUM.mode=mode;
  loadSummary();
  if(SUM.node && !SUM.through.has(summaryThroughKey())) loadThrough();
}

// ---- what is picked ----------------------------------------------------------
/** Open a box (`g:<group>` or `f:<family>`), or close the one open; null is the whole map. */
function summarySelect(id){
  SUM.sel = SUM.sel===id ? null : id;
  SUM.node=null; SUM.all=false;
  renderSummary();
}
/** Pick a route or a table inside the open box: only its paths are drawn. */
function summaryPickNode(node){
  SUM.node = SUM.node===node ? null : node;
  renderSummary();
  if(SUM.node && !SUM.through.has(summaryThroughKey())) loadThrough();
}
const summaryThroughKey=()=> SUM.mode+'|'+SUM.node;
async function loadThrough(){
  const node=SUM.node, key=summaryThroughKey();
  const at=node.indexOf(':');
  let r;
  try{ r=await api('summary',{ mode:SUM.mode, [node.slice(0, at)]:node.slice(at+1) }); }
  catch(e){ if(stale(e)) return; r={ error:e }; }
  SUM.through.set(key, r);
  if(SUM.node===node) renderSummary();
}
/** The paths through the picked node in the mode on screen, once they are in. */
function summaryThroughNow(){
  const r=SUM.node ? SUM.through.get(summaryThroughKey()) : null;
  return (r && !r.error) ? r.answer.through : null;
}
/** A box the answer no longer has (another mode, another project) is not picked. */
function summaryValidate(a){
  const names=new Set([...a.groups.map((g)=> 'g:'+g.name), ...a.families.map((f)=> 'f:'+f.name),
    ...(a.otherGroups.groups ? ['g:'+SUM_OTHERS] : []), ...(a.otherFamilies.families ? ['f:'+SUM_OTHERS] : [])]);
  if(SUM.sel && !names.has(SUM.sel)){ SUM.sel=null; SUM.node=null; }
}

// ---- the picture -------------------------------------------------------------
function renderSummary(){
  const r=SUM.resp, host=SUM.host; if(!r || !host) return;
  const a=r.answer;
  summaryValidate(a);
  const boxes=new Map();
  SUM.rowEls=new Map();
  const lit=summaryLit(a);
  const left=el('div',{className:'sumcol'}, summaryGroupBoxes(a, boxes, lit));
  const right=el('div',{className:'sumcol'}, summaryFamilyBoxes(a, boxes, lit));
  const svg=svgEl('svg',{class:'sumlinks'});
  const picture=el('div',{className:'sumpic'},[left, el('div',{className:'sumgap'}), right, svg]);
  setKids(host, summaryHead(a), summaryCrumbs(), summaryEmptyNote(a),
    el('div',{className:'sumgrid'},[picture, el('div',{className:'flowside'},[summaryDetail(a), honesty(r, 'summary')])]));
  SUM.drawn={ a, picture, svg, boxes };
  requestAnimationFrame(()=> summaryRedraw());
}
/** Draw the lines again where the boxes are now: a resize, a scrolled list. */
function summaryRedraw(){
  const d=SUM.drawn;
  if(d && d.picture.isConnected!==false) drawSummaryLinks(d.a, d.picture, d.svg, d.boxes);
}
/** The title, the mode it was walked in, and what made the boxes. */
function summaryHead(a){
  const sel=el('select',{id:'summode', title:t('summary.mode.title'), onchange:(e)=> summarySetMode(e.target.value)},
    Object.keys(SUM_MODE_KEY).map((m)=> el('option',{value:m, textContent:t(SUM_MODE_KEY[m])+' ('+SUM_MODE_GRADE[m]+')'})));
  sel.value=SUM.mode;
  return el('div',{className:'sumtop'},[
    el('div',{className:'sumtitle'},[ el('h2',{textContent:t('summary.title')}), sel ]),
    el('div',{className:'panelsub',textContent:summaryRuleLine(a)}) ]);
}
// WHAT THE BOXES ARE GROUPED BY, one sentence per rule the engine names
// (`answer.rule`), and a second wording for a rule with no shared prefix to
// name, so the line never reads "below -".
const SUM_RULE_KEY = { declared:'summary.rule.declared', 'code-path':'summary.rule.code', lane:'summary.rule.lane',
  path:'summary.rule.path', 'name-words':'summary.rule.words', 'name-letters':'summary.rule.letters' };
const SUM_RULE_TOP = { 'code-path':'summary.rule.code.top', path:'summary.rule.path.top',
  'name-words':'summary.rule.words.top', 'name-letters':'summary.rule.letters.top' };
/** What made the boxes, in the page's words around the engine's values. */
function summaryRuleLine(a){
  const g=a.rule.groups, f=a.rule.tables;
  return summaryRuleSay(g.kind, g.kind==='path' ? g.commonPath : g.commonPrefix, g.packageDepth)+' '+summaryRuleSay(f.kind, f.commonPrefix);
}
function summaryRuleSay(kind, prefix, n){
  const bare=!prefix || prefix==='/';
  return t((bare && SUM_RULE_TOP[kind]) || SUM_RULE_KEY[kind] || SUM_RULE_KEY.path, { prefix, n });
}
/** The way back, a step at a time: the whole map, the open box, the picked node. */
function summaryCrumbs(){
  const crumbs=[{ text:t('summary.crumb.all'), go: SUM.sel ? ()=> summarySelect(null) : null }];
  if(SUM.sel) crumbs.push({ text:t(SUM.sel[0]==='g' ? 'summary.crumb.group' : 'summary.crumb.family', {name:SUM.sel.slice(2), ...summaryNouns()}),
    go: SUM.node ? ()=> summaryPickNode(null) : null });
  if(SUM.node) crumbs.push({ text:SUM.node.slice(SUM.node.indexOf(':')+1), go:null });
  const nav=el('nav',{className:'sumcrumbs'});
  nav.setAttribute('aria-label', t('summary.crumb.title'));
  crumbs.forEach((c, i)=>{
    if(i) nav.append(el('span',{className:'sumsep'},[foldChevron()]));
    nav.append(c.go ? el('button',{type:'button', className:'sumcrumb', textContent:c.text, onclick:c.go})
      : el('span',{className:'sumcrumb here', textContent:c.text}));
  });
  return nav;
}
/**
 * A map with no line says why, in this answer's own numbers: no route at all,
 * or routes whose walks stopped at this mode's floor, with the wider mode that
 * would walk them (ghostfolio's routes are graded HEURISTIC, so a conservative
 * walk stops at every one of them).
 */
function summaryEmptyNote(a){
  if(a.links.length) return null;
  if(!a.totals.endpoints) return el('div',{className:'empty',textContent:t('summary.none.routes')});
  const w=a.walk||{}, by=w.byModeGrades||{};
  const wider=chainWiderMode(a.mode, by);
  const grades=Object.keys(by).filter((g)=> by[g]>0).join(', ');
  return el('div',{className:'sumempty'},[
    el('span',{textContent: w.byMode>0 ? t('summary.none.floor',{mode:a.mode, n:ovNum(w.byMode), grades}) : t('summary.none.tables',{mode:a.mode})}),
    wider ? el('button',{type:'button', className:'mini', textContent:t('chain.empty.switch',{mode:wider}), onclick:()=> summarySetMode(wider)}) : null,
    summaryRouteFix(a.mode, by) ]);
}
/** Do the routes' own addresses carry a grade this map's walks left out? */
const summaryGuessCut=(by, rg)=> Object.keys(by).some((g)=> by[g]>0 && rg[g]>0);
/**
 * WHEN THE ROUTES THEMSELVES ARE GUESSES at a grade this map left out, the
 * notice says so in the overview's own count and carries the engine's fix for
 * them (RM67-U2d): on ghostfolio every route stops at itself, and the reason is
 * one profile key a reader can declare.
 */
function summaryRouteFix(mode, by){
  const a=OV.resp ? OV.resp.answer : null, guessed=a ? ovRoutesGuessed({ mode, reach:a.reach }) : null;
  if(!guessed || !summaryGuessCut(by, a.reach.routeGrades || {})) return null;
  return el('div',{className:'sumroutefix'},[ el('span',{textContent:guessed}), remedyLine(a.routeRemedy) ]);
}

// ---- the boxes ---------------------------------------------------------------
/**
 * Which boxes stay lit: all of them with nothing picked; the open box and the
 * ones its lines reach; with a node picked, the ones its own paths reach.
 * null means nothing is dimmed.
 */
function summaryLit(a){
  if(!SUM.sel) return null;
  const g=SUM.sel[0]==='g', name=SUM.sel.slice(2), th=summaryThroughNow();
  const other = th ? th.links.map((l)=> (g ? l.family : l.group))
    : a.links.filter((l)=> (g ? l.group : l.family)===name).map((l)=> (g ? l.family : l.group));
  return g ? { g:new Set([name]), f:new Set(other) } : { g:new Set(other), f:new Set([name]) };
}
function summaryGroupBoxes(a, boxes, lit){
  const out=a.groups.map((g)=> summaryBox(boxes, lit, 'g', g.name, t('summary.group.sub',{routes:g.endpoints.length, tables:g.tables}), g.endpoints));
  if(a.otherGroups.groups) out.push(summaryBox(boxes, lit, 'g', SUM_OTHERS,
    t('summary.others.groups',{n:a.otherGroups.groups, routes:a.otherGroups.endpoints.length, ...summaryNouns()}), a.otherGroups.endpoints, 'sumothers'));
  return out;
}
function summaryFamilyBoxes(a, boxes, lit){
  // A family says how many routes reach it, which is what the families are kept by.
  const out=a.families.map((f)=> summaryBox(boxes, lit, 'f', f.name,
    t(f.routes!=null ? 'summary.family.sub.routes' : 'summary.family.sub',{tables:f.tables.length, routes:f.routes}), f.tables));
  if(a.otherFamilies.families) out.push(summaryBox(boxes, lit, 'f', SUM_OTHERS,
    t('summary.others.families',{n:a.otherFamilies.families, tables:a.otherFamilies.tables.length}), a.otherFamilies.tables, 'sumothers'));
  return out;
}
/** One box: a head that opens and closes it, and, open, the routes or tables it holds. */
function summaryBox(boxes, lit, kind, name, sub, members, extra){
  const id=kind+':'+name, open=SUM.sel===id;
  const head=el('button',{type:'button', className:'sumhead', title:t(open ? 'summary.box.close' : 'summary.box.open'),
    onclick:()=> summarySelect(id)}, [ el('span',{className:'sumname',textContent:name}), el('span',{className:'count',textContent:sub}) ]);
  head.setAttribute('aria-expanded', String(open));
  const dim=!!lit && !lit[kind].has(name);
  const box=el('div',{className:'sumbox'+(extra ? ' '+extra : '')+(open ? ' open' : '')+(dim ? ' dim' : '')}, [head]);
  if(open) box.append(summaryBoxRows(members));
  boxes.set(id, head);
  return box;
}
/** What an open box holds, the first rows and then all of them on request. */
function summaryBoxRows(members){
  const shown=SUM.all ? members : members.slice(0, SUM_ROWS);
  const list=el('div',{className:'sumrows'}, shown.map(summaryRow));
  list.onscroll=()=> requestAnimationFrame(()=> summaryRedraw());
  if(members.length>shown.length) list.append(el('button',{type:'button', className:'mini sumall',
    textContent:t('summary.rows.all',{n:members.length}), onclick:()=>{ SUM.all=true; renderSummary(); }}));
  return list;
}
/** One route or table: pick it to see its paths; the button beside it goes into Trace. */
function summaryRow(id){
  const at=id.indexOf(':'), kind=id.slice(0, at), key=id.slice(at+1), dir=kind==='endpoint' ? 'down' : 'up';
  const pick=el('button',{type:'button', className:'sumrow'+(SUM.node===id ? ' sel' : ''), title:t('summary.row.title',{id:key}),
    onclick:()=> summaryPickNode(id)}, kind==='endpoint' ? pathLabel(key) : nameSplit(key));
  const go=el('button',{type:'button', className:'mini sumtrace', textContent:t('btn.trace'),
    title:t(TRACE_DIR_TITLE[dir]), onclick:()=> openTrace({ kind, id:key }, dir)});
  const row=el('div',{className:'sumrowwrap'},[pick, go]);
  SUM.rowEls.set(id, row);
  return row;
}

// ---- the lines -----------------------------------------------------------------
/** One line per link, from its group's box to its family's box, measured from the page. */
function drawSummaryLinks(a, picture, svg, boxes){
  if(!picture.getBoundingClientRect || picture.offsetParent===null) return;
  const pr=picture.getBoundingClientRect();
  svg.setAttribute('width', pr.width); svg.setAttribute('height', pr.height);
  svg.replaceChildren(...summaryLines(a, boxes).map((l)=> summaryPath(l, pr)).filter(Boolean));
}
/** The lines on screen: every link, the open box's own, or the paths through the picked node. */
function summaryLines(a, boxes){
  const th=summaryThroughNow();
  if(th) return summaryThroughLines(th, boxes);
  return a.links.filter((l)=> !SUM.sel || SUM.sel==='g:'+l.group || SUM.sel==='f:'+l.family)
    .map((l)=> ({ from:boxes.get('g:'+l.group), to:boxes.get('f:'+l.family), grade:l.grade, weight:l.tables,
      group:l.group, family:l.family, tip:t('summary.link.title',{tables:l.tables, routes:l.endpoints, grade:l.grade}) }));
}
/** A route's lines run from its row to each family it reaches; a table's from each group to its row. */
function summaryThroughLines(th, boxes){
  const row=SUM.rowEls.get(th.node);
  if(th.node.startsWith('endpoint:')) return th.links.map((l)=> ({ from:row, to:boxes.get('f:'+l.family), grade:l.grade,
    weight:l.tables.length, group:th.group, family:l.family, tip:t('summary.through.route.title',{n:l.tables.length, grade:l.grade}) }));
  return th.links.map((l)=> ({ from:boxes.get('g:'+l.group), to:row, grade:l.grade,
    weight:l.endpoints.length, group:l.group, family:th.family, tip:t('summary.through.table.title',{n:l.endpoints.length, grade:l.grade, ...summaryNouns()}) }));
}
function summaryPath(l, pr){
  if(!l.from || !l.to) return null;
  const f=summaryAnchor(l.from), g=summaryAnchor(l.to);
  const x1=f.right-pr.left, y1=f.mid-pr.top, x2=g.left-pr.left, y2=g.mid-pr.top, dx=(x2-x1)/2;
  const p=svgEl('path',{ d:'M'+x1+','+y1+' C'+(x1+dx)+','+y1+' '+(x2-dx)+','+y2+' '+x2+','+y2, fill:'none',
    stroke:cssVar('--edge'), 'stroke-width':String(1+Math.min(6, Math.log2(1+l.weight))), opacity:'0.85',
    'data-group':l.group||'', 'data-family':l.family||'', 'data-grade':l.grade||'' });
  if(gradeDash(l.grade)) p.setAttribute('stroke-dasharray', gradeDash(l.grade));
  const tip=svgEl('title');
  tip.textContent=l.tip;
  p.append(tip);
  return p;
}
/** Where a line meets an element: its edges, and its middle kept inside a list that scrolls. */
function summaryAnchor(node){
  const r=node.getBoundingClientRect();
  const list=node.closest ? node.closest('.sumrows') : null;
  let mid=r.top+r.height/2;
  if(list){ const lr=list.getBoundingClientRect(); mid=Math.max(lr.top+4, Math.min(lr.bottom-4, mid)); }
  return { left:r.left, right:r.right, mid };
}

// ---- beside the picture ------------------------------------------------------------
/** What the reader picked, said beside the picture: nothing, a box, or one node's paths. */
function summaryDetail(a){
  if(SUM.node) return summaryNodeCard();
  if(SUM.sel) return summaryBoxCard(a);
  return el('div',{className:'panel'},[ el('div',{className:'comment',textContent:t('summary.pick')}),
    el('div',{className:'count',style:'margin-top:6px',textContent:t('summary.totals',{...summaryNouns(), routes:ovNum(a.totals.endpoints),
      groups:ovNum(a.totals.groups), families:ovNum(a.totals.families), tables:ovNum(a.totals.tablesReached)})}) ]);
}
/** An open box: the boxes across from it that its lines reach, each a way to open that one. */
function summaryBoxCard(a){
  const g=SUM.sel[0]==='g', name=SUM.sel.slice(2);
  const links=a.links.filter((l)=> (g ? l.group : l.family)===name);
  const other=(l)=> (g ? l.family : l.group);
  return el('div',{className:'panel sumdetail'},[
    el('h2',{textContent:t(g ? 'summary.crumb.group' : 'summary.crumb.family', {name, ...summaryNouns()})}),
    el('div',{className:'comment',textContent:t(g ? 'summary.box.group.lead' : 'summary.box.family.lead', summaryNouns())}),
    el('ul',{className:'list'}, links.length ? links.map((l)=> el('li',{},[
      el('a',{className:'id clickable', textContent:other(l), onclick:()=> summarySelect((g ? 'f:' : 'g:')+other(l))}),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        el('span',{className:'count',textContent:t('summary.link.row',{tables:l.tables, routes:l.endpoints})}), badge(l.grade) ]) ]))
      : [el('li',{className:'empty',textContent:t('summary.box.none')})]) ]);
}
/** One node: every way into Trace, then the paths through it, each with its members. */
function summaryNodeCard(){
  const at=SUM.node.indexOf(':'), kind=SUM.node.slice(0, at), key=SUM.node.slice(at+1);
  const r=SUM.through.get(summaryThroughKey());
  const head=[ el('h2',{},[ kindGlyph(TRACE_GLYPH[kind], 12), ' ', el('code',{className:'id',style:'overflow-wrap:anywhere',textContent:key}) ]),
    el('div',{className:'sumgo'}, ['down','up','detail'].map((d)=> traceButton(kind, key, d)).filter(Boolean)) ];
  const body = !r ? el('div',{className:'empty',textContent:t('summary.through.loading')})
    : r.error ? errPanel(r.error) : summaryThroughList(r.answer.through, kind);
  return el('div',{className:'panel sumdetail'},[...head, body]);
}
function summaryThroughList(th, kind){
  const route=kind==='endpoint';
  if(!th.links.length) return el('div',{className:'empty',textContent:t(route ? 'summary.through.none.route' : 'summary.through.none.table',{mode:SUM.mode})});
  return el('div',{className:'sumpaths'},[ el('div',{className:'comment',textContent:t(route ? 'summary.through.route.lead' : 'summary.through.table.lead',{mode:SUM.mode, ...summaryNouns()})}),
    ...th.links.map((l)=> el('div',{className:'sumpath'},[
      el('div',{className:'sumpathhead'},[ el('span',{className:'sumname',textContent:route ? l.family : l.group}), badge(l.grade),
        el('span',{className:'count',textContent:t(route ? 'summary.through.tables' : 'summary.through.routes',{n:(route ? l.tables : l.endpoints).length})}) ]),
      summaryMembers(route ? l.tables : l.endpoints) ])) ]);
}
/** A path's routes or tables, the first few and the rest under a fold, each a way into Trace. */
function summaryMembers(ids){
  const row=(id)=>{ const at=id.indexOf(':'), k=id.slice(0, at), key=id.slice(at+1);
    return el('li',{},[ el('span',{className:'id',title:key,textContent:key}), traceButton(k, key, k==='endpoint' ? 'down' : 'up') ]); };
  const rest=ids.slice(SUM_MEMBERS);
  return el('ul',{className:'list'},[ ...ids.slice(0, SUM_MEMBERS).map(row),
    rest.length ? el('li',{},[ fold('summary.members', [t('summary.members.more',{n:rest.length})], ()=> [el('ul',{className:'list'}, rest.map(row))]) ]) : null ].filter(Boolean));
}
