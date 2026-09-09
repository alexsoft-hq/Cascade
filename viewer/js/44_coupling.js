// 44_coupling.js — the Coupling tab: which API group writes what another one reads.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

const cpKey=(w,r)=>w+'\u0000'+r;   // NUL: no group name can contain it
const cpUnit=(axis,one)=> (axis==='column' ? (one?'column':'columns') : (one?'table':'tables'));

async function drawCoupling(){
  const wrap=byId('cpmatrix'), side=byId('cpside'), sum=byId('cpsummary');
  sum.replaceChildren(t('load.coupling'));
  wrap.replaceChildren(); side.replaceChildren();
  CP.cellEls=new Map();
  const q={axis:CP.axis, mode:byId('cpmode').value, depth:Number(byId('cpdepth').value)};
  // The PREVIOUS answer dies with the request, not with its reply: a query that
  // fails must not leave the old axis's matrix live behind a toolbar that now
  // says something else.
  CP.resp=null; CP.sel=null;
  // A late answer is never the current answer: an axis switched twice must not
  // be overwritten by the first request coming back second.
  const mine=++CP.seq;
  let r;
  try{ r=await api('coupling',{...q, limit:500}); }
  catch(e){ if(stale(e)||mine!==CP.seq) return; sum.replaceChildren();
    wrap.replaceChildren(el('div',{className:'panel',
      textContent:t('err.coupling',{axis:q.axis, mode:q.mode, depth:q.depth, message:e.message})})); return; }
  if(mine!==CP.seq) return;
  CP.resp=r;
  renderCoupling();
}
// An empty matrix in the Explore words ("none — nothing reaches this") reads as
// "these modules share nothing". It usually is not: it is the grade floor, or
// the depth. Say WHICH, and offer the mode that would look wider.
function cpEmptyNote(a){
  if(a.empty && a.empty.pairs==='not-shipped') return emptyNote(a.empty,'pairs');
  const byMode=(a.walk&&a.walk.byMode)||0;
  if(byMode>0){
    const wider = a.mode==='strict' ? 'conservative' : a.mode==='conservative' ? 'heuristic' : null;
    return el('li',{className:'empty'},[
      t('cp.empty.bymode',{mode:a.mode, n:byMode}),
      wider? el('button',{className:'mini',style:'margin-left:8px',textContent:t('cp.empty.switch',{mode:wider}),onclick:()=>{ byId('cpmode').value=wider; drawCoupling(); }}) : null ]);
  }
  return el('li',{className:'empty',textContent:t('cp.empty.none',{depth:a.depth})});
}
function renderCoupling(){
  const r=CP.resp; if(!r) return;
  const a=r.answer, cells=a.cells||[], s=a.summary||{};
  byId('cpsummary').replaceChildren(
    el('b',{textContent:String(s.groups??0)}), ' groups\u00a0\u00a0',
    el('b',{textContent:String(s.participatingGroups??0)}), ' participating\u00a0\u00a0',
    el('b',{textContent:String(cells.length)}), ' pairs\u00a0\u00a0',
    el('b',{textContent:String(s.coupledItems??0)}), ' coupled '+cpUnit(a.axis), '\u00a0\u00a0',
    el('b',{textContent:String(s.selfOnlyItems??0)}), ' self-only\u00a0\u00a0',
    el('b',{textContent:String((s.writeOnlyItems??0)+(s.readOnlyItems??0))}), ' write-only or read-only');
  renderCouplingMatrix(a, cells);
  renderCouplingSide();
}
function renderCouplingMatrix(a, cells){
  const wrap=byId('cpmatrix');
  const part=new Set(); cells.forEach(c=>{ part.add(c.writer); part.add(c.reader); });
  const all=(a.groups||[]).map(g=>g.group);
  // Collapsed to the participating groups by default: on a real pack the matrix
  // is sparse (mall: 14 filled cells of 650), and 26×26 mostly-empty squares
  // hide the finding instead of showing it.
  const groups=CP.showAll?all:all.filter(g=>part.has(g));
  CP.cellEls=new Map();
  if(!groups.length){
    wrap.replaceChildren(el('div',{className:'panel'},[el('ul',{className:'list'},[cpEmptyNote(a)])]));
    return;
  }
  const unit=cpUnit(a.axis);
  const count=new Map(cells.map(c=>[cpKey(c.writer,c.reader), c.count]));
  const max=cells.reduce((m,c)=>Math.max(m,c.count),0)||1;
  const colTh=[], rowTh=[];
  const head=el('tr',{},[el('th',{className:'cpcorner',title:'a row WRITES what a column READS',textContent:'writer ↓ / reader →'})]);
  groups.forEach(g=>{ const th=el('th',{title:g,textContent:g}); colTh.push(th); head.append(th); });
  const body=el('tbody');
  groups.forEach((w,i)=>{
    const rth=el('th',{title:w,textContent:w}); rowTh.push(rth);
    const tr=el('tr',{},[rth]);
    groups.forEach((rd,j)=>{
      const n=count.get(cpKey(w,rd))||0;
      const cell=el('div',{className:'cpcell'+(w===rd?' diag':'')+(n?' on':'')});
      if(w===rd){
        cell.title=t('cp.diag.title',{group:w, unit});
      } else if(n){
        // One hue, alpha by count -- the WRITE hue, because a cell counts what
        // the row writes. The ramp is the token's own colour at an alpha, so it
        // follows the theme; past the halfway mark the text flips to the ground.
        const alpha=0.08+0.62*(n/max);
        cell.style.background=gfAlpha(cssVar('--write'), alpha);
        if(alpha>0.45) cell.style.color=cssVar('--g0');
        cell.textContent=String(n);
        cell.title=w+' writes '+n+' '+cpUnit(a.axis,n===1)+' that '+rd+' reads';
        cell.tabIndex=0;
        cell.setAttribute('role','button');
        cell.setAttribute('aria-label',cell.title);
        const open=()=>cpSelect(w,rd);
        cell.addEventListener('click',open);
        cell.addEventListener('keydown',(ev)=>{ if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); open(); } });
        CP.cellEls.set(cpKey(w,rd),cell);
        if(CP.sel===cpKey(w,rd)) cell.classList.add('sel');
      } else {
        cell.textContent='·';
      }
      // A cell far from its labels is unreadable: hovering (or focusing) one
      // lights the row and column it belongs to.
      const lightOn=()=>{ colTh[j].classList.add('hot'); rowTh[i].classList.add('hot'); };
      const lightOff=()=>{ colTh[j].classList.remove('hot'); rowTh[i].classList.remove('hot'); };
      cell.addEventListener('mouseenter',lightOn);
      cell.addEventListener('mouseleave',lightOff);
      cell.addEventListener('focus',lightOn);
      cell.addEventListener('blur',lightOff);
      tr.append(el('td',{},[cell]));
    });
    body.append(tr);
  });
  wrap.replaceChildren(el('table',{className:'cpm'},[el('thead',{},[head]), body]));
}
function cpSelect(w,rd){
  const k=cpKey(w,rd);
  CP.sel = CP.sel===k ? null : k;
  for(const [key,e] of CP.cellEls) e.classList.toggle('sel', key===CP.sel);
  renderCouplingSide();
}
function cpClear(){ CP.sel=null; for(const [,e] of CP.cellEls) e.classList.remove('sel'); renderCouplingSide(); }
function renderCouplingSide(){
  const r=CP.resp; if(!r) return;
  const a=r.answer, pairs=a.pairs||[];
  const sel=CP.sel ? pairs.find(p=>cpKey(p.writer,p.reader)===CP.sel) : null;
  const kids=[];
  if(CP.sel && !sel){
    // The cell is in the matrix (cells are never cut) but its pair fell past the
    // list limit — say so rather than showing an empty card.
    kids.push(el('div',{className:'panel'},[
      el('div',{className:'srchead'},[ el('button',{textContent:'All pairs',onclick:cpClear}), el('span',{className:'id',textContent:CP.sel.replace('\u0000',' → ')}) ]),
      el('div',{className:'empty',textContent:t('cp.pastcut',{unit:cpUnit(a.axis)})})]));
  } else if(sel){
    kids.push(...cpDetail(a, sel));
  } else {
    kids.push(cpPairList(r, a, pairs));
  }
  kids.push(honesty(r, 'coupling'));
  byId('cpside').replaceChildren(...kids);
}
function cpPairList(r, a, pairs){
  const tf=(r.truncated&&(r.truncated.fields||[]).find(f=>f.field==='pairs'))||{};
  const total=tf.total ?? pairs.length;
  return el('div',{className:'panel'},[
    el('h2',{},['coupled pairs ', el('span',{className:'count',textContent:'('+total+')'})]),
    el('div',{className:'comment',textContent:t('cp.pairs.note',{unit:cpUnit(a.axis)})}),
    el('ul',{className:'list'}, pairs.length? pairs.map(p=>el('li',{},[
      el('a',{className:'id clickable cppair',title:t('cp.pairs.title',{unit:cpUnit(a.axis)}),onclick:()=>cpSelect(p.writer,p.reader)},[
        el('span',{className:'cpg',textContent:p.writer}), el('span',{className:'cparrow',textContent:'→'}), el('span',{className:'cpg',textContent:p.reader}) ]),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        p.viaShared? el('span',{className:'tag warn',title:t('cp.viashared.tag.title',{n:p.viaShared}),textContent:'⇢ '+p.viaShared}) : null,
        el('span',{className:'tag',textContent:String(p.count)}) ]) ])) : [cpEmptyNote(a)])
  ]);
}
function cpDetail(a, p){
  const many=cpUnit(a.axis);
  const head=el('div',{className:'panel'},[
    el('div',{className:'srchead'},[ el('button',{textContent:'All pairs',onclick:cpClear}),
      el('span',{className:'id',textContent:p.writer+' → '+p.reader}) ]),
    el('div',{className:'comment',textContent:t('cp.detail.note',{writer:p.writer, n:p.count, unit:cpUnit(a.axis,p.count===1), reader:p.reader})}),
    p.viaShared? el('div',{className:'cpnote'},[
      el('span',{className:'tag warn',textContent:'⇢ '+p.viaShared+' via a shared statement'}),
      t('cp.viashared.note') ]) : null,
    // THIS pair's evidence, not the pack's most-reached statements.
    (p.sharedVia&&p.sharedVia.length)? el('ul',{className:'list'}, p.sharedVia.map(sid=>el('li',{},[
      el('a',{className:'id clickable',textContent:sid,title:'view the SQL',onclick:()=>{ activateTab('explore'); showSource('statement:'+sid); }}),
      el('span',{className:'tag warn',textContent:'shared'}) ]))) : null
  ]);
  const list=el('div',{className:'panel'},[
    el('h2',{},['shared '+many+' ', el('span',{className:'count',textContent: p.items.length<p.count ? '(showing '+p.items.length+' of '+p.count+')' : '('+p.count+')'})]),
    el('ul',{className:'list'}, p.items.length? p.items.map(it=>el('li',{},[
      el('span',{className:'id',textContent:it}),
      el('span',{style:'display:flex;align-items:center;gap:6px;flex:none'},[
        a.axis==='table'? el('button',{className:'mini',textContent:'ERD',title:t('btn.erd.title'),onclick:()=>openErd(it)}) : null,
        el('button',{className:'mini',textContent:'Impact',title:t('btn.impact.title'),
          onclick:()=> a.axis==='column'? openImpact({column:it}) : openImpact({table:it})}) ]) ]))
      : [el('li',{className:'empty',textContent:'none'})])
  ]);
  return [head, list];
}
