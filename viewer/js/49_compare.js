// 49_compare.js — the Compare tab: the change report between this project's pack and an earlier build of the same project.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// The base is chosen ONLY from this project's own pack history (the builds a
// certified analyze kept when it replaced them), so the tab can never set one
// project against another. With no earlier build kept the tab is not shown.
//
// The tab reads the `pack_diff` answer (src/core/pack_diff.mjs) and writes it as
// ONE report, in the order a reviewer has to read it: what is compared with what;
// whether the two packs were analyzed the same way, and every limit the engine
// states; the counts, grouped by what kind of change each is (an attribute of a
// node, a relation, the evidence a relation rests on, or only where a thing sits
// in the source); the endpoints and screens above the change; what to check;
// then the records themselves, each changed attribute and each changed evidence
// with its value before and after. Every value is the engine's; only the headings,
// and the sentences that say what a group means, are the page's. The report can
// be printed and saved as Markdown, from the answer already on screen and from
// nothing else.
const CMP = { resp:null, error:null, seq:0, pending:false, filter:'', opened:[] };

/** The old project's comparison, gone, and the list of packs to compare with, re-read. */
function resetCompare(){
  CMP.seq++; CMP.resp=null; CMP.error=null; CMP.pending=false; CMP.filter='';
  byId('cmpview').replaceChildren();
  renderCompareChrome();
}
/** The earlier builds of the project on screen, newest first. */
// Only the metadata OF THE PROJECT ON SCREEN counts: right after a switch the old
// project's is still in memory, and its builds are not this project's.
const compareBuilds=()=> (STATE.meta && STATE.meta.projectId===STATE.project && Array.isArray(STATE.meta.history)) ? STATE.meta.history : [];
/** The tab exists only where this project has an earlier build to compare with. */
function renderCompareChrome(){
  const builds=compareBuilds();
  const tab=document.querySelector('.tab[data-tab="compare"]');
  if(tab) tab.classList.toggle('hidden', builds.length===0 || !!SNAP);
  const sel=byId('cmpbase');
  if(!sel) return;
  const was=sel.value;
  sel.replaceChildren(...builds.map(compareOption));
  // The choice a reader made stays; otherwise the newest earlier build is the one shown.
  sel.value = builds.some((b)=>b.id===was) ? was : (builds[0] ? builds[0].id : '');
  compareWhenReady(sel);
}
/** One earlier build as a choice: its commit, when it was built, and whether it held uncommitted edits. */
function compareOption(b){
  const built=String(b.builtAt||'?').replace('T',' ').replace(/\..*$/,'');
  return el('option',{ value:b.id, title:b.id,
    textContent:t('compare.build',{ commit:String(b.commit||'?').slice(0,12), built })+(b.dirty ? ' '+t('compare.dirty') : '') });
}
/**
 * A link that opens this tab lands before the builds are known; draw once they
 * are. What is already known is drawn again from memory (the chrome is rebuilt
 * on a language switch): the report from its answer, a refusal from its error,
 * a comparison still on its way as the wait it is. Nothing is asked of the server.
 */
function compareWhenReady(sel){
  if(CMP.resp){ renderCompare(); return; }
  if(CMP.error){ byId('cmpview').replaceChildren(compareError(CMP.error)); return; }
  if(CMP.pending){ byId('cmpview').replaceChildren(el('div',{className:'empty',textContent:t('compare.loading')})); return; }
  if(STATE.tab==='compare' && sel.value) drawCompare();
}
async function drawCompare(){
  const view=byId('cmpview');
  const base=byId('cmpbase').value;
  if(!base){ view.replaceChildren(el('div',{className:'empty',textContent:t('compare.none')})); return; }
  view.replaceChildren(el('div',{className:'empty',textContent:t('compare.loading')}));
  // The answer for the base chosen before is not this base's: it goes now, not when the new one lands.
  const mine=++CMP.seq;
  let r;
  CMP.pending=true; CMP.resp=null; CMP.error=null;
  try{ r=await api('pack_diff',{ base_history:base, limit:200 }); }
  catch(e){ if(stale(e)||mine!==CMP.seq) return; CMP.error=e; view.replaceChildren(compareError(e)); return; }
  finally{ if(mine===CMP.seq) CMP.pending=false; }
  if(mine!==CMP.seq) return;
  CMP.resp=r;
  renderCompare();
}
/** The comparison the server refused, with its own sentence word for word. */
function compareError(e){
  return el('div',{className:'panel warnpanel'},[
    el('h2',{textContent:t('compare.error')}),
    el('div',{className:'comment',textContent:(e && e.message) || String(e)}) ]);
}

