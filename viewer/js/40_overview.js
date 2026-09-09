// 40_overview.js — the Overview tab: the pack at a glance, from ONE answer.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

const ovNum = (n)=> n==null ? '—' : Number(n).toLocaleString('en-US');
// The engine's own name for a long id: the last two dotted segments. The full
// id travels in the title, so nothing is lost by shortening the chip.
const ovShort = (id)=> String(id).split('.').slice(-2).join('.');
const ovTotal = (r, field, fallback)=>{
  const f = (r.truncated && (r.truncated.fields||[]).find(x=>x.field===field));
  return f ? f.total : fallback;
};

async function loadOverview(){
  const cards=byId('ovcards'), panels=byId('ovpanels'), side=byId('ovside');
  cards.replaceChildren(el('div',{className:'panel',textContent:t('load.overview')}));
  panels.replaceChildren(); side.replaceChildren();
  let r;
  try { r=await api('overview',{}); }
  catch(e){ if(stale(e)) return; cards.replaceChildren(errPanel(e)); return; }
  OV.resp=r;
  OV.screens=null;
  renderOverview();
  // THE ONE EXTRA REQUEST THIS TAB MAKES, and only where there is something to
  // ask about: the busiest screens, from the same `browse kind=screen` list the
  // Explore rail draws. The overview answer carries the screen CENSUS but no
  // per-screen rows, and the page must not invent them. Drawn when it lands, so
  // nothing on this tab waits for it.
  if(!r.answer.screens) return;
  const mine=STATE.seq, forProject=STATE.project;
  let b;
  try { b=await api('browse',{kind:'screen', sort:'tables', limit:OV_HUB_TOP}); }
  catch(e){ return; }
  if(mine!==STATE.seq || forProject!==STATE.project || OV.resp!==r) return;
  OV.screens=b;
  renderOverview();
}
function renderOverview(){
  const r=OV.resp; if(!r) return;
  const a=r.answer;
  byId('ovcards').replaceChildren(...ovKpis(a));
  byId('ovhero').classList.remove('hidden');
  byId('ovherocol').replaceChildren(ovHubBars(r,a), ovGapsPanel(a), ovConnectedPanel(a), ovGradesPanel(a));
  // The ribbon is NOT deleted: it is the drawing theme's own picture of the same
  // four numbers, one click below the dials that replaced it.
  byId('ovfold').replaceChildren(el('div',{className:'panel ovfoldwrap'},[
    fold('ov.ribbon', [t('ribbon.title')], ()=> [ovRibbon(a)]) ]));
  byId('ovpanels').replaceChildren(ovNodesPanel(a), ovEdgesPanel(a),
    ovCodePanel(a), ovHubEndpoints(r,a), ovHubScreens(a));
  byId('ovside').replaceChildren(honesty(r, 'overview'));
  // The screens layer's default is a COUNT, and the count is on THIS answer. A
  // map drawn before it landed (a deep link straight to the Graph tab) was
  // asked for without the layer, so it is asked again — once, and only where
  // the decision is "on". Everywhere else this costs nothing.
  mapScreensDecide();
  if(GMAP.askedScreens!==undefined && GMAP.askedScreens!==GMAP.screens) drawMap();
  else if(GMAP.resp && GMAP.api) renderMapChips();
  renderCascadeRail();
  renderMastChrome();
  ovMapMount();
}

