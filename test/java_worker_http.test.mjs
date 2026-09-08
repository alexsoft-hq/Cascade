// java_worker_http.test.mjs — what adapters/java/JavaFacts.java records for an
// IMPERATIVE HTTP call (javafacts/8), read back off real compiled-and-run output.
//
// A declarative client states its route in an annotation. Most service-to-service
// traffic does not: it is a fluent chain (`webClient.get().uri(u).retrieve()`) or
// a RestTemplate request, where the verb is a method name and the url is an
// argument somebody built. This test pins what the worker may say about those,
// and — just as important — what it may NOT:
//
//   * a url with nothing literal in it is `unresolved`, with the expression as
//     written and no path. It is never guessed into a route;
//   * a `+` whose leading operand is a constant this file cannot read keeps the
//     literal tail and NAMES the base, rather than dropping the call;
//   * a receiver that is not one of the three clients is not an HTTP call,
//     however its method is spelled: `pool.execute(task)` and `props.get(k)`
//     leave no record at all.
//
// The worker decides nothing beyond that. Whether `/a/{id}` names a route this
// pack serves is src/adapters/java_bridge.mjs's reading (I-1/I-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { JAVA_WORKER_VERSION } from '../src/core/worker_versions.mjs';
import { splitJavaFactsByFile, assembleJavaFacts } from '../src/core/facts_store.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * One class holding every call shape this rule reads, in `com.example`. The
 * imports are the real Spring ones because the worker resolves a receiver by
 * its DECLARED type and a reader should see where that type comes from; nothing
 * here is compiled against Spring (the worker is parse-only).
 */
const SOURCES = {
  'Caller.java': `package com.example;
import java.util.Map;
import java.util.concurrent.Executor;
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

public class Caller {
    private final WebClient webClient;
    private final WebClient.Builder builder;
    private final RestTemplate restTemplate;
    private final Executor pool;
    private final Map<String, String> props;
    private String hostname = "http://svc.invalid/";

    public Caller(WebClient webClient, WebClient.Builder builder, RestTemplate restTemplate,
                  Executor pool, Map<String, String> props) {
        this.webClient = webClient;
        this.builder = builder;
        this.restTemplate = restTemplate;
        this.pool = pool;
        this.props = props;
    }

    // A literal with a uri-template placeholder, host and all.
    public String one(int id) {
        return webClient.get().uri("http://svc.invalid/a/{id}", id).retrieve().bodyToMono(String.class).block();
    }

    // The chain starts at a BUILDER, so the verb and the url are the only
    // evidence of what it is.
    public String two() {
        return builder.build().post().uri("http://svc.invalid/a").retrieve().bodyToMono(String.class).block();
    }

    // RestTemplate: the method name is the verb.
    public String three() {
        return restTemplate.getForObject("http://svc.invalid/b", String.class);
    }

    // ...except for exchange/execute, where an ARGUMENT names it.
    public String four() {
        return restTemplate.exchange("http://svc.invalid/c", HttpMethod.POST, null, String.class).getBody();
    }

    // A base this file cannot read, a literal tail, an interpolated value and a
    // query string.
    public String five(int id, String q) {
        return webClient.get().uri(hostname + "d/{id}?q={q}", id, q).retrieve().bodyToMono(String.class).block();
    }

    // Nothing literal anywhere: the url is not in this file.
    public String six() {
        String endpoint = buildUrl();
        return restTemplate.getForObject(endpoint, String.class);
    }

    // The verb is an argument this file cannot read: a variable named "method"
    // is not a method, and the record says the verb is unknown rather than
    // naming the variable.
    public String eight(HttpMethod method) {
        return restTemplate.exchange("http://svc.invalid/f", method, null, String.class).getBody();
    }

    // Neither of these is an HTTP call, whatever the method is called.
    public void seven(Runnable task) {
        pool.execute(task);
        props.get("size");
    }

    private String buildUrl() { return "http://svc.invalid/e"; }
}
`,
};