// ---------- what the answer holds ---------------------------------------------
// The answer's shape is the engine's contract; nothing below fills a field the
// answer left out with a zero. A server older than this page compares ids and
// grades only: it has no `nodes.changed`, and the report says so instead.
const hasContentDiff=(a)=> typeof a.nodes.changed==='number' && Array.isArray(a.nodes.changedList)
  && typeof a.edges.changed==='number' && Array.isArray(a.edges.changedList);
const listOf=(x)=> Array.isArray(x) ? x : [];
const limitsOf=(r)=> listOf(r.limits);
/** The lists the answer cut: only a list that shows fewer rows than it has. */
const cutFields=(r)=> listOf(r.truncated && r.truncated.fields).filter((f)=> f.shown<f.total);
const projectOf=(a)=> a.head.project || a.base.project || '?';
/** One side, in words: its whole commit, when it was built, which pack, and whether it held uncommitted edits. */
function sideText(s){
  const commit=s.commit ? String(s.commit) : t('compare.side.nocommit');
  const built=String(s.builtAt||'?').replace('T',' ').replace(/\..*$/,'');
  const digest=String(s.digest||'?');
  return t('compare.side',{commit, built, digest})+(s.dirty ? ' '+t('compare.dirty') : '');
}
/** A condition's value as the engine spelled it; one that is not a string is printed as JSON. */
const condText=(v)=> typeof v==='string' ? v : JSON.stringify(v);
const conditionsKey=(verdict)=> verdict==='same' ? 'compare.conditions.same' : verdict==='different' ? 'compare.conditions.different' : 'compare.conditions.unknown';
/** The counts only a content comparison has; zero where the server made none, so the guidance is silent on them. */
const contentCounts=(a, full)=> full ? { changed:a.nodes.changed, evidence:a.edges.changed, moved:a.nodes.moved+a.edges.moved } : { changed:0, evidence:0, moved:0 };
/**
 * The rows the answer gives. From an older server, its ids with what the shown
 * removed list says of them: an id that list names is the earlier build's alone;
 * when that list is cut, nothing can be said of any id, and `head` is null.
 */