// ---- the hero, row 1: four KPI dials ---------------------------------------
// The SAME four numbers the ribbon was drawn from — `overview.answer.reach`,
// field for field — read as "how much of this lane is wired". The page does one
// division and one rounding; it walks nothing and counts nothing.
// THE FIFTH DIAL is the far end of the round trip, and it is drawn only where
// the answer carries a `screens` block: an axis that never ran has no share to
// show, and a 0% dial there would say the frontend reaches nothing when the
// truth is that no frontend was analyzed.
// `fed` is the SECOND number a project whose requests are answered elsewhere
// has to say: how many of its own routes or screens reach a table in a
// CONNECTED project (`overview.reach.viaFederation`, RM47). The dial keeps this
// project's own share, because that is what a share of this project means; the
// subtitle then reads "0 here, 8 in connected projects" instead of "8 reach
// none", which is true of one pack and false of the product.
const OV_KPI = [
  { kind:'endpoint',  lbl:'kpi.endpoints',  rest:'kpi.rest.endpoints',
    has:()=> true,
    of:(a)=> (a.reach||{}).endpoints||0,
    fed:(a)=> ((a.reach||{}).viaFederation||{}).endpoints||0,
    got:(a)=> ((a.reach||{}).endpoints||0)-((a.reach||{}).endpointsWithoutStatement||0) },
  { kind:'statement', lbl:'kpi.statements', rest:'kpi.rest.statements',
    has:()=> true,
    of:(a)=> (a.reach||{}).statements||0, got:(a)=> (a.reach||{}).statementsReached||0 },
  { kind:'table',     lbl:'kpi.tables',     rest:'kpi.rest.tables',
    has:()=> true,
    of:(a)=> (a.reach||{}).tables||0,     got:(a)=> (a.reach||{}).tablesReached||0 },
  { kind:'column',    lbl:'kpi.columns',    rest:'kpi.rest.columns',
    has:()=> true,
    of:(a)=> (a.reach||{}).columns||0,    got:(a)=> (a.reach||{}).columnsReached||0 },
  { kind:'screen',    lbl:'kpi.screens',    rest:'kpi.rest.screens',
    has:(a)=> !!a.screens,
    fed:(a)=> ((a.reach||{}).viaFederation||{}).screens||0,
    of:(a)=> (a.screens||{}).screens||0,  got:(a)=> (a.screens||{}).reachingATable||0,
    // A router the SERVER fills in at run time makes the denominator itself a
    // lower bound, and a share of a lower bound has to say so on the card.
    note:(a)=> ((a.screens||{}).serverDriven ? 'kpi.screens.serverdriven' : null) },
];
const KPI_R=26, KPI_C=2*Math.PI*KPI_R;
function ovKpis(a){
  return OV_KPI.filter((k)=>k.has(a)).map((k)=>{
    const total=k.of(a), got=k.got(a), rest=Math.max(0, total-got);
    const pct = total ? Math.round(got/total*100) : 0;
    // The connected number, when there is one and it has something to say.
    const there = k.fed ? k.fed(a) : 0;
    const tail = there>0 ? t('kpi.fed',{here:ovNum(got), there:ovNum(there)}) : t(k.rest,{n:ovNum(rest)});
    const card=el('div',{className:'kpi', style:'color:'+kindColor(k.kind)},[
      el('div',{className:'kpilbl',textContent:t(k.lbl)}),
      el('div',{className:'kpinum'},[ ovNum(got===0&&total===0?0:pct),
        el('span',{className:'kpipct',textContent:'%'}) ]),
      el('div',{className:'kpiden',
        textContent: ovNum(got)+' / '+ovNum(total)+'\u00a0\u00a0'+tail}),
      (k.note && k.note(a)) ? el('div',{className:'kpinote',textContent:t(k.note(a))}) : null,
    ]);
    // The arc: the same share, drawn. `stroke-dasharray` is the share of the
    // circumference, so the gauge cannot disagree with the number beside it.
    const svg=svgEl('svg',{class:'kpidial', width:64, height:64, viewBox:'0 0 64 64','aria-hidden':'true'});
    svg.append(svgEl('circle',{class:'kpitrack', cx:32, cy:32, r:KPI_R, fill:'none','stroke-width':7}));
    svg.append(svgEl('circle',{class:'kpiarc', cx:32, cy:32, r:KPI_R, fill:'none','stroke-width':7,
      'stroke-linecap':'round', transform:'rotate(-90 32 32)',
      'stroke-dasharray':(KPI_C*pct/100).toFixed(1)+' '+(KPI_C*2).toFixed(1)}));
    card.append(svg);
    card.setAttribute('aria-label', t(k.lbl)+': '+pct+'% — '+ovNum(got)+' / '+ovNum(total));
    return card;
  });
}

