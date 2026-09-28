// java_mapping_multi.test.mjs — a mapping annotation that names several methods
// or several paths serves a route for each one.
//
// jeecg-boot's SysUserController declares
//   @RequestMapping(value = "/edit", method = {RequestMethod.PUT, RequestMethod.POST})
// and the Java lane read only the first method, so the frontend's POST to
// /sys/user/edit landed on nothing. Spring serves the handler for every method
// the list names, and for every path a `value`/`path` array names, under every
// path a class-level array names. Each of those is a route the source states,
// so each is EXACT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findJdk } from '../src/cli/env.mjs';
import { runJavaLane } from '../src/cli/lanes_run.mjs';
import { Graph } from '../src/core/graph.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';

const SOURCES = {
  'UserController.java': `package com.example;
import static org.springframework.web.bind.annotation.RequestMethod.GET;
import static org.springframework.web.bind.annotation.RequestMethod.POST;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/sys/user")
public class UserController {
    @RequestMapping(value = "/edit", method = {RequestMethod.PUT, RequestMethod.POST})
    public Object edit() { return null; }

    @GetMapping({"/list-all-simple", "simple-list"})
    public Object simple() { return null; }

    @RequestMapping(value = {"/x", "/y"}, method = {GET, POST})
    public Object both() { return null; }

    @RequestMapping(path = "/one", method = RequestMethod.DELETE)
    public Object one() { return null; }

    @RequestMapping("/any")
    public Object any() { return null; }
}
`,
  'TwoBases.java': `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/a", "/b"})
public class TwoBases {
    @PostMapping("/c")
    public Object c() { return null; }
}
`,
  'UserClient.java': `package com.example;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "users")
public interface UserClient {
    @RequestMapping(value = "/sys/user/edit", method = {RequestMethod.PUT, RequestMethod.POST})
    Object edit();
}
`,
};

let cached;
function facts(t) {
  if (cached !== undefined) return cached;
  const jdk = findJdk();
  if (!jdk) { t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-mapping-multi-'));
  const src = path.join(dir, 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), body);
  try { cached = runJavaLane(jdk, dir, [dir], { quiet: true }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return cached;
}

const handlesTo = (g, member) => g.edges.filter((e) => e.type === 'HANDLES' && e.to === `symbol:${member}`)
  .map((e) => [e.from.replace('endpoint:', ''), e.grade]).sort();

test('mapping_with_several_methods_serves_each_method', (t) => {
  const f = facts(t);
  if (!f) return;
  const g = new Graph();
  addJavaFacts(g, f, {});
  assert.deepEqual(handlesTo(g, 'com.example.UserController#edit'), [['POST /sys/user/edit', 'EXACT'], ['PUT /sys/user/edit', 'EXACT']]);
  assert.deepEqual(handlesTo(g, 'com.example.UserController#one'), [['DELETE /sys/user/one', 'EXACT']], 'one method stays one route');
  assert.deepEqual(handlesTo(g, 'com.example.UserController#any'), [['ANY /sys/user/any', 'EXACT']], 'no method still means every method');
});

test('mapping_with_several_paths_serves_each_path', (t) => {
  const f = facts(t);
  if (!f) return;
  const g = new Graph();
  addJavaFacts(g, f, {});
  assert.deepEqual(handlesTo(g, 'com.example.UserController#simple'), [['GET /sys/user/list-all-simple', 'EXACT'], ['GET /sys/user/simple-list', 'EXACT']]);
  assert.deepEqual(handlesTo(g, 'com.example.UserController#both'),
    [['GET /sys/user/x', 'EXACT'], ['GET /sys/user/y', 'EXACT'], ['POST /sys/user/x', 'EXACT'], ['POST /sys/user/y', 'EXACT']],
    'several methods and several paths: a route for each pair, static imports read the same');
});

test('class_level_mapping_with_several_paths_prefixes_each', (t) => {
  const f = facts(t);
  if (!f) return;
  const g = new Graph();
  addJavaFacts(g, f, {});
  assert.deepEqual(handlesTo(g, 'com.example.TwoBases#c'), [['POST /a/c', 'EXACT'], ['POST /b/c', 'EXACT']]);
});

test('client_mapping_with_several_methods_calls_each_route', (t) => {
  const f = facts(t);
  if (!f) return;
  const g = new Graph();
  addJavaFacts(g, f, {});
  const calls = g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.from === 'symbol:com.example.UserClient#edit').map((e) => [e.to, e.grade]).sort();
  assert.deepEqual(calls, [['endpoint:POST /sys/user/edit', 'SOUND_SET'], ['endpoint:PUT /sys/user/edit', 'SOUND_SET']]);
});