function endRows(touched, a){
  if(Array.isArray(touched.rows)) return touched.rows;
  const whole = a.nodes.removedIds.length===a.nodes.removed;
  const removed=new Set(a.nodes.removedIds.map((x)=> x.id));
  return touched.ids.map((id)=> ({ id, base:null, head: whole ? !removed.has(id) : null }));
}
const endsGone=(a)=> endRows(a.endpointsTouched, a).concat(endRows(a.screensTouched, a)).filter((row)=> row.head===false).length;
/** The summary's four groups, as [heading key, sentence]. */
function summaryRows(a, full){
  const n=a.nodes, e=a.edges, nc=t('compare.notcompared');
  return [
    ['compare.sum.content', t('compare.sum.content.v',{ added:n.added, removed:n.removed, changed: full ? n.changed : nc })],
    ['compare.sum.relations', t('compare.sum.relations.v',{ added:e.added, removed:e.removed })],
    ['compare.sum.evidence', t('compare.sum.evidence.v',{ regraded:e.regraded, changed: full ? e.changed : nc })],
    ['compare.sum.location', full ? t('compare.sum.location.v',{ nodes:n.moved, edges:e.moved }) : nc] ];
}
const COUNT_MARKS=[['added','+'],['removed','-'],['regraded','~'],['changed','*'],['moved','>']];
/** Per kind or per type, the marks of the legend: `endpoint +2 -1 *3`. */
function countLine(obj){
  return Object.entries(obj||{}).map(([k,v])=> k+' '+COUNT_MARKS.map(([f,mark])=> v[f] ? mark+v[f] : '').filter(Boolean).join(' ')).join(', ');
}
/** Nothing to list: which of the four reasons, or null when there is something. */
function emptyState(a, full){
  const n=a.nodes, e=a.edges;
  const nm=full ? n.moved : 0, em=full ? e.moved : 0, changed=full ? n.changed+e.changed : 0;
  if(n.added+n.removed+e.added+e.removed+e.regraded+changed>0) return null;
  return { key:emptyKey(a, full, nm+em), nodes:nm, edges:em };
}
function emptyKey(a, full, moved){
  if(a.samePack) return 'compare.empty.samepack';
  if(!full) return 'compare.empty.legacy';
  return moved>0 ? 'compare.empty.moved' : 'compare.empty.same';
}
const lineIf=(cond, key, params)=> cond ? t(key, params) : null;
/** What to check, from the counts and the flags alone: no score, no verdict. */
function guidanceLines(r, a, full){
  const k=contentCounts(a, full);
  const ends=a.endpointsTouched.total+a.screensTouched.total;
  return [
    lineIf(a.conditions.verdict!=='same', 'compare.check.conditions'),
    lineIf(cutFields(r).length>0, 'compare.check.cut'),
    lineIf(ends>0, 'compare.check.ends', { n:a.endpointsTouched.total, m:a.screensTouched.total }),
    lineIf(endsGone(a)>0, 'compare.check.gone', { n:endsGone(a) }),
    lineIf(k.changed>0, 'compare.check.content', { n:k.changed }),
    lineIf(k.evidence>0, 'compare.check.evidence', { n:k.evidence }),
    lineIf(a.edges.regraded>0, 'compare.check.regraded', { n:a.edges.regraded }),
    lineIf(k.moved>0, 'compare.check.moved', { n:k.moved }),
    lineIf(!full, 'compare.check.legacy'),
    t('compare.check.always') ].filter(Boolean);
}
/**
 * A value as text that keeps its type: a string is quoted (so the string "null"
 * and an empty string read as what they are, and a line break stays a line
 * break), everything else is JSON.
 */
const valueText=(v)=> typeof v==='string' ? '"'+v+'"' : v===undefined ? 'undefined' : JSON.stringify(v, null, 1);
const edgeLabel=(e)=> e.type+(e.rule ? ' ['+e.rule+']' : '');
/** Base and head records of one relation, one JSON line each, for the fold and the file. */
function recordsText(e){
  const side=(key, records)=> t(key)+' ('+records.length+')\n'+records.map((rec)=> JSON.stringify(rec)).join('\n');
  return side('compare.base', listOf(e.base))+'\n'+side('compare.head', listOf(e.head));
}