// ---- the hero, row 2: what the map cannot say ------------------------------
// The busiest tables, as bars: the name in the table hue, the bar the share of
// the busiest one, the count its own. `hubs.tables` is the answer's, in the
// answer's order; the rest of what it carries opens under the five.
const OV_BAR_TOP=5;
function ovHubBars(r,a){
  const rows=(a.hubs&&a.hubs.tables)||[];
  const total=ovTotal(r,'hubs.tables',rows.length);
  const kids=[ el('h2',{},[t('ov.hubtables.title')+' ',
    el('span',{className:'count',textContent:'('+total+')'})]),
    el('div',{className:'panelsub',textContent:t('ov.hubtables.by')}) ];
  if(!rows.length){
    kids.push(el('div',{className:'empty',textContent:emptyText({hubs:ovHubEmpty(a)},'hubs')}));
    return el('div',{className:'panel'},kids);
  }
  const top=rows.reduce((m,x)=>Math.max(m,x.endpoints||0),0)||1;
  const bar=(x)=> el('div',{className:'ovbar'},[
    el('b',{title:x.table,textContent:x.table}),
    el('span',{className:'ovbartrack'},[ el('i',{style:'width:'+(100*(x.endpoints||0)/top).toFixed(1)+'%'}) ]),
    el('button',{className:'ovbarn mini',
      title:t('btn.impact.table.title'),
      onclick:()=>openImpact({table:x.table}), textContent:ovNum(x.endpoints)}) ]);
  for(const x of rows.slice(0,OV_BAR_TOP)) kids.push(bar(x));
  if(rows.length>OV_BAR_TOP) kids.push(el('div',{className:'ovhubmore'},[
    fold('ov.hubtables.rest', [t('ov.hub.more',{n:rows.length-OV_BAR_TOP, total})],
      ()=> rows.slice(OV_BAR_TOP).map(bar)) ]));
  return el('div',{className:'panel'},kids);
}
// The edge grades, as the five strokes this page uses for certainty everywhere
// else. Counts are `answer.grades`, relayed.
function ovGradesPanel(a){
  const grades=a.grades||[];
  return el('div',{className:'panel'},[
    el('h2',{textContent:t('ov.grades.title')}),
    el('div',{className:'panelsub',textContent:t('ov.grades.note')}),
    grades.length
      ? el('div',{className:'ovgrades'}, grades.map((g)=> el('span',{className:'grade g-'+g.grade,
          title:g.grade+' '+ovNum(g.count)}, [g.grade+' '+ovNum(g.count)])))
      : el('div',{className:'empty',textContent:emptyText(a.empty,'edges')}) ]);
}
// The cartography's own words: what the picture shows, counted off the SAME
// answer the Graph tab draws, and how to read it.
function renderOvMapChrome(){
  const sub=byId('ovmapsub');
  if(!sub) return;
  if(!GMAP.resp){ sub.replaceChildren(); return; }
  const s=GMAP.resp.answer.summary;
  const say=(key,params)=> el('span',{}, richNodes(t(key,params)));
  // GLANCE is the two counts this picture adds \u2014 how many groups it drew and
  // how many lines. The endpoint and table censuses are the masthead rail's,
  // one line up, and are not printed twice. HOW TO READ it is one click away,
  // like every other sentence on this page.
  sub.replaceChildren(fold('ov.map.lead',
    [ say('gcount.groups',{n:s.shown.groups}), '\u00a0\u00a0', say('gcount.links',{n:GMAP.links.length}) ],
    ()=> [el('div',{className:'comment'},[t('ov.map.hint')])] ));
  renderMapLegend('ovmapleg');
}
// Bring the live map here. The ANSWER is asked for once and shared with the
// Graph tab: opening that tab moves the same renderer and the same layout, and
// asks the server for nothing.
function ovMapMount(){
  if(STATE.tab!=='overview' || !OV.resp) return;
  mapMoveTo('overview');
  if(!GMAP.resp){ drawMap(); return; }
  if(!GMAP.api || GMAP.mounted!==byId('ovmapwrap')) renderMap();
  else renderOvMapChrome();
}

