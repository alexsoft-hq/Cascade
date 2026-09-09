import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_DEFAULTS, PROFILE_KEY_CONSUMERS, profileDiagnostics, normalizeProfile,
  leafKeyPaths, readKeyPath, sqlDialectOf, trustGapsFor, SQL_DIALECT_ALIASES,
  validateProfile, gatewayRouteOf,
} from '../src/core/profile.mjs';

// Invariant I-5 (SPEC §6.2, MUST): a key the profile DECLARES must actually be
// consumed — a declared key with no reading code is a dead key, and a dead key
// is a lie about what the engine does with your configuration. This file is
// that gate. It walks PROFILE_DEFAULTS itself, so a key added to the defaults
// and forgotten everywhere else fails the build the moment it is added.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEAVES = leafKeyPaths(PROFILE_DEFAULTS);

// A non-default value for every leaf, used to prove the diagnostics fire.
const NON_DEFAULT = {
  'build.tool': 'gradle',
  'build.javaRelease': 21,
  'build.profiles': ['staging'],
  packagePrefixes: ['com.example.shop'],
  'schema.default': 'shopdb',
  'schema.propertyNames': ['dbMain'],
  'schema.rewriteLayer': 'inhouse-rewriter',
  sqlDialects: { main: 'oracle-19c' },
  gatewayRoutes: { '/api': 'backend' },
  'screenAxis.enabled': true,
  'screenAxis.codeRegex': '^[A-Z]{2,4}\\d{4}$',
  'screenAxis.pathRule': 'last-segment',
  'screenAxis.nameSource': 'route-meta',
  'moduleAttribution.packageDepth': 4,
  'moduleAttribution.codeLength': 4,
  frameworkPacks: ['spring-mvc'],
  modelPacks: ['owasp-taint'],
  'catalog.source': 'file',
  'catalog.connectionFrom': '../schema.sql',
  'calibration.firstRun': 'require-baseline',
  'calibration.maxRelativeDrop': 0.1,
  'calibration.maxRelativeDropOnRepin': 0.4,
  'calibration.receiptTtlDays': 7,
  'mybatisPlus.namingStrategy': 'underscore',
  'mybatisPlus.tablePrefix': 'app_',
  'mybatisPlus.logicDeleteValue': '1',
  'mybatisPlus.logicNotDeleteValue': '0',
};

/** A profile that is the defaults except for one leaf key. */
function withKey(keyPath, value) {
  const segs = keyPath.split('.');
  const obj = {};
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i += 1) { cur[segs[i]] = {}; cur = cur[segs[i]]; }
  cur[segs[segs.length - 1]] = value;
  return normalizeProfile(obj);
}

/** Diagnostics whose key IS this leaf, or a parent covering it (e.g. `build`). */
function covering(diags, keyPath) {
  return diags.filter((d) => d.key === keyPath || keyPath.startsWith(d.key + '.'));
}

test('I-5: every leaf key of PROFILE_DEFAULTS has a PROFILE_KEY_CONSUMERS entry', () => {
  const missing = LEAVES.filter((k) => !Object.hasOwn(PROFILE_KEY_CONSUMERS, k));
  assert.deepEqual(missing, [], `profile keys with no declared consumer (dead keys — I-5 forbids them): ${missing.join(', ')}`);
  // And no entry describes a key that does not exist any more.
  const stale = Object.keys(PROFILE_KEY_CONSUMERS).filter((k) => !LEAVES.includes(k));
  assert.deepEqual(stale, [], `PROFILE_KEY_CONSUMERS entries for keys that are not in PROFILE_DEFAULTS: ${stale.join(', ')}`);
  assert.ok(LEAVES.length >= 20, `expected the walk to find every leaf, got ${LEAVES.length}`);
});

test('I-5: every entry declares one of the two honest statuses, with a note', () => {
  for (const [key, entry] of Object.entries(PROFILE_KEY_CONSUMERS)) {
    assert.ok(['consumed', 'recorded-not-acted'].includes(entry.status), `${key}: unknown status ${entry.status}`);
    assert.ok(typeof entry.note === 'string' && entry.note.length > 10, `${key}: needs a note saying what happens to it`);
  }
});

test('I-5: a `consumed` key names a file that exists and mentions the key', () => {
  for (const [key, entry] of Object.entries(PROFILE_KEY_CONSUMERS)) {
    if (entry.status !== 'consumed') continue;
    assert.ok(typeof entry.where === 'string' && entry.where.length > 0, `${key}: a consumed key must name where it is read`);
    const file = path.join(ROOT, entry.where);
    assert.ok(fs.existsSync(file), `${key}: ${entry.where} does not exist`);
    const text = fs.readFileSync(file, 'utf8');
    const token = key.split('.').pop();
    assert.match(text, new RegExp(`\\b${token}\\b`), `${key}: ${entry.where} never mentions ${token}`);
  }
});

