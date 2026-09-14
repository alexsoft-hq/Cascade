// 50_summary.js — the Overview's summary picture: groups of routes by where their code sits, and the table families they reach.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// It is a FOLD, closed until a reader opens it: the answer is a walk from every
// route in the pack, which a reader who came for one route should not wait for.
// Opening it asks `summary` once; the picture is two columns of boxes joined by
// one line per group and family, as thick as the tables behind it and dashed by
// the weakest grade on the way. A box opens beside the picture into the routes
// or the tables it holds, each with the button that walks it.
const SUM = { resp:null, seq:0, sel:null, host:null };

/** The fold on the Overview, rebuilt with the rest of the tab. */
function renderSummaryFold(){
  const slot=byId('ovsummary');
  if(!slot) return;
  if(SNAP || !OV.resp){ slot.replaceChildren(); return; }
  slot.replaceChildren(fold('ov.summary', [t('summary.lead')], ()=>{
    SUM.host=el('div',{className:'sumhost'});
    if(SUM.resp) renderSummary(); else loadSummary();
    return [SUM.host];
  }));
}
async function loadSummary(){
  const mine=++SUM.seq;
  SUM.host.replaceChildren(el('div',{className:'empty',textContent:t('summary.loading')}));
  let r;
  try{ r=await api('summary',{}); }
  catch(e){ if(stale(e)||mine!==SUM.seq) return; SUM.host.replaceChildren(errPanel(e)); return; }
  if(mine!==SUM.seq) return;
  SUM.resp=r; SUM.sel=null;
  renderSummary();
}
/** What made the boxes, in the page's words around the engine's values. */
function summaryRuleLine(a){
  const g=a.rule.groups, f=a.rule.tables;
  const groups = g.kind==='declared' ? t('summary.rule.declared',{n:g.packageDepth})
    : g.kind==='code-path' ? t('summary.rule.code',{prefix:g.commonPrefix||'-'})
    : t('summary.rule.path',{prefix:g.commonPath||'/'});
  const tables = f.kind==='name-words' ? t('summary.rule.words',{prefix:f.commonPrefix||'-'}) : t('summary.rule.letters',{prefix:f.commonPrefix||'-'});
  return groups+' '+tables;
}
function summaryBox(boxes, kind, name, sub, extraClass){
  const id=kind+':'+name;
  const b=el('button',{type:'button', className:'sumbox'+(extraClass?' '+extraClass:'')+(SUM.sel===id?' sel':''),
    onclick:()=>{ SUM.sel = SUM.sel===id ? null : id; renderSummary(); }}, [
    el('span',{className:'sumname',textContent:name}), el('span',{className:'count',textContent:sub}) ]);
  boxes.set(id, b);
  return b;
}
function renderSummary(){
  const r=SUM.resp, host=SUM.host; if(!r || !host) return;
  const a=r.answer;
  const boxes=new Map();
  const groups=a.groups.map((g)=> summaryBox(boxes, 'g', g.name, t('summary.group.sub',{routes:g.endpoints.length, tables:g.tables})));
  if(a.otherGroups.groups) groups.push(summaryBox(boxes, 'g', '(others)', t('summary.others.groups',{n:a.otherGroups.groups, routes:a.otherGroups.endpoints.length}), 'sumothers'));
  const fams=a.families.map((f)=> summaryBox(boxes, 'f', f.name, t('summary.family.sub',{tables:f.tables.length})));
  if(a.otherFamilies.families) fams.push(summaryBox(boxes, 'f', '(others)', t('summary.others.families',{n:a.otherFamilies.families, tables:a.otherFamilies.tables.length}), 'sumothers'));
  const svg=svgEl('svg',{class:'sumlinks'});
  const left=el('div',{className:'sumcol'}, groups), right=el('div',{className:'sumcol'}, fams);
  // The middle column is space for the lines; the SVG lies over the whole picture.
  const picture=el('div',{className:'sumpic'},[left, el('div',{className:'sumgap'}), right, svg]);
  host.replaceChildren(el('div',{className:'panelsub',textContent:summaryRuleLine(a)}),
    el('div',{className:'sumgrid'},[picture, el('div',{className:'flowside'},[summaryDetail(a), honesty(r, 'summary')].filter(Boolean))]));
  requestAnimationFrame(()=>drawSummaryLinks(a, picture, svg, boxes));
}
/** One line per link, from its group's box to its family's box, measured from the page. */
function drawSummaryLinks(a, picture, svg, boxes){
  if(!picture.getBoundingClientRect || picture.offsetParent===null) return;
  const pr=picture.getBoundingClientRect();
  const boxOf=(kind, name)=> boxes.get(kind+':'+name);
  svg.setAttribute('width', pr.width); svg.setAttribute('height', pr.height);
  svg.replaceChildren();
  for(const l of a.links){
    const gb=boxOf('g', l.group), fb=boxOf('f', l.family);
    if(!gb || !fb) continue;
    const g=gb.getBoundingClientRect(), f=fb.getBoundingClientRect();
    const x1=g.right-pr.left, y1=g.top-pr.top+g.height/2, x2=f.left-pr.left, y2=f.top-pr.top+f.height/2;
    const dx=(x2-x1)/2;
    const lit = !SUM.sel || SUM.sel==='g:'+l.group || SUM.sel==='f:'+l.family;
    const p=svgEl('path',{ d:'M'+x1+','+y1+' C'+(x1+dx)+','+y1+' '+(x2-dx)+','+y2+' '+x2+','+y2, fill:'none',
      stroke:cssVar('--edge'), 'stroke-width':String(1+Math.min(6, Math.log2(1+l.tables))), opacity: lit ? '0.85' : '0.12' });
    if(gradeDash(l.grade)) p.setAttribute('stroke-dasharray', gradeDash(l.grade));
    const tip=svgEl('title');
    tip.textContent=t('summary.link.title',{tables:l.tables, routes:l.endpoints, grade:l.grade});
    p.append(tip);
    svg.append(p);
  }
}
/** The box a reader opened: its routes with Flow, or its tables with Impact. */
function summaryDetail(a){
  if(!SUM.sel) return el('div',{className:'panel'},[ el('div',{className:'comment',textContent:t('summary.pick')}) ]);
  const kind=SUM.sel.slice(0,1), name=SUM.sel.slice(2);
  if(kind==='g'){
    const g = name==='(others)' ? { endpoints:a.otherGroups.endpoints } : a.groups.find((x)=>x.name===name);
    if(!g) return null;
    return el('div',{className:'panel sumdetail'},[ el('h2',{textContent:name}),
      el('ul',{className:'list'}, g.endpoints.map((id)=>{ const route=id.slice('endpoint:'.length);
        return el('li',{},[ el('span',{className:'mono',textContent:route}),
          el('button',{className:'mini',textContent:'Flow',title:t('btn.flow.title'),onclick:()=>openFlow({endpoint:route})}) ]); })) ]);
  }
  const f = name==='(others)' ? { tables:a.otherFamilies.tables } : a.families.find((x)=>x.name===name);
  if(!f) return null;
  return el('div',{className:'panel sumdetail'},[ el('h2',{textContent:name}),
    el('ul',{className:'list'}, f.tables.map((id)=>{ const table=id.slice('table:'.length);
      return el('li',{},[ el('span',{className:'mono',textContent:table}),
        el('button',{className:'mini',textContent:'Impact',title:t('summary.impact.title'),onclick:()=>openImpact({table})}) ]); })) ]);
}