// ---- the hero: the cascade ribbon ------------------------------------------
// The ONE bold thing on this page. Four lanes of the chain, left to right, each
// a vertical band whose height is proportional to the SQUARE ROOT of its count:
// on a real pack the lanes differ by more than tenfold (906 statements against
// 76 tables) and a linear scale flattens the small ones into a line. The solid
// part is what an endpoint reaches, the hatched part what nothing analysed
// reaches, and the tapered band between two lanes is reached carrying over into
// reached. Static — nothing here moves, on load or ever.
// One SVG text node, built in one call — the DOM's `textContent` is the only
// safe way to put a string into a picture, and a helper keeps it that way.
const svgText=(attrs, text, tag)=>{ const e=svgEl(tag||'text', attrs); e.textContent=text; return e; };
// A count and what it counts, on one line: the number in Mono, the word muted.
const ribbonCount=(x, y, num, word)=> {
  const e=svgEl('text',{x, y});
  e.append(svgText({class:'num'}, num, 'tspan'), svgText({class:'small'}, word, 'tspan'));
  return e;
};
const RIBBON_H=170, RIBBON_STEP=168, RIBBON_W=34, RIBBON_TOP=14, RIBBON_LEFT=10;
function ovRibbon(a){
  const rc=a.reach||{};
  // Each lane names its two catalogue keys OUTRIGHT rather than building them
  // out of the lane name: a key assembled at run time is a key no test can see.
  const lanes=[
    { lane:'ribbon.lane.endpoints',  say:'ribbon.say.endpoints',
      total:rc.endpoints||0,  reached:(rc.endpoints||0)-(rc.endpointsWithoutStatement||0) },
    { lane:'ribbon.lane.statements', say:'ribbon.say.statements',
      total:rc.statements||0, reached:rc.statementsReached||0 },
    { lane:'ribbon.lane.tables',     say:'ribbon.say.tables',
      total:rc.tables||0,     reached:rc.tablesReached||0 },
    { lane:'ribbon.lane.columns',    say:'ribbon.say.columns',
      total:rc.columns||0,    reached:rc.columnsReached||0 },
  ];
  const top=lanes.reduce((m,l)=>Math.max(m,l.total),0)||1;
  const height=(n)=> Math.max(2, RIBBON_H*Math.sqrt(Math.max(0,n)/top));
  const W=RIBBON_LEFT+RIBBON_STEP*(lanes.length-1)+RIBBON_W+112;
  const H=RIBBON_TOP+RIBBON_H+30;
  const ink3=cssVar('--t3');
  const svg=svgEl('svg',{class:'ribbonsvg', viewBox:'0 0 '+W+' '+H, preserveAspectRatio:'xMidYMid meet',
    role:'img', 'aria-label':t('ribbon.title')});
  const note=t('ribbon.note',{mode:a.mode, depth:a.depth});
  // The scale this picture used, as the picture's OWN accessible name — and as
  // a sentence under the heading, because a reader should not have to hover to
  // learn that the heights are square-rooted.
  svg.append(svgText({}, note, 'title'));
  const defs=svgEl('defs');
  const pat=svgEl('pattern',{id:'ribbonhatch', width:5, height:5, patternUnits:'userSpaceOnUse', patternTransform:'rotate(45)'});
  pat.append(svgEl('line',{x1:0, y1:0, x2:0, y2:5, stroke:ink3, 'stroke-width':1}));
  defs.append(pat); svg.append(defs);

  // Every band stands on the SAME ground line, with what is reached at the
  // bottom (solid ink) and what is not above it (hatched): the chain is read
  // along the ground, and the hatching is the part of the pack it never gets to.
  const base=RIBBON_TOP+RIBBON_H;
  const geo=lanes.map((l,i)=>{
    const full=height(l.total);
    const reach=l.total ? full*(l.reached/l.total) : 0;
    return { l, x:RIBBON_LEFT+i*RIBBON_STEP, full, reach,
      top:base-full, reachTop:base-reach, base };
  });
  // the reached-to-reached connectors go UNDER the bands, along the ground line
  for(let i=0;i<geo.length-1;i++){
    const A=geo[i], B=geo[i+1];
    const x1=A.x+RIBBON_W, x2=B.x;
    svg.append(svgEl('path',{class:'flowband',
      d:'M'+x1+','+A.reachTop+' L'+x2+','+B.reachTop+' L'+x2+','+base+' L'+x1+','+base+' Z'}));
  }
  svg.append(svgEl('line',{class:'ground', x1:0, y1:base, x2:W, y2:base}));
  const say=el('div',{className:'ribbonsay', textContent:t('ribbon.hover')});
  const groups=[];
  for(const g of geo){
    const l=g.l, rest=Math.max(0, l.total-l.reached);
    const box=svgEl('g',{class:'band', tabindex:'0'});
    if(g.reach>0.5) box.append(svgEl('rect',{class:'solid', x:g.x, y:g.reachTop, width:RIBBON_W, height:g.reach}));
    if(g.full-g.reach>0.5) box.append(svgEl('rect',{class:'hatch', x:g.x, y:g.top, width:RIBBON_W, height:g.full-g.reach}));
    // The counts sit beside the part each one measures, centred on it — and the
    // upper one is pushed clear when the two parts are too thin to hold both.
    const lx=g.x+RIBBON_W+8;
    const yReach=Math.min(g.base-4, g.reachTop+g.reach/2+4);
    let yRest=g.top+(g.full-g.reach)/2+4;
    if(yReach-yRest<14) yRest=yReach-14;
    box.append(ribbonCount(lx, yReach, ovNum(l.reached), ' '+t('ribbon.reached')));
    if(rest>0) box.append(ribbonCount(lx, yRest, ovNum(rest), ' '+t('ribbon.unreached')));
    box.append(svgText({class:'lane', x:g.x, y:base+21}, t(l.lane)));
    const sentence=t(l.say, {reached:ovNum(l.reached), total:ovNum(l.total), rest:ovNum(rest)});
    box.setAttribute('aria-label', sentence);
    const light=()=>{ say.textContent=sentence;
      for(const other of groups) other.classList.toggle('dim', other!==box);
      box.classList.add('on'); };
    const clear=()=>{ say.textContent=t('ribbon.hover');
      for(const other of groups){ other.classList.remove('dim'); other.classList.remove('on'); } };
    box.addEventListener('mouseenter', light);
    box.addEventListener('mouseleave', clear);
    box.addEventListener('focus', light);
    box.addEventListener('blur', clear);
    groups.push(box);
    svg.append(box);
  }
  return el('div',{className:'ribbon'},[
    el('h2',{textContent:t('ribbon.title')}),
    el('p',{className:'ribbonnote', textContent:note}),
    svg, say ]);
}