test('I-5: a `recorded-not-acted` key is silent at its default and diagnosed off it', () => {
  const atDefaults = profileDiagnostics(normalizeProfile({}));
  for (const [key, entry] of Object.entries(PROFILE_KEY_CONSUMERS)) {
    if (entry.status !== 'recorded-not-acted') continue;
    assert.deepEqual(covering(atDefaults, key), [],
      `${key} is at its default value but profileDiagnostics still complains about it`);
    assert.ok(Object.hasOwn(NON_DEFAULT, key), `this test needs a non-default value for ${key}`);
    const diags = profileDiagnostics(withKey(key, NON_DEFAULT[key]));
    assert.ok(covering(diags, key).length > 0,
      `${key} was set to a non-default value and produced NO diagnostic — that is a silently dead key (I-5)`);
  }
});

test('packagePrefixes: an empty list says so rather than filtering nothing in silence', () => {
  const d = profileDiagnostics(normalizeProfile({}));
  const hit = d.find((x) => x.key === 'packagePrefixes');
  assert.ok(hit, 'the default empty packagePrefixes must be announced');
  assert.match(hit.reason, /every type is treated as project code/);
  // Declared prefixes: nothing to announce.
  assert.equal(profileDiagnostics(normalizeProfile({ packagePrefixes: ['com.example'] }))
    .some((x) => x.key === 'packagePrefixes'), false);
});

test('sqlDialects: main is routed, other keys are declared unrouted, unknown fails closed', () => {
  assert.equal(sqlDialectOf(normalizeProfile({})), 'mysql');
  for (const [name, mapped] of Object.entries(SQL_DIALECT_ALIASES)) {
    assert.equal(sqlDialectOf(normalizeProfile({ sqlDialects: { main: name } })), mapped);
  }
  assert.throws(
    () => sqlDialectOf(normalizeProfile({ sqlDialects: { main: 'db2' } })),
    (e) => e.name === 'ProfileError' && /Accepted values are mysql, mariadb, postgres/.test(e.message),
  );
  // An empty map announces the assumption instead of silently defaulting.
  assert.match(
    profileDiagnostics(normalizeProfile({})).find((d) => d.key === 'sqlDialects').reason,
    /assumed the mysql dialect/,
  );
  // A second dialect is recorded, not routed.
  const extra = profileDiagnostics(normalizeProfile({ sqlDialects: { main: 'mysql', legacy: 'oracle-11g' } }));
  assert.match(extra.find((d) => d.key === 'sqlDialects').reason, /only `main` is routed.*ignored: legacy/);
  // A bad dialect is an error-severity diagnostic as well as a throw.
  const bad = profileDiagnostics(normalizeProfile({ sqlDialects: { main: 'db2' } }));
  assert.equal(bad.find((d) => d.kind === 'BAD_DIALECT').severity, 'error');
});

test('frameworkPacks: an unknown pack is UNSUPPORTED_TECHNOLOGY, never silently skipped', () => {
  const d = profileDiagnostics(normalizeProfile({ frameworkPacks: ['spring-mvc', 'hibernate-xml'] }));
  const hit = d.find((x) => x.kind === 'UNSUPPORTED_TECHNOLOGY');
  assert.ok(hit);
  assert.match(hit.reason, /"hibernate-xml".*no lane.*skipped/);
  assert.equal(profileDiagnostics(normalizeProfile({ frameworkPacks: ['spring-mvc', 'mybatis-xml', 'jpa'] }))
    .some((x) => x.kind === 'UNSUPPORTED_TECHNOLOGY'), false, 'jpa ships a lane as of M10');
});

test('catalog.source=jdbc says the run reads a pinned snapshot and never connects', () => {
  const d = profileDiagnostics(normalizeProfile({ catalog: { source: 'jdbc', connectionFrom: 'app.yml' } }));
  const hit = d.find((x) => x.key === 'catalog.source');
  assert.equal(hit.kind, 'SNAPSHOT_REQUIRED');
  assert.equal(hit.severity, 'info');
  assert.match(hit.reason, /never connects to a database/);
  assert.match(hit.reason, /cascade catalog fetch/);
});

test('screenAxis: the known gap is what the PACK declared, not what the profile asked for', () => {
  // With no pack to read, the profile's own request is all there is to go on.
  assert.deepEqual(trustGapsFor(normalizeProfile({})), []);
  assert.deepEqual(trustGapsFor(normalizeProfile({ screenAxis: { enabled: true } })), ['screen-axis-not-shipped']);
  // With one, the axis decides: a screen axis that really shipped owes no gap,
  // and one that did not still does.
  const on = normalizeProfile({ screenAxis: { enabled: true } });
  assert.deepEqual(trustGapsFor(on, { screen: { status: 'shipped', reason: null } }), []);
  assert.deepEqual(trustGapsFor(on, { screen: { status: 'degraded', reason: 'x' } }), []);
  assert.deepEqual(trustGapsFor(on, { screen: { status: 'not-shipped', reason: 'x' } }), ['screen-axis-not-shipped']);
  // Turning the axis on with no frontend to read it from changes nothing, and
  // the diagnostic says so.
  const d = profileDiagnostics(on);
  assert.equal(d.find((x) => x.key === 'screenAxis.enabled').kind, 'RECORDED_NOT_ACTED');
  // ...and a name source this engine does not read is REFUSED by name.
  const jsdoc = profileDiagnostics(normalizeProfile({
    frameworkPacks: ['web'], screenAxis: { enabled: true, nameSource: 'jsdoc-comment' },
  }));
  const refused = jsdoc.find((x) => x.key === 'screenAxis.nameSource');
  assert.equal(refused.kind, 'NOT_SHIPPED');
  assert.match(refused.reason, /jsdoc-comment/);
});

