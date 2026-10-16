import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';
const row={id:'decl:load',name:'load',signature:'load(id: string): Order',kind:'function',file:'src/load.ts',line:2,endLine:4,extent:'line'};
const dependency={from:'src/api',to:'src/data',type:'CALLS',count:2,provenance:'recorded-call',examples:[{fromFile:'src/load.ts',toFile:'src/db.ts',line:2,grade:'EXACT'}]};
const envelope=(answer)=>({answer,basis:{structureDigest:'structure12345678',buildDigest:'0123456789abcdef',freshness:{verdict:'current'}},limits:[],truncated:{fields:[]}});
async function boot(t,{fail=false}={}){
  const {html,base}=await startViewer(t,['gamma','delta']); const asked=[];
  const answer=async(url,opts)=>{
    const body=opts?.body?JSON.parse(opts.body):null;
    const name=body?.name; if(name) asked.push(body);
    const responses={
      session_briefing:envelope({summary:{project:body?.project,files:4,declarations:8,modules:2},items:[{module:'src/api',files:2,declarations:4}],dependencies:[dependency],text:'Server briefing: src/api -> src/data. Bounded analyzed inputs.',entrypoints:[{kind:'endpoint',method:'GET',path:'/orders',file:row.file,line:2,evidence:'recorded-endpoint'}],coverage:{scope:'analyzed-inputs',lanes:['ts'],complete:false,limitations:['Only selected files.']},workflow:{discover:'Use code_search.',inspect:'Inspect exact source before editing.',change:'Check impact.'},totals:{dependencies:1}}),
      architecture:envelope({dependencies:[dependency],totals:{dependencies:1},paging:{dependencies:{nextOffset:null}},unresolved:[]}),
      code_search:envelope({items:[row]}),file_outline:envelope({file:{path:row.file},items:[row]}),
      code_snippet:envelope({file:row.file,fromLine:2,toLine:4,snippet:'function load() {\n  return "<img src=x onerror=alert(1)>";\n}',cut:false}),
      index_status:envelope({available:true,generation:'structure12345678',status:{verdict:'behind',reason:'test freshness disclosure'}}),
    };
    if(name in responses) return new Response(JSON.stringify(fail&&name!=='index_status'?{error:{code:'structure-unavailable',message:'Run cascade analyze'}}:responses[name]),{status:200});
    return fetch(base+url,opts);
  };
  const page=await bootPage({html,origin:base,hash:'#p=gamma&tab=code',answer}); await settle(page.ctx,30); return {...page,asked};
}
test('Code workspace loads briefing, dependencies and search with honest freshness',async(t)=>{
  const page=await boot(t), text=page.byId.get('codeview').textContent;
  assert.match(text,/Session briefing/); assert.match(text,/Directed dependencies/); assert.match(text,/src\/api/); assert.match(text,/src\/data/); assert.match(text,/CALLS/); assert.match(text,/behind/);
  for(const name of ['session_briefing','architecture','code_search','index_status']) assert.ok(page.asked.some((call)=>call.name===name));
  assert.ok(page.body.querySelectorAll('.tab').some((node)=>node.dataset.place==='code'));
});
test('selecting a result loads outline and bounded exact bytes without interpreting source markup',async(t)=>{
  const page=await boot(t); page.byId.get('codeview').querySelector('.code-result').onclick(); await settle(page.ctx,20);
  assert.ok(page.asked.some((call)=>call.name==='file_outline'&&call.arguments.file===row.file));
  assert.ok(page.asked.some((call)=>call.name==='code_snippet'&&call.arguments.file===row.file&&call.arguments.fromLine===2));
  const box=page.byId.get('codeview'); assert.match(box.textContent,/<img src=x onerror=alert\(1\)>/); assert.equal(box.querySelectorAll('img').length,0);
  assert.equal(box.querySelectorAll('.code-line').length,3); assert.match(box.textContent,/Source hash verified/);
});
test('copy briefing is readable text and project reset discards source state',async(t)=>{
  const page=await boot(t); const text=ev(page.ctx,'codeBriefingText()');
  assert.match(text,/src\/api -> src\/data/); assert.match(text,/behind/); assert.match(text,/missing relations/);
  ev(page.ctx,"CODE.selected='src/old.ts'; codeReset()"); assert.equal(ev(page.ctx,'CODE.selected'),null); assert.equal(page.byId.get('codeview').hasChildNodes(),false);
});
test('old packs show an actionable unavailable state, not empty architecture',async(t)=>{
  const page=await boot(t,{fail:true}); const text=page.byId.get('codeview').textContent;
  assert.match(text,/Code knowledge is unavailable/); assert.match(text,/cascade analyze/);
  assert.equal(page.byId.get('codeview').querySelectorAll('.code-dependency').length,0);
});