// ---------- the report on screen ----------------------------------------------
function renderCompare(){
  const r=CMP.resp; if(!r) return;
  const a=r.answer, view=byId('cmpview');
  const full=hasContentDiff(a);
  view.replaceChildren(el('div',{className:'cmpgrid cmpreport'},[
    el('div',{},[
      cmpHeadline(a), cmpActions(), cmpConditions(a.conditions), cmpLimits(r, full),
      cmpSummary(a, full), cmpEmpty(a, full),
      cmpEndList('compare.endpoints', 'endpoint', a.endpointsTouched, a),
      cmpEndList('compare.screens', 'screen', a.screensTouched, a),
      cmpGuidance(r, a, full), ...cmpSections(a, full), cmpMeta(r) ]),
    honesty(r, 'compare') ]));
  applyCompareFilter();
}
function cmpHeadline(a){
  return el('div',{className:'panel cmphead'},[
    el('h2',{className:'cmptitle',textContent:t('compare.report.title',{ project:projectOf(a) })}),
    el('div',{className:'railrow'},[ el('span',{textContent:t('compare.base')}), el('span',{className:'mono',textContent:sideText(a.base)}) ]),
    el('div',{className:'railrow'},[ el('span',{textContent:t('compare.head')}), el('span',{className:'mono',textContent:sideText(a.head)}) ]),
    el('div',{className:'comment',textContent:t('compare.report.basis')}) ]);
}
/** Print, save, and a filter that hides rows without changing a single total. */
function cmpActions(){
  const input=el('input',{ type:'text', id:'cmpfilter', value:CMP.filter, placeholder:t('compare.filter.placeholder'), title:t('compare.filter.title') });
  input.oninput=()=>{ CMP.filter=input.value; applyCompareFilter(); };
  return el('div',{className:'cmpactions'},[
    el('button',{ type:'button', className:'mini', id:'cmpprint', textContent:t('compare.print'), title:t('compare.print.title'), onclick:printCompare }),
    el('button',{ type:'button', className:'mini', id:'cmpsave', textContent:t('compare.download'), title:t('compare.download.title'), onclick:downloadCompare }),
    input, el('span',{className:'count', id:'cmpfiltern'}) ]);
}
function applyCompareFilter(){
  const q=CMP.filter.trim().toLowerCase();
  const rows=[...byId('cmpview').querySelectorAll('.cmprow')];
  let shown=0;
  for(const li of rows){
    const hit=!q || li.textContent.toLowerCase().includes(q);
    li.classList.toggle('hidden', !hit);
    if(hit) shown++;
  }
  const n=byId('cmpview').querySelector('#cmpfiltern');
  if(n) n.textContent = q ? t('compare.filter.count',{ shown, total:rows.length }) : '';
}
function cmpConditions(c){
  const lines=[ ...c.differences.map((d)=> el('li',{},[ el('span',{className:'mono',textContent:d.what}),
      el('span',{className:'count',textContent:condText(d.base)+' → '+condText(d.head)}) ])),
    ...c.unknown.map((u)=> el('li',{},[ el('span',{className:'comment',textContent:t('compare.unknown')+' '+u}) ])) ];
  return el('div',{className:'panel'+(c.verdict==='same' ? '' : ' warnpanel')},[
    el('h2',{textContent:t(conditionsKey(c.verdict))}),
    lines.length ? el('ul',{className:'list'}, lines) : null ]);
}
const noteRow=(text)=> el('li',{className:'cmpstack'},[ el('span',{className:'comment',textContent:text}) ]);
const limitRow=(l)=> el('li',{className:'cmpstack'},[ el('span',{className:'mono',textContent:String(l.scope||'')}), el('span',{className:'comment',textContent:' '+String(l.reason||'')}) ]);
/** Every limit the engine states, every list it cut, and whether it compared content at all: before any count. */
function cmpLimits(r, full){
  const rows=[ ...limitsOf(r).map(limitRow),
    full ? null : noteRow(t('compare.legacy')),
    ...cutFields(r).map((f)=> noteRow(t('compare.cut',{ field:f.field, shown:f.shown, total:f.total }))) ];
  if(!rows.some(Boolean)) return null;
  return el('div',{className:'panel warnpanel'},[ el('h2',{textContent:t('compare.limits')}), el('ul',{className:'list'}, rows) ]);
}
function cmpSummary(a, full){
  const rows=summaryRows(a, full).map(([key, value])=> el('li',{className:'cmpstack'},[
    el('strong',{textContent:t(key)+': '}), el('span',{textContent:value}) ]));
  return el('div',{className:'panel'},[
    el('h2',{textContent:t('compare.summary')}),
    el('ul',{className:'list'}, rows),
    el('div',{className:'comment mono',textContent:t('compare.bykind')+': '+countLine(a.nodes.byKind)}),
    el('div',{className:'comment mono',textContent:t('compare.bytype')+': '+countLine(a.edges.byType)}),
    el('div',{className:'comment',textContent:t('compare.legend')}) ]);
}
function cmpEmpty(a, full){
  const s=emptyState(a, full);
  if(!s) return null;
  return el('div',{className:'panel'},[ el('h2',{textContent:t(s.key, s)}), el('div',{className:'comment',textContent:t('compare.empty.note')}) ]);
}
/** One list under a heading, with the count of what is not shown. */
function cmpList(title, total, rows, note){
  if(!total) return null;
  const more=total-rows.length;
  return el('div',{className:'panel'},[
    el('h2',{textContent:t(title,{n:total})}),
    note ? el('div',{className:'comment cmpnote',textContent:note}) : null,
    el('ul',{className:'list'}, rows),
    more>0 ? el('div',{className:'comment',textContent:t('chain.cut',{n:more}).trim()}) : null ]);
}
function cmpEndList(title, kind, touched, a){
  return cmpList(title, touched.total, endRows(touched, a).map((row)=> endRow(kind, row)), t('compare.ends.note'));
}
/**
 * An end the head is known to have gets a Flow button; one the earlier build
 * alone had is said so, and one whose presence is not known is said so too.
 * Neither of those opens anything: there may be no chain to walk.
 */
