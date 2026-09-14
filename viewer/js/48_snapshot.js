// 48_snapshot.js — the Export button, and the page when it IS an exported file.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// ---------- the Export button, on a live page ---------------------------------
// What the button sends is the question the picture on screen answered: the tab
// and the arguments `drawChain` last asked `flow` with. The server writes the
// file with the same generator `cascade export` uses (src/viewer/snapshot.mjs),
// so the button and the command line cannot write two different files for one
// question. The page only saves what comes back.
const exportButtonOf=(v)=> byId(v.name==='flow' ? 'fexport' : 'iexport');
/** A picture with no answer on screen has nothing to write. */
function refreshExportButtons(){
  for(const v of [FLOWV, IMPACTV]){
    const b=exportButtonOf(v);
    if(b) b.disabled = !!SNAP || !(v.resp && v.args);
  }
}
async function exportChain(v){
  if(SNAP || !v.resp || !v.args) return;
  const btn=exportButtonOf(v);
  btn.disabled=true;
  try{
    const body={ tab:v.name, arguments:v.args, lang:I18N.lang, ...(STATE.project ? {project:STATE.project} : {}) };
    const r=await fetch('/api/export', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    const j=await r.json();
    if(j.error) throw new Error(j.error.code+': '+j.error.message);
    snapshotSave(j.answer.filename, j.answer.html);
  }catch(e){
    vside(v).prepend(errPanel(e));
  }finally{
    refreshExportButtons();
  }
}
/** Hand the file to the browser's own download, and let go of it after. */
function snapshotSave(filename, html){
  const url=URL.createObjectURL(new Blob([html], {type:'text/html;charset=utf-8'}));
  const a=document.createElement('a');
  a.href=url; a.download=filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// ---------- the page, when it is an exported file ------------------------------
// The band under the masthead says what the file is before anything else does:
// the one question it answers, when and from which pack, and how much that
// answer is worth. The limits and the truncated lists are drawn in the rail
// beside the picture exactly as on a live page; the band counts them so a reader
// skimming a report cannot miss that there are some.
function renderSnapshotChrome(){
  const bar=byId('snapbar');
  if(!bar) return;
  if(!SNAP){ bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const flow=SNAP.calls.find((c)=>c.name==='flow');
  const a=flow ? flow.answer : null;
  const limits=a && Array.isArray(a.limits) ? a.limits.length : 0;
  // A list is CUT only when it shows fewer rows than it has; a list shown whole is
  // a truncation line too, and counting those would report cuts that are not there.
  const truncated=a && a.truncated && Array.isArray(a.truncated.fields) ? a.truncated.fields.filter((f)=>f.shown<f.total).length : 0;
  const trust=a && a.trust && a.trust.trustLevel ? a.trust.trustLevel : '?';
  const m=SNAP.meta||{};
  const tabName=SNAP.tab==='impact' ? t('tab.impact') : t('tab.flow');
  bar.replaceChildren(
    el('strong',{textContent:t('snap.title')}),
    el('span',{textContent:t('snap.question',{ tab:tabName, kind:SNAP.entry.kind, value:SNAP.entry.value,
      mode:SNAP.args.mode, depth:SNAP.args.depth, limit:SNAP.args.limit })}),
    el('span',{textContent:t('snap.when',{ generated:SNAP.generatedAt||'?', digest:m.digest||'?', built:m.builtAt||'?',
      version:(SNAP.engine && SNAP.engine.version)||'?' })}),
    el('span',{className:(limits||truncated) ? 'snapwarn' : '', textContent:t('snap.honesty',{ trust, limits, truncated })}),
    el('span',{textContent:t('snap.only')}));
}
/**
 * Boot an exported file: no project list, no rail, one tab, and the picture
 * drawn through the same `drawChain` a live page uses, whose one question the
 * file answers. The controls that would ask a different question are disabled
 * rather than left to fail; the two that only redraw the same answer (chain or
 * by hop, the moving dots) still work.
 */
async function snapshotBoot(){
  document.body.classList.add('snapshot');
  setTheme('drawing', true);
  await Promise.all(Object.keys(SNAP.catalogs||{}).map(loadCatalog));
  await loadProjects();
  STATE.project=SNAP.project.id;
  STATE.tab=SNAP.tab;
  setLang(SNAP.lang||'en');
  for(const n of document.querySelectorAll('.tab')) n.classList.toggle('snaptab', n.dataset.tab===SNAP.tab);
  loadMeta();
  loadOverview();
  const v=CHAINTABS[SNAP.tab];
  byId(v.entryId).value=SNAP.entry.value;
  v.pick={ kind:SNAP.entry.kind, value:SNAP.entry.value };
  byId(v.modeId).value=SNAP.args.mode;
  byId(v.depthId).value=String(SNAP.args.depth);
  v.limit=SNAP.args.limit;
  for(const id of [v.entryId, v.modeId, v.depthId]) byId(id).disabled=true;
  // Drawn before the tab opens, so opening it finds a picture and asks nothing.
  const drawn=drawChain(v, true);
  activateTab(SNAP.tab);
  await drawn;
  renderSnapshotChrome();
  refreshExportButtons();
  refreshShowAll();
}
