// 57_status.js — Analysis status: what this analysis could see, what it could not, and what to do about it (RM67-U2c).
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.
//
// ONE PLACE FOR THE ANALYSIS'S OWN STATE. It used to be spread over the
// Overview's side column, the masthead's chips and a Rules tab of its own. Now
// it reads from the top: how fresh the pack is, what the trust level rests on,
// the mode the census was walked in; every axis with where it was read from
// and what it changes; every blind spot as a row that says its cause, what it
// touches and what to do; the lanes' diagnostics grouped by kind and by what
// they say; the census; and the evidence rail with every limit. Rules is the
// place's second view. The limits that change ONE answer stay beside that
// answer on Trace as well (54_trace.js traceLimitsPanel): this is the whole
// list, not the only place a limit is said.
//
// Every row is the `overview` answer's. The words around them are the page's,
// and a blind spot the page has no words for is still listed, under its class's.

// What an axis's state is called, and what an axis changes when it is not whole.
const STATUS_AXIS_STATE = { shipped:'status.axis.ok', degraded:'status.axis.part', 'not-shipped':'status.axis.none' };
const STATUS_AXIS_TOUCH = { catalog:'status.axis.touch.catalog', statements:'status.axis.touch.statements',
  column:'status.axis.touch.column', code:'status.axis.touch.code', web:'status.axis.touch.web',
  screen:'status.axis.touch.screen', jpa:'status.axis.touch.jpa', mybatisPlus:'status.axis.touch.mybatisPlus' };
// A blind spot's own words, per kind, under these two prefixes; one without
// them is said in its class's (`gap.touch.class.<class>`, `gap.todo.class.<class>`).
const STATUS_WORDS = { touch:'gap.touch.', todo:'gap.todo.' };

/** Where a row of this place lives in the document, so a link elsewhere can go to it. */
const statusRowId=(key)=> 'st-'+String(key).replace(/[^\w-]/g, '-');

/** The landing answer, drawn as this place reads it. */
function renderStatus(r){
  const a=r.answer;
  setKids(byId('stfacts'), statusFreshness(r), statusTrust(r), statusCensus(a));
  byId('staxes').replaceChildren(statusAxesPanel(a));
  byId('stgaps').replaceChildren(statusGapsPanel(a));
  byId('stdiags').replaceChildren(statusDiagPanel(a));
  // `setKids`: the connected-projects panel is null on a project that calls
  // nobody, and a null handed to replaceChildren is printed as the word null.
  setKids(byId('stconnected'), ovConnectedPanel(a));
  // The ribbon is the drawing theme's own picture of the four shares on Start.
  byId('ovfold').replaceChildren(el('div',{className:'panel ovfoldwrap'},[
    fold('ov.ribbon', [t('ribbon.title')], ()=> [ovRibbon(a)]) ]));
  byId('ovpanels').replaceChildren(ovGradesPanel(a), ovNodesPanel(a), ovEdgesPanel(a), ovCodePanel(a));
  byId('ovside').replaceChildren(honesty(r, 'overview'));
}
/** Everything this place drew for the project being left. */
function statusReset(){
  for(const id of ['stfacts','staxes','stgaps','stdiags','stconnected','ovfold','ovpanels','ovside']) byId(id).replaceChildren();
}

// ---- the three facts on top -----------------------------------------------------
/** Whether the pack still matches the working tree, in the masthead's words, with when and from what it was built. */
function statusFreshness(r){
  const v=(r.basis && r.basis.freshness && r.basis.freshness.verdict) || 'unknown';
  const fs=MAST_FRESH[v] || { say:'', why:'', tint:'' };
  const pack=(r.answer && r.answer.pack) || {};
  const built=String(pack.builtAt || '').replace('T',' ').replace(/\..*$/,'');
  const commit=(pack.base && pack.base.commit) ? pack.base.commit.slice(0,10) : '';
  return el('div',{className:'panel stfact'},[ el('h2',{textContent:t('status.fresh.title')}),
    el('div',{className:'stbig'+(fs.tint ? ' warn' : ''), textContent: fs.say ? t(fs.say) : t('status.fresh.unknown')}),
    fs.why ? el('div',{className:'comment',textContent:t(fs.why)}) : null,
    el('div',{className:'count',textContent:t('status.fresh.built',{ built:built || '?', commit:commit || '?', digest:pack.digest || '?' })}) ]);
}
/** What the trust level is, what it means, what would move it, and every gate and gap it names. */
function statusTrust(r){
  const tt=r.trust || {}, lvl=tt.trustLevel || null;
  const held=[...(tt.gatesNotShown || []), ...(tt.knownGaps || [])];
  return el('div',{className:'panel stfact'},[ el('h2',{textContent:t('status.trust.title')}),
    el('div',{className:'stbig', textContent: lvl ? mastSay(mastTrustKey(lvl), lvl) : t('status.trust.none')}),
    el('div',{className:'comment',textContent: lvl ? mastSay(mastTrustKey(lvl)+'.title', '') : t('mast.trust.none.title')}),
    noGoldenSet(tt) ? el('div',{className:'comment',textContent:t('mast.trust.how')}) : null,
    held.length ? el('div',{className:'ovchips'}, held.map((g)=> el('span',{className:'tag',textContent:g}))) : null ]);
}
/** The mode and depth every share and count on Start and here was walked in. */
function statusCensus(a){
  return el('div',{className:'panel stfact'},[ el('h2',{textContent:t('status.census.title')}),
    el('div',{className:'stbig', textContent:t('status.census.mode',{ mode:a.mode, depth:depthText(a.depth) })}),
    el('div',{className:'comment',textContent:t('status.census.lead',{ grades:(MODE_ADMITS[a.mode] || []).join(', ') })}) ]);
}