function endRow(kind, row){
  const name=row.id.slice(kind.length+1);
  const tail = row.head===true
    ? el('button',{ type:'button', className:'mini', textContent:'Flow', title:t('btn.flow.title'), onclick:()=> openFlow({ [kind]:name }) })
    : el('span',{className:'count',textContent:t(row.head===false ? 'compare.ends.gone' : 'compare.ends.unknown')});
  return el('li',{className:'cmprow'},[
    el('span',{className:'mono',textContent:name}),
    row.base===false ? el('span',{className:'count',textContent:t('compare.ends.new')}) : null,
    tail ]);
}
function cmpGuidance(r, a, full){
  return el('div',{className:'panel'},[
    el('h2',{textContent:t('compare.check')}),
    el('ol',{className:'cmpsteps'}, guidanceLines(r, a, full).map((s)=> el('li',{textContent:s}))) ]);
}
/** The answer's own basis and trust, exact, as JSON text: what a reader away from the server needs to weigh the report. */
const metaText=(r)=> JSON.stringify({ basis:r.basis || null, trust:r.trust || null }, null, 1);
/** Behind a fold on screen (opened for the print sheet), so the caveats travel with the report without crowding it. */
function cmpMeta(r){
  return el('div',{className:'panel'},[
    el('details',{className:'cmpfold', id:'cmpmeta'},[
      el('summary',{textContent:t('compare.meta')}),
      el('div',{className:'comment cmpnote',textContent:t('compare.meta.note')}),
      el('pre',{className:'cmppre',textContent:metaText(r)}) ]) ]);
}
/** The lists, the ones a reviewer acts on first: content, evidence, grades, then presence, then the moves last. */
function cmpSections(a, full){
  const n=a.nodes, e=a.edges;
  const content = full ? [
    cmpList('compare.changed', n.changed, n.changedList.map(nodeChangeRow), t('compare.changed.note')),
    cmpList('compare.edges.changed', e.changed, e.changedList.map(edgeChangeRow), t('compare.edges.changed.note')) ] : [];
  const moved = full ? [
    cmpList('compare.moved', n.moved, n.movedList.map(nodeChangeRow), t('compare.moved.note')),
    cmpList('compare.edges.moved', e.moved, e.movedList.map(edgeChangeRow), t('compare.edges.moved.note')) ] : [];
  return [ ...content,
    cmpList('compare.edges.regraded', e.regraded, e.regradedList.map((x)=> edgeRow(x, x.base+' → '+x.head))),
    cmpList('compare.added', n.added, n.addedIds.map((id)=> nodeRow(id, null))),
    cmpList('compare.removed', n.removed, n.removedIds.map(removedRow)),
    cmpList('compare.edges.added', e.added, e.addedList.map((x)=> edgeRow(x, x.grade))),
    cmpList('compare.edges.removed', e.removed, e.removedList.map((x)=> edgeRow(x, x.grade))),
    ...moved ];
}
const nodeRow=(id, extra)=> el('li',{className:'cmprow'},[ el('span',{className:'mono',textContent:id}), extra ? el('span',{className:'comment',textContent:extra}) : null ]);
const removedRow=(x)=> nodeRow(x.id, x.axisChanged ? t('compare.axis',{axis:x.axisChanged}) : null);
const edgeRow=(e, grade)=> el('li',{className:'cmprow'},[ el('span',{className:'mono',textContent:e.from+' → '+e.to}),
  el('span',{className:'count',textContent:edgeLabel(e)+'  '+grade}) ]);