// ---- everything else on this tab is a plain ruled table --------------------
function ovNodesPanel(a){
  const nodes=a.nodes||[];
  const rows = nodes.length
    ? nodes.map((n)=> el('tr',{},[
        el('td',{},[ kindGlyph(n.kind,12), ' '+n.kind ]),
        el('td',{className:'num',textContent:ovNum(n.count)}) ]))
    : [ el('tr',{},[ el('td',{className:'empty', colSpan:2, textContent:emptyText(a.empty,'nodes')}) ]) ];
  return el('div',{className:'panel'},[
    el('h2',{},[t('ov.nodes.title')+' ', el('span',{className:'count',textContent:t('ov.nodes.count',{n:nodes.length})})]),
    ruled([{label:'kind'},{label:'nodes',num:true}], rows) ]);
}
function ovEdgesPanel(a){
  const edges=a.edges||[];
  const rows = edges.length
    ? edges.map((e)=> el('tr',{title:e.type+' / '+e.grade},[
        el('td',{textContent:e.type}),
        el('td',{},[badge(e.grade)]),
        el('td',{className:'num',textContent:ovNum(e.count)}) ]))
    : [ el('tr',{},[ el('td',{className:'empty', colSpan:3, textContent:emptyText(a.empty,'edges')}) ]) ];
  // The per-grade total that used to close this table is the hero's own
  // `Edge grades` panel now, drawn from the same field. One count, one place.
  return el('div',{className:'panel'},[
    el('h2',{},[t('ov.edges.title')+' ', el('span',{className:'count',textContent:'('+edges.length+')'})]),
    ruled([{label:'type'},{label:'grade'},{label:'edges',num:true}], rows) ]);
}

function ovCodePanel(a){
  const c=a.code||{};
  const row=(k,v,title)=> el('tr',{title:title||''},[
    el('td',{textContent:k}), el('td',{className:'num',textContent:ovNum(v)}) ]);
  return el('div',{className:'panel'},[ el('h2',{textContent:t('ov.code.title')}),
    ruled([{label:'what'},{label:'count',num:true}], [
      row('symbols', c.symbols, t('ov.code.symbols.title')),
      row('external types', c.external, t('ov.code.external.title')),
      row('@Transactional', c.transactional, t('ov.code.tx.title')),
      row('mapper methods', c.mapperMethods, t('ov.code.mapper.title')) ]),
    c.statementsWithoutMapper? el('div',{className:'comment',style:'margin-top:8px',
      textContent:t('ov.code.nomapper',{n:ovNum(c.statementsWithoutMapper)})}) : null ]);
}
// The honesty panel, at GLANCE level: one row of chips, `kind count`, in the
// order the answer tells the story. A chip opens the engine's own sentence about
// that gap — and the sample ids under it, each still a handoff to the view that
// can answer "so what IS this one?". Nothing is dropped; the count is outside
// the fold, because a count is what a glance is for.
// A gap's TINT is a reading of its kind, not of its count: `warn`, the soft
// amber, for the boundaries of what the analyzer can see at all, and plain for
// the rest — which are counts of the pack, not of the analysis. The count
// itself never folds.
//
// NOTHING HERE IS RED (RM36). `unresolved-calls` wore the error red until this
// round, and it is the first chip on the panel: a reader meeting this tool was
// told in the colour of a broken build that the honest disclosure at the top of
// the page was a fault. It is not. A blind spot named and counted is the thing
// this product exists to do, so the worst any of them wears is amber.
const OV_GAP_TINT = { 'unresolved-calls':'warn', 'external-symbols':'warn',
  'multi-handler-routes':'warn' };