test('failed refresh still displays independent index status and does not claim current source',async(t)=>{
  const page=await boot(t,{fail:true});
  assert.ok(page.asked.some((call)=>call.name==='index_status'));
  assert.match(page.byId.get('codeview').textContent,/behind/);
  assert.match(page.byId.get('codeview').textContent,/test freshness disclosure/);
});

test('language and theme changes repaint loaded Code content without another analysis request',async(t)=>{
  const page=await boot(t); const before=page.asked.length;
  await ev(page.ctx,"loadCatalog('ko')"); ev(page.ctx,"setLang('ko'); setTheme('drawing')");
  assert.match(page.byId.get('codeview').textContent,/세션 시작 요약/);
  assert.match(page.byId.get('codeview').textContent,/방향이 있는 의존 관계/);
  assert.equal(page.asked.length,before);
});

test('actual briefing object schema copies authoritative prose, entrypoint evidence and coverage, with manual fallback',async(t)=>{
  const page=await boot(t);
  ev(page.ctx,"globalThis.navigator={clipboard:{writeText:async(text)=>{globalThis.copiedBriefing=text;}}}");
  await ev(page.ctx,'codeCopyBriefing()');
  const copied=ev(page.ctx,'copiedBriefing');
  for(const text of ['Server briefing:','recorded-endpoint','Only selected files.','Use code_search.','behind']) assert.ok(copied.includes(text));
  ev(page.ctx,"navigator.clipboard.writeText=async()=>{throw new Error('denied')}");
  await ev(page.ctx,'codeCopyBriefing()');
  assert.equal(page.byId.get('codeview').querySelector('.code-copy-text').value,copied);
  assert.match(page.byId.get('codeview').textContent,/Index: structure123/);
});
test('directory depth reloads both views and outline labels distinguish signatures',async(t)=>{
  const page=await boot(t), select=page.byId.get('codeview').querySelector('.code-depth').querySelector('select');
  assert.equal(select.children.length,8);
  select.onchange({target:{value:'5'}}); await settle(page.ctx,25);
  for(const name of ['session_briefing','architecture']) assert.equal(page.asked.filter((call)=>call.name===name).at(-1).arguments.depth,5);
  page.byId.get('codeview').querySelector('.code-result').onclick(); await settle(page.ctx,20);
  const outline=page.byId.get('codeview').querySelector('.code-outline');
  assert.match(outline.textContent,/load\(id: string\): Order/);
  assert.match(outline.querySelector('button').title,/src\/load.ts:2/);
  const disclosure=page.byId.get('codeview').querySelector('.code-full-briefing');
  assert.match(disclosure.textContent,/Server briefing/); assert.equal(disclosure.getAttribute('open'),null);
});

function deferApi(page){
  ev(page.ctx, `globalThis.pending=[]; globalThis.fetch=(url,opts)=>new Promise((resolve,reject)=>{const body=JSON.parse(opts.body); pending.push({name:body.name,args:body.arguments,resolve:(data)=>resolve({ok:true,json:async()=>data}),reject});});`);
}
function resolvePending(page,index,response){
  ev(page.ctx, `pending[${index}].resolve(${JSON.stringify(response)})`);
}
test('dependency paging rejects depth/reload replacement and prevents double requests',async(t)=>{
  const page=await boot(t); deferApi(page);
  ev(page.ctx,"CODE.architecture.answer.paging.dependencies.nextOffset=24; codeMoreDependencies(); codeMoreDependencies()");
  assert.equal(ev(page.ctx,'pending.length'),1);
  ev(page.ctx,"CODE.depth=5; codeReload(); CODE.architecture={answer:{dependencies:[{from:'new-depth'}]}};");
  resolvePending(page,0,envelope({dependencies:[dependency],paging:{dependencies:{nextOffset:null}}})); await settle(page.ctx,5);
  assert.equal(ev(page.ctx,'CODE.architecture.answer.dependencies[0].from'),'new-depth');
  assert.equal(ev(page.ctx,'CODE.depPending'),null);
});
test('same-file repick rejects old outline page and duplicate More calls',async(t)=>{
  const page=await boot(t); await ev(page.ctx,"codeOpenFile('src/load.ts',2)"); deferApi(page);
  ev(page.ctx,'codeMoreOutline(100); codeMoreOutline(100)'); assert.equal(ev(page.ctx,'pending.length'),1);
  ev(page.ctx,"CODE.pickSeq++; CODE.outline={answer:{items:[{name:'replacement'}]},truncated:{fields:[]}}");
  resolvePending(page,0,envelope({items:[row]})); await settle(page.ctx,5);
  assert.equal(ev(page.ctx,'CODE.outline.answer.items.length'),1);
  assert.equal(ev(page.ctx,'CODE.outline.answer.items[0].name'),'replacement');
});
test('failed old load cannot replace newer status after fallback status await',async(t)=>{
  const page=await boot(t); deferApi(page);
  ev(page.ctx,'loadCodeWorkspace()'); ev(page.ctx,"pending[0].reject(new Error('failure'))"); await settle(page.ctx,3);
  assert.equal(ev(page.ctx,'pending[3].name'),'index_status');
  ev(page.ctx,"CODE.seq++; CODE.status={answer:{status:{verdict:'current',reason:'newer'}}}");
  resolvePending(page,3,envelope({status:{verdict:'behind',reason:'old'}})); await settle(page.ctx,3);
  assert.equal(ev(page.ctx,'CODE.status.answer.status.reason'),'newer');
});
test('new query generation marks overview unknown and disables copying without changing source freshness',async(t)=>{
  const page=await boot(t); deferApi(page); ev(page.ctx,'codeSearch()');
  const response=envelope({items:[row]}); response.basis.structureDigest='new-generation';
  resolvePending(page,0,response); await settle(page.ctx,5);
  assert.equal(ev(page.ctx,'CODE.overviewChanged'),true); assert.equal(ev(page.ctx,'codeFreshness().verdict'),'unknown');
  assert.equal(page.byId.get('codeview').querySelector('.code-copy').disabled,true);
  assert.equal(ev(page.ctx,'CODE.briefing.basis.structureDigest'),'structure12345678');
});