function nodeChangeRow(x){
  return el('li',{className:'cmprow cmpstack'},[
    el('span',{className:'mono',textContent:x.id}),
    el('div',{className:'cmpfields'}, listOf(x.fields).map(fieldRow)) ]);
}
function edgeChangeRow(e){
  return el('li',{className:'cmprow cmpstack'},[
    el('div',{className:'cmpedge'},[ el('span',{className:'mono',textContent:e.from+' → '+e.to}), el('span',{className:'count',textContent:edgeLabel(e)}) ]),
    el('div',{className:'cmpfields'}, listOf(e.fields).map(fieldRow)),
    el('details',{className:'cmpfold'},[
      el('summary',{textContent:t('compare.records.lead',{ base:listOf(e.base).length, head:listOf(e.head).length })}),
      el('pre',{className:'cmppre',textContent:recordsText(e)}) ]) ]);
}
/** A field that says where a thing sits in the source, not what it is: a changed record can carry one beside its content. */
const isLocationField=(name)=> /^(evidence\.)?(file|line|declaredAt|locationRecords)$/.test(String(name));
/** One attribute: its name (marked when it is a source location), the value before, the value after. */
function fieldRow(f){
  const name=el('span',{className:'cmpfname mono'},[ f.name, isLocationField(f.name) ? el('em',{className:'cmploc',textContent:' '+t('compare.field.location')}) : null ]);
  return el('div',{className:'cmpfield'},[
    name, valueNode(f.base, f.basePresent), el('span',{className:'cmparrow',textContent:'→'}), valueNode(f.head, f.headPresent) ]);
}
/** A value as text, never as markup: not recorded is said, null is printed, a long one folds. */
function valueNode(v, present){
  if(present===false) return el('span',{className:'cmpval cmpabsent',textContent:t('compare.value.missing')});
  const text=valueText(v);
  if(text.length<=80 && !text.includes('\n')) return el('span',{className:'cmpval mono',textContent:text});
  return el('details',{className:'cmpval cmpfold'},[
    el('summary',{className:'mono',textContent:text.slice(0,60).replace(/\s+/g,' ')+'…'}),
    el('pre',{className:'cmppre',textContent:text}) ]);
}

// ---------- print, and the Markdown file --------------------------------------
/**
 * Every fold opened, every row on the sheet whatever the filter hides on screen,
 * the page marked for the print sheet, and the browser asked to print. The
 * filter and the folds are put back when printing ends.
 */
function printCompare(){
  if(!CMP.resp) return;
  const view=byId('cmpview');
  CMP.opened=[...view.querySelectorAll('details')].filter((d)=> !d.open);
  for(const d of CMP.opened) d.open=true;
  for(const li of view.querySelectorAll('.cmprow')) li.classList.remove('hidden');
  document.body.classList.add('cmpprint');
  window.print();
}
function afterComparePrint(){
  document.body.classList.remove('cmpprint');
  for(const d of CMP.opened) d.open=false;
  CMP.opened=[];
  applyCompareFilter();
}
window.addEventListener('afterprint', afterComparePrint);
const shortCommit=(s)=> s.commit ? s.commit.slice(0,7) : 'nocommit';
/** The report as a Markdown file, from the answer on screen. */
function downloadCompare(){
  const r=CMP.resp; if(!r) return;
  const a=r.answer;
  const name=['cascade-compare', projectOf(a), shortCommit(a.base), shortCommit(a.head)].join('-').replace(/[^A-Za-z0-9._-]+/g,'_')+'.md';
  snapshotSave(name, compareMarkdown(r), 'text/markdown;charset=utf-8');
}
/**
 * A value as Markdown code that cannot break out of it: the span or fence is one
 * backtick longer than any run of backticks inside the value, so a pipe, a
 * backtick or a tag in a comment stays text. A value with a line break is a
 * fenced block, indented to the list item it belongs to.
 */