// THE NAME OF A GAP, in the reader's words. `unresolved-calls` is what the
// engine calls it and stays on the tooltip beside the count; this is what a
// person who has not read the docs can read off the chip. A kind with no label
// in the catalogue falls back to its own slug, so the day the engine emits a
// new one the panel says its name rather than a catalogue key or nothing.
//
// The existence check is against the ENGLISH catalogue and not against t(),
// because English is the key set every translation is held to and because
// asking t() for a key nobody wrote would file it in the missing-key ledger.
// That ledger is how a real dropped string is found, and a fallback we designed
// on purpose is not a dropped string.
function ovGapLabel(kind){
  const key='ov.gap.'+kind+'.label';
  return Object.hasOwn(VIEWER_STRINGS.en, key) ? t(key) : String(kind).replace(/-/g,' ');
}
function ovGapsPanel(a){
  const gaps=a.gaps||[];
  // HOW MUCH OF THIS PROJECT LEAVES IT (RM44), counted by the engine on this
  // same answer and never re-derived here. Drawn only where there IS a call
  // that leaves: on a project that talks to nobody the sentence would be noise.
  const fed=a.federation||null;
  const kids=[ el('h2',{},[t('ov.gaps.title')+' ', el('span',{className:'count',textContent:'('+gaps.length+')'})]),
    el('div',{className:'panelsub',textContent:t('ov.gaps.note',{n:gaps.length})}),
    (fed && fed.calls>0)
      ? el('div',{className:'panelsub',textContent:t('ov.federation.note',{n:fed.calls, k:fed.answered, m:fed.unmatched})})
      : null ];
  if(!gaps.length){ kids.push(el('ul',{className:'list'},[emptyNote(a.empty,'gaps')])); return el('div',{className:'panel'},kids); }
  const chips=el('div',{className:'ovchips'});
  const bodies=el('div',{className:'ovgapbodies'});
  for(const g of gaps){
    const tint=OV_GAP_TINT[g.kind];
    const [head, body]=foldParts('ov.gap.'+g.kind,
      [ ovGapLabel(g.kind), el('span',{className:'ovnum',style:'margin-left:6px',textContent:g.count==null?'unknown':ovNum(g.count)}) ],
      ()=>{ const out=[el('div',{className:'ovgapnote',textContent:g.note})];
        const c=ovGapChips(a,g.kind); if(c) out.push(c); return out; },
      'ovchip'+(tint?' '+tint:''));
    head.title=(g.count==null?'unknown':ovNum(g.count))+'  '+g.kind;
    chips.append(head); bodies.append(body);
  }
  kids.push(chips, bodies);
  return el('div',{className:'panel'},kids);
}
// How many routes a connected-project row lists before it says "+n more".
const OV_CONNECTED_ROUTES=5;
/**
 * WHO THIS PROJECT TALKS TO (RM45), from the overview's own census.
 *
 * One row per registered project that answers a route this one calls, with the
 * routes themselves; clicking a row goes there. The last row is the calls
 * NOBODY registered answers, with the remedy, because "register the project
 * that serves this" is the one thing a reader can act on.
 *
 * Absent on a project that calls nobody: a panel that says "0" about something
 * this pack does not do is noise. On a server holding one project the sibling
 * rows are empty and the unmatched row is the whole panel, which is exactly
 * what that reader needs to see.
 */
