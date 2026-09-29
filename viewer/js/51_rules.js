// 51_rules.js — the Rules tab: what it holds, and how it asks for it.
//
// ONE of the page's scripts, sharing the page's one global scope (see the tags
// at the foot of viewer/index.html). The drawing is 52_rules_draw.js.
//
// A rule is framework knowledge written as data (docs/rules.md): which
// decorator makes a route, which base type makes a mapper, what a Prisma call
// reads and writes. A link a rule gave names it in its evidence, so a reader
// looking at a guessed route or a generic statement can ask "which rule said
// so?", and a reader looking at a rule can ask "what did it give here?".
//
// EVERY NUMBER IS THE `rules` TOOL'S (src/mcp/tools_rules.mjs), the same answer
// a model gets over MCP: the list with what each rule gave in this pack, and one
// rule whole with the links and nodes it gave, a page at a time. Whether a
// rule's examples hold comes from `GET /api/rules/examples`, which runs them the
// way `cascade rules test` does. The page filters the rows it holds and counts
// nothing itself.
//
// WHAT APPLIES HERE COMES FIRST (RM67). The tab used to open on the first pack
// by name, so a NestJS project opened on a MyBatis-Plus-Join rule that did
// nothing for it, and a Prisma rule that had made every statement said "0 links".
// It now opens on the rules that gave something in this project, biggest first,
// with the rest one click away.

const RULES = { list:null, examples:null, detail:new Map(), pick:null, offset:0, q:'', kind:'', lane:'', scope:null, seq:0 };
const RULES_PAGE = 10;
const RULES_LANES = ['java', 'ts', 'sql', 'web'];

/** Everything the tab held for the project being left. */
function rulesReset(){
  RULES.list=null; RULES.detail.clear(); RULES.pick=null; RULES.offset=0; RULES.scope=null; RULES.seq++;
}

async function loadRules(){
  byId('rulesview').replaceChildren(el('div',{className:'panel',textContent:t('rules.loading')}));
  const mine=++RULES.seq;
  let r;
  try { r=await api('rules', {}); } catch(e){ rulesFailed(e, mine); return; }
  if(mine===RULES.seq) rulesTake(r);
}
function rulesFailed(e, mine){
  if(stale(e) || mine!==RULES.seq) return;
  byId('rulesview').replaceChildren(errPanel(e));
}
/** The list landed: open on what applies here when anything does, and on its biggest rule. */
function rulesTake(r){
  RULES.list=r;
  // What applies here first, even when that is nothing: the list then says so (rulesNoneShown).
  if(RULES.scope===null) RULES.scope='here';
  RULES.pick=rulesDefaultPick();
  drawRules();
  rulesLoadExamples();
  if(RULES.pick) rulesLoadDetail(RULES.pick, 0);
}
/** The rule picked before, while it is still on the list; else the first row. */
function rulesDefaultPick(){
  const shown=rulesShown();
  if(RULES.pick && shown.some((x)=> x.id===RULES.pick)) return RULES.pick;
  return shown.length ? shown[0].id : null;
}

/** Whether each example holds: about the engine, not a project, so asked once. */
async function rulesLoadExamples(){
  if(RULES.examples || SNAP) return;
  try { RULES.examples=rulesVerdicts(await (await fetch('/api/rules/examples')).json()); }
  catch(e){ /* no verdicts: the examples are shown without one, and say so */ }
  if(RULES.list) drawRules();
}
const rulesVerdicts=(j)=> (j && Array.isArray(j.rules)) ? new Map(j.rules.map((x)=> [x.id, x])) : null;

/** One rule whole, and a page of what it gave, kept per rule and offset. */
async function rulesLoadDetail(id, offset){
  const key=id+'@'+offset;
  if(RULES.detail.has(key)) { drawRules(); return; }
  const mine=RULES.seq, project=STATE.project;
  let r;
  try { r=await api('rules', { rule:id, limit:RULES_PAGE, offset }); }
  catch(e){ if(stale(e)) return; r={ error:e }; }
  if(mine!==RULES.seq || project!==STATE.project) return;
  RULES.detail.set(key, r);
  drawRules();
}

/** A language change redraws the tab's own words from the answers already held; nothing is asked again. */
function renderRulesChrome(){
  rulesRenderToolbar();
  if(RULES.list) drawRules();
}

// The filters, each on its own: the scope, the lane, the kind and the words typed.
const rulesTyped=()=> RULES.q.trim().toLowerCase();
const RULES_FILTERS=[
  (x)=> RULES.scope!=='here' || x.here,
  (x)=> !RULES.lane || x.lane===RULES.lane,
  (x)=> !RULES.kind || x.kind===RULES.kind,
  (x)=> !rulesTyped() || (x.id+' '+x.pack+' '+x.kind+' '+x.description).toLowerCase().includes(rulesTyped()),
];
/** The rows this list shows, out of the rows the answer holds. */
function rulesShown(){
  const rows=(RULES.list && RULES.list.answer.rules) || [];
  return rows.filter((x)=> RULES_FILTERS.every((f)=> f(x)));
}

function rulesSetScope(scope){
  RULES.scope=scope;
  drawRules();
}
function rulesPick(id){
  RULES.pick=id; RULES.offset=0;
  drawRules();
  rulesLoadDetail(id, 0);
}
function rulesPage(id, offset){
  RULES.offset=offset;
  rulesLoadDetail(id, offset);
}
/** The toolbar's controls, wired once; each redraws from the rows already held. */
function rulesWire(){
  const q=byId('rq');
  if(!q) return;
  q.addEventListener('input', ()=>{ RULES.q=q.value; drawRules(); });
  byId('rkind').onchange=(e)=>{ RULES.kind=e.target.value; drawRules(); };
  byId('rlane').onchange=(e)=>{ RULES.lane=e.target.value; drawRules(); };
}
