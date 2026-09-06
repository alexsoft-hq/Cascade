import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  normalizeProfile,
  validateProfile,
  loadProfile,
  PROFILE_DEFAULTS,
  ProfileError,
} from '../src/core/profile.mjs';

test('normalizeProfile({}) deep-equals the documented defaults shape', () => {
  const p = normalizeProfile({});
  assert.equal(p.schema.default, null);
  assert.deepEqual(p.packagePrefixes, []);
  assert.equal(p.screenAxis.enabled, null, 'the third state is the DEFAULT: no word from the user, decide it from what the run reads');
  assert.equal(p.catalog.source, 'none');
  assert.equal(p.calibration.firstRun, 'bootstrap');
  assert.deepEqual(p, PROFILE_DEFAULTS);
});

test('normalizeProfile({}) returns a frozen object, nested objects frozen too', () => {
  const p = normalizeProfile({});
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.build));
  assert.ok(Object.isFrozen(p.schema));
  assert.ok(Object.isFrozen(p.screenAxis));
  assert.ok(Object.isFrozen(p.catalog));
  assert.ok(Object.isFrozen(p.calibration));
  assert.ok(Object.isFrozen(p.packagePrefixes));
});

test('I-4: normalizeProfile never invents a schema — schema.default stays null even when propertyNames is given', () => {
  const p = normalizeProfile({ schema: { propertyNames: ['dbMain'] } });
  assert.equal(p.schema.default, null);
});

test('arrays REPLACE, not concat: packagePrefixes fully replaces the empty default', () => {
  const p = normalizeProfile({ packagePrefixes: ['com.a'] });
  assert.deepEqual(p.packagePrefixes, ['com.a']);
  assert.equal(p.packagePrefixes.length, 1);
});

test('deep merge keeps unspecified defaults alongside a specified sibling key', () => {
  const p = normalizeProfile({ build: { tool: 'maven' } });
  assert.equal(p.build.javaRelease, null);
  assert.equal(p.build.tool, 'maven');
});

test('validateProfile throws ProfileError when packagePrefixes is present but a string', () => {
  assert.throws(() => validateProfile({ packagePrefixes: 'com.a' }), ProfileError);
});

test('validateProfile throws ProfileError when schema.default is present and an empty string', () => {
  assert.throws(() => validateProfile({ schema: { default: '' } }), ProfileError);
});

test('screenAxis.enabled has THREE states, and anything else is a typo', () => {
  // true and false are the user's word and are obeyed whatever the run reads;
  // null (and the key absent) is "decide it from what the run reads".
  for (const v of [true, false, null]) {
    assert.doesNotThrow(() => validateProfile({ screenAxis: { enabled: v } }), `enabled: ${JSON.stringify(v)}`);
    assert.equal(normalizeProfile({ screenAxis: { enabled: v } }).screenAxis.enabled, v);
  }
  assert.equal(normalizeProfile({ screenAxis: {} }).screenAxis.enabled, null, 'the key absent is the third state too');
  assert.doesNotThrow(() => validateProfile({ screenAxis: {} }));
});

test('validateProfile throws ProfileError when screenAxis.enabled is present and not true/false/null', () => {
  assert.throws(() => validateProfile({ screenAxis: { enabled: 'yes' } }), ProfileError);
  assert.throws(() => validateProfile({ screenAxis: { enabled: 0 } }), ProfileError);
});

test('validateProfile throws ProfileError when catalog.source is present and not in jdbc|file|none', () => {
  assert.throws(() => validateProfile({ catalog: { source: 'redis' } }), ProfileError);
});

test('validateProfile throws ProfileError when build.tool is present and not in gradle|maven|null', () => {
  assert.throws(() => validateProfile({ build: { tool: 'ant' } }), ProfileError);
});

test('validateProfile does not throw when a key is omitted entirely (present-key checking)', () => {
  assert.doesNotThrow(() => validateProfile({}));
  assert.doesNotThrow(() => validateProfile({ build: {} }));
  assert.doesNotThrow(() => validateProfile({ schema: {} }));
});

test('loadProfile reads, normalizes and validates a real profile.json from disk', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const profilePath = path.join(tmp, 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify({ build: { tool: 'gradle' }, packagePrefixes: ['com.x'] }), 'utf8');

  const loaded = loadProfile(profilePath);
  assert.equal(loaded.build.tool, 'gradle');
  assert.deepEqual(loaded.packagePrefixes, ['com.x']);
  assert.equal(loaded.schema.default, null);
  assert.ok(Object.isFrozen(loaded));
});

test("loadProfile('x.yaml') throws ProfileError mentioning YAML or an adapter", () => {
  assert.throws(() => loadProfile('x.yaml'), (err) => {
    assert.ok(err instanceof ProfileError);
    assert.ok(/yaml/i.test(err.message) || /adapter/i.test(err.message), `expected message to mention yaml/adapter, got: ${err.message}`);
    return true;
  });
});