function ovConnectedPanel(a){
  const fed=a.federation||null;
  if(!fed) return null;
  const rows=fed.byProject||[];
  const missing=fed.unmatchedRoutes||[];
  if(!rows.length && !missing.length) return null;
  const color=fedRingColor(rows.map((p)=>p.project));
  const routeChips=(routes)=>{
    const shown=routes.slice(0, OV_CONNECTED_ROUTES);
    const kids=shown.map((r)=> el('span',{className:'ovchip', title:t('ov.connected.route.title',{n:r.sites}),
      textContent:r.method+' '+r.path}));
    if(routes.length>shown.length) {
      kids.push(el('span',{className:'count',textContent:t('ov.connected.more',{n:routes.length-shown.length})}));
    }
    return el('div',{className:'ovchips'}, kids);
  };
  const kids=[ el('h2',{},[t('ov.connected.title')+' ',
    el('span',{className:'count',textContent:'('+rows.length+')'})]),
    el('div',{className:'panelsub',textContent:t('ov.connected.note')}) ];
  for(const p of rows){
    kids.push(el('button',{className:'ovconn', title:t('ov.connected.open.title',{p:p.project}),
      onclick:()=>switchProject(p.project, {tab:'overview'})},[
      el('div',{className:'ovconnhead'},[
        el('span',{className:'grow'},[
          el('span',{className:'fedring',style:'border-color:'+color(p.project)}), ' ',
          el('span',{className:'id',textContent:p.project}) ]),
        el('span',{className:'count',textContent:t('ov.connected.calls',{n:p.sites, r:p.routes.length})}) ]),
      routeChips(p.routes) ]));
  }
  if(missing.length){
    kids.push(el('div',{className:'ovconn ovconn-none'},[
      el('div',{className:'ovconnhead'},[
        el('span',{className:'grow'},[el('span',{className:'tag warn',textContent:t('ov.connected.unmatched')})]),
        el('span',{className:'count',
          textContent:t('ov.connected.calls',{n:missing.reduce((n,r)=>n+r.sites,0), r:missing.length})}) ]),
      routeChips(missing),
      el('div',{className:'cpnote',textContent:t('ov.connected.unmatched.note')}) ]));
  }
  return el('div',{className:'panel'},kids);
}
function ovGapChips(a,kind){
  const s=(a.reach&&a.reach.samples)||{};
  const chips=(items,title,label,go)=> (items&&items.length)
    ? el('div',{className:'ovchips'}, items.map(it=>el('button',{className:'ovchip',textContent:label(it),title:it+' — '+title,onclick:()=>go(it)})))
    : null;
  if(kind==='endpoints-without-statement')
    return chips(s.endpointsWithoutStatement, t('btn.flow.title'), (x)=>x, (id)=>openFlow({endpoint:id}));
  if(kind==='tables-not-reached')
    return chips(s.unreachedTables, t('ov.gap.table.title'), (x)=>x,
      (t)=>{ activateTab('explore'); showTable(t); });
  if(kind==='statements-not-reached')
    return chips(s.unreachedStatements, 'view the SQL', ovShort,
      (id)=>{ activateTab('explore'); showSource('statement:'+id); });
  return null;
}
// Where the pack concentrates. An empty hub list on a pack with no endpoints is
// "not shipped" — read off the answer's own endpoint count, not assumed.
const ovHubEmpty = (a)=> ((a.reach&&a.reach.endpoints) ? 'none' : 'not-shipped');
const OV_HUB_TOP = 5;
// The top five stand on the page; the rest of what the ANSWER carries opens
// under them. The line never says "all": the answer holds ten of forty-nine and
// says so, and the forty-nine is printed in the heading beside the title.
function ovHubPanel(title, total, rows, heads, mkRow, key, empty){
  const kids=[ el('h2',{},[t(title)+' ', el('span',{className:'count',textContent:'('+total+')'})]) ];
  if(!rows.length){ kids.push(ruled(heads, [ el('tr',{},[ el('td',{className:'empty', colSpan:heads.length, textContent:empty}) ]) ])); return el('div',{className:'panel'},kids); }
  kids.push(ruled(heads, rows.slice(0,OV_HUB_TOP).map(mkRow)));
  if(rows.length>OV_HUB_TOP) kids.push(el('div',{className:'ovhubmore'},[
    fold(key, [t('ov.hub.more',{n:rows.length-OV_HUB_TOP, total:total})],
      ()=> [ruled(heads, rows.slice(OV_HUB_TOP).map(mkRow))]) ]));
  return el('div',{className:'panel'},kids);
}
function ovHubTables(r,a){
  const rows=(a.hubs&&a.hubs.tables)||[];
  return ovHubPanel('ov.hubtables.title', ovTotal(r,'hubs.tables',rows.length), rows,
    [{label:'table'},{label:'endpoints',num:true},{label:'statements',num:true}],
    (x)=> el('tr',{},[
      el('td',{className:'wrapcell'},[ kindGlyph('table',12), ' ',
        el('a',{className:'id clickable',textContent:x.table,title:'which endpoints can reach this table',onclick:()=>openImpact({table:x.table})}) ]),
      el('td',{className:'num',textContent:ovNum(x.endpoints)}),
      el('td',{className:'num',textContent:ovNum(x.statements)}) ]),
    'ov.hubtables.rest', emptyText({hubs:ovHubEmpty(a)},'hubs'));
}
// THE OTHER END OF THE ROUND TRIP, listed the way the API hubs are. The rows
// are one `browse kind=screen sort=tables` answer, and a click walks the chain
// down from that screen. Nothing is drawn where the axis is not shipped: the
// section says so in one line instead, because an empty list would read as "this
// frontend reaches no table".
function ovHubScreens(a){
  const kids=[ el('h2',{},[t('ov.hubscreens.title')]) ];
  if(!a.screens){
    kids.push(el('div',{className:'empty',textContent:t('ov.hubscreens.none')}));
    return el('div',{className:'panel'},kids);
  }
  const b=OV.screens;
  const rows=(b && b.answer.items) || [];
  const total=b ? b.answer.total : null;
  kids[0]=el('h2',{},[t('ov.hubscreens.title')+' ',
    el('span',{className:'count',textContent: total==null?'':('('+ovNum(total)+')')})]);
  kids.push(el('div',{className:'panelsub',textContent:t('ov.hubscreens.by')}));
  if(!b){ kids.push(el('div',{className:'empty',textContent:t('load.overview')})); return el('div',{className:'panel'},kids); }
  const heads=[{label:'screen'},{label:'tables',num:true},{label:'APIs',num:true}];
  const row=(x)=> el('tr',{},[
    el('td',{className:'wrapcell'},[ kindGlyph('screen',12), ' ',
      el('a',{className:'id clickable',textContent:x.screen,title:t('btn.flow.screen.title'),
        onclick:()=>openFlow({screen:x.screen})}) ]),
    el('td',{className:'num',textContent:ovNum(x.tables)}),
    el('td',{className:'num',textContent:ovNum(x.endpoints)}) ]);
  kids.push(rows.length
    ? ruled(heads, rows.map(row))
    : ruled(heads, [ el('tr',{},[ el('td',{className:'empty', colSpan:heads.length,
        textContent:emptyText(b.answer.empty,'items')}) ]) ]));
  return el('div',{className:'panel'},kids);
}
function ovHubEndpoints(r,a){
  const rows=(a.hubs&&a.hubs.endpoints)||[];
  return ovHubPanel('ov.hubendpoints.title', ovTotal(r,'hubs.endpoints',rows.length), rows,
    [{label:'endpoint'},{label:'tables',num:true},{label:'statements',num:true}],
    (x)=> el('tr',{},[
      el('td',{className:'wrapcell'},[ kindGlyph('endpoint',12), ' ',
        el('a',{className:'id clickable',textContent:x.endpoint,title:'the chain this call runs through',onclick:()=>openFlow({endpoint:x.endpoint})}) ]),
      el('td',{className:'num',textContent:ovNum(x.tables)}),
      el('td',{className:'num',textContent:ovNum(x.statements)}) ]),
    'ov.hubendpoints.rest', emptyText({hubs:ovHubEmpty(a)},'hubs'));
}
// THE "THIS PACK" CARD IS GONE. Every field it printed is already on this
// screen: project, digest, lanes and base commit in the masthead's title block,
// built and freshness in the evidence rail's `basis` block beside this column,
// and mode/depth in the ribbon's own note. A second copy of all six was the
// clearest case of the same fact printed twice on one page.

