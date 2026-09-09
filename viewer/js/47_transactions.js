// 47_transactions.js — the Transactions tab: where a write boundary sits.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// ---------- Transactions tab ----------
async function loadTx(){
  const tv=document.getElementById('txview');
  tv.replaceChildren(el('div',{className:'panel',textContent:t('load.tx')}));
  let r; try { r=await api('transactions',{limit:100}); } catch(e){ if(stale(e)) return; tv.replaceChildren(errPanel(e)); return; }
  const txs=r.answer.transactions||[];
  const panel=listPanel('@Transactional boundaries', r.truncated?.fields?.[0]?.total ?? txs.length, txs,
    (t)=> el('li',{}, [
      el('a',{className:'id clickable', textContent:t.method.replace(/^com\.macro\.mall\./,''), title:'columns + source', onclick:()=>showTx(t.method)}),
      el('span',{}, [ el('span',{className:'tag write',textContent:'W '+t.writeCount}), ' ', el('span',{className:'tag read',textContent:'R '+t.readCount}), ' ', el('span',{className:'tag',textContent:t.tableCount+' tables'}) ])
    ]), r.answer.empty, 'transactions');
  tv.replaceChildren(panel, honesty(r, 'tx'));
}
async function showTx(method){
  const tv=document.getElementById('txview');
  tv.replaceChildren(el('div',{className:'panel',textContent:'loading '+method+'…'}));
  try {
    const r=await api('transactions',{method});
    const d=r.answer.transactions[0]; if(!d){ tv.replaceChildren(el('div',{className:'panel',textContent:'not found'})); return; }
    const head=el('div',{className:'panel'},[ el('div',{className:'srchead'},[ el('button',{textContent:'All transactions', onclick:loadTx}), el('span',{className:'id',textContent:d.method}), el('span',{className:'tag',textContent:d.scope||''}), el('button',{className:'mini',textContent:'Source', title:t('src.open.title'), onclick:()=>srcOpen('symbol:'+d.method, {tab:'tx'})}), el('button',{className:'mini',textContent:'Flow', title:t('btn.tx.flow.title'), onclick:()=>openFlow({symbol:d.method})}), el('button',{className:'mini',textContent:'Impact', title:t('btn.tx.impact.title'), onclick:()=>openImpact({symbol:d.method})}) ]),
      el('div',{className:'comment',textContent:d.statementCount+' statements\u00a0\u00a0'+d.tableCount+' tables\u00a0\u00a0atomic'}) ,
      el('div',{style:'margin-top:6px'}, (d.tables||[]).map(t=>el('button',{textContent:t,style:'margin:2px 4px 0 0',onclick:()=>openErd(t)}))) ]);
    const wPanel=listPanel('writes', (d.writes||[]).length, d.writes||[], (c)=>el('li',{},[el('a',{className:'id clickable',textContent:c,onclick:()=>showColumn('column:'+c)}), el('span',{className:'tag write',textContent:'write'})]), {writes:'none'}, 'writes');
    const rPanel=listPanel('reads', (d.reads||[]).length, d.reads||[], (c)=>el('li',{},[el('a',{className:'id clickable',textContent:c,onclick:()=>showColumn('column:'+c)}), el('span',{className:'tag read',textContent:'read'})]), {reads:'none'}, 'reads');
    const kids=[head, el('div',{className:'cols'},[wPanel,rPanel])];
    kids.push(honesty(r, 'tx'));
    tv.replaceChildren(...kids);
  } catch(e){ if(stale(e)) return; tv.replaceChildren(errPanel(e)); }
}
