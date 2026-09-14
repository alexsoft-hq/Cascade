// viewer_compare.test.mjs — the Compare tab, run for real: one project against an earlier build of itself.
//
// The tab once offered every other served project as a base, and on a normal
// registry that set one codebase against another. What is held here: the tab is
// there only when the project on screen has an earlier build kept, its choices
// are those builds and nothing else, it asks `pack_diff` for the one chosen, and
// it reads the conditions before the lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { keepPreviousPack } from '../src/cli/pack_history.mjs';
import { digest12 } from '../src/core/canonical.mjs';
import { bootPage as boot, ev, settle } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

/**
 * Give one fixture project an earlier build: its pack with one more route, kept
 * the way a certified analyze keeps the pack it replaces.
 */
function keepEarlierBuild(host, id) {
  const dir = host.ctxFor(id).packDir;
  const file = path.join(dir, 'pack.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const earlier = JSON.parse(JSON.stringify(current));
  earlier.meta.base = { commit: 'a'.repeat(40), dirty: false };
  earlier.nodes.push({ id: 'endpoint:GET /retired', kind: 'endpoint', path: '/retired', httpMethod: 'GET' });
  // The history checks a kept pack's body against its digest, so the earlier build carries its real one.
  earlier.digest = digest12({ nodes: earlier.nodes, edges: earlier.edges });
  fs.writeFileSync(file, JSON.stringify(earlier));
  keepPreviousPack(dir, current);
  fs.writeFileSync(file, JSON.stringify(current));
  // The served context was loaded before the pack file was touched; it reads it again.
  host.ctxFor(id);
}

async function bootWith(t, { ids = ['alpha', 'beta'], earlier = [], hash = '', hold = () => null } = {}) {
  const { html, base, host } = await startViewer(t, ids);
  for (const id of earlier) keepEarlierBuild(host, id);
  // `hold` may return a promise that a request waits on before it is answered.
  const page = await boot({ html, hash, origin: base, answer: async (url, opts) => { await hold(url, opts); return fetch(base + url, opts); } });
  return page;
}

const tabButton = (page) => page.body.querySelectorAll('.tab').find((n) => n.getAttribute('data-tab') === 'compare');

test('a project with no earlier build has no Compare tab, even on a server with other projects', async (t) => {
  const page = await bootWith(t, { hash: '#p=beta&tab=overview' });
  assert.equal(tabButton(page).classList.contains('hidden'), true);
  assert.equal(page.byId.get('cmpbase').children.length, 0, 'another served project is never offered as a base');
});

test('the Compare tab offers this project\'s earlier builds only, and draws the one chosen, conditions first', async (t) => {
  const page = await bootWith(t, { earlier: ['beta'], hash: '#p=beta&tab=compare' });
  assert.equal(tabButton(page).classList.contains('hidden'), false);
  const options = page.byId.get('cmpbase').children;
  assert.equal(options.length, 1);
  assert.match(options[0].textContent, /^commit aaaaaaaaaaaa, built /);
  for (let i = 0; i < 40 && !ev(page.ctx, 'CMP.resp'); i += 1) await settle(page.ctx, 1);
  const asked = page.calls.filter((c) => c.body && c.body.name === 'pack_diff');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].body.project, 'beta');
  assert.match(asked[0].body.arguments.base_history, /^aaaaaaaaaaaa-[0-9a-f]{12}$/);
  const text = page.byId.get('cmpview').textContent;
  assert.match(text, /Removed nodes \(1\)/);
  assert.match(text, /endpoint:GET \/retired/);
});

test('switching between two projects that both keep builds asks the new project with its OWN build', async (t) => {
  const page = await bootWith(t, { earlier: ['alpha', 'beta'], hash: '#p=beta&tab=compare' });
  for (let i = 0; i < 40 && !ev(page.ctx, 'CMP.resp'); i += 1) await settle(page.ctx, 1);
  ev(page.ctx, "switchProject('alpha')");
  for (let i = 0; i < 40 && !ev(page.ctx, 'CMP.resp'); i += 1) await settle(page.ctx, 1);
  const asked = page.calls.filter((c) => c.body && c.body.name === 'pack_diff');
  assert.deepEqual(asked.map((c) => c.body.project), ['beta', 'alpha'], 'one request per project, none with the old project\'s build');
  assert.equal(ev(page.ctx, 'CMP.resp.basis.project'), 'alpha');
});

test('switching to a project with no earlier build hides the tab and drops the old comparison', async (t) => {
  const page = await bootWith(t, { earlier: ['beta'], hash: '#p=beta&tab=compare' });
  for (let i = 0; i < 40 && !ev(page.ctx, 'CMP.resp'); i += 1) await settle(page.ctx, 1);
  ev(page.ctx, "switchProject('alpha')");
  await settle(page.ctx);
  assert.equal(ev(page.ctx, 'CMP.resp'), null);
  assert.equal(tabButton(page).classList.contains('hidden'), true);
});

test('an answer for the old project that arrives after a switch is not drawn for the new one', async (t) => {
  let release;
  let held = false;
  const gate = new Promise((r) => { release = r; });
  const heldBeta = (_url, opts) => {
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    if (!(body && body.name === 'pack_diff' && body.project === 'beta')) return null;
    held = true;
    return gate;
  };
  const page = await bootWith(t, { earlier: ['alpha', 'beta'], hash: '#p=beta&tab=compare', hold: heldBeta });
  for (let i = 0; i < 40 && !page.calls.some((c) => c.body && c.body.name === 'pack_diff'); i += 1) await settle(page.ctx, 1);
  assert.equal(held, true, 'the beta answer is on its way when the switch happens');
  ev(page.ctx, "switchProject('alpha')");
  for (let i = 0; i < 40 && !ev(page.ctx, 'CMP.resp'); i += 1) await settle(page.ctx, 1);
  assert.equal(ev(page.ctx, 'CMP.resp.basis.project'), 'alpha');
  release();
  await settle(page.ctx, 5);
  assert.equal(ev(page.ctx, 'CMP.resp.basis.project'), 'alpha', 'the late beta answer was dropped');
});
