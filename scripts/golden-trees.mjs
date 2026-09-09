// golden-trees.mjs — the three little projects the safety nets are recorded on.
//
// One backend (a schema, a JPA entity pair, a repository pair, a service and
// four controllers) and three frontends laid beside it, so that every lane and
// every axis is on in at least one of the trees:
//
//   fullstack   the Vue/React frontend in `test/fixtures/web-smoke`, whose calls
//               really land on the routes the backend serves.
//   angular     `test/fixtures/web-angular`, where a screen's name comes from a
//               registry of component and template names rather than a router.
//   templates   a `@Controller` that returns view names plus the Thymeleaf pages
//               in `test/fixtures/web-templates` — the server-rendered page.
//
// It lives beside the recorders rather than inside one test file because TWO
// nets stand on it: `test/golden_answers.test.mjs` records what the SERVER
// answers over these trees, and `scripts/cli-snapshot.mjs` records what the CLI
// PRINTS while building them. One definition, two readers, so the two nets can
// never be recorded over two different sets of projects.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const FIXTURES = path.join(ENGINE_ROOT, 'test', 'fixtures');

// ---------------------------------------------------------------------------
// the backend every tree shares
//
// Four controllers serving exactly the routes `test/fixtures/web-smoke` calls,
// so the web lane has something to match rather than a list of dead ends.
// ---------------------------------------------------------------------------

const DDL = `CREATE TABLE \`thing\` (
  \`id\` bigint NOT NULL,
  \`name\` varchar(64) DEFAULT NULL COMMENT 'what the thing is called',
  \`kind\` varchar(32) DEFAULT NULL COMMENT 'which family it belongs to',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB COMMENT='one row per thing';

CREATE TABLE \`thing_tag\` (
  \`id\` bigint NOT NULL,
  \`thing_id\` bigint NOT NULL COMMENT 'the thing this tag is on',
  \`label\` varchar(32) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB COMMENT='a label on a thing';
`;

const JAVA = Object.freeze({
  'domain/Thing.java': `package com.example.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "thing")
public class Thing {
  @Id
  @Column(name = "id")
  private Long id;

  @Column(name = "name")
  private String name;

  @Column(name = "kind")
  private String kind;

  public Long getId() { return id; }
  public String getName() { return name; }
  public String getKind() { return kind; }
}
`,
  'domain/ThingTag.java': `package com.example.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "thing_tag")
public class ThingTag {
  @Id
  @Column(name = "id")
  private Long id;

  @Column(name = "thing_id")
  private Long thingId;

  @Column(name = "label")
  private String label;

  public Long getId() { return id; }
  public String getLabel() { return label; }
}
`,
  'domain/ThingRepository.java': `package com.example.domain;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ThingRepository extends JpaRepository<Thing, Long> {
  List<Thing> findByKind(String kind);
  Thing findByName(String name);
}
`,
  'domain/ThingTagRepository.java': `package com.example.domain;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ThingTagRepository extends JpaRepository<ThingTag, Long> {
  List<ThingTag> findByThingId(Long thingId);
}
`,
  'service/ThingService.java': `package com.example.service;

import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.example.domain.Thing;
import com.example.domain.ThingRepository;
import com.example.domain.ThingTag;
import com.example.domain.ThingTagRepository;

@Service
public class ThingService {
  private final ThingRepository things;
  private final ThingTagRepository tags;

  public ThingService(ThingRepository things, ThingTagRepository tags) {
    this.things = things;
    this.tags = tags;
  }

  public List<Thing> list(String kind) {
    return things.findByKind(kind);
  }

  public Thing byId(Long id) {
    return things.findById(id).orElse(null);
  }

  public List<ThingTag> tagsOf(Long id) {
    return tags.findByThingId(id);
  }

  @Transactional
  public Thing save(Thing thing) {
    return things.save(thing);
  }
}
`,
  'web/ThingController.java': `package com.example.web;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import com.example.domain.Thing;
import com.example.domain.ThingTag;
import com.example.service.ThingService;

@RestController
@RequestMapping("/things")
public class ThingController {
  private final ThingService service;

  public ThingController(ThingService service) {
    this.service = service;
  }

  @GetMapping("/list")
  public List<Thing> list(@RequestParam(required = false) String kind) {
    return service.list(kind);
  }

  @GetMapping("/{id}")
  public Thing detail(@PathVariable Long id) {
    return service.byId(id);
  }

  @GetMapping("/{id}/tags")
  public List<ThingTag> tags(@PathVariable Long id) {
    return service.tagsOf(id);
  }

  @PostMapping("/save")
  public Thing save(@RequestBody Thing thing) {
    return service.save(thing);
  }
}
`,
  'web/CatalogController.java': `package com.example.web;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.example.domain.Thing;
import com.example.service.ThingService;

@RestController
@RequestMapping("/catalog")
public class CatalogController {
  private final ThingService service;

  public CatalogController(ThingService service) {
    this.service = service;
  }

  @GetMapping("/list")
  public List<Thing> list() {
    return service.list("catalog");
  }

  @PostMapping("/save")
  public Thing save(@RequestBody Thing thing) {
    return service.save(thing);
  }

  @PostMapping("/edit")
  public Thing edit(@RequestBody Thing thing) {
    return service.save(thing);
  }
}
`,
  'web/OrderController.java': `package com.example.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.example.domain.Thing;
import com.example.service.ThingService;

@RestController
@RequestMapping("/orders")
public class OrderController {
  private final ThingService service;

  public OrderController(ThingService service) {
    this.service = service;
  }

  @GetMapping("/{id}")
  public Thing one(@PathVariable Long id) {
    return service.byId(id);
  }
}
`,
});

