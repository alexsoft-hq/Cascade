// 49_compare.js — the Compare tab: what changed between this project's pack and an earlier build of the same project.
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
// The tab reads the `pack_diff` answer (src/core/pack_diff.mjs) and draws it in
// the order a reviewer has to read it: first whether the two packs were analyzed
// the same way, then the counts, then the endpoints and screens above the change,
// then the lists. Every value is the engine's; only the headings are the page's.
const CMP = { resp:null, seq:0, pending:false };

/** The old project's comparison, gone, and the list of packs to compare with, re-read. */
function resetCompare(){
  CMP.seq++; CMP.resp=null; CMP.pending=false;
  byId('cmpview').replaceChildren();
  renderCompareChrome();
}
/** The earlier builds of the project on screen, newest first. */
const compareBuilds=()=> (STATE.meta && Array.isArray(STATE.meta.history)) ? STATE.meta.history : [];
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
/** A link that opens this tab lands before the builds are known; draw once they are. */
function compareWhenReady(sel){
  if(STATE.tab==='compare' && !CMP.resp && sel.value && !CMP.pending) drawCompare();
}
async function drawCompare(){
  const view=byId('cmpview');
  const base=byId('cmpbase').value;
  if(!base){ view.replaceChildren(el('div',{className:'empty',textContent:t('compare.none')})); return; }
  view.replaceChildren(el('div',{className:'empty',textContent:t('compare.loading')}));
  const mine=++CMP.seq;
  let r;
  CMP.pending=true;
  try{ r=await api('pack_diff',{ base_history:base, limit:200 }); }
  catch(e){ if(stale(e)||mine!==CMP.seq) return; view.replaceChildren(errPanel(e)); return; }
  finally{ if(mine===CMP.seq) CMP.pending=false; }
  if(mine!==CMP.seq) return;
  CMP.resp=r;
  renderCompare();
}
/** One list under a heading, with the count of what is not shown. */
function cmpList(title, total, rows){
  if(!total) return null;
  const more=total-rows.length;
  return el('div',{className:'panel'},[
    el('h2',{textContent:t(title,{n:total})}),
    el('ul',{className:'list'}, rows),
    more>0 ? el('div',{className:'comment',textContent:t('chain.cut',{n:more}).trim()}) : null ]);
}
function cmpConditions(c){
  const lines=[ ...c.differences.map((d)=> el('li',{},[ el('span',{className:'mono',textContent:d.what}),
      el('span',{className:'count',textContent:String(d.base)+' → '+String(d.head)}) ])),
    ...c.unknown.map((u)=> el('li',{},[ el('span',{className:'comment',textContent:t('compare.unknown')+' '+u}) ])) ];
  return el('div',{className:'panel'+(c.verdict==='same' ? '' : ' warnpanel')},[
    el('h2',{textContent: c.verdict==='same' ? t('compare.conditions.same') : c.verdict==='different' ? t('compare.conditions.different') : t('compare.conditions.unknown')}),
    lines.length ? el('ul',{className:'list'}, lines) : null ]);
}
function renderCompare(){
  const r=CMP.resp; if(!r) return;
  const a=r.answer, view=byId('cmpview');
  const side=(s)=> [s.project, (s.digest||'').slice(0,12), s.commit ? s.commit.slice(0,10) : ''].filter(Boolean).join('  ');
  const counts=(obj, fields)=> Object.entries(obj).map(([k,v])=> k+' '+fields.map(([f,sym])=> v[f] ? sym+v[f] : '').filter(Boolean).join('/')).join(', ');
  const nodeRow=(id, extra)=> el('li',{},[ el('span',{className:'mono',textContent:id}), extra ? el('span',{className:'comment',textContent:extra}) : null ]);
  const edgeRow=(e, grade)=> el('li',{},[ el('span',{className:'mono',textContent:e.from+' → '+e.to}),
    el('span',{className:'count',textContent:e.type+(e.rule ? ' ['+e.rule+']' : '')+'  '+grade}) ]);
  const flowButton=(id)=> el('button',{className:'mini',textContent:'Flow',title:t('btn.flow.title'),onclick:()=>openFlow({endpoint:id.slice('endpoint:'.length)})});
  view.replaceChildren(el('div',{className:'cmpgrid'},[
    el('div',{},[
      el('div',{className:'panel'},[
        el('div',{className:'railrow'},[ el('span',{textContent:t('compare.base')}), el('span',{className:'mono',textContent:side(a.base)}) ]),
        el('div',{className:'railrow'},[ el('span',{textContent:t('compare.head')}), el('span',{className:'mono',textContent:side(a.head)}) ]),
        el('div',{className:'comment',textContent:t('compare.counts',{ nodes:'+'+a.nodes.added+' -'+a.nodes.removed, edges:'+'+a.edges.added+' -'+a.edges.removed+' ~'+a.edges.regraded })}),
        el('div',{className:'comment mono',textContent:counts(a.nodes.byKind,[['added','+'],['removed','-']])}),
        el('div',{className:'comment mono',textContent:counts(a.edges.byType,[['added','+'],['removed','-'],['regraded','~']])}) ]),
      cmpConditions(a.conditions),
      cmpList('compare.endpoints', a.endpointsTouched.total, a.endpointsTouched.ids.map((id)=> el('li',{},[ el('span',{className:'mono',textContent:id.slice('endpoint:'.length)}), flowButton(id) ]))),
      cmpList('compare.screens', a.screensTouched.total, a.screensTouched.ids.map((id)=> nodeRow(id.slice('screen:'.length)))),
      cmpList('compare.added', a.nodes.added, a.nodes.addedIds.map((id)=> nodeRow(id))),
      cmpList('compare.removed', a.nodes.removed, a.nodes.removedIds.map((x)=> nodeRow(x.id, x.axisChanged ? t('compare.axis',{axis:x.axisChanged}) : null))),
      cmpList('compare.edges.added', a.edges.added, a.edges.addedList.map((e)=> edgeRow(e, e.grade))),
      cmpList('compare.edges.removed', a.edges.removed, a.edges.removedList.map((e)=> edgeRow(e, e.grade))),
      cmpList('compare.edges.regraded', a.edges.regraded, a.edges.regradedList.map((e)=> edgeRow(e, e.base+' → '+e.head))) ]),
    honesty(r, 'compare') ]));
}
