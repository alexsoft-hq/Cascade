// 48_snapshot.js — the Export button, and the page when it IS an exported file.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// ---------- the Export button, on a live page ---------------------------------
// What the button sends is the question the picture on screen answered: the
// arguments `drawChain` last asked `flow` with, and which of the two pictures a
// file is of (`flow` down, `impact` up, the names `cascade export --tab` takes).
// The server writes the
// file with the same generator `cascade export` uses (src/viewer/snapshot.mjs),
// so the button and the command line cannot write two different files for one
// question. The page only saves what comes back.
const EXPORT_BUTTONS={ trace:{html:'texport', svg:'tsvg', png:'tpng'} };
/** Which saved picture an answer is: down is a Flow file, up an Impact one. */
const exportTabOf=(v)=> v.direction==='up' ? 'impact' : 'flow';
/** A picture with no answer on screen has nothing to write, and the details lists are not a picture. */
function refreshExportButtons(){
  const v=TRACEV;
  for(const id of Object.values(EXPORT_BUTTONS[v.name])){
    const b=byId(id);
    if(b) b.disabled = !!SNAP || !(v.resp && v.args) || TRACE.dir==='detail' || TRACE.edits;
  }
}
/**
 * HTML and SVG are written by the server; a PNG is the SVG drawn by THIS
 * browser, so nothing has to be installed anywhere to make one.
 */
async function exportChain(v, format='html'){
  if(SNAP || !v.resp || !v.args) return;
  for(const id of Object.values(EXPORT_BUTTONS[v.name])) byId(id).disabled=true;
  try{
    const body={ tab:exportTabOf(v), arguments:v.args, lang:I18N.lang, format: format==='html' ? 'html' : 'svg', ...(STATE.project ? {project:STATE.project} : {}) };
    const r=await fetch('/api/export', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    const j=await r.json();
    if(j.error) throw new Error(j.error.code+': '+j.error.message);
    const a=j.answer;
    if(format==='html') snapshotSave(a.filename, a.html, 'text/html;charset=utf-8');
    else if(format==='svg') snapshotSave(a.filename, a.svg, 'image/svg+xml');
    else snapshotSave(a.filename.replace(/\.svg$/, '.png'), await svgToPng(a.svg), 'image/png');
  }catch(e){
    vside(v).prepend(errPanel(e));
  }finally{
    refreshExportButtons();
  }
}
/**
 * The SVG drawn onto a canvas at twice its size, as a PNG. The side is capped so
 * a very tall answer still fits the largest canvas a browser will make.
 */
async function svgToPng(svg){
  const url=URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'}));
  try{
    const img=new Image();
    await new Promise((ok, no)=>{ img.onload=ok; img.onerror=()=>no(new Error(t('export.png.failed'))); img.src=url; });
    const w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
    const scale=Math.min(2, 16000/Math.max(w, h, 1));
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(w*scale); canvas.height=Math.round(h*scale);
    const ctx=canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return await new Promise((ok, no)=> canvas.toBlob((b)=> b ? ok(b) : no(new Error(t('export.png.failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
/** Hand the file to the browser's own download, and let go of it after. */
function snapshotSave(filename, data, type){
  const url=URL.createObjectURL(data instanceof Blob ? data : new Blob([data], {type}));
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
  // The file answers one Trace question: the direction is its name.
  const dirName=t(SNAP.tab==='impact' ? 'trace.dir.up' : 'trace.dir.down');
  bar.replaceChildren(
    el('strong',{textContent:t('snap.title')}),
    el('span',{textContent:t('snap.question',{ dir:dirName, kind:SNAP.entry.kind, value:SNAP.entry.value,
      mode:SNAP.args.mode, depth:depthText(SNAP.args.depth), limit:SNAP.args.limit })}),
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
  STATE.tab='trace';
  setLang(SNAP.lang||'en');
  for(const n of document.querySelectorAll('.tab')) n.classList.toggle('snaptab', n.dataset.place==='trace');
  loadMeta();
  loadOverview();
  traceFromSnapshot(SNAP);
  // Drawn before the tab opens, so opening it finds a picture and asks nothing.
  const drawn=drawChain(TRACEV, true);
  activateTab('trace');
  await drawn;
  renderSnapshotChrome();
  refreshExportButtons();
  refreshShowAll();
}