/** The `@Controller` that RETURNS A VIEW NAME, so the template tree has pages a handler serves. */
const PAGE_CONTROLLER = `package com.example.web;

import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import com.example.service.ThingService;

@Controller
public class ThingPageController {
  private final ThingService service;

  public ThingPageController(ThingService service) {
    this.service = service;
  }

  @GetMapping("/page/things")
  public String list(Model model) {
    model.addAttribute("things", service.list(null));
    return "things/list";
  }

  @GetMapping("/page/things/new")
  public String create() {
    return "redirect:/page/things";
  }
}
`;

/**
 * The routes the AngularJS fixture calls, which the shared backend does not
 * serve. Only that tree gets this file, so its calls land on real routes and the
 * match, the grade and the outbound census are exercised there too.
 */
const SHOP_CONTROLLER = `package com.example.web;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import com.example.domain.Thing;
import com.example.domain.ThingTag;
import com.example.service.ThingService;

@RestController
public class ShopController {
  private final ThingService service;

  public ShopController(ThingService service) {
    this.service = service;
  }

  @GetMapping("/things")
  public List<Thing> things() {
    return service.list(null);
  }

  @GetMapping("/things/{thingId}")
  public Thing thing(@PathVariable Long thingId) {
    return service.byId(thingId);
  }

  @GetMapping("/boxes")
  public List<Thing> boxes() {
    return service.list("box");
  }

  @GetMapping("/twins")
  public List<Thing> twins() {
    return service.list("twin");
  }

  @GetMapping("/api/shop/badges")
  public List<ThingTag> badges() {
    return service.tagsOf(1L);
  }
}
`;

// ---------------------------------------------------------------------------
// building one tree
// ---------------------------------------------------------------------------

/**
 * Lay the shared backend into `dir` and commit it. The commit exists because a
 * pack pins the commit it was built from and an unpinned tree answers
 * "freshness: unknown" for a reason that has nothing to do with the code.
 */
export function backend(dir, { extraJava = {} } = {}) {
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'db', 'schema.sql'), DDL, 'utf8');
  for (const [rel, body] of Object.entries({ ...JAVA, ...extraJava })) {
    const file = path.join(dir, 'src/main/java/com/example', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
}

export function commit(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'the golden fixture');
}

/**
 * Everything about a temp build that is NOT the answer: the directory it was
 * built in, the sha `git init` + `git commit` happened to produce, and the
 * generated pack's own file paths where they are absolute. Replaced with fixed
 * markers so the golden describes the ANSWER and nothing else.
 */
export function scrubberFor(base) {
  const roots = [base, fs.realpathSync(os.tmpdir())];
  return function scrub(value) {
    if (typeof value === 'string') {
      let out = value;
      for (const root of roots) out = out.split(root).join('<tmp>');
      // A 40-hex git object name, wherever it appears: `base.commit`, an
      // overlay's HEAD, a freshness verdict's reason.
      return out.replace(/\b[0-9a-f]{40}\b/g, '<commit>');
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
      return out;
    }
    return value;
  };
}


// ---------------------------------------------------------------------------
// the three trees, and the one comparison
// ---------------------------------------------------------------------------

export const TREES = Object.freeze([
  {
    name: 'fullstack',
    // The Vue/React frontend, as its own package beside the backend: that is
    // where its package.json, its `.env` and its dev-proxy rule live, and the
    // prefix rules are read from there.
    build: (repo) => {
      backend(repo);
      fs.cpSync(path.join(FIXTURES, 'web-smoke'), path.join(repo, 'front'), { recursive: true });
    },
    flags: (repo) => ['--web-src', path.join(repo, 'front', 'src'), '--no-mappers'],
  },
  {
    name: 'angular',
    build: (repo) => {
      backend(repo, { extraJava: { 'web/ShopController.java': SHOP_CONTROLLER } });
      fs.cpSync(path.join(FIXTURES, 'web-angular'), path.join(repo, 'front'), { recursive: true });
    },
    flags: (repo) => ['--web-src', path.join(repo, 'front', 'static'), '--no-mappers'],
  },
  {
    name: 'templates',
    build: (repo) => {
      backend(repo, { extraJava: { 'web/ThingPageController.java': PAGE_CONTROLLER } });
      fs.cpSync(
        path.join(FIXTURES, 'web-templates', 'thymeleaf', 'templates'),
        path.join(repo, 'src/main/resources/templates'),
        { recursive: true },
      );
    },
    // No `--web-src`: the template root is DISCOVERED, which is the path a real
    // server-rendered project takes.
    flags: () => ['--no-mappers'],
  },
]);
