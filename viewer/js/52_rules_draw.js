// 52_rules_draw.js — the Rules tab, drawn: the list with what applies here first, and one rule with the way to every link it gave.
//
// ONE of the page's scripts, sharing the page's one global scope (see the tags
// at the foot of viewer/index.html). What the tab holds and how it asks for it
// is 51_rules.js; this draws it, and asks for nothing.

function drawRules(){
  if(!RULES.list) return;
  rulesRenderToolbar();
  const pick=((RULES.list.answer.rules)||[]).find((x)=> x.id===RULES.pick) || null;
  byId('rulesview').replaceChildren(el('div',{className:'rulesgrid'},[ rulesListPanel(rulesShown()), rulesDetailPanel(pick) ]));
}

// ---- the toolbar ------------------------------------------------------------
function rulesRenderToolbar(){
  const a=RULES.list && RULES.list.answer;
  const kindSel=byId('rkind'), laneSel=byId('rlane'), scope=byId('rscope'), q=byId('rq');
  if(!kindSel) return;
  kindSel.replaceChildren(el('option',{value:'',textContent:t('rules.kind.all')}),
    ...(a ? a.kinds : []).map((k)=> el('option',{value:k.name,textContent:k.name})));
  kindSel.value=RULES.kind;
  laneSel.replaceChildren(el('option',{value:'',textContent:t('rules.lane.all')}), ...RULES_LANES.map((l)=> el('option',{value:l,textContent:l})));
  laneSel.value=RULES.lane;
  scope.replaceChildren(
    el('button',{className:RULES.scope==='here'?'on':'', onclick:()=> rulesSetScope('here')},[t('rules.scope.here',{n:a ? a.totals.here : 0})]),
    el('button',{className:RULES.scope==='all'?'on':'', onclick:()=> rulesSetScope('all')},[t('rules.scope.all',{n:a ? a.totals.rules : 0})]));
  if(q.value!==RULES.q) q.value=RULES.q;
}

// ---- the list ---------------------------------------------------------------
/** What a rule gave here, in a few words: links, the kinds of node it made, or that it has nothing to count. */
function rulesGaveText(g){
  if(g===null) return t('rules.gave.classifies');
  const parts=[];
  if(g.edges>0) parts.push(t('rules.gave.links',{n:ovNum(g.edges)}));
  for(const [kind, n] of Object.entries(g.byKind||{})) parts.push(t('rules.gave.nodes',{n:ovNum(n), kind}));
  return parts.length ? parts.join(', ') : t('rules.gave.none');
}
/**
 * The list, in three groups: what gave something here, what could have and did
 * not, and what only classifies. In the `applies here` scope only the first is
 * drawn, and a line says how many more there are and shows them.
 */
function rulesListPanel(shown){
  const a=RULES.list.answer;
  const groups=[
    ['rules.group.here', shown.filter((x)=> x.here)],
    ['rules.group.idle', shown.filter((x)=> !x.here && x.gave!==null)],
    ['rules.group.classify', shown.filter((x)=> x.gave===null)],
  ];
  const kids=[ el('div',{className:'rulesum'},[ t('rules.summary',{packs:a.totals.packs, rules:a.totals.rules, here:a.totals.here}) ]) ];
  for(const [key, rows] of groups){
    if(!rows.length) continue;
    kids.push(el('div',{className:'rulegrp'},[ t(key), el('span',{className:'count',textContent:' ('+rows.length+')'}) ]));
    for(const r of rows) kids.push(rulesRow(r));
  }
  if(!shown.length) kids.push(rulesNoneShown(a));
  const hidden=(a.rules||[]).length-shown.length;
  if(RULES.scope==='here' && hidden>0) {
    kids.push(el('div',{className:'rulemore'},[ t('rules.more.idle',{n:hidden}), ' ',
      el('button',{className:'mini',textContent:t('rules.more.show'),onclick:()=> rulesSetScope('all')}) ]));
  }
  return el('div',{className:'panel ruleslist'}, kids);
}
/**
 * NOTHING ON THE LIST. Opened on what applies here, a project no rule drew
 * anything for says so plainly and says it is normal where the project uses no
 * framework a pack describes (RM67-U2e): the tab used to fall back to all the
 * rules and open on one about another stack. A filter that matches nothing is
 * the page's doing, and says that instead.
 */