// ---- the axes ------------------------------------------------------------------------
/** The axes this pack states, in the chain's order, the two Java bridges only where they ran. */
function statusAxesShown(a){
  const has=(axis)=> !!(a.axes && a.axes[axis]);
  return [...OV_AXES.filter(([axis])=> has(axis)),
    ...OV_BRIDGE_AXES.filter(([axis])=> has(axis) && ovAxisStatus(a, axis)!=='not-shipped')];
}
/** Where an axis was read from, where the pack says: the schema file or the mapping's sources. */
function statusAxisSource(a, axis){
  if(axis!=='catalog' || ovAxisStatus(a, axis)==='not-shipped') return '';
  const src=(a.axes && a.axes.catalog && a.axes.catalog.sources) || [];
  if(src.length) return src.join(', ');
  const ddl=a.pack && a.pack.ddl, root=a.pack && a.pack.base && a.pack.base.repoPath;
  if(!ddl) return '';
  return (root && ddl.startsWith(root+'/')) ? ddl.slice(root.length+1) : String(ddl).split('/').pop();
}
/** The notes an axis carries even when it was read whole (the frontend's calls traced to no client). */
const statusAxisNotes=(a, axis)=> ((a.axes && a.axes[axis] && a.axes[axis].notes) || []).join(' ');
function statusAxesPanel(a){
  const rows=statusAxesShown(a).map(([axis, key])=> statusAxisRow(a, axis, key));
  const heads=[t('status.axes.col.axis'), t('status.axes.col.state'), t('status.axes.col.from'), t('status.axes.col.touch')];
  return el('div',{className:'panel',id:'staxespanel'},[ el('h2',{textContent:t('status.axes.title')}),
    el('div',{className:'panelsub',textContent:t('status.axes.lead')}),
    rows.length ? el('table',{className:'ruled staxes'},[ el('thead',{},[ el('tr',{}, heads.map((h)=> el('th',{textContent:h}))) ]), el('tbody',{}, rows) ])
      : el('div',{className:'empty',textContent:t('status.axes.none')}) ]);
}
/** One axis: its state, where it was read from, and what it changes, with the engine's own reason. */
function statusAxisRow(a, axis, key){
  const st=ovAxisStatus(a, axis) || 'shipped', why=ovAxisReason(a, axis) || statusAxisNotes(a, axis);
  const tr=el('tr',{id:statusRowId('ov.axis.'+axis), className:st==='shipped' ? '' : 'warn'},[
    el('td',{},[ el('b',{textContent:t(key)}) ]),
    el('td',{},[ el('span',{className:'tag'+(st==='shipped' ? '' : ' warnt'), textContent:t(STATUS_AXIS_STATE[st] || STATUS_AXIS_STATE.shipped)}) ]),
    el('td',{className:'mono stsrc',textContent:statusAxisSource(a, axis)}),
    el('td',{},[ el('div',{textContent:t(STATUS_AXIS_TOUCH[axis])}), why ? el('div',{className:'comment',textContent:why}) : null ]) ]);
  return tr;
}

// ---- the blind spots -------------------------------------------------------------------
/**
 * EVERY THING THE ANALYSIS COULD NOT SEE, as one list: the gaps the overview
 * names (`gaps[].class` says which of the five kinds each is), an axis it did
 * not build or read in part, and each kind of diagnostic a lane reported. Start
 * lists the ones that change an answer (56_start.js); this place draws them all.
 * Ordered by what a reader can do about each, input first.
 */
