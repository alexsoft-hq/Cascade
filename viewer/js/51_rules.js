// 51_rules.js — the Rules tab: the rule packs this engine runs, read-only.
//
// ONE of the page's scripts, sharing the page's one global scope (see the tags
// at the foot of viewer/index.html).
//
// What each rule says, why it is there, its params and its examples, and how
// many links of this project's pack it gave: the same packs `cascade rules show`
// prints, so a person reads here what the engine runs. A rule is changed in its
// JSON pack (docs/rules.md), and `cascade rules test` says whether its examples
// still hold; nothing here edits one.

const RULES = { catalog:null, pick:null };

async function fetchRules(){
  const was=STATE.project;
  const r=await fetch(withProject('/api/rules'));
  const j=await r.json();
  if(was!==STATE.project) throw staleAnswer(was);
  if(j.error) throw new Error(j.error.code+': '+j.error.message);
  return j;
}

async function loadRules(){
  const box=byId('rulesview');
  box.replaceChildren(el('div',{className:'panel',textContent:t('rules.loading')}));
  try { RULES.catalog=await fetchRules(); } catch(e){ if(stale(e)) return; box.replaceChildren(errPanel(e)); return; }
  drawRules();
}

const allRules=(cat)=> cat.packs.flatMap((p)=>p.rules);

/** A language change redraws the tab's own words from the catalogue already held; nothing is asked again. */
function renderRulesChrome(){
  if(RULES.catalog) drawRules();
}

function drawRules(){
  const cat=RULES.catalog;
  const pick=allRules(cat).find((r)=>r.id===RULES.pick) || allRules(cat)[0] || null;
  byId('rulesview').replaceChildren(el('div',{className:'cols'},[ rulesListPanel(cat, pick), ruleDetailPanel(cat, pick) ]));
}

function rulesListPanel(cat, pick){
  return el('div',{className:'panel'},[
    el('h2',{textContent:t('rules.title')}),
    el('div',{className:'comment',textContent:t('rules.lede')}),
    ...cat.packs.map((p)=> el('div',{className:'rulepack'},[
      el('h3',{textContent:p.name+'@'+p.version}),
      el('div',{className:'comment',textContent:p.description}),
      el('ul',{className:'list'}, p.rules.map((r)=> ruleRow(cat, r, r===pick))),
    ])),
  ]);
}

function ruleRow(cat, r, active){
  return el('li',{className: active ? 'rulerow sel' : 'rulerow'},[
    el('a',{className:'id clickable',textContent:r.id,onclick:()=>{ RULES.pick=r.id; drawRules(); }}),
    el('span',{},[ el('span',{className:'tag',textContent:r.kind}), ' ', gradeOf(cat, r), ' ', appliedTag(r) ]),
  ]);
}

/** The grade a rule gives: its own, else its kind's; a kind that only classifies gives none. */
function gradeOf(cat, r){
  const cap=(cat.kinds.find((k)=>k.name===r.kind)||{}).gradeCap || null;
  const g=r.grade || cap;
  return g ? badge(g) : null;
}

function appliedTag(r){
  if(r.appliedHere===null) return el('span',{className:'tag',title:t('rules.applied.none.title'),textContent:t('rules.applied.none')});
  return el('span',{className:'tag',title:t('rules.applied.title'),textContent:t('rules.applied',{n:r.appliedHere})});
}

function ruleDetailPanel(cat, r){
  if(!r) return el('div',{className:'panel',textContent:t('rules.empty')});
  const { library, ...params }=r.params||{};
  return el('div',{className:'panel'},[
    el('div',{className:'srchead'},[ el('span',{className:'id',textContent:r.id}), el('span',{className:'tag',textContent:r.kind}), gradeOf(cat, r) ]),
    el('p',{textContent:r.description}),
    r.why ? el('h3',{textContent:t('rules.why')}) : null,
    r.why ? el('p',{className:'comment',textContent:r.why}) : null,
    library ? libraryBlock(library) : null,
    el('h3',{textContent:t('rules.params')}),
    el('pre',{className:'rulesrc',textContent:JSON.stringify(params, null, 2)}),
    el('h3',{textContent:t('rules.examples',{n:r.examples.length})}),
    el('ol',{className:'ruleex'}, r.examples.map(exampleItem)),
    el('div',{className:'comment',textContent:t('rules.how')}),
  ]);
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

function exampleItem(ex){
  return el('li',{},[
    el('pre',{className:'rulesrc',textContent: ex.source!==undefined ? ex.source : ex.path}),
    el('div',{className:'comment',textContent:t('rules.expect',{expect:JSON.stringify(ex.expect)})}),
    ex.why ? el('div',{className:'comment',textContent:ex.why}) : null,
  ]);
}