function rulesNoneShown(a){
  const here=RULES.scope==='here' && !RULES.q.trim() && !RULES.kind && !RULES.lane && a.totals.here===0;
  return el('div',{className:here ? 'rulenone' : 'empty', textContent:t(here ? 'rules.none.here' : 'rules.none.match')});
}
function rulesRow(r){
  const on=r.id===RULES.pick;
  const btn=el('button',{type:'button', className:'rulerow'+(on?' on':''), onclick:()=> rulesPick(r.id)},[
    el('div',{className:'ruleline'},[ el('span',{className:'ruleid',textContent:r.id}),
      el('span',{className:'rulegave'+(r.here?' here':''),textContent:rulesGaveText(r.gave)}) ]),
    el('div',{className:'rulemeta'},[ el('span',{className:'tag',textContent:r.kind}),
      r.lane ? el('span',{className:'tag',textContent:r.lane}) : null, ...rulesGrades(r) ]),
  ]);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  return btn;
}
/**
 * THE GRADES A RULE GAVE, not only the one it may give. nestjs.routes may give
 * EXACT, and on a project whose global prefix excludes routes this engine could
 * not read it gave 117 HEURISTIC links: the cap alone said the opposite of what
 * happened. Where it gave no link, the cap is what there is to say.
 */
function rulesGrades(r){
  const by=(r.gave && r.gave.byGrade) || {};
  const given=GRADES.filter((g)=> by[g]>0);
  if(!given.length) return r.grade ? [ el('span',{className:'rulecap',title:t('rules.cap.title')},[badge(r.grade)]) ] : [];
  return given.map((g)=> el('span',{className:'rulegrade'},[ badge(g), el('span',{className:'count',textContent:ovNum(by[g])}) ]));
}

// ---- one rule ---------------------------------------------------------------
function rulesDetailPanel(row){
  if(!row) return el('div',{className:'panel',textContent:t(RULES.list.answer.totals.rules ? 'rules.none.pick' : 'rules.empty')});
  const d=RULES.detail.get(row.id+'@'+RULES.offset);
  if(!d) return el('div',{className:'panel'},[ rulesHead(row), el('div',{className:'empty',textContent:t('rules.loading')}) ]);
  if(d.error) return el('div',{className:'panel'},[ rulesHead(row), errPanel(d.error) ]);
  const rule=d.answer.rule;
  const { library, ...params }=rule.params||{};
  return el('div',{className:'panel ruledetail'},[
    rulesHead(row),
    el('p',{className:'ruledesc',textContent:rule.description}),
    el('div',{className:'comment',textContent:t('rules.file',{file:rule.file, pack:rule.pack})}),
    rulesGaveBlock(row, d),
    rule.why ? el('h3',{textContent:t('rules.why')}) : null,
    rule.why ? el('p',{className:'comment',textContent:rule.why}) : null,
    library ? libraryBlock(library) : null,
    rulesExamplesBlock(rule),
    el('div',{className:'rulefold'},[ fold('rules.params.'+rule.id, [t('rules.params')],
      ()=> [el('pre',{className:'rulesrc',textContent:JSON.stringify(params, null, 2)})]) ]),
    el('div',{className:'comment',style:'margin-top:10px'},richNodes(t('rules.how'))),
  ]);
}
function rulesHead(row){
  return el('div',{className:'rulehead'},[ el('span',{className:'ruleid big',textContent:row.id}),
    el('span',{className:'tag',textContent:row.kind}), row.lane ? el('span',{className:'tag',textContent:row.lane}) : null,
    row.grade ? el('span',{className:'rulecap',title:t('rules.cap.title')},[ t('rules.cap'), ' ', badge(row.grade) ]) : null ]);
}

/**
 * WHAT IT GAVE HERE, and the way to each: the totals by type, grade and kind,
 * then a page of the links and nodes themselves, each end a button that opens
 * it where it can be read (a route on Flow, a statement on Impact).
 */