function statusItems(a){
  const gaps=a.gaps || [];
  const said=new Set(gaps.map((g)=> g.kind));
  const items=gaps.map((g)=> ({ src:'gap', kind:g.kind, key:'ov.gap.'+g.kind, cls:g.class || 'info', label:ovGapLabel(g.kind), count:g.count, note:g.note }));
  for(const [axis, nameKey] of statusAxesShown(a)){
    const st=ovAxisStatus(a, axis);
    if((st!=='not-shipped' && st!=='degraded') || said.has(OV_AXIS_GAP[axis])) continue;
    items.push({ src:'axis', kind:axis, key:'ov.axis.'+axis, cls:st==='not-shipped' ? 'input' : 'unresolved',
      label:t(st==='not-shipped' ? 'ov.axis.notshipped' : 'ov.axis.degraded', {axis:t(nameKey)}), count:null, note:ovAxisReason(a, axis) });
  }
  for(const g of diagGroups(a.diagnostics || [])) items.push({ src:'diag', kind:g.kind, key:'ov.diag.'+g.kind, cls:'unresolved', label:t('status.diag.label',{kind:g.kind}), count:g.count });
  const order=OV_GAP_GROUPS.map(([cls])=> cls);
  return items.map((it, i)=> [it, i]).sort((x, y)=> (order.indexOf(x[0].cls)-order.indexOf(y[0].cls)) || (x[1]-y[1])).map(([it])=> it);
}
/** The overview's blind spots, set out by what a reader can do, each a row. */
function statusGapsPanel(a){
  const items=statusItems(a).filter((it)=> it.src==='gap');
  const fed=a.federation || null;
  const kids=[ el('h2',{},[t('ov.gaps.title')+' ', el('span',{className:'count',textContent:'('+items.length+')'})]),
    el('div',{className:'panelsub',textContent:t('status.gaps.lead')}),
    (fed && fed.calls>0) ? el('div',{className:'panelsub',textContent:t('ov.federation.note',{n:fed.calls, k:fed.answered, m:fed.unmatched})}) : null ];
  if(!items.length) kids.push(el('ul',{className:'list'},[emptyNote(a.empty, 'gaps')]));
  for(const [cls, labelKey] of OV_GAP_GROUPS){
    const mine=items.filter((x)=> x.cls===cls);
    if(mine.length) kids.push(el('div',{className:'stgrp'},[ el('div',{className:'ovgaplbl',textContent:t(labelKey)}), ...mine.map((it)=> statusItemRow(a, it)) ]));
  }
  return el('div',{className:'panel',id:'ovgaps'}, kids.filter(Boolean));
}
/** One blind spot: its name and count, then its cause, what it touches, and what to do. */
function statusItemRow(a, it){
  const note=String(it.note || ''), lead=leadOf(note);
  return el('div',{className:'stitem'+(OV_GAP_TINTED.has(it.cls) ? ' warn' : ''), id:statusRowId(it.key)},[
    el('div',{className:'stitemhead'},[ el('b',{textContent:it.label}),
      it.count!=null ? el('span',{className:'ovnum',textContent:ovNum(it.count)}) : null, el('span',{className:'ovdiag',title:t('status.kind.title'),textContent:it.kind}) ]),
    statusLine('status.cause', [ lead===note ? el('span',{textContent:note}) : fold(it.key, [lead], ()=> [el('div',{className:'comment'},[note])]) ]),
    statusLine('status.touches', [ statusWords(it, 'touch'), ovGapChips(a, it.kind) ]),
    statusLine('status.todo', [ statusWords(it, 'todo') ]) ]);
}
function statusLine(labelKey, kids){
  return el('div',{className:'stline'},[ el('span',{className:'stlbl',textContent:t(labelKey)}), el('div',{className:'stval'}, kids.filter(Boolean)) ]);
}
/** A blind spot's own words for what it touches or what to do, or its class's where it has none. */
function statusWords(it, what){
  const own=STATUS_WORDS[what]+it.kind, cls=STATUS_WORDS[what]+'class.'+it.cls;
  return el('span',{textContent: Object.hasOwn(VIEWER_STRINGS.en, own) ? t(own) : t(cls)});
}

// ---- the lanes' diagnostics -------------------------------------------------------------
/**
 * What the lanes reported, one row per KIND and inside it one line per thing
 * the rows SAY (diagGroups): a cache directory that moved leaves 866 of one
 * kind, and that is one row with its count. Each row says what to do, in the
 * kind's own words where the page has them.
 */
function statusDiagPanel(a){
  const groups=diagGroups(a.diagnostics || []);
  return el('div',{className:'panel',id:'stdiag'},[
    el('h2',{},[t('status.diags.title')+' ', el('span',{className:'count',textContent:'('+groups.length+')'})]),
    el('div',{className:'panelsub',textContent:t(groups.length ? 'status.diags.lead' : 'status.diags.none')}),
    ...groups.map((g)=> el('div',{className:'stitem warn', id:statusRowId('ov.diag.'+g.kind)},[
      el('div',{className:'stitemhead'},[ el('b',{className:'ovdiag',textContent:g.kind}), el('span',{className:'ovnum',textContent:ovNum(g.count)}),
        g.causes.length>1 ? el('span',{className:'count',textContent:t('diag.group.causes',{k:g.causes.length})}) : null ]),
      ...diagGroupBody('ov.diag.'+g.kind, g),
      Object.hasOwn(VIEWER_STRINGS.en, 'diag.todo.'+g.kind) ? null : statusLine('status.todo', [el('span',{textContent:t('diag.todo.any')})]) ].filter(Boolean))) ]);
}