function runWorker(jdk, dir) {
  const buildDir = path.join(dir, 'classes');
  fs.mkdirSync(buildDir, { recursive: true });
  execFileSync(jdk.javac, ['-d', buildDir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const src = path.join(dir, 'src');
  const out = execFileSync(jdk.java, ['-cp', buildDir, 'JavaFacts', '--root', src, src], { maxBuffer: 1 << 26 })
    .toString('utf8');
  return out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function writeSources(dir) {
  const src = path.join(dir, 'src', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), body);
}

test('javafacts/8: an imperative HTTP call is recorded with its verb and the path it could read', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-javahttp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSources(dir);
  const records = runWorker(jdk, dir);

  const header = records[0];
  assert.equal(header.kind, 'header');
  assert.equal(header.version, JAVA_WORKER_VERSION, 'the mirrored version must be the one the worker stamps');

  const calls = records.filter((r) => r.kind === 'httpCall');
  const byMethod = new Map(calls.map((c) => [c.from.slice(c.from.indexOf('#') + 1), c]));
  // Eight methods, seven requests: `seven` sends none, and nothing in it is
  // read as one either.
  assert.equal(calls.length, 7, `expected seven requests, got ${calls.map((c) => c.from).join(', ')}`);
  assert.equal(header.httpCalls, 7, 'the header counts what the stream carries');
  assert.equal(byMethod.has('seven'), false, 'an Executor and a Map are not HTTP clients');

  // 1. a literal url, host and template placeholder read apart.
  assert.deepEqual(pick(byMethod.get('one')), {
    client: 'webclient', receiver: 'webClient', receiverType: 'WebClient',
    httpMethod: 'GET', urlKind: 'template', url: 'http://svc.invalid/a/{id}',
    host: 'svc.invalid', hostLiteral: true, base: null, path: '/a/{id}', query: null,
  });

  // 2. a builder chain: the receiver's type is `WebClient.Builder`, which names
  //    a WebClient — read segment by segment, not by its last segment alone.
  assert.deepEqual(pick(byMethod.get('two')), {
    client: 'webclient', receiver: 'builder', receiverType: 'WebClient.Builder',
    httpMethod: 'POST', urlKind: 'literal', url: 'http://svc.invalid/a',
    host: 'svc.invalid', hostLiteral: true, base: null, path: '/a', query: null,
  });

  // 3. RestTemplate, verb from the method name.
  assert.deepEqual(pick(byMethod.get('three')), {
    client: 'resttemplate', receiver: 'restTemplate', receiverType: 'RestTemplate',
    httpMethod: 'GET', urlKind: 'literal', url: 'http://svc.invalid/b',
    host: 'svc.invalid', hostLiteral: true, base: null, path: '/b', query: null,
  });

  // 4. ...and from argument 1 for exchange().
  assert.deepEqual(pick(byMethod.get('four')), {
    client: 'resttemplate', receiver: 'restTemplate', receiverType: 'RestTemplate',
    httpMethod: 'POST', urlKind: 'literal', url: 'http://svc.invalid/c',
    host: 'svc.invalid', hostLiteral: true, base: null, path: '/c', query: null,
  });

  // 5. a `+` whose base is a field this scan does not resolve: the literal tail
  //    is kept, the base is NAMED, and the query rides beside the path.
  assert.deepEqual(pick(byMethod.get('five')), {
    client: 'webclient', receiver: 'webClient', receiverType: 'WebClient',
    httpMethod: 'GET', urlKind: 'concat', url: 'd/{id}?q={q}',
    host: null, hostLiteral: false, base: 'hostname', path: '/d/{id}', query: 'q={q}',
  });
  assert.equal(byMethod.get('five').written, 'hostname + "d/{id}?q={q}"');

  // 6. a bare variable: UNRESOLVED, with what the worker could see and no path.
  //    `buildUrl()` really does return a literal one line down, and reading it
  //    would be a guess about what runs, not a fact about this call site.
  const six = byMethod.get('six');
  assert.equal(six.urlKind, 'unresolved');
  assert.equal(six.url, null);
  assert.equal(six.path, null);
  assert.equal(six.host, null);
  assert.equal(six.written, 'endpoint');
  assert.equal(six.httpMethod, 'GET', 'the verb is still known: only the url was not');

  // 7. the verb in a variable: the path is known, the method is NOT named after
  //    the variable that holds it.
  const eight = byMethod.get('eight');
  assert.equal(eight.httpMethod, null);
  assert.equal(eight.path, '/f', 'the url was still readable: only the verb was not');

  // Every record carries its file and a line, because the incremental core
  // shards this stream by file and the viewer opens the call site.
  for (const c of calls) {
    assert.equal(c.file, 'com/example/Caller.java');
    assert.ok(Number.isInteger(c.line) && c.line > 0, `${c.from} has no line`);
  }
});

test('javafacts/8: an httpCall record shards and reassembles like every other record', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-javahttp-shard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSources(dir);
  const records = runWorker(jdk, dir);

  // A record kind the store does not know is DROPPED from the shard, and an
  // incremental run would then quietly lose every imperative HTTP call. Only the
  // header may fail to land.
  const { byFile, skipped } = splitJavaFactsByFile(records);
  assert.equal(skipped, 1, 'only the header should fail to land in a shard');
  const sharded = [...byFile.values()].flat().filter((r) => r.kind === 'httpCall');
  assert.equal(sharded.length, 7, 'every httpCall record is shard content');

  // ...and the reassembled stream is the worker's own, line for line: an
  // incremental run assembles from shards and must produce the same bytes.
  const expected = records.filter((r) => r.kind !== 'header').map((r) => JSON.stringify(r));
  assert.deepEqual(assembleJavaFacts(byFile).map((r) => JSON.stringify(r)), expected);
});

/** The fields under test, so one assertion reads as one call shape. */
function pick(c) {
  assert.ok(c, 'expected a record for this method');
  return {
    client: c.client, receiver: c.receiver, receiverType: c.receiverType,
    httpMethod: c.httpMethod, urlKind: c.urlKind, url: c.url,
    host: c.host, hostLiteral: c.hostLiteral, base: c.base, path: c.path, query: c.query,
  };
}