function mdCode(text, indent=''){
  const s=String(text);
  const longest=(s.match(/`+/g)||[]).reduce((m, run)=> Math.max(m, run.length), 0);
  if(s.includes('\n')){
    const fence='`'.repeat(Math.max(3, longest+1));
    return '\n'+[fence, ...s.split('\n'), fence].map((line)=> indent+line).join('\n');
  }
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return '`'.repeat(longest+1)+pad+s+pad+'`'.repeat(longest+1);
}
function compareMarkdown(r){
  const a=r.answer, full=hasContentDiff(a);
  return [ mdHead(r, a), mdConditions(a.conditions), mdLimits(r, full), mdSummary(a, full), mdEmpty(a, full),
    mdEnds('compare.endpoints', 'endpoint', a.endpointsTouched, a), mdEnds('compare.screens', 'screen', a.screensTouched, a),
    '## '+t('compare.check')+'\n\n'+guidanceLines(r, a, full).map((s, i)=> (i+1)+'. '+s).join('\n'),
    ...mdLists(a, full), mdOmitted(r),
    '## '+t('compare.meta')+'\n\n'+t('compare.meta.note')+mdCode(metaText(r)),
    t('compare.md.foot') ].filter(Boolean).join('\n\n')+'\n';
}
/** One side as a file line: the words of the screen, then the build time and the dirty flag as recorded. */
function mdSide(key, s){
  return '- '+t(key)+': '+mdCode(sideText(s))+'\n  - '+t('compare.md.raw',{ built:mdCode(String(s.builtAt||'?')), dirty:mdCode(String(s.dirty===true)) });
}
function mdHead(r, a){
  const trust=(r.trust && r.trust.trustLevel) || 'unknown';
  return '# '+t('compare.report.title',{ project:mdCode(projectOf(a)) })+'\n\n'
    +mdSide('compare.base', a.base)+'\n'
    +mdSide('compare.head', a.head)+'\n'
    +'- '+t('compare.md.trust')+': '+mdCode(trust)+'\n\n'
    +t('compare.report.basis');
}
function mdConditions(c){
  const rows=[ ...c.differences.map((d)=> '- '+mdCode(d.what)+': '+mdCode(condText(d.base))+' -> '+mdCode(condText(d.head))),
    ...c.unknown.map((u)=> '- '+t('compare.unknown')+' '+mdCode(u)) ];
  return '## '+t(conditionsKey(c.verdict))+(rows.length ? '\n\n'+rows.join('\n') : '');
}
function mdLimits(r, full){
  const rows=[ ...limitsOf(r).map((l)=> '- '+mdCode(String(l.scope||''))+': '+mdCode(String(l.reason||''), '  ')),
    full ? null : '- '+t('compare.legacy'),
    ...cutFields(r).map((f)=> '- '+t('compare.cut',{ field:f.field, shown:f.shown, total:f.total })) ].filter(Boolean);
  return rows.length ? '## '+t('compare.limits')+'\n\n'+rows.join('\n') : null;
}
function mdSummary(a, full){
  const rows=summaryRows(a, full).map(([key, value])=> '- '+t(key)+': '+value);
  return '## '+t('compare.summary')+'\n\n'+rows.join('\n')
    +'\n- '+t('compare.bykind')+': '+mdCode(countLine(a.nodes.byKind)||'0')
    +'\n- '+t('compare.bytype')+': '+mdCode(countLine(a.edges.byType)||'0')
    +'\n\n'+t('compare.legend');
}
function mdEmpty(a, full){
  const s=emptyState(a, full);
  return s ? '## '+t(s.key, s)+'\n\n'+t('compare.empty.note') : null;
}
/** A heading, its note, its rows, and how many rows did not fit; null when the list is empty. */
function mdSection(heading, note, rows, total){
  if(!total) return null;
  const more=total-rows.length;
  return ['## '+heading, note, rows.join('\n'), more>0 ? t('chain.cut',{n:more}).trim() : null].filter(Boolean).join('\n\n');
}
const endMark=(row)=> row.head===false ? ' ('+t('compare.ends.gone')+')' : row.head!==true ? ' ('+t('compare.ends.unknown')+')' : row.base===false ? ' ('+t('compare.ends.new')+')' : '';
function mdEnds(title, kind, touched, a){
  const rows=endRows(touched, a).map((row)=> '- '+mdCode(row.id.slice(kind.length+1))+endMark(row));
  return mdSection(t(title,{n:touched.total}), t('compare.ends.note'), rows, touched.total);
}
function mdLists(a, full){
  const n=a.nodes, e=a.edges;
  const content = full ? [
    mdSection(t('compare.changed',{n:n.changed}), t('compare.changed.note'), n.changedList.map(mdNodeChange), n.changed),
    mdSection(t('compare.edges.changed',{n:e.changed}), t('compare.edges.changed.note'), e.changedList.map(mdEdgeChange), e.changed) ] : [];
  const moved = full ? [
    mdSection(t('compare.moved',{n:n.moved}), t('compare.moved.note'), n.movedList.map(mdNodeChange), n.moved),
    mdSection(t('compare.edges.moved',{n:e.moved}), t('compare.edges.moved.note'), e.movedList.map(mdEdgeChange), e.moved) ] : [];
  return [ ...content,
    mdSection(t('compare.edges.regraded',{n:e.regraded}), null, e.regradedList.map((x)=> mdEdge(x)+' '+mdCode(x.base)+' -> '+mdCode(x.head)), e.regraded),
    mdSection(t('compare.added',{n:n.added}), null, n.addedIds.map((id)=> '- '+mdCode(id)), n.added),
    mdSection(t('compare.removed',{n:n.removed}), null, n.removedIds.map(mdRemoved), n.removed),
    mdSection(t('compare.edges.added',{n:e.added}), null, e.addedList.map((x)=> mdEdge(x)+' '+mdCode(x.grade)), e.added),
    mdSection(t('compare.edges.removed',{n:e.removed}), null, e.removedList.map((x)=> mdEdge(x)+' '+mdCode(x.grade)), e.removed),
    ...moved ].filter(Boolean);
}
const mdEdge=(x)=> '- '+mdCode(x.from)+' -> '+mdCode(x.to)+' '+mdCode(edgeLabel(x));
const mdRemoved=(x)=> '- '+mdCode(x.id)+(x.axisChanged ? ' ('+t('compare.axis',{axis:mdCode(x.axisChanged)})+')' : '');
const mdValue=(f, side, indent)=> f[side+'Present']===false ? t('compare.value.missing') : mdCode(valueText(f[side]), indent);
const multiline=(f, side)=> f[side+'Present']!==false && valueText(f[side]).includes('\n');
/**
 * One attribute as a file line. A value with a line break is a fenced block,
 * and a fence can be followed by nothing on its line, so the two sides are
 * then two labeled items of their own rather than one `before -> after` line.
 */
function mdField(f){
  const name=mdCode(f.name)+(isLocationField(f.name) ? ' '+t('compare.field.location') : '');
  if(!multiline(f, 'base') && !multiline(f, 'head')) return '  - '+name+': '+mdValue(f, 'base')+' -> '+mdValue(f, 'head');
  return '  - '+name+':\n    - '+t('compare.base')+': '+mdValue(f, 'base', '      ')
    +'\n    - '+t('compare.head')+': '+mdValue(f, 'head', '      ');
}
const mdNodeChange=(x)=> '- '+mdCode(x.id)+'\n'+listOf(x.fields).map(mdField).join('\n');
function mdEdgeChange(e){
  return mdEdge(e)+'\n'+listOf(e.fields).map(mdField).join('\n')
    +'\n  - '+t('compare.records.lead',{ base:listOf(e.base).length, head:listOf(e.head).length })+mdCode(recordsText(e), '    ');
}
/** Which lists the file does not hold whole, so a reader of the file alone knows. */
function mdOmitted(r){
  const rows=cutFields(r).map((f)=> '- '+mdCode(f.field)+': '+t('compare.cut.row',{ shown:f.shown, total:f.total, order:mdCode(String(f.order)) }));
  return '## '+t('compare.omitted')+'\n\n'+(rows.length ? rows.join('\n') : t('compare.omitted.none'));
}
