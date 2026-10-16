// Code workspace: persisted structure, bounded source reads, and explicit freshness.
const CODE_LABELS={files:'code.files',declarations:'code.declarations',modules:'code.modules',all:'code.kind.all',file:'code.kind.file',declaration:'code.kind.declaration'};
const CODE={ project:null, seq:0, pickSeq:0, loading:false, error:null, briefing:null, architecture:null, status:null, depBudget:32768, depth:2, results:null, query:'', kind:'all', outline:null, snippet:null, selected:null, feedback:'', depPending:null, outlinePending:null, overviewChanged:false,latestGeneration:null };
function codeReset(){
  CODE.seq++; CODE.pickSeq++;
  Object.assign(CODE,{project:null,depth:2,depBudget:32768,loading:false,error:null,briefing:null,architecture:null,status:null,results:null,query:'',kind:'all',outline:null,snippet:null,selected:null,feedback:'',depPending:null,outlinePending:null,overviewChanged:false,latestGeneration:null});
  const box=byId('codeview'); if(box) box.replaceChildren();
}
function codeOnScreen(){ if(CODE.project!==STATE.project || !CODE.briefing && !CODE.error && !CODE.loading) loadCodeWorkspace(); else renderCodeWorkspace(); }
async function loadCodeWorkspace(){
  const seq=++CODE.seq; CODE.project=STATE.project; CODE.loading=true; CODE.error=null; renderCodeWorkspace();
  try{
    const [briefing,architecture,results]=await Promise.all([
      api('session_briefing',{depth:CODE.depth,limit:12}), api('architecture',{depth:CODE.depth,limit:24,maxBytes:CODE.depBudget}),
      api('code_search',{query:CODE.query.trim()||'.',kind:CODE.query.trim()?CODE.kind:'file',limit:40})]);
    const status=await api('index_status',{});
    if(seq!==CODE.seq) return;
    Object.assign(CODE,{briefing,architecture,results,status,overviewChanged:false,latestGeneration:briefing.basis?.structureDigest??null});
  }catch(e){ if(seq===CODE.seq && !stale(e)){ CODE.error=e.message; try{ const status=await api('index_status',{}); if(seq===CODE.seq) CODE.status=status; }catch{ /* status can also be unavailable */ } } }
  finally{ if(seq===CODE.seq){ CODE.loading=false; renderCodeWorkspace(); } }
}
function codeText(tag,text,className=''){ return el(tag,{textContent:String(text??''),className}); }
function codeButton(key,action,props={}){ return el('button',{type:'button',textContent:t(key),onclick:action,...props}); }
function codeSection(title,children,className=''){
  return el('section',{className:'code-card '+className},[codeText('h3',t(title)),...children]);
}
function codeObserveGeneration(response){
  const shown=CODE.briefing?.basis?.structureDigest, received=response?.basis?.structureDigest;
  if(received) CODE.latestGeneration=received;
  if(shown && received && shown!==received) CODE.overviewChanged=true;
}
function codeFreshness(){ if(CODE.overviewChanged) return {verdict:'unknown',reason:t('code.reload')}; return CODE.status?.answer?.status || CODE.status?.basis?.freshness || CODE.briefing?.basis?.freshness || {}; }
function codeStatusLine(){
  const fresh=codeFreshness();
  const line=el('div',{className:'code-status',role:'status'},[
    codeText('span',fresh.verdict||'unknown','code-fresh '+(fresh.verdict==='current'?'is-current':'')),
    codeText('span',t('code.saved'),'code-muted')]);
  if(fresh.reason) line.append(codeText('span',fresh.reason,'code-muted'));
  const generation=CODE.status?.answer?.generation||CODE.briefing?.basis?.structureDigest;
  if(generation) line.append(codeText('code',`${t('code.index')}: ${generation.slice(0,12)}`));
  return line;
}
function renderCodeWorkspace(){
  const box=byId('codeview'); if(!box) return;
  const head=el('div',{className:'code-heading'},[
    el('div',{},[codeText('div',t('code.eyebrow'),'code-eyebrow'),codeText('h2',t('code.title')),codeText('p',t('code.intro'),'code-muted')]),
    el('div',{className:'code-controls'},[codeDepthControl(),codeButton('code.reload',()=>codeReload(),{disabled:CODE.loading,className:'primary'})])]);
  const children=[head,codeStatusLine()];
  if(CODE.loading) children.push(codeText('p',t('code.loading'),'code-notice'));
  if(CODE.error) children.push(codeSection('code.unavailable',[codeText('p',CODE.error),codeText('p',t('code.recovery'),'code-muted')],'code-error'));
  if(CODE.briefing) children.push(el('div',{className:'code-overview'},[codeBriefingCard(),codeDependenciesCard()]));
  if(CODE.results) children.push(codeBrowser());
  children.push(codeText('p',t('code.coverage'),'code-footnote'));
  box.replaceChildren(...children); box.setAttribute('aria-busy',String(CODE.loading));
}
async function codeReload(){
  CODE.pickSeq++; CODE.outline=null; CODE.snippet=null; CODE.selected=null; CODE.feedback='';
  await loadCodeWorkspace();
}
function codeDepthControl(){
  const select=el('select',{ariaLabel:t('code.depth'),disabled:CODE.loading,onchange:(event)=>{CODE.depth=Number(event.target.value); codeReload();}},
    Array.from({length:8},(_,i)=>el('option',{value:String(i+1),selected:CODE.depth===i+1,textContent:String(i+1)})));
  return el('label',{className:'code-depth'},[codeText('span',t('code.depth')),select]);
}
function codeBriefingText(){
  const answer=CODE.briefing?.answer||{}, summary=answer.summary||{};
  const lines=[answer.text||`${t('code.briefing')}: ${summary.project||STATE.project||''}`,
    `${t('code.freshness')}: ${codeFreshness().verdict||'unknown'}`];
  for(const entry of answer.entrypoints||[]) lines.push([entry.method||entry.kind,entry.path,entry.file,entry.line,entry.evidence].filter(Boolean).join(' · '));
  for(const step of Object.values(answer.workflow||{})) if(typeof step==='string') lines.push(step);
  if(answer.coverage) lines.push([answer.coverage.scope,...(answer.coverage.lanes||[])].filter(Boolean).join(' · '));
  for(const caveat of answer.coverage?.limitations||[]) lines.push(String(caveat));
  lines.push(t('code.shown',{shown:(answer.dependencies||[]).length,total:answer.totals?.dependencies??(answer.dependencies||[]).length}));
  lines.push(t('code.coverage'));
  for(const limit of CODE.briefing?.limits||[]) lines.push(limit.reason);
  return lines.join('\n');
}
async function codeCopyBriefing(){
  if(CODE.overviewChanged) return;
  try{ await navigator.clipboard.writeText(codeBriefingText()); CODE.feedback=t('code.copied'); }
  catch{ CODE.feedback=t('code.copyManual'); }
  renderCodeWorkspace();
}
function codeBriefingCard(){
  const answer=CODE.briefing.answer||{}, summary=answer.summary||{};
  const stats=el('div',{className:'code-stats'},['files','declarations','modules'].map((key)=>el('div',{},[codeText('strong',summary[key]??0),codeText('span',t(CODE_LABELS[key]))])));
  const modules=el('div',{className:'code-module-chips'},(answer.items||[]).slice(0,8).map((item)=>el('button',{type:'button',className:'code-module',textContent:item.module,onclick:()=>codeSearchFor(item.module)})));
  const entrypoints=el('div',{className:'code-entrypoints'},(answer.entrypoints||[]).slice(0,4).map((item)=>el('button',{type:'button',disabled:!item.file,textContent:[item.method,item.path||item.id].filter(Boolean).join(' '),onclick:()=>codeOpenFile(item.file,item.line)})));
  const copy=codeButton('code.copy',codeCopyBriefing,{className:'code-copy',disabled:CODE.overviewChanged,title:CODE.overviewChanged?t('code.reload'):''});
  const children=[stats];
  if(answer.text) children.push(el('details',{className:'code-full-briefing'},[el('summary',{textContent:t('code.fullBriefing')}),codeText('p',answer.text,'code-briefing-text')]));
  children.push(codeText('p',t('code.moduleHint'),'code-muted'),modules);
  if(entrypoints.hasChildNodes()) children.push(codeText('h4',t('code.entrypoints')),entrypoints);
  children.push(copy,codeText('span',CODE.feedback,'code-feedback'));
  if(CODE.feedback===t('code.copyManual')) children.push(el('textarea',{readOnly:true,value:codeBriefingText(),className:'code-copy-text',ariaLabel:t('code.briefing')}));
  return codeSection('code.briefing',children);
}
function codeDependenciesCard(){
  const a=CODE.architecture?.answer||{}, rows=a.dependencies||[];
  const list=el('div',{className:'code-dependencies'},rows.map(codeDependency));
  const children=[codeText('p',t('code.direction'),'code-muted'),list];
  if(!rows.length) children.push(codeText('p',t('code.noDependencies'),'code-notice'));
  const total=a.totals?.dependencies??rows.length;
  children.push(codeText('p',t('code.shown',{shown:rows.length,total}),'code-muted'));
  if(a.paging?.dependencies?.byteLimited) children.push(codeText('p',t('code.byteLimited'),'code-notice'));
  if(a.paging?.dependencies?.nextOffset!=null || a.paging?.dependencies?.byteLimited&&CODE.depBudget<262144) children.push(codeButton('code.more',()=>codeMoreDependencies(),{disabled:!!CODE.depPending}));
  if((a.unresolved||[]).length) children.push(codeUnresolved(a));
  return codeSection('code.dependencies',children,'code-dependency-card');
}
function codeDependency(row){
  const details=el('details',{className:'code-dependency'});
  const summary=el('summary',{},[
    codeText('span',row.from,'code-path'),codeText('span','→','code-arrow'),codeText('span',row.to,'code-path'),
    codeText('span',`${row.type} × ${row.count}`,'code-relation')]);
  const evidence=el('div',{className:'code-evidence'},[codeText('p',row.provenance,'code-muted')]);
  for(const example of row.examples||[]){
    const source=[example.fromFile,example.line?':'+example.line:''].join('');
    evidence.append(el('button',{type:'button',className:'code-evidence-link',textContent:source+' → '+example.toFile,onclick:()=>codeOpenFile(example.fromFile,example.line)}));
    evidence.append(codeText('p',[example.grade,example.resolution].filter(Boolean).join(' / '),'code-muted'));
  }
  details.append(summary,evidence); return details;
}
function codeUnresolved(answer){
  const details=el('details',{className:'code-unresolved'},[el('summary',{textContent:t('code.unresolved',{n:answer.totals?.unresolved??answer.unresolved.length})})]);
  for(const row of answer.unresolved.slice(0,12)) details.append(codeText('p',`${row.sourceFile} → ${row.target}: ${row.reason}`));
  return details;
}
function codeDependencyRequest(){
  if(CODE.depPending || CODE.loading) return null;
  const base=CODE.architecture, seq=CODE.seq, depth=CODE.depth, project=CODE.project;
  const paging=base?.answer?.paging?.dependencies;
  const offset=paging?.nextOffset??paging?.blockedOffset; if(offset==null) return null;
  const token={}; CODE.depPending=token;
  const valid=()=>seq===CODE.seq && project===CODE.project && depth===CODE.depth && base===CODE.architecture;
  if(paging.byteLimited) CODE.depBudget=Math.min(CODE.depBudget*2,262144);
  return {base,token,valid,args:{depth,limit:24,offset,maxBytes:CODE.depBudget}};
}
function codePageGeneration(base,response){
  if(base?.basis?.structureDigest===response?.basis?.structureDigest) return true;
  codeObserveGeneration(response); CODE.overviewChanged=true; renderCodeWorkspace(); return false;
}
async function codeMoreDependencies(){
  const request=codeDependencyRequest(); if(!request) return;
  const {base,token,valid,args}=request; renderCodeWorkspace();
  try{
    const response=await api('architecture',args);
    if(!valid() || !codePageGeneration(base,response)) return;
    codeObserveGeneration(response);
    CODE.architecture=response; CODE.architecture.answer.dependencies=[...base.answer.dependencies,...response.answer.dependencies];
  }catch(e){ if(valid()&&!stale(e)) CODE.error=e.message; }
  finally{ if(CODE.depPending===token){ CODE.depPending=null; renderCodeWorkspace(); } }
}
function codeSearchFor(query){ CODE.query=query; CODE.kind='all'; codeSearch(); }
async function codeSearch(offset=0){
  if(CODE.loading) return;
  const seq=++CODE.seq, base=CODE.results;
  try{
    const response=await api('code_search',{query:CODE.query.trim()||'.',kind:CODE.query.trim()?CODE.kind:'file',limit:40,offset});
    if(seq!==CODE.seq || offset && !codePageGeneration(base,response)) return;
    const previous=offset?(CODE.results?.answer?.items||[]):[];
    codeObserveGeneration(response); CODE.results=response; CODE.results.answer.items=[...previous,...response.answer.items]; CODE.error=null; renderCodeWorkspace();
  }catch(e){ if(seq===CODE.seq&&!stale(e)){ CODE.error=e.message; renderCodeWorkspace(); } }
}
function codeBrowser(){
  const query=el('input',{type:'search',value:CODE.query,placeholder:t('code.searchPlaceholder'),ariaLabel:t('code.search'),oninput:(event)=>{CODE.query=event.target.value;}});
  const kind=el('select',{value:CODE.kind,ariaLabel:t('code.kind'),onchange:(event)=>{CODE.kind=event.target.value;}},['all','file','declaration'].map((value)=>el('option',{value,selected:CODE.kind===value,textContent:t(CODE_LABELS[value])})));
  const form=el('form',{className:'code-search',onsubmit:(event)=>{event.preventDefault(); codeSearch();}},[query,kind,el('button',{type:'submit',textContent:t('code.search')})]);
  const resultList=el('div',{className:'code-results'},(CODE.results?.answer?.items||[]).map(codeResult));
  if(!resultList.hasChildNodes()) resultList.append(codeText('p',t('code.noResults'),'code-muted'));
  const field=CODE.results?.truncated?.fields?.find((item)=>item.field==='items');
  const count=codeText('p',t('code.shown',{shown:CODE.results?.answer?.items?.length||0,total:field?.total??0}),'code-muted');
  const sidebar=el('aside',{className:'code-files'},[count,resultList]);
  if(field?.nextOffset!=null) sidebar.append(codeButton('code.more',()=>codeSearch(field.nextOffset)));
  return codeSection('code.browse',[form,el('div',{className:'code-browser'},[sidebar,codeSourcePanel()])],'code-browser-card');
}
function codeResult(row){
  const button=el('button',{type:'button',className:'code-result'+(CODE.selected===row.file?' selected':''),onclick:()=>codeOpenFile(row.file,row.line,row)},[
    codeText('span',row.name||row.file,'code-result-name'),codeText('span',row.file,'code-result-path'),codeText('span',row.kind||row.resultKind,'code-result-kind')]);
  button.setAttribute('aria-pressed',String(CODE.selected===row.file)); return button;
}
async function codeOpenFile(file,line,declaration){
  if(!file || CODE.loading) return; const seq=++CODE.pickSeq;
  CODE.selected=file; CODE.outline=null; CODE.snippet=null; CODE.feedback=''; renderCodeWorkspace();
  try{
    const outline=await api('file_outline',{file,limit:100}); if(seq!==CODE.pickSeq) return;
    codeObserveGeneration(outline); CODE.outline=outline;
    const args=declaration?.extent==='exact'&&declaration?.offsetEncoding==='utf16'&&Number.isInteger(declaration.startOffset)&&Number.isInteger(declaration.endOffset)?{symbol:declaration.id}:{file,fromLine:line||1,maxLines:120};
    const snippet=await api('code_snippet',args); if(seq!==CODE.pickSeq) return;
    codeObserveGeneration(snippet); CODE.snippet=snippet; CODE.error=null; renderCodeWorkspace();
  }catch(e){ if(seq===CODE.pickSeq&&!stale(e)){ CODE.error=e.message; renderCodeWorkspace(); } }
}
function codeSourcePanel(){
  if(!CODE.selected) return el('div',{className:'code-source-empty'},[codeText('strong',t('code.chooseFile')),codeText('p',t('code.chooseHint'))]);
  const children=[codeText('h4',CODE.selected,'code-source-title')];
  const rows=CODE.outline?.answer?.items||[];
  children.push(codeText('h4',t('code.outline')),el('div',{className:'code-outline'},rows.map(codeOutlineRow)));
  const field=CODE.outline?.truncated?.fields?.find((item)=>item.field==='items');
  if(field?.nextOffset!=null) children.push(codeButton('code.moreOutline',()=>codeMoreOutline(field.nextOffset),{disabled:!!CODE.outlinePending}));
  if(!CODE.snippet) children.push(codeText('p',CODE.error||t('code.loading'),'code-muted'));
  else children.push(...codeSourceLines(CODE.snippet));
  return el('section',{className:'code-source'},children);
}
function codeOutlineRow(row){
  const signature=row.signature||row.name;
  return el('button',{type:'button',textContent:`${row.kind} ${signature} :${row.line||'?'}`,title:`${row.file}:${row.line||'?'} · ${signature}`,onclick:()=>codeOpenFile(row.file,row.line,row)});
}
function codeSourceLines(response){
  if(CODE.latestGeneration && response.basis?.structureDigest!==CODE.latestGeneration) return [codeText('p',t('code.reload'),'code-notice')];
  const a=response.answer, fresh=response.basis?.freshness?.verdict||'unknown';
  const meta=codeText('p',`${t('code.sourceVerified')} · ${a.fromLine}–${a.toLine} · ${fresh}`,'code-source-meta');
  const pre=el('pre',{className:'code-source-code',tabIndex:0});
  pre.setAttribute('aria-label',t('code.source'));
  a.snippet.split('\n').forEach((line,index)=>pre.append(el('span',{className:'code-line'},[codeText('span',a.fromLine+index,'code-line-number'),codeText('code',line||' ')])));
  const children=[meta,pre,codeText('p',t('code.sourceCaution'),'code-muted')];
  if(a.cut) children.push(codeText('p',t('code.sourceCut'),'code-notice'));
  return children;
}
async function codeMoreOutline(offset){
  if(CODE.outlinePending || CODE.loading) return;
  const file=CODE.selected, seq=CODE.pickSeq, base=CODE.outline, project=CODE.project;
  const token={}; CODE.outlinePending=token;
  const valid=()=>seq===CODE.pickSeq && file===CODE.selected && project===CODE.project && base===CODE.outline;
  renderCodeWorkspace();
  try{ const response=await api('file_outline',{file,limit:100,offset}); if(!valid() || !codePageGeneration(base,response)) return;
    codeObserveGeneration(response); CODE.outline.answer.items.push(...response.answer.items); CODE.outline.truncated=response.truncated;
  }catch(e){ if(valid()&&!stale(e)) CODE.error=e.message; }
  finally{ if(CODE.outlinePending===token){ CODE.outlinePending=null; renderCodeWorkspace(); } }
}
