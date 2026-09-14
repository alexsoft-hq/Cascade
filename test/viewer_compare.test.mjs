// viewer_compare.test.mjs — the Compare tab, run for real against a two-project server.
//
// What a reviewer depends on: the tab is there only when there is another pack
// to compare with, it asks `pack_diff` of the project on screen with the other
// one as the base, it puts the analysis conditions before the lists, and a
// switch of project leaves nothing of the old comparison behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage as boot, ev, settle } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

async function bootPage(t, { hash = '', ids } = {}) {
  const { html, base } = await startViewer(t, ids);
  return boot({ html, hash, origin: base, answer: (url, opts) => fetch(base + url, opts) });
}

const tabButton = (page) => page.body.querySelectorAll('.tab').find((n) => n.getAttribute('data-tab') === 'compare');

test('the Compare tab asks pack_diff with the other project as the base, and reads the conditions first', async (t) => {
  const page = await bootPage(t, { hash: '#p=beta&tab=compare' });
  assert.equal(tabButton(page).classList.contains('hidden'), false, 'a server with two projects has something to compare');
  for (let i = 0; i < 40 && !ev(page.ctx, 'CMP.resp'); i += 1) await settle(page.ctx, 1);
  const asked = page.calls.filter((c) => c.body && c.body.name === 'pack_diff');
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].body, { name: 'pack_diff', arguments: { base: 'alpha', limit: 200 }, project: 'beta' });
  const text = page.byId.get('cmpview').textContent;
  const conditions = text.indexOf('Not every analysis condition is recorded');
  assert.ok(conditions >= 0, text.slice(0, 400));
  assert.ok(conditions < text.indexOf('Added nodes ('), 'the conditions are read before the lists');
  assert.match(text, /Removed nodes \(\d+\)/);
  assert.match(text, /\d+ limits|trust|UNCERTIFIED/, 'the evidence rail stands beside the lists');
});

test('a server with one project has no Compare tab', async (t) => {
  const page = await bootPage(t, { ids: ['alpha'] });
  assert.equal(tabButton(page).classList.contains('hidden'), true);
  assert.equal(page.byId.get('cmpbase').children.length, 0);
});

test('switching project drops the old comparison and offers the new project\'s other packs', async (t) => {
  const page = await bootPage(t, { hash: '#p=beta&tab=compare' });
  for (let i = 0; i < 40 && !ev(page.ctx, 'CMP.resp'); i += 1) await settle(page.ctx, 1);
  ev(page.ctx, "switchProject('alpha')");
  assert.equal(ev(page.ctx, 'CMP.resp'), null);
  assert.deepEqual(page.byId.get('cmpbase').children.map((o) => o.value), ['beta']);
});