test('leafKeyPaths / readKeyPath: an empty object is a leaf in its own right', () => {
  assert.ok(LEAVES.includes('sqlDialects'), 'sqlDialects is {} and must still be a key, not a vanished node');
  assert.ok(LEAVES.includes('gatewayRoutes'));
  assert.ok(LEAVES.includes('build.tool'));
  assert.equal(readKeyPath(PROFILE_DEFAULTS, 'schema.default'), null);
  assert.equal(readKeyPath(PROFILE_DEFAULTS, 'schema.nope'), undefined);
  assert.equal(readKeyPath(PROFILE_DEFAULTS, 'schema.default.deeper'), undefined);
});

test('profileDiagnostics is pure: it neither mutates nor depends on call order', () => {
  const p = normalizeProfile({ modelPacks: ['x'], gatewayRoutes: { '/a': 'b' } });
  const before = JSON.stringify(p);
  const a = profileDiagnostics(p);
  const b = profileDiagnostics(p);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(p), before);
  assert.throws(() => profileDiagnostics(null), (e) => e.name === 'ProfileError');
});

test('serviceNames: consumed by federation, validated as a list of names', () => {
  const entry = PROFILE_KEY_CONSUMERS.serviceNames;
  assert.equal(entry.status, 'consumed');
  assert.equal(entry.where, 'src/mcp/federation.mjs');
  assert.deepEqual(normalizeProfile({}).serviceNames, [], 'a project that never says its name declares none');
  assert.deepEqual(normalizeProfile({ serviceNames: ['edge-service'] }).serviceNames, ['edge-service']);
  // Declared or not, there is nothing to warn about: the key changes which
  // project answers a call, and it does that whichever lanes ran.
  assert.equal(profileDiagnostics(normalizeProfile({ serviceNames: ['edge-service'] }))
    .some((d) => d.key === 'serviceNames'), false);
  assert.throws(() => validateProfile({ serviceNames: 'edge-service' }), (e) => e.name === 'ProfileError');
  assert.throws(() => validateProfile({ serviceNames: [''] }), (e) => e.name === 'ProfileError');
});

test('a gatewayRoutes value is a prefix or an object, and a typo fails closed', () => {
  assert.doesNotThrow(() => validateProfile({ gatewayRoutes: { '/api': '/sys' } }));
  assert.doesNotThrow(() => validateProfile({ gatewayRoutes: { '/api': { to: '', service: 'x', from: 'a.yml' } } }));
  assert.doesNotThrow(() => validateProfile({ gatewayRoutes: { '/api': { to: '/sys', service: null } } }));
  // The object form without the one field that says what the prefix becomes.
  assert.throws(() => validateProfile({ gatewayRoutes: { '/api': { service: 'x' } } }), (e) => e.name === 'ProfileError');
  assert.throws(() => validateProfile({ gatewayRoutes: { '/api': { to: '', service: 3 } } }), (e) => e.name === 'ProfileError');
  assert.throws(() => validateProfile({ gatewayRoutes: [] }), (e) => e.name === 'ProfileError');
  // Both shapes read the same way, in the one reader both bridges call.
  assert.deepEqual(gatewayRouteOf('/sys'), { to: '/sys', service: null });
  assert.deepEqual(gatewayRouteOf({ to: '', service: 'x', from: 'a.yml' }), { to: '', service: 'x' });
  assert.deepEqual(gatewayRouteOf(null), { to: '', service: null });
});

test('gatewayRoutes: consumed by the web bridge, and announced when no web lane will read it', () => {
  const entry = PROFILE_KEY_CONSUMERS.gatewayRoutes;
  assert.equal(entry.status, 'consumed');
  assert.equal(entry.where, 'src/adapters/web_bridge.mjs');
  assert.match(entry.note, /front-end prefix/);

  // Declared with the web pack: nothing to announce, the bridge reads it.
  const withLane = profileDiagnostics(normalizeProfile({
    frameworkPacks: ['web'], gatewayRoutes: { '/dev-api': '' },
  }));
  assert.equal(withLane.some((d) => d.key === 'gatewayRoutes'), false, JSON.stringify(withLane));

  // Declared WITHOUT it: the declaration changes nothing, and nothing else
  // would say so.
  const withoutLane = profileDiagnostics(normalizeProfile({ gatewayRoutes: { '/dev-api': '' } }));
  const hit = withoutLane.find((d) => d.key === 'gatewayRoutes');
  assert.ok(hit, JSON.stringify(withoutLane));
  assert.equal(hit.kind, 'RECORDED_NOT_ACTED');
  assert.match(hit.reason, /Pass --web-src, or add "web" to frameworkPacks/);
});