test('pagination preserves old rows and requires reload across generations for all three lists',async(t)=>{
  const page=await boot(t); await ev(page.ctx,"codeOpenFile('src/load.ts',2)"); deferApi(page);
  ev(page.ctx,'CODE.architecture.answer.paging.dependencies.nextOffset=24; codeMoreDependencies()');
  const next=envelope({dependencies:[{from:'new'}],items:[{name:'new'}],paging:{dependencies:{nextOffset:null}}});
  next.basis.structureDigest='new-generation';
  resolvePending(page,0,next); await settle(page.ctx,3);
  assert.equal(ev(page.ctx,'CODE.architecture.answer.dependencies.length'),1);
  assert.equal(ev(page.ctx,'CODE.architecture.answer.dependencies[0].from'),'src/api');
  ev(page.ctx,'codeMoreOutline(100)'); resolvePending(page,1,next); await settle(page.ctx,3);
  assert.equal(ev(page.ctx,'CODE.outline.answer.items.length'),1);
  assert.equal(ev(page.ctx,'CODE.outline.answer.items[0].name'),'load');
  ev(page.ctx,'codeSearch(40)'); resolvePending(page,2,next); await settle(page.ctx,3);
  assert.equal(ev(page.ctx,'CODE.results.answer.items.length'),1);
  assert.equal(ev(page.ctx,'CODE.results.answer.items[0].name'),'load');
  assert.equal(ev(page.ctx,'CODE.overviewChanged'),true);
  assert.equal(page.byId.get('codeview').querySelector('.code-copy').disabled,true);
});

test('new generation search hides old source and a newly opened snippet remains visible',async(t)=>{
  const page=await boot(t); await ev(page.ctx,"codeOpenFile('src/load.ts',2)");
  assert.ok(page.byId.get('codeview').querySelector('.code-source-code'));
  deferApi(page); ev(page.ctx,'codeSearch()');
  const current=(answer)=>({...envelope(answer),basis:{...envelope({}).basis,structureDigest:'saved-generation'}});
  resolvePending(page,0,current({items:[]})); await settle(page.ctx,3);
  assert.equal(page.byId.get('codeview').querySelector('.code-source-code'),null);
  assert.equal(page.byId.get('codeview').querySelector('.code-source-meta'),null);
  ev(page.ctx,"codeOpenFile('src/load.ts',2)");
  resolvePending(page,1,current({file:{path:row.file},items:[row]})); await settle(page.ctx,3);
  resolvePending(page,2,current({file:row.file,fromLine:2,toLine:2,snippet:'new source',cut:false})); await settle(page.ctx,3);
  assert.match(page.byId.get('codeview').querySelector('.code-source-code').textContent,/new source/);
  assert.match(page.byId.get('codeview').querySelector('.code-source-meta').textContent,/current/);
  assert.equal(ev(page.ctx,'CODE.overviewChanged'),true);
});