function rulesGaveBlock(row, d){
  const g=d.answer.gave;
  const kids=[ el('h3',{textContent:t('rules.gave.title')}) ];
  if(g===null){ kids.push(el('div',{className:'comment',textContent:t('rules.gave.classifies.long')})); return el('div',{},kids); }
  const census=[ ...Object.entries(g.byType||{}), ...Object.entries(g.byGrade||{}), ...Object.entries(g.byKind||{}) ]
    .map(([k,n])=> k+' '+ovNum(n));
  kids.push(el('div',{className:'rulecensus'},[ rulesGaveText(g), census.length ? '  ('+census.join(', ')+')' : '' ]));
  if(!g.edges && !g.nodes){ kids.push(el('div',{className:'comment',textContent:t('rules.gave.nothing')})); return el('div',{},kids); }
  const list=el('ul',{className:'list rulelinks'});
  for(const e of d.answer.edges) list.append(rulesLinkRow(e));
  for(const n of d.answer.nodes) list.append(el('li',{},[ rulesEnd(n) ]));
  kids.push(list, rulesPager(row.id, d));
  return el('div',{},kids);
}
function rulesLinkRow(e){
  return el('li',{className:'rulelink'},[
    el('div',{className:'rulelinkends'},[ rulesEnd(e.from), el('span',{className:'cparrow',textContent:'→'}), rulesEnd(e.to) ]),
    el('span',{className:'rulelinkgrade',title:[e.type, e.basis].filter(Boolean).join('  ')},[ badge(e.grade) ]),
  ]);
}
/** One end of a link: its label, and a button that opens it on the tab that reads it. */
function rulesEnd(end){
  const go=rulesGoTo(end);
  return go
    ? el('button',{type:'button', className:'ruleend', title:end.id+'  '+t(go.title), onclick:go.run},[ kindGlyph(end.kind, 11), ' ', end.label ])
    : el('span',{className:'ruleend',title:end.id},[ kindGlyph(end.kind, 11), ' ', end.label ]);
}
/** Where a node of each kind is read on Trace: a route, a screen and a method walked down, a statement, table or column walked up. */
function rulesGoTo(end){
  const key=String(end.id).slice(String(end.id).indexOf(':')+1);
  const dir=traceHas(end.kind, 'down') ? 'down' : 'up';
  if(!traceHas(end.kind, dir)) return null;
  return { title:dir==='down' ? 'trace.dir.down.title' : 'trace.dir.up.title', run:()=> openTrace({ kind:end.kind, id:key }, dir) };
}
function rulesPager(id, d){
  const f=(d.truncated && d.truncated.fields)||[];
  const total=f.reduce((n,x)=> n+x.total, 0), shown=f.reduce((n,x)=> n+x.shown, 0);
  const offset=RULES.offset;
  const next=f.some((x)=> x.nextOffset!=null);
  return el('div',{className:'rulepager'},[
    el('span',{className:'count',textContent:t('rules.page',{from:offset+1, to:offset+shown, total:ovNum(total)})}),
    offset>0 ? el('button',{className:'mini',textContent:t('rules.page.prev'),onclick:()=> rulesPage(id, Math.max(0, offset-RULES_PAGE))}) : null,
    next ? el('button',{className:'mini',textContent:t('rules.page.next'),onclick:()=> rulesPage(id, offset+RULES_PAGE)}) : null,
  ]);
}

/** The examples, each with whether it holds as `cascade rules test` ran it on this server. */
function rulesExamplesBlock(rule){
  const v=RULES.examples ? RULES.examples.get(rule.id) : null;
  const held=v && Array.isArray(v.held) ? v.held : null;
  const head=held ? t('rules.examples.held',{n:rule.examples.length, k:held.filter(Boolean).length}) : t('rules.examples',{n:rule.examples.length});
  const kids=[ el('h3',{textContent:head}) ];
  if(!held) kids.push(el('div',{className:'comment',textContent: v && v.notRun ? t('rules.examples.notrun',{why:v.notRun}) : t('rules.examples.unknown')}));
  kids.push(el('ol',{className:'ruleex'}, rule.examples.map((ex,i)=> exampleItem(ex, held ? held[i] : null))));
  return el('div',{},kids);
}

/** What a rule relying on a library's declaration relies on, and where anyone can check it. */
function libraryBlock(lib){
  return el('div',{},[
    el('h3',{textContent:t('rules.library')}),
    el('div',{className:'id',textContent:lib.type}),
    el('pre',{className:'rulesrc',textContent:lib.declares}),
    el('div',{className:'comment',textContent:t('rules.library.source',{source:lib.source})}),
  ]);
}

function exampleItem(ex, holds){
  const mark = holds===true ? el('span',{className:'ruleok',textContent:t('rules.example.holds')})
    : holds===false ? el('span',{className:'rulebad',textContent:t('rules.example.fails')}) : null;
  return el('li',{},[
    mark,
    el('pre',{className:'rulesrc',textContent: ex.source!==undefined ? ex.source : ex.path}),
    el('div',{className:'comment',textContent:t('rules.expect',{expect:JSON.stringify(ex.expect)})}),
    ex.why ? el('div',{className:'comment',textContent:ex.why}) : null,
  ]);
}