// ---------- the cascade rail — the chain, in the order this engine walks it ---
// The header's second line. Six lanes joined by hairlines: every count is the
// `overview` answer's own node census, and a lane whose AXIS the pack does not
// ship is drawn hollow saying so rather than reading as a count of zero.
//
// The api-group lane is the one the overview answer does not carry. A group is
// the `map` tool's own bucket (the first segment of a route), so this lane waits
// for that answer and shows an em dash until the Graph map has been drawn — the
// page does not invent the number, and does not spend a second whole-pack walk
// on the landing screen to learn it.
const CRAIL = [
  ['screen',    'crail.screens'],
  ['group',     'crail.groups'],
  ['endpoint',  'crail.endpoints'],
  ['symbol',    'crail.services'],
  ['statement', 'crail.sql'],
  ['table',     'crail.tables'],
  ['column',    'crail.columns'],
];
const CRAIL_AXIS = { screen:'screen', endpoint:'code', symbol:'code', statement:'statements', table:'catalog', column:'column' };
function renderCascadeRail(){
  const box=byId('crail');
  const a=OV.resp && OV.resp.answer;
  if(!a){ box.replaceChildren(); box.title=''; return; }
  const census=new Map((a.nodes||[]).map((n)=>[n.kind, n.count]));
  const axes=a.axes||{};
  const groups=(GMAP.resp && GMAP.resp.answer && GMAP.resp.answer.summary)
    ? GMAP.resp.answer.summary.groups : null;
  box.title=t('crail.title');
  const kids=[];
  CRAIL.forEach(([kind,key],i)=>{
    if(i) kids.push(el('span',{className:'crrule'}));
    const axis=CRAIL_AXIS[kind];
    // THREE STATES, not two. An axis that never ran says so; one that RAN AND
    // COULD NOT SEE ALL OF IT keeps its number, with a mark saying the number
    // is a lower bound and the engine's own reason on it. A screens block the
    // answer does not carry at all IS the engine saying there is no screen
    // axis, whatever an older pack declares in its axis map.
    let status = (axis && axes[axis] && axes[axis].status) || 'shipped';
    if(kind==='screen' && !a.screens) status='not-shipped';
    const reason = (axis && axes[axis] && axes[axis].reason) || null;
    let value, title='', hollow=false;
    if(kind==='group'){
      value = groups==null ? '—' : ovNum(groups);
      hollow = groups==null;
      title = t('crail.groups.title');
    } else if(status!=='shipped' && status!=='degraded'){
      value=t('crail.notshipped'); hollow=true;
      title=reason || t('crail.notshipped.title');
    } else {
      // The screen count is the overview's own screens block, which is the
      // number every other screen view on this page is drawn from.
      value=ovNum(kind==='screen' ? (a.screens.screens||0) : (census.get(kind)||0));
      if(status==='degraded'){
        value=value+'\u00a0~';
        title=reason || t('crail.degraded.title');
      }
    }
    kids.push(el('span',{className:'crlane'+(hollow?' hollow':''), title},
      [ t(key)+' ', el('b',{textContent:value}) ]));
  });
  box.replaceChildren(...kids);
}
