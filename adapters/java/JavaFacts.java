/*
 * JavaFacts — Java source-facts worker for the Cascade Java lane (SPEC §3.4, §9.1-9.2).
 *
 * Parse-only, dependency-free structural extractor. Uses the JDK compiler's
 * parse-only Tree API (ToolProvider.getSystemJavaCompiler() -> JavacTask ->
 * task.parse()) and walks com.sun.source.tree.* nodes. It NEVER calls
 * task.analyze() and does NOT require the analyzed project's dependencies
 * (Spring/MyBatis) on the classpath: parsing succeeds with those absent, and we
 * resolve names ourselves from the parse tree (package, imports, field types).
 *
 * This makes the worker robust (no "cannot find symbol" cascade) and honest:
 * the call edges it emits are name-resolved candidates, not compiler-verified
 * bindings. Per SPEC §3.1/§8.3 the downstream policy grades these SOUND_SET;
 * endpoint HANDLES and mapper-interface methods are definitional/EXACT. This
 * worker emits evidence only and never computes a grade (invariant I-1/I-6).
 *
 * Output: one compact JSON object per line on stdout, deterministic (records
 * sorted by a stable key; paths relative to --root; no timestamps, no absolute
 * paths, no machine identity). Structured diagnostics + a summary go to stderr.
 *
 * Record kinds: header, parse_error, import, type, entity, repository, field,
 * endpoint, method, transactional, call, httpCall, mpEntity, mpMapper, mpService, mpWrapper. EVERY record but the header carries a
 * `file`, because the incremental core shards the stream by file: a record
 * without one would be silently dropped from the cache (src/core/facts_store.mjs
 * mirrors the sort keys and a test proves the mirror byte-for-byte).
 *
 * `parse_error` is on STDOUT on purpose (javafacts/3). It used to be a stderr
 * line only, which made the parse-error count a property of ONE invocation:
 * an incremental run over three files and a cold run over the whole tree would
 * report different numbers for the same tree, and the calibration gate would
 * read that as nondeterminism. As a per-file record it rides in that file's
 * shard and the two runs agree.
 *
 * CLI: java JavaFacts --root <repoDir> <srcRoot> [<srcRoot> ...]
 */

import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.ArrayTypeTree;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.LineMap;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeParameterTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.Trees;
import com.sun.source.util.TreeScanner;

import javax.lang.model.element.Modifier;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

import java.io.File;
import java.io.IOException;
import java.io.PrintStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class JavaFacts {

    static final String SCHEMA = "cascade:javafacts:1";
    // Worker version — the identity of THIS extractor's output shape. It rides in
    // the header record and is folded into every content-addressed fact-shard key
    // (SPEC §17.7): upgrading the worker invalidates the whole cache instead of
    // mixing two generations of facts in one graph. BUMP IT whenever the records
    // this file emits change in any way. Mirrored (and asserted) in
    // src/core/worker_versions.mjs.
    static final String VERSION = "javafacts/8";
    // Internal sort-key field separator. Never emitted; unlikely to occur in code.
    static final char SEP = '\u0001';

    // ---- one output record: a stable sort key + its rendered JSON line. -------
    static final class Rec implements Comparable<Rec> {
        final String key;
        final String json;
        Rec(String key, String json) { this.key = key; this.json = json; }
        public int compareTo(Rec o) { return this.key.compareTo(o.key); }
    }

    // ---- run-wide accumulator -------------------------------------------------
    static final class Sink {
        final List<Rec> records = new ArrayList<>();
        final List<Map<String, Object>> diagnostics = new ArrayList<>();
        int files, types, endpoints, calls, methods, skippedCalls, parseErrors, transactional;
        // The half of `skippedCalls` that is a receiver THIS FILE declares — a
        // local, a parameter, a catch/lambda variable or a field whose declared
        // type the walker could not use. Split out (javafacts/7) because the other
        // half is not the same failure at all: a receiver the compilation unit
        // never declares is an INHERITED member, and those are now emitted as
        // calls with `via:"identifier"` for the bridge to resolve through the
        // supertype chain. Without the split, "skipped" hid two different things
        // behind one number.
        int skippedLocalReceivers;
        int entities, repositories;
        // MyBatis-Plus evidence (javafacts/6). Counted, never interpreted: which
        // classes carry MP mapping annotations, which interfaces/classes name an
        // entity through BaseMapper/IService/ServiceImpl, and which condition
        // wrappers a method builds. What any of it MEANS is the bridge's call.
        int mpEntities, mpMappers, mpServices, mpWrappers;
        // MyBatis statements written as an ANNOTATION on a mapper method
        // rather than in a mapper XML (javafacts/7).
        int mapperAnnotationSql;
        // IMPERATIVE HTTP calls: a WebClient/RestClient chain or a RestTemplate
        // request, where the verb is a method name and the url is an argument
        // (javafacts/8). Counted, never interpreted: whether the url names a
        // route this pack serves is decided in src/adapters/java_bridge.mjs.
        int httpCalls;

        void add(String key, Map<String, Object> obj) {
            records.add(new Rec(key, toJson(obj)));
        }
        void warn(String code, String file, String message) {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("level", "warn");
            d.put("code", code);
            if (file != null) d.put("file", file);
            d.put("message", message);
            diagnostics.add(d);
        }
    }

    public static void main(String[] args) {
        String root = null;
        List<String> roots = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            if ("--root".equals(args[i]) && i + 1 < args.length) {
                root = args[++i];
            } else {
                roots.add(args[i]);
            }
        }
        if (roots.isEmpty()) {
            System.err.println("usage: java JavaFacts --root <repoDir> <srcRoot> [<srcRoot> ...]");
            System.exit(2);
            return;
        }

        Path rootPath = (root != null) ? Paths.get(root).toAbsolutePath().normalize() : null;

        // Deterministic file order (also aids reproducibility of any per-file state).
        List<File> javaFiles = new ArrayList<>();
        for (String r : roots) collectJava(new File(r), javaFiles);
        javaFiles.sort((a, b) -> a.getAbsolutePath().compareTo(b.getAbsolutePath()));

        Sink sink = new Sink();
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            System.err.println("{\"level\":\"error\",\"code\":\"no_compiler\","
                + "\"message\":\"ToolProvider.getSystemJavaCompiler() returned null; run with a JDK\"}");
            System.exit(2);
            return;
        }

        DiagnosticCollector<JavaFileObject> dc = new DiagnosticCollector<>();
        StandardJavaFileManager fm = compiler.getStandardFileManager(dc, null, StandardCharsets.UTF_8);
        try {
            Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromFiles(javaFiles);
            // Parse-only: -proc:none disables annotation processing; we never analyze().
            JavacTask task = (JavacTask) compiler.getTask(
                    nullWriter(), fm, dc, Arrays.asList("-proc:none"), null, units);
            // Source positions from the parse tree (no analyze needed) → 1-based
            // line numbers, so the viewer can preview the exact method from disk.
            SourcePositions srcPos = Trees.instance(task).getSourcePositions();

            Iterable<? extends CompilationUnitTree> parsed;
            try {
                parsed = task.parse();
            } catch (Throwable t) {
                // A catastrophic parse failure must not abort the whole run.
                sink.warn("parse_error", null, "task.parse() failed: " + shortMsg(t));
                parsed = Collections.emptyList();
            }

            // Which source files had ERROR diagnostics -> a per-file parse_error
            // RECORD (not only a stderr line). Emitting it on stdout is what makes
            // the parse-error count a property of the FACT SET rather than of one
            // invocation: the file's shard carries it, so an incremental run over a
            // subset and a cold run over the whole tree agree, and the calibration
            // gate can measure `javaParseErrors` instead of reporting it unknown.
            //
            // ONE record per file, chosen deterministically (lowest line, then
            // column, then message) — javac's diagnostic ORDER is not part of any
            // contract, and a shard whose bytes depended on it would break I-9.
            Map<String, long[]> errorPos = new HashMap<>();   // uri -> {line, column}
            Map<String, String> errorFiles = new HashMap<>(); // uri -> message
            for (Diagnostic<? extends JavaFileObject> d : dc.getDiagnostics()) {
                if (d.getKind() != Diagnostic.Kind.ERROR || d.getSource() == null) continue;
                String uri = d.getSource().toUri().toString();
                String msg = String.valueOf(d.getMessage(null));
                long line = d.getLineNumber();
                long col = d.getColumnNumber();
                long[] cur = errorPos.get(uri);
                if (cur == null
                        || line < cur[0]
                        || (line == cur[0] && col < cur[1])
                        || (line == cur[0] && col == cur[1] && msg.compareTo(errorFiles.get(uri)) < 0)) {
                    errorPos.put(uri, new long[]{line, col});
                    errorFiles.put(uri, msg);
                }
            }

            for (CompilationUnitTree cu : parsed) {
                String rel;
                URI uri;
                try {
                    uri = cu.getSourceFile().toUri();
                    rel = relativize(rootPath, uri);
                } catch (Exception e) {
                    uri = null;
                    rel = "<unknown>";
                }
                sink.files++;
                if (uri != null && errorFiles.containsKey(uri.toString())) {
                    String msg = errorFiles.get(uri.toString());
                    long[] pos = errorPos.get(uri.toString());
                    int line = (pos != null && pos[0] > 0) ? (int) pos[0] : 0;
                    sink.parseErrors++;
                    Map<String, Object> pe = new LinkedHashMap<>();
                    pe.put("kind", "parse_error");
                    pe.put("line", line);
                    pe.put("message", msg);
                    pe.put("file", rel);
                    sink.add("0parse" + SEP + rel, pe);
                    sink.warn("parse_error", rel, msg);
                }
                try {
                    new FileWalker(sink, rel, srcPos, cu).walk(cu);
                } catch (Throwable t) {
                    // One file's scan must never crash the run.
                    sink.warn("scan_error", rel, shortMsg(t));
                }
            }
        } finally {
            try { fm.close(); } catch (IOException ignored) { }
        }

        emit(sink);
    }

    // =========================================================================
    // Per-file walk
    // =========================================================================
    static final class FileWalker {
        final Sink sink;
        final String rel;
        final SourcePositions srcPos;
        final CompilationUnitTree cu;
        final LineMap lineMap;
        String pkg = "";
        // simple name -> FQN, from non-static, non-star imports in this file.
        final Map<String, String> imports = new LinkedHashMap<>();
        // ordered list of (simple, fqn) to emit as import records per top type.
        final List<String[]> importList = new ArrayList<>();
        // on-demand (wildcard) import packages, e.g. "com.macro.mall.mapper" from
        // `import com.macro.mall.mapper.*;` — emitted as import records with
        // simple="*" so the bridge can resolve a simple name against the package.
        final List<String> wildcardList = new ArrayList<>();
        // Simple names brought in by STATIC imports (`import static x.Y.assertThat;`
        // and `import static x.Y.*;` -> the marker "*"). An unqualified call whose
        // name is statically imported is NOT a call on the enclosing type, so the
        // self-call rule below must not claim it.
        final java.util.Set<String> staticImportNames = new java.util.HashSet<>();
        // EVERY name this compilation unit declares as a variable: fields (static
        // ones too), method and constructor parameters, locals, catch parameters,
        // for-loop and lambda variables, in every type in the file.
        //
        // It answers ONE question, and it is the question that separates two very
        // different receivers spelled the same way (javafacts/7). `x.m()` where
        // `x` is declared somewhere in this file is a local/param/field the walker
        // could not type — a skip, as before. `x.m()` where NOTHING in the file
        // declares `x` cannot be a local: Java resolves that name in the
        // enclosing type's INHERITED members, and the declaration is in a
        // superclass this worker is not allowed to read (parse-only, one file at
        // a time). So the NAME is emitted as evidence with `toTypeSimple:null`
        // and the bridge — which has every type record — decides what it is.
        //
        // Compilation-unit scope, not block scope, on purpose: it can only ever
        // make the worker emit FEWER identifier receivers, never a wrong one, and
        // a shadowing local anywhere in the file keeps the call a skip.
        final java.util.Set<String> declaredNames = new java.util.HashSet<>();

        FileWalker(Sink sink, String rel, SourcePositions srcPos, CompilationUnitTree cu) {
            this.sink = sink; this.rel = rel; this.srcPos = srcPos; this.cu = cu;
            this.lineMap = cu.getLineMap();
        }

        // 1-based start line of a tree node, or 0 when unavailable.
        int lineOf(Tree t) {
            try {
                long pos = srcPos.getStartPosition(cu, t);
                if (pos < 0 || lineMap == null) return 0;
                return (int) lineMap.getLineNumber(pos);
            } catch (Throwable ignored) { return 0; }
        }

        /**
         * The 1-based declaration line of every entry of `declaredMethodsOf(ct)`,
         * in the SAME order (javafacts/7).
         *
         * A method a class only INHERITS is instantiated downstream as a member
         * of the concrete class, and a reader who opens it must land on the line
         * that really declares it — in the ancestor's file. Without this the
         * bridge knows the ancestor but not where in it, and the source preview
         * opens a file at no particular place.
         *
         * The first declaration of a "name/arity" wins, exactly as the key list
         * dedupes it, so the two lists cannot drift apart.
         */
        List<Object> declaredMethodLinesOf(ClassTree ct) {
            Map<String, Integer> firstLine = new LinkedHashMap<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof MethodTree)) continue;
                MethodTree m = (MethodTree) member;
                String n = m.getName().toString();
                if ("<init>".equals(n)) continue;
                String key = n + "/" + m.getParameters().size();
                if (!firstLine.containsKey(key)) firstLine.put(key, lineOf(m));
            }
            List<Object> out = new ArrayList<>();
            for (String key : declaredMethodKeys(ct)) out.add(firstLine.get(key));
            return out;
        }

        void walk(CompilationUnitTree cu) {
            ExpressionTree pkgTree = cu.getPackageName();
            pkg = (pkgTree != null) ? pkgTree.toString() : "";
            for (ImportTree imp : cu.getImports()) {
                String qs = imp.getQualifiedIdentifier().toString();
                if (imp.isStatic()) {
                    int sdot = qs.lastIndexOf('.');
                    staticImportNames.add((sdot >= 0) ? qs.substring(sdot + 1) : qs);
                    continue;
                }
                String q = qs;
                int dot = q.lastIndexOf('.');
                String simple = (dot >= 0) ? q.substring(dot + 1) : q;
                if ("*".equals(simple)) { // on-demand import: record the package
                    String pkgOfStar = (dot >= 0) ? q.substring(0, dot) : "";
                    if (!pkgOfStar.isEmpty()) wildcardList.add(pkgOfStar);
                    continue;
                }
                imports.put(simple, q);
                importList.add(new String[]{simple, q});
            }
            // Collect every declared variable name BEFORE any type is walked: a
            // call in the first method of the file may name a local declared in
            // the last, and a one-pass answer would depend on reading order.
            cu.accept(new TreeScanner<Void, Void>() {
                @Override public Void visitVariable(VariableTree v, Void p) {
                    declaredNames.add(v.getName().toString());
                    return super.visitVariable(v, p);
                }
            }, null);
            for (Tree decl : cu.getTypeDecls()) {
                if (decl instanceof ClassTree) {
                    processType((ClassTree) decl, null);
                }
            }
        }

        void processType(ClassTree ct, String enclosingFqn) {
            String name = ct.getSimpleName().toString();
            if (name.isEmpty()) return; // anonymous class: no stable FQN
            String fqn;
            if (enclosingFqn != null) {
                fqn = enclosingFqn + "." + name;
            } else {
                fqn = pkg.isEmpty() ? name : pkg + "." + name;
            }

            String typeKind = kindOf(ct);
            List<String> annotations = annotationNames(ct.getModifiers().getAnnotations());
            List<String> impls = new ArrayList<>();
            List<Object> implArgs = new ArrayList<>();
            for (Tree t : ct.getImplementsClause()) {
                String s = typeSimpleName(t);
                if (s == null) continue;
                impls.add(s);
                implArgs.add(typeArgSimples(t));
            }
            String ext = (ct.getExtendsClause() != null) ? typeSimpleName(ct.getExtendsClause()) : null;
            List<String> extArgs = (ct.getExtendsClause() != null)
                    ? typeArgSimples(ct.getExtendsClause()) : new ArrayList<String>();

            // The type's own DECLARED type parameters, and the first bound of each
            // (`<T, S extends IService<T>>` -> ["T","S"] + [null,"IService"]). The
            // bridge needs them to answer "this field's declared type is a type
            // PARAMETER — what does a subclass bind it to?" (rule type-param-binding).
            List<String> typeParams = new ArrayList<>();
            List<String> typeParamBounds = new ArrayList<>();
            for (TypeParameterTree tp : ct.getTypeParameters()) {
                typeParams.add(tp.getName().toString());
                String bound = null;
                for (Tree b : tp.getBounds()) { bound = typeSimpleName(b); if (bound != null) break; }
                typeParamBounds.add(bound);
            }

            Map<String, Object> typeRec = new LinkedHashMap<>();
            typeRec.put("kind", "type");
            typeRec.put("fqn", fqn);
            typeRec.put("typeKind", typeKind);
            typeRec.put("abstract", ct.getModifiers().getFlags().contains(Modifier.ABSTRACT));
            typeRec.put("package", pkg);
            typeRec.put("annotations", annotations);
            typeRec.put("implements", impls);
            typeRec.put("implementsArgs", implArgs);
            typeRec.put("extends", ext);
            typeRec.put("extendsArgs", extArgs);
            typeRec.put("typeParams", typeParams);
            typeRec.put("typeParamBounds", typeParamBounds);
            // The HTTP-CLIENT annotation this type carries, verbatim: @FeignClient
            // (Spring Cloud OpenFeign) or a class-level @HttpExchange (Spring 6's
            // declarative client). EVIDENCE ONLY — this worker never decides that a
            // mapping annotation is a client call rather than a route (I-1/I-6);
            // src/adapters/java_bridge.mjs reads this and decides.
            typeRec.put("client", clientAnnotationOf(annotationsOf(ct.getModifiers().getAnnotations())));
            // Every method this type DECLARES, as "name/arity". A `super.m()` has to
            // be resolved to the first ancestor that declares `m`, and a route
            // contract to the implementer that declares the same method; both need
            // to know what a type declares WITHOUT a method record per method (which
            // would put every private helper in the pack as a node).
            typeRec.put("declaredMethods", declaredMethodsOf(ct));
            // …and where each of them is declared, aligned index-for-index.
            typeRec.put("declaredMethodLines", declaredMethodLinesOf(ct));
            typeRec.put("file", rel);
            sink.types++;
            sink.add("2type" + SEP + fqn, typeRec);

            // Imports belong to the file; attribute them to each top-level type
            // so the bridge can resolve simple->FQN by the call's owning type.
            if (enclosingFqn == null) {
                for (String[] si : importList) {
                    Map<String, Object> ir = new LinkedHashMap<>();
                    ir.put("kind", "import");
                    ir.put("owner", fqn);
                    ir.put("simple", si[0]);
                    ir.put("fqn", si[1]);
                    ir.put("file", rel);
                    sink.add("1import" + SEP + fqn + SEP + si[0] + SEP + si[1], ir);
                }
                for (String wp : wildcardList) {
                    Map<String, Object> ir = new LinkedHashMap<>();
                    ir.put("kind", "import");
                    ir.put("owner", fqn);
                    ir.put("simple", "*");
                    ir.put("fqn", wp); // the on-demand package, no ".*"
                    ir.put("file", rel);
                    sink.add("1import" + SEP + fqn + SEP + "*" + SEP + wp, ir);
                }
            }

            boolean isInterface = "interface".equals(typeKind);

            // --- JPA / Spring Data evidence (SPEC §15 M10) ---------------------
            // Still EVIDENCE ONLY: what the annotations say, resolved no further
            // than this file. Which physical table/column an entity maps to, and
            // what a derived query name means, is decided later by the bridge
            // (src/adapters/jpa_bridge.mjs) against the whole fact set + profile.
            List<AnnotationTree> typeAnns = annotationsOf(ct.getModifiers().getAnnotations());
            emitEntity(ct, fqn, typeAnns, annotations, ext);
            if (isInterface) emitRepository(ct, fqn, typeAnns);

            // --- MyBatis-Plus evidence (javafacts/6) ---------------------------
            // Same discipline: what the annotations and the generic bases SAY,
            // resolved no further than this file.
            emitMpEntity(ct, fqn, typeAnns, annotations, ext);
            emitMpMapperOrService(ct, fqn, isInterface, ext, extArgs);

            // --- pass 1: instance fields (class/interface-typed) ---------------
            Map<String, String> fields = new LinkedHashMap<>();
            // The type of every field AS WRITTEN (`WebClient.Builder`, not
            // `Builder`), static ones included. A second map on purpose: the
            // call scan wants the SIMPLE name of an instance field, while the
            // HTTP scan has to tell `WebClient.Builder` from any other nested
            // `Builder`, and an imperative client is as often a
            // `private static final RestTemplate` as an injected field.
            Map<String, String> fieldTypeWritten = new LinkedHashMap<>();
            for (Tree member : ct.getMembers()) {
                if (member instanceof VariableTree) {
                    VariableTree v = (VariableTree) member;
                    String written = typeWrittenName(v.getType());
                    if (written != null && !fieldTypeWritten.containsKey(v.getName().toString())) {
                        fieldTypeWritten.put(v.getName().toString(), written);
                    }
                    if (v.getModifiers().getFlags().contains(Modifier.STATIC)) continue;
                    String typeSimple = typeSimpleName(v.getType());
                    if (typeSimple == null) continue; // primitive/var/unknown: skip
                    String fname = v.getName().toString();
                    fields.put(fname, typeSimple);
                    Map<String, Object> fr = new LinkedHashMap<>();
                    fr.put("kind", "field");
                    fr.put("owner", fqn);
                    fr.put("name", fname);
                    fr.put("typeSimple", typeSimple);
                    fr.put("file", rel);
                    sink.add("3field" + SEP + fqn + SEP + fname, fr);
                }
            }
            // MyBatis-Plus's `ServiceImpl<M, T>` declares `protected M baseMapper`,
            // and 138 call sites in jeecg-boot are spelled `baseMapper.selectList(…)`.
            // Until javafacts/6 every one of them was an unresolved receiver, because
            // the field is declared in the SUPERCLASS. The `extends ServiceImpl<M, T>`
            // clause is IN THIS FILE and it names M, so the field's declared type is
            // read from it — no cross-file lookup, and no invented field: a class that
            // does not extend ServiceImpl gains nothing. No `field` RECORD is emitted:
            // this type does not declare the field, and claiming it does would put a
            // fact in the stream that no line of this file states.
            if (ext != null && !extArgs.isEmpty()) {
                for (String implBase : MP_SERVICE_IMPL_BASES) {
                    if (implBase.equals(ext) && !fields.containsKey("baseMapper")) {
                        fields.put("baseMapper", extArgs.get(0));
                    }
                }
            }

            // A declarative HTTP client puts its own prefix on the annotation that
            // makes it a client (`@FeignClient(path="/sys")`, `@HttpExchange("/sys")`),
            // and Spring joins it in FRONT of any class-level @RequestMapping. Path
            // assembly lives in ONE place — here — so the bridge never has to
            // re-join two halves of a route.
            String basePath = joinPathParts(clientPathOf(annotationsOf(ct.getModifiers().getAnnotations())),
                    classLevelBasePath(annotationsOf(ct.getModifiers().getAnnotations())));
            // @Transactional at class level applies to every method (a transaction
            // boundary); method-level overrides/adds. Recorded so the graph can
            // show a transaction's read/write footprint.
            boolean classTx = annotationNames(ct.getModifiers().getAnnotations()).contains("Transactional");

            // --- pass 2: methods (endpoints, method records, calls) ------------
            for (Tree member : ct.getMembers()) {
                if (member instanceof ClassTree) {
                    processType((ClassTree) member, fqn);
                } else if (member instanceof MethodTree) {
                    MethodTree m = (MethodTree) member;
                    String mname = m.getName().toString();
                    int paramCount = m.getParameters().size();
                    boolean isHandler = false;

                    // Transaction boundary: method-level @Transactional (mall marks
                    // it on the service INTERFACE declaration — no body — and it
                    // applies to the impl at runtime, reachable via dispatch), or a
                    // class-level @Transactional on a concrete method.
                    boolean methodTx = annotationNames(m.getModifiers().getAnnotations()).contains("Transactional");
                    if (methodTx || (classTx && m.getBody() != null)) {
                        String txm = fqn + "#" + mname;
                        Map<String, Object> tr = new LinkedHashMap<>();
                        tr.put("kind", "transactional");
                        tr.put("method", txm);
                        tr.put("scope", methodTx ? "method" : "class");
                        tr.put("line", lineOf(m));
                        tr.put("file", rel);
                        sink.transactional++;
                        sink.add("6tx" + SEP + txm, tr);
                    }

                    Mapping mp = methodMapping(m);
                    if (mp != null) {
                        isHandler = true;
                        String path = joinPath(basePath, mp.path);
                        String handler = fqn + "#" + mname;
                        Map<String, Object> ep = new LinkedHashMap<>();
                        ep.put("kind", "endpoint");
                        ep.put("httpMethod", mp.httpMethod);
                        ep.put("path", path);
                        ep.put("handler", handler);
                        ep.put("handlerType", fqn);
                        ep.put("line", lineOf(m));
                        ep.put("file", rel);
                        sink.endpoints++;
                        sink.add("4endpoint" + SEP + handler + SEP + mp.httpMethod + SEP + path, ep);
                    }

                    // method records: interface methods (mapper bindings) + handlers.
                    if (isInterface || isHandler) {
                        String mfqn = fqn + "#" + mname;
                        Map<String, Object> mr = new LinkedHashMap<>();
                        mr.put("kind", "method");
                        mr.put("fqn", mfqn);
                        mr.put("owner", fqn);
                        mr.put("name", mname);
                        mr.put("paramCount", paramCount);
                        mr.put("line", lineOf(m));
                        mr.put("file", rel);
                        sink.methods++;
                        sink.add("5method" + SEP + mfqn + SEP + paramCount, mr);
                    }

                    // MyBatis's four statement annotations. Evidence only: the
                    // TEXT as the source wrote it, the verb the annotation names,
                    // and where it is. Whether that text is SQL this engine can
                    // read, what it touches, and whether an XML statement for the
                    // same method overrides it, are all decided downstream.
                    emitMapperAnnotationSql(fqn, mname, m);

                    if (m.getBody() != null) {
                        scanCalls(fqn, mname, fields, ext, m);
                        scanWrappers(fqn, mname, fields, m);
                        scanHttpCalls(fqn, mname, fieldTypeWritten, m);
                    }
                }
            }
        }

        // ---- JPA: `entity` records ----------------------------------------
        // A class annotated @Entity, @MappedSuperclass or @Embeddable. Attributes
        // come from the instance FIELDS (JPA's field access, what petclinic uses)
        // plus any GETTER that itself carries a JPA annotation (property access).
        // Every non-static field is listed: in JPA a field without @Column is
        // still persistent, and @Transient is RECORDED rather than dropped so the
        // bridge — not this worker — decides what becomes a column.
        void emitEntity(ClassTree ct, String fqn, List<AnnotationTree> typeAnns, List<String> annNames, String ext) {
            boolean entity = annNames.contains("Entity");
            boolean mapped = annNames.contains("MappedSuperclass");
            boolean embeddable = annNames.contains("Embeddable");
            if (!entity && !mapped && !embeddable) return;

            AnnotationTree table = annNamed(typeAnns, "Table");
            String tableName = (table != null) ? firstString(annAttr(table, "name")) : null;

            List<Object> attrs = new ArrayList<>();
            List<String> seen = new ArrayList<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof VariableTree)) continue;
                VariableTree v = (VariableTree) member;
                if (v.getModifiers().getFlags().contains(Modifier.STATIC)) continue;
                String name = v.getName().toString();
                seen.add(name);
                attrs.add(attributeOf(name, v.getType(), annotationsOf(v.getModifiers().getAnnotations()), lineOf(v)));
            }
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof MethodTree)) continue;
                MethodTree m = (MethodTree) member;
                if (!m.getParameters().isEmpty()) continue;
                String prop = propertyNameOf(m.getName().toString());
                if (prop == null || seen.contains(prop)) continue;
                List<AnnotationTree> ma = annotationsOf(m.getModifiers().getAnnotations());
                if (!hasJpaAnnotation(ma)) continue; // an unannotated getter is not new evidence
                seen.add(prop);
                attrs.add(attributeOf(prop, m.getReturnType(), ma, lineOf(m)));
            }

            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "entity");
            rec.put("fqn", fqn);
            rec.put("tableName", tableName);
            rec.put("entity", entity);
            rec.put("mappedSuperclass", mapped);
            rec.put("embeddable", embeddable);
            rec.put("superclass", ext);
            rec.put("attributes", attrs);
            rec.put("line", lineOf(ct));
            rec.put("file", rel);
            sink.entities++;
            sink.add("2entity" + SEP + fqn, rec);
        }

        /** One entity attribute, as evidence: the annotations, verbatim, resolved to names. */
        Map<String, Object> attributeOf(String name, Tree type, List<AnnotationTree> anns, int line) {
            List<String> names = annotationNames(anns);
            AnnotationTree column = annNamed(anns, "Column");
            AnnotationTree join = annNamed(anns, "JoinColumn");
            AnnotationTree joinTable = annNamed(anns, "JoinTable");
            String relation = null;
            AnnotationTree rel = null;
            for (String[] pair : RELATION_ANNOTATIONS) {
                AnnotationTree a = annNamed(anns, pair[0]);
                if (a != null) { relation = pair[1]; rel = a; break; }
            }
            List<String> args = typeArgSimples(type);

            Map<String, Object> at = new LinkedHashMap<>();
            at.put("name", name);
            at.put("typeSimple", typeSimpleName(type));
            // The TARGET of a collection association (`List<Pet> pets` -> "Pet").
            // Emitted separately so the bridge never has to re-parse a type name.
            at.put("typeArgSimple", args.isEmpty() ? null : args.get(0));
            at.put("line", line);
            at.put("column", (column != null) ? firstString(annAttr(column, "name")) : null);
            at.put("id", names.contains("Id") || names.contains("EmbeddedId"));
            at.put("transient", names.contains("Transient"));
            at.put("relation", relation);
            at.put("mappedBy", (rel != null) ? firstString(annAttr(rel, "mappedBy")) : null);
            at.put("cascade", (rel != null) ? memberNames(annAttr(rel, "cascade")) : new ArrayList<String>());
            at.put("joinColumn", (join != null) ? firstString(annAttr(join, "name")) : null);
            if (joinTable != null) {
                Map<String, Object> jt = new LinkedHashMap<>();
                jt.put("name", firstString(annAttr(joinTable, "name")));
                jt.put("joinColumns", joinColumnNames(annAttr(joinTable, "joinColumns")));
                jt.put("inverseJoinColumns", joinColumnNames(annAttr(joinTable, "inverseJoinColumns")));
                at.put("joinTable", jt);
            } else {
                at.put("joinTable", null);
            }
            at.put("embedded", names.contains("Embedded") || names.contains("EmbeddedId"));
            return at;
        }

        // ---- Spring Data: `repository` records ------------------------------
        // An interface whose extends clause (javac puts an interface's `extends`
        // list in the IMPLEMENTS clause) names a Spring Data base repository.
        // `Repository` alone is far too common a simple name to trust, so that one
        // is accepted only when the file imports it from org.springframework.data.
        void emitRepository(ClassTree ct, String fqn, List<AnnotationTree> typeAnns) {
            String base = null;
            Tree baseTree = null;
            for (Tree t : ct.getImplementsClause()) {
                String s = typeSimpleName(t);
                if (s == null) continue;
                boolean known = false;
                for (String b : REPOSITORY_BASES) if (b.equals(s)) known = true;
                if (!known) continue;
                String imported = imports.get(s);
                if ("Repository".equals(s) && (imported == null || !imported.startsWith("org.springframework.data."))) {
                    continue; // a `Repository` this file did not import from Spring Data
                }
                if (imported != null && !imported.startsWith("org.springframework.data.")) continue;
                base = s;
                baseTree = t;
                break;
            }
            if (base == null) return;

            List<String> args = typeArgSimples(baseTree);
            List<Object> methods = new ArrayList<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof MethodTree)) continue;
                MethodTree m = (MethodTree) member;
                if (m.getBody() != null) continue; // a default method is code, not a query
                List<AnnotationTree> ma = annotationsOf(m.getModifiers().getAnnotations());
                List<String> params = new ArrayList<>();
                for (VariableTree p : m.getParameters()) {
                    String ps = typeSimpleName(p.getType());
                    params.add(ps == null ? p.getType().toString() : ps);
                }
                AnnotationTree q = annNamed(ma, "Query");
                Map<String, Object> query = null;
                if (q != null) {
                    String text = firstString(annAttr(q, "value"));
                    Boolean nat = boolOf(annAttr(q, "nativeQuery"));
                    query = new LinkedHashMap<>();
                    query.put("text", text);
                    query.put("native", nat != null && nat);
                }
                Map<String, Object> mr = new LinkedHashMap<>();
                mr.put("name", m.getName().toString());
                mr.put("line", lineOf(m));
                mr.put("params", params);
                mr.put("query", query);
                mr.put("modifying", annotationNames(ma).contains("Modifying"));
                methods.add(mr);
            }

            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "repository");
            rec.put("fqn", fqn);
            rec.put("base", base);
            rec.put("entityTypeSimple", args.size() > 0 ? args.get(0) : null);
            rec.put("idTypeSimple", args.size() > 1 ? args.get(1) : null);
            rec.put("methods", methods);
            rec.put("line", lineOf(ct));
            rec.put("file", rel);
            sink.repositories++;
            sink.add("2repo" + SEP + fqn, rec);
        }

        // ---- MyBatis-Plus: `mpEntity` records (javafacts/6) -----------------
        // MP maps a plain POJO to a table with no @Entity anywhere: the class is
        // named as the `T` of BaseMapper<T> / IService<T> / ServiceImpl<M,T>, and
        // the physical names come from a GLOBAL naming rule plus whatever
        // @TableName/@TableField spell out. THIS WORKER RECORDS ONLY WHAT THE
        // FILE SAYS. Whether `SysUser` is `sys_user`, and how sure that is, is
        // decided in src/adapters/mp_bridge.mjs against the profile (I-1/I-6).
        //
        // PER-FILE, deliberately: the fact cache shards this stream by file
        // (src/core/facts_store.mjs), so a record emitted for THIS class because
        // of what ANOTHER file declares would be wrong the moment one of the two
        // is re-read on its own. So the trigger here is an MP annotation in this
        // very file; a class named as an entity that carries none is resolved,
        // and reported, by the bridge from the mapper/service records below.
        void emitMpEntity(ClassTree ct, String fqn, List<AnnotationTree> typeAnns, List<String> annNames, String ext) {
            AnnotationTree tableName = annNamed(typeAnns, "TableName");
            boolean anyMemberAnnotation = false;
            for (Tree member : ct.getMembers()) {
                List<AnnotationTree> ma = null;
                if (member instanceof VariableTree) ma = annotationsOf(((VariableTree) member).getModifiers().getAnnotations());
                else if (member instanceof MethodTree) ma = annotationsOf(((MethodTree) member).getModifiers().getAnnotations());
                if (ma == null) continue;
                if (hasMpAnnotation(ma)) { anyMemberAnnotation = true; break; }
            }
            if (tableName == null && !anyMemberAnnotation) return;

            List<Object> fields = new ArrayList<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof VariableTree)) continue;
                VariableTree v = (VariableTree) member;
                java.util.Set<Modifier> flags = v.getModifiers().getFlags();
                // MP's own rule (TableInfoHelper): a static or transient field is
                // never a column. Both are RECORDED rather than dropped, so the
                // bridge can say why a field owns no column instead of the field
                // vanishing between the source and the answer.
                boolean isStatic = flags.contains(Modifier.STATIC);
                boolean isTransient = flags.contains(Modifier.TRANSIENT);
                List<AnnotationTree> anns = annotationsOf(v.getModifiers().getAnnotations());
                List<String> names = annotationNames(anns);
                AnnotationTree tf = annNamed(anns, "TableField");
                AnnotationTree tid = annNamed(anns, "TableId");
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("name", v.getName().toString());
                f.put("typeSimple", typeSimpleName(v.getType()));
                f.put("line", lineOf(v));
                // @TableField("x") and @TableField(value="x") are the same
                // declaration; @TableId(value="x") names the id column.
                String col = (tf != null) ? firstString(annAttr(tf, "value")) : null;
                if (col == null && tid != null) col = firstString(annAttr(tid, "value"));
                f.put("column", col);
                Boolean exist = (tf != null) ? boolOf(annAttr(tf, "exist")) : null;
                f.put("exist", exist == null ? Boolean.TRUE : exist);
                f.put("id", tid != null);
                f.put("idType", (tid != null) ? firstMemberName(annAttr(tid, "type")) : null);
                f.put("logic", names.contains("TableLogic"));
                f.put("version", names.contains("Version"));
                f.put("fill", (tf != null) ? firstMemberName(annAttr(tf, "fill")) : null);
                f.put("static", isStatic);
                f.put("transient", isTransient);
                fields.add(f);
            }

            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "mpEntity");
            rec.put("fqn", fqn);
            rec.put("tableName", (tableName != null) ? firstString(annAttr(tableName, "value")) : null);
            rec.put("schema", (tableName != null) ? firstString(annAttr(tableName, "schema")) : null);
            // Declared, so the bridge never has to re-read the annotation list to
            // learn whether the table name was WRITTEN or has to be derived.
            rec.put("tableNameDeclared", tableName != null);
            rec.put("superclass", ext);
            rec.put("fields", fields);
            rec.put("line", lineOf(ct));
            rec.put("file", rel);
            sink.mpEntities++;
            sink.add("2mpentity" + SEP + fqn, rec);
        }

        // ---- MyBatis-Plus: `mpMapper` / `mpService` records -----------------
        // The three declarations that name an MP entity, verbatim:
        //   interface XMapper extends BaseMapper<T>            -> mpMapper
        //   interface IXService extends IService<T>            -> mpService (base IService)
        //   class XServiceImpl extends ServiceImpl<M, T>       -> mpService (base ServiceImpl, mapper M)
        // The SIMPLE names are recorded; resolving them to a type is the bridge's
        // job, through the same resolver every other simple name goes through.
        void emitMpMapperOrService(ClassTree ct, String fqn, boolean isInterface, String ext, List<String> extArgs) {
            // javac puts an INTERFACE's `extends` list in the implements clause.
            for (Tree t : ct.getImplementsClause()) {
                String simple = typeSimpleName(t);
                if (simple == null) continue;
                List<String> args = typeArgSimples(t);
                if (MP_MAPPER_BASE.equals(simple)) { addMpMapper(fqn, simple, args, ct); }
                else if (MP_SERVICE_IFACE.equals(simple)) { addMpService(fqn, simple, null, args.isEmpty() ? null : args.get(0), ct); }
            }
            if (ext == null) return;
            if (MP_MAPPER_BASE.equals(ext)) { addMpMapper(fqn, ext, extArgs, ct); return; }
            if (MP_SERVICE_IFACE.equals(ext)) { addMpService(fqn, ext, null, extArgs.isEmpty() ? null : extArgs.get(0), ct); return; }
            for (String impl : MP_SERVICE_IMPL_BASES) {
                if (!impl.equals(ext)) continue;
                // ServiceImpl<M, T>: the FIRST argument is the mapper, the SECOND
                // the entity. A subclass that binds only one of them (an abstract
                // base) records what it has and nulls the rest.
                addMpService(fqn, ext,
                        extArgs.size() > 0 ? extArgs.get(0) : null,
                        extArgs.size() > 1 ? extArgs.get(1) : null, ct);
                return;
            }
        }

        void addMpMapper(String fqn, String base, List<String> args, ClassTree ct) {
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "mpMapper");
            rec.put("fqn", fqn);
            rec.put("base", base);
            rec.put("entityTypeSimple", args.isEmpty() ? null : args.get(0));
            rec.put("line", lineOf(ct));
            rec.put("file", rel);
            sink.mpMappers++;
            sink.add("2mpmapper" + SEP + fqn, rec);
        }

        void addMpService(String fqn, String base, String mapperSimple, String entitySimple, ClassTree ct) {
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "mpService");
            rec.put("fqn", fqn);
            rec.put("base", base);
            rec.put("mapperTypeSimple", mapperSimple);
            rec.put("entityTypeSimple", entitySimple);
            rec.put("line", lineOf(ct));
            rec.put("file", rel);
            sink.mpServices++;
            sink.add("2mpservice" + SEP + fqn + SEP + base, rec);
        }

        // ---- MyBatis annotation SQL: `mapperAnnotationSql` (javafacts/7) ---
        //
        // `@Select("select * from t")` on a mapper interface method is a MyBatis
        // statement with no XML anywhere. The text is read in the three
        // spellings MyBatis accepts and nothing more is done with it: this
        // worker does not know what SQL is, and saying "this is a SELECT of
        // t_user" would be a reading, not a fact about the file (I-1/I-6).
        void emitMapperAnnotationSql(String fqn, String mname, MethodTree m) {
            for (String verb : MAPPER_SQL_ANNOTATIONS) {
                AnnotationTree a = annNamed(annotationsOf(m.getModifiers().getAnnotations()), verb);
                if (a == null) continue;
                String text = annotationSqlText(annAttr(a, "value"));
                if (text == null || text.trim().isEmpty()) {
                    sink.warn("mapper_annotation_sql_unreadable", rel,
                            "@" + verb + " on " + fqn + "#" + mname
                            + " carries no readable string (a constant reference, or a provider), so no statement was made for it");
                    continue;
                }
                Map<String, Object> rec = new LinkedHashMap<>();
                rec.put("kind", "mapperAnnotationSql");
                rec.put("ownerFqn", fqn);
                rec.put("method", mname);
                // LOWER CASE, matching the XML element that means the same thing,
                // so one downstream rule reads both spellings of a statement.
                rec.put("verb", verb.toLowerCase(java.util.Locale.ROOT));
                rec.put("text", text);
                rec.put("line", lineOf(m));
                rec.put("file", rel);
                sink.mapperAnnotationSql++;
                sink.add("5mapsql" + SEP + fqn + SEP + mname + SEP + verb.toLowerCase(java.util.Locale.ROOT), rec);
            }
        }

        /**
         * The text of a MyBatis statement annotation, in the three spellings the
         * framework accepts: one string literal, a `+` concatenation of literals,
         * and a `{ "a", "b" }` array. The array is joined with a SPACE, which is
         * what MyBatis itself does — joining without one would weld `where` onto
         * the line before it.
         *
         * Anything that is not a literal (a reference to a constant, an
         * expression) yields null: the value is not in this file, and inventing
         * a placeholder would put SQL in the stream that nobody wrote.
         */
        String annotationSqlText(ExpressionTree e) {
            if (e == null) return null;
            if (e instanceof LiteralTree) {
                Object v = ((LiteralTree) e).getValue();
                return (v instanceof String) ? (String) v : null;
            }
            if (e instanceof BinaryTree) {
                BinaryTree b = (BinaryTree) e;
                if (b.getKind() != Tree.Kind.PLUS) return null;
                String l = annotationSqlText(b.getLeftOperand());
                String r = annotationSqlText(b.getRightOperand());
                return (l == null || r == null) ? null : l + r;
            }
            if (e instanceof NewArrayTree) {
                List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
                if (inits == null) return null;
                StringBuilder sb = new StringBuilder();
                for (ExpressionTree it : inits) {
                    String part = annotationSqlText(it);
                    if (part == null) return null;
                    if (sb.length() > 0) sb.append(' ');
                    sb.append(part);
                }
                return sb.length() == 0 ? null : sb.toString();
            }
            return null;
        }

        // Method-invocation walk: emit a call only when the receiver is a simple
        // name that resolves to an instance field of the enclosing type.
        void scanCalls(final String fqn, final String mname, final Map<String, String> fields,
                       final String superSimple, MethodTree m) {
            final String from = fqn + "#" + mname;
            final String ownSimple = fqn.substring(fqn.lastIndexOf('.') + 1);
            m.getBody().accept(new TreeScanner<Void, Void>() {
                @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                    Tree sel = inv.getMethodSelect();
                    if (sel instanceof MemberSelectTree) {
                        MemberSelectTree ms = (MemberSelectTree) sel;
                        ExpressionTree recvExpr = ms.getExpression();
                        String methodName = ms.getIdentifier().toString();
                        // `this.m()` and `super.m()` are calls the lane dropped
                        // entirely until javafacts/5 — with them went every chain
                        // that ran through a base controller's `super.exportXls(...)`
                        // or a helper reached as `this.helper()`. `this.m()` is the
                        // SAME call as the unqualified `m()`; `super.m()` names the
                        // SUPERCLASS, and which ancestor actually declares `m` is
                        // resolved later, in the bridge, from the type records.
                        String keyword = receiverKeyword(recvExpr);
                        if (keyword != null) {
                            if ("this".equals(keyword)) {
                                emitCall(from, "this", methodName, ownSimple, "this-method");
                            } else {
                                emitCall(from, "super", methodName, superSimple, "super-method");
                            }
                            return super.visitMethodInvocation(inv, p);
                        }
                        // `field.m()` and `this.field.m()` are the SAME call: the
                        // second spelling was silently dropped until javafacts/3,
                        // which lost every `this.repo.save(x)` in a Spring project.
                        String recv = receiverFieldName(recvExpr);
                        if (recv != null) {
                            String toType = fields.get(recv);
                            if (toType != null) {
                                // The SPELLING is recorded (`x.m()` vs `this.x.m()`)
                                // even though both resolve through the same field.
                                // Downstream turns it into the rule that made the
                                // edge, so a reader can see what the resolution
                                // rested on instead of taking one grade on faith.
                                emitCall(from, recv, methodName, toType,
                                        (recvExpr instanceof IdentifierTree) ? "field" : "this-field");
                            } else if (declaredNames.contains(recv)) {
                                // a receiver THIS FILE declares (a local, a
                                // parameter, or a field whose type is a primitive
                                // or otherwise unusable): honest skip, as before,
                                // and now counted under its own name.
                                sink.skippedCalls++;
                                sink.skippedLocalReceivers++;
                            } else {
                                // A receiver NOTHING in this file declares. In Java
                                // that name resolves to a member INHERITED from a
                                // supertype — whose declaration is in another file,
                                // which a parse-only per-file worker may not read.
                                // The name is the evidence; `toTypeSimple` stays
                                // null because this worker knows no type for it,
                                // and the bridge resolves it against the type
                                // records it holds for the whole tree (I-1/I-6).
                                emitCall(from, recv, methodName, null, "identifier");
                            }
                        }
                        // chained/qualified receivers (a.b().c(), Type.x()) are not
                        // simple-name receivers: skipped silently, not counted.
                    } else if (sel instanceof IdentifierTree) {
                        // An UNQUALIFIED call `m(...)`: in Java that is a method of
                        // the enclosing type or one it inherits — never a free
                        // function. Recorded as a call ON THE ENCLOSING TYPE, which
                        // is what keeps a chain alive through a controller's private
                        // helper. A statically imported name is NOT such a call, so
                        // it is skipped rather than mis-attributed.
                        String methodName = ((IdentifierTree) sel).getName().toString();
                        if (staticImportNames.contains(methodName) || staticImportNames.contains("*")) {
                            sink.skippedCalls++;
                        } else if (!"this".equals(methodName) && !"super".equals(methodName)) {
                            emitCall(from, "this", methodName, ownSimple, "unqualified");
                        }
                    }
                    return super.visitMethodInvocation(inv, p);
                }

                void emitCall(String fromMember, String recv, String methodName, String toType, String via) {
                    Map<String, Object> cr = new LinkedHashMap<>();
                    cr.put("kind", "call");
                    cr.put("from", fromMember);
                    cr.put("receiver", recv);
                    cr.put("method", methodName);
                    cr.put("toTypeSimple", toType);
                    cr.put("via", via);
                    cr.put("file", rel);
                    sink.calls++;
                    sink.add("6call" + SEP + fromMember + SEP + recv + SEP + methodName + SEP
                            + toType + SEP + via + SEP + Integer.toString(sink.calls), cr);
                }
            }, null);
        }


        // ---- imperative HTTP calls: `httpCall` records (javafacts/8) --------
        //
        // A DECLARATIVE client says where it is going in an annotation, and the
        // `client` field on the type record above carries it. Most
        // service-to-service traffic is not written that way. It is a fluent
        // chain (`webClient.get().uri("http://svc.invalid/a/{id}", x).retrieve()`) or a
        // RestTemplate call (`restTemplate.getForObject(url, X.class)`), where
        // the VERB is a method name and the URL is an argument. Until
        // javafacts/8 the lane saw none of it, so a five-service application
        // whose gateway calls the other four with a WebClient produced no
        // cross-service edge at all.
        //
        // WHAT TRIGGERS THE SCAN, and why it is that and not a name:
        //   - RestTemplate: the receiver's DECLARED TYPE. `execute` and `put`
        //     and `delete` are ordinary method names, so a thread pool's
        //     `pool.execute(task)` must never be read as an HTTP request; only
        //     a receiver this file declares as a RestTemplate/RestOperations
        //     gets there.
        //   - WebClient/RestClient: the SHAPE. A builder chain often starts at
        //     an expression whose type no single file states
        //     (`webClientBuilder.build().get()`), so the chain itself is the
        //     evidence: a verb call, a `.uri(...)`, and the call that sends it.
        //     Both must be present, which is what keeps it off ordinary code.
        //
        // IT DECIDES NOTHING. The url is recorded as far as one file can read
        // it and no further: a literal, a literal with `{…}` placeholders, or a
        // concatenation whose literal halves are kept and whose base is named
        // as unreadable. A url this scan cannot reduce to a path is recorded
        // `unresolved` WITH THE EXPRESSION AS WRITTEN, never guessed into a
        // route. Whether the path names a route this pack serves is decided in
        // src/adapters/java_bridge.mjs (I-1/I-6).
        void scanHttpCalls(final String fqn, final String mname,
                           final Map<String, String> fieldTypeWritten, MethodTree m) {
            final String from = fqn + "#" + mname;
            // Every name this METHOD binds, by its written type: a client is as
            // often a local or a parameter as an injected field. Collected in
            // its own pass so a call before the declaration reads the same as
            // one after it.
            final Map<String, String> localTypes = new LinkedHashMap<>();
            for (VariableTree p : m.getParameters()) {
                String w = typeWrittenName(p.getType());
                if (w != null) localTypes.put(p.getName().toString(), w);
            }
            m.getBody().accept(new TreeScanner<Void, Void>() {
                @Override public Void visitVariable(VariableTree v, Void p) {
                    String w = typeWrittenName(v.getType());
                    if (w != null) localTypes.put(v.getName().toString(), w);
                    return super.visitVariable(v, p);
                }
            }, null);

            m.getBody().accept(new TreeScanner<Void, Void>() {
                @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                    Tree sel = inv.getMethodSelect();
                    if (sel instanceof MemberSelectTree) {
                        MemberSelectTree ms = (MemberSelectTree) sel;
                        String name = ms.getIdentifier().toString();
                        ExpressionTree recv = unwrap(ms.getExpression());
                        String recvName = receiverFieldName(recv);
                        String recvType = typeOfName(recvName);
                        if ("resttemplate".equals(httpClientKindOf(recvType))) {
                            restTemplateCall(inv, name, recvName, recvType);
                        } else if (FLUENT_TERMINALS.contains(name)) {
                            fluentChain(inv);
                        }
                    }
                    return super.visitMethodInvocation(inv, p);
                }

                /** The written type of a name this method or this class binds, or null. */
                String typeOfName(String name) {
                    if (name == null) return null;
                    String local = localTypes.get(name);
                    return (local != null) ? local : fieldTypeWritten.get(name);
                }

                /** One RestTemplate request: the method name says the verb, argument 0 the url. */
                void restTemplateCall(MethodInvocationTree inv, String name, String recvName, String recvType) {
                    String verb = REST_TEMPLATE_VERBS.get(name);
                    if (verb == null || inv.getArguments().isEmpty()) return;
                    String httpMethod = verb;
                    if (verb.isEmpty()) {
                        // `exchange(url, HttpMethod.POST, …)` / `execute(url, HttpMethod.GET, …)`:
                        // the verb is an ARGUMENT, and one this file may not be able to read.
                        httpMethod = (inv.getArguments().size() > 1)
                                ? httpMethodArgOf(inv.getArguments().get(1)) : null;
                    }
                    emitHttpCall("resttemplate", recvName, recvType, httpMethod,
                            inv.getArguments().get(0), lineOf(inv));
                }

                /**
                 * The fluent chain that ends at the call which SENDS it, read
                 * from the outside in: the first `.uri(...)` carries the url and
                 * the first verb call names the method. Both are required.
                 */
                void fluentChain(MethodInvocationTree terminal) {
                    ExpressionTree cur = unwrap(((MemberSelectTree) terminal.getMethodSelect()).getExpression());
                    String httpMethod = null;
                    MethodInvocationTree uriCall = null;
                    ExpressionTree root = null;
                    for (int i = 0; i < FLUENT_CHAIN_LIMIT && cur != null; i++) {
                        if (!(cur instanceof MethodInvocationTree)) { root = cur; break; }
                        MethodInvocationTree step = (MethodInvocationTree) cur;
                        Tree ssel = step.getMethodSelect();
                        if (!(ssel instanceof MemberSelectTree)) break;
                        MemberSelectTree sms = (MemberSelectTree) ssel;
                        String sname = sms.getIdentifier().toString();
                        if (uriCall == null && FLUENT_URI_METHODS.contains(sname) && !step.getArguments().isEmpty()) {
                            uriCall = step;
                        }
                        if (httpMethod == null) {
                            String v = fluentVerbOf(sname, step);
                            if (v != null) httpMethod = v;
                        }
                        cur = unwrap(sms.getExpression());
                    }
                    if (uriCall == null || httpMethod == null) return;
                    String recvName = receiverFieldName(root);
                    String recvType = typeOfName(recvName);
                    String kind = httpClientKindOf(recvType);
                    emitHttpCall(kind, recvName, recvType, httpMethod,
                            uriCall.getArguments().get(0), lineOf(terminal));
                }

                void emitHttpCall(String clientKind, String recvName, String recvType,
                                  String httpMethod, ExpressionTree urlExpr, int line) {
                    UrlRead u = readUrl(urlExpr);
                    String host = null;
                    String query = null;
                    String pathStr = null;
                    if (u.value != null) {
                        String[] hp = splitHost(u.value);
                        host = hp[0];
                        String rest = hp[1];
                        int hash = rest.indexOf('#');
                        if (hash >= 0) rest = rest.substring(0, hash);
                        int q = rest.indexOf('?');
                        if (q >= 0) { query = rest.substring(q + 1); rest = rest.substring(0, q); }
                        pathStr = joinPath(null, rest);
                    }
                    Map<String, Object> rec = new LinkedHashMap<>();
                    rec.put("kind", "httpCall");
                    rec.put("from", from);
                    // Which of the three clients it is, when the receiver's type
                    // says so; null for a builder chain whose type no line of
                    // this file states. The SHAPE is the evidence either way.
                    rec.put("client", clientKind);
                    rec.put("receiver", recvName);
                    rec.put("receiverType", recvType);
                    rec.put("httpMethod", httpMethod);
                    rec.put("urlKind", u.kind);
                    rec.put("url", u.value);
                    // The expression AS WRITTEN, which is the whole of what an
                    // unresolved url has to show for itself.
                    rec.put("written", u.written);
                    rec.put("host", host);
                    rec.put("hostLiteral", host != null && !host.contains(URL_HOLE));
                    rec.put("base", u.base);
                    rec.put("path", pathStr);
                    rec.put("query", query);
                    rec.put("line", line);
                    rec.put("file", rel);
                    sink.httpCalls++;
                    sink.add("8httpcall" + SEP + from + SEP + pad(line) + SEP
                            + (httpMethod == null ? "" : httpMethod) + SEP
                            + (pathStr == null ? "" : pathStr) + SEP + Integer.toString(sink.httpCalls), rec);
                }
            }, null);
        }

        // ---- MyBatis-Plus: `mpWrapper` records (javafacts/6) ----------------
        //
        // A condition WRAPPER is where MyBatis-Plus hides the WHERE clause. There
        // is no SQL text anywhere: `new LambdaQueryWrapper<SysUserDepart>()
        // .eq(SysUserDepart::getDepId, x)` is a method reference and a value, and
        // the column it filters on only exists at run time. This scan records the
        // three things a reader would need to work it out by hand — what kind of
        // wrapper was built, for which entity type, and which operations were
        // called on it with which method references and literals — plus WHERE the
        // wrapper ended up (which mapper/service call it was handed to).
        //
        // IT DECIDES NOTHING. `eq` is recorded as the op named `eq`; that `eq`
        // means an equality predicate on a column, that `SysUserDepart::getDepId`
        // is the property `depId`, and that `depId` is the column `dep_id`, are
        // three separate readings the bridge makes against the profile and the
        // entity model (I-1/I-6). A wrapper the scan cannot see through — one
        // built by a helper such as `QueryGenerator.initQueryWrapper(request…)` —
        // is recorded with `opsComplete:false` and the name of whatever built it,
        // so the bridge can say "columns decided at run time" instead of guessing
        // or going silent.
        void scanWrappers(final String fqn, final String mname, final Map<String, String> fields, MethodTree m) {
            final String from = fqn + "#" + mname;
            final String ownSimple = fqn.substring(fqn.lastIndexOf('.') + 1);
            final Map<String, W> vars = new LinkedHashMap<>();
            final List<W> all = new ArrayList<>();
            // Tree identity -> the wrapper an expression EVALUATES TO, so a chain
            // is read once whether it is met from the outside in (as an argument)
            // or from the inside out (as a receiver).
            final java.util.IdentityHashMap<Tree, W> value = new java.util.IdentityHashMap<>();
            final java.util.IdentityHashMap<Tree, Boolean> chainDone = new java.util.IdentityHashMap<>();

            // A wrapper this method RECEIVES was built by its caller: its ops are
            // not in this file, and saying so is the whole point.
            for (VariableTree p : m.getParameters()) {
                String simple = typeSimpleName(p.getType());
                String kind = wrapperKindOf(simple);
                if (kind == null) continue;
                List<String> args = typeArgSimples(p.getType());
                W w = new W(p.getName().toString(), kind, args.isEmpty() ? null : args.get(0),
                        "parameter", null, false, lineOf(p));
                vars.put(w.var, w);
                all.add(w);
            }

            m.getBody().accept(new TreeScanner<Void, Void>() {
                @Override public Void visitVariable(VariableTree v, Void p) {
                    String declSimple = typeSimpleName(v.getType());
                    String declKind = wrapperKindOf(declSimple);
                    List<String> declArgs = typeArgSimples(v.getType());
                    ExpressionTree init = unwrap(v.getInitializer());
                    W w = null;
                    if (init instanceof NewClassTree) {
                        w = fromNew((NewClassTree) init, declKind, declArgs);
                    } else if (declKind != null && init instanceof MethodInvocationTree) {
                        // The declared type says it is a wrapper; the initializer is
                        // a call whose body is not this method. Read the chain — it
                        // may be a factory we know — and if nothing came back, the
                        // wrapper arrived already built.
                        W made = resolveChain((MethodInvocationTree) init);
                        if (made != null) {
                            w = made;
                            if (w.entitySimple == null && !declArgs.isEmpty()) w.entitySimple = declArgs.get(0);
                        } else {
                            w = new W(null, declKind, declArgs.isEmpty() ? null : declArgs.get(0),
                                    "opaque-initializer", calleeName((MethodInvocationTree) init), false, lineOf(v));
                            all.add(w);
                        }
                    } else if (declKind != null) {
                        w = new W(null, declKind, declArgs.isEmpty() ? null : declArgs.get(0),
                                init == null ? "declared-uninitialised" : "declared-type", null, init == null, lineOf(v));
                        all.add(w);
                    }
                    if (w != null) {
                        w.var = v.getName().toString();
                        vars.put(w.var, w);
                        if (init != null) value.put(init, w);
                    }
                    return super.visitVariable(v, p);
                }

                @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                    resolveChain(inv);
                    // Every ARGUMENT that is a wrapper: this call is where it went.
                    Tree sel = inv.getMethodSelect();
                    String method = null;
                    ExpressionTree recv = null;
                    if (sel instanceof MemberSelectTree) {
                        method = ((MemberSelectTree) sel).getIdentifier().toString();
                        recv = ((MemberSelectTree) sel).getExpression();
                    } else if (sel instanceof IdentifierTree) {
                        method = ((IdentifierTree) sel).getName().toString();
                    }
                    if (method != null) {
                        for (ExpressionTree arg : inv.getArguments()) {
                            W aw = wrapperOfExpr(arg);
                            if (aw == null) continue;
                            addSink(aw, recv, method, lineOf(inv));
                        }
                    }
                    return super.visitMethodInvocation(inv, p);
                }

                @Override public Void visitReturn(com.sun.source.tree.ReturnTree r, Void p) {
                    W w = wrapperOfExpr(r.getExpression());
                    if (w != null) w.sinks.add(sinkRec("returned", null, null, mname, lineOf(r)));
                    return super.visitReturn(r, p);
                }

                // ---- the chain reader -------------------------------------
                W resolveChain(MethodInvocationTree inv) {
                    if (chainDone.containsKey(inv)) return value.get(inv);
                    chainDone.put(inv, Boolean.TRUE);
                    Tree sel = inv.getMethodSelect();
                    if (!(sel instanceof MemberSelectTree)) return null;
                    MemberSelectTree ms = (MemberSelectTree) sel;
                    String method = ms.getIdentifier().toString();
                    ExpressionTree recv = unwrap(ms.getExpression());
                    W w = wrapperOfExpr(recv);
                    if (w != null) {
                        if (MP_CHAIN_TERMINALS.contains(method)) {
                            w.sinks.add(sinkRec("chain-terminal", null, w.factoryReceiverType, method, lineOf(inv)));
                            return null; // the chain's value is a result, not the wrapper
                        }
                        addOp(w, method, inv, lineOf(inv));
                        value.put(inv, w);
                        return w;
                    }
                    // A FACTORY: `Wrappers.lambdaQuery()`, or the fluent starter a
                    // service/mapper offers (`this.lambdaQuery()`), which is the
                    // only nullary form safe to read as one — `x.query(a, b)` is
                    // far too common a method name to claim.
                    String kind = factoryKindOf(method);
                    if (kind == null) return null;
                    boolean wrappersHolder = (recv instanceof IdentifierTree)
                            && "Wrappers".equals(((IdentifierTree) recv).getName().toString());
                    boolean fluentStarter = inv.getArguments().isEmpty()
                            && ("lambdaQuery".equals(method) || "lambdaUpdate".equals(method));
                    if (!wrappersHolder && !fluentStarter) return null;
                    String entity = null;
                    for (Tree ta : inv.getTypeArguments()) { entity = typeSimpleName(ta); if (entity != null) break; }
                    W made = new W(null, kind, entity, wrappersHolder ? "factory" : "fluent-starter", null, true, lineOf(inv));
                    if (!wrappersHolder) {
                        String rf = receiverFieldName(recv);
                        made.factoryReceiver = (rf != null) ? rf : receiverKeywordOrSelf(recv);
                        made.factoryReceiverType = (rf != null) ? fields.get(rf) : ownSimple;
                    }
                    all.add(made);
                    value.put(inv, made);
                    return made;
                }

                W fromNew(NewClassTree nc, String declKind, List<String> declArgs) {
                    String simple = typeSimpleName(nc.getIdentifier());
                    String kind = wrapperKindOf(simple);
                    if (kind == null) return null;
                    List<String> args = typeArgSimples(nc.getIdentifier());
                    String entity = !args.isEmpty() ? args.get(0)
                            : (declArgs != null && !declArgs.isEmpty() ? declArgs.get(0) : null);
                    W w = new W(null, kind, entity, "new", null, true, lineOf(nc));
                    all.add(w);
                    value.put(nc, w);
                    return w;
                }

                /** The wrapper an expression evaluates to, or null. */
                W wrapperOfExpr(ExpressionTree e) {
                    ExpressionTree x = unwrap(e);
                    if (x == null) return null;
                    W known = value.get(x);
                    if (known != null) return known;
                    if (x instanceof IdentifierTree) return vars.get(((IdentifierTree) x).getName().toString());
                    if (x instanceof MemberSelectTree) {
                        MemberSelectTree ms = (MemberSelectTree) x;
                        if (ms.getExpression() instanceof IdentifierTree
                                && "this".equals(((IdentifierTree) ms.getExpression()).getName().toString())) {
                            return vars.get(ms.getIdentifier().toString());
                        }
                        return null;
                    }
                    if (x instanceof NewClassTree) return fromNew((NewClassTree) x, null, null);
                    if (x instanceof MethodInvocationTree) return resolveChain((MethodInvocationTree) x);
                    return null;
                }

                void addSink(W w, ExpressionTree recv, String method, int line) {
                    String rf = receiverFieldName(recv);
                    if (rf != null && fields.containsKey(rf)) {
                        w.sinks.add(sinkRec("field", rf, fields.get(rf), method, line));
                    } else if (recv == null || receiverKeyword(recv) != null) {
                        w.sinks.add(sinkRec("this", (recv == null) ? null : receiverKeyword(recv), ownSimple, method, line));
                    } else {
                        w.sinks.add(sinkRec("passed-on", rf, null, method, line));
                    }
                }

                void addOp(W w, String name, MethodInvocationTree inv, int line) {
                    Map<String, Object> op = new LinkedHashMap<>();
                    op.put("name", name);
                    // One entry per TOP-LEVEL argument: its string value when the
                    // argument is a string literal, its value when it is a boolean
                    // literal (MP's `eq(boolean condition, …)` overloads put one in
                    // front), and null for anything else. WHICH position names a
                    // column is the bridge's reading, not this scan's.
                    List<Object> args = new ArrayList<>();
                    List<Object> props = new ArrayList<>();
                    for (ExpressionTree a : inv.getArguments()) {
                        ExpressionTree ua = unwrap(a);
                        Object slot = null;
                        if (ua instanceof LiteralTree) {
                            Object v = ((LiteralTree) ua).getValue();
                            if (v instanceof String || v instanceof Boolean) slot = v;
                        }
                        args.add(slot);
                        collectMemberRefs(a, props);
                    }
                    op.put("args", args);
                    op.put("props", props);
                    op.put("line", line);
                    w.ops.add(op);
                }
            }, null);

            for (W w : all) {
                Map<String, Object> rec = new LinkedHashMap<>();
                rec.put("kind", "mpWrapper");
                rec.put("from", from);
                rec.put("var", w.var);
                rec.put("wrapperKind", w.kind);
                rec.put("entityTypeSimple", w.entitySimple);
                rec.put("origin", w.origin);
                rec.put("builtBy", w.initFrom);
                rec.put("opsComplete", w.opsComplete);
                rec.put("factoryReceiver", w.factoryReceiver);
                rec.put("factoryReceiverType", w.factoryReceiverType);
                rec.put("ops", w.ops);
                rec.put("sinks", w.sinks);
                rec.put("line", w.line);
                rec.put("file", rel);
                sink.mpWrappers++;
                sink.add("7mpwrapper" + SEP + from + SEP + pad(w.line) + SEP + (w.var == null ? "" : w.var)
                        + SEP + Integer.toString(sink.mpWrappers), rec);
            }
        }

        Map<String, Object> sinkRec(String kind, String receiver, String receiverType, String method, int line) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("kind", kind);
            s.put("receiver", receiver);
            s.put("receiverTypeSimple", receiverType);
            s.put("method", method);
            s.put("line", line);
            return s;
        }

        /** `this`/`super` as written, else the receiver's own simple spelling. */
        static String receiverKeywordOrSelf(ExpressionTree e) {
            String k = receiverKeyword(e);
            return (k != null) ? k : null;
        }

        /**
         * `"this"` / `"super"` when the receiver is exactly that keyword, else null.
         * `this.field.m()` is NOT one of these — its receiver is the field.
         */
        static String receiverKeyword(ExpressionTree recvExpr) {
            if (!(recvExpr instanceof IdentifierTree)) return null;
            String n = ((IdentifierTree) recvExpr).getName().toString();
            return ("this".equals(n) || "super".equals(n)) ? n : null;
        }

        /**
         * The FIELD name a receiver expression denotes, for `x.m()` and `this.x.m()`.
         * Null for anything else (a qualified type, a chained call, `super`).
         */
        static String receiverFieldName(ExpressionTree recvExpr) {
            if (recvExpr instanceof IdentifierTree) {
                String n = ((IdentifierTree) recvExpr).getName().toString();
                return ("this".equals(n) || "super".equals(n)) ? null : n;
            }
            if (recvExpr instanceof MemberSelectTree) {
                MemberSelectTree inner = (MemberSelectTree) recvExpr;
                ExpressionTree base = inner.getExpression();
                if (base instanceof IdentifierTree
                        && "this".equals(((IdentifierTree) base).getName().toString())) {
                    return inner.getIdentifier().toString();
                }
            }
            return null;
        }
    }


    /**
     * One condition wrapper as the scan saw it being built. MUTABLE while the
     * method body is walked, then rendered into an `mpWrapper` record.
     */
    static final class W {
        String var;                 // the local/parameter it was bound to, or null
        String kind;                // wrapperKind, from the type that was written
        String entitySimple;        // the declared type argument, or null
        final String origin;        // how it came into existence, as written
        final String initFrom;      // the call that built it, when this lane cannot see through
        final boolean opsComplete;  // false when ops were added outside this method
        final int line;
        String factoryReceiver;     // for `x.lambdaQuery()`: the receiver, as written
        String factoryReceiverType; //  …and its declared type's simple name
        final List<Object> ops = new ArrayList<>();
        final List<Object> sinks = new ArrayList<>();
        W(String var, String kind, String entitySimple, String origin, String initFrom, boolean opsComplete, int line) {
            this.var = var; this.kind = kind; this.entitySimple = entitySimple;
            this.origin = origin; this.initFrom = initFrom; this.opsComplete = opsComplete; this.line = line;
        }
    }

    /**
     * The calls that END a fluent chain wrapper (`…lambdaQuery().eq(…).list()`):
     * their value is the query RESULT, not the wrapper, so the chain stops there
     * and the call becomes the wrapper's sink.
     */
    static final java.util.Set<String> MP_CHAIN_TERMINALS = new java.util.HashSet<>(Arrays.asList(
        "list", "one", "oneOpt", "count", "page", "exists", "remove", "update"));

    /** Strip parentheses and casts: they change nothing about which object this is. */
    static ExpressionTree unwrap(ExpressionTree e) {
        ExpressionTree cur = e;
        for (int i = 0; i < 8 && cur != null; i++) {
            if (cur instanceof com.sun.source.tree.ParenthesizedTree) {
                cur = ((com.sun.source.tree.ParenthesizedTree) cur).getExpression();
            } else if (cur instanceof com.sun.source.tree.TypeCastTree) {
                cur = ((com.sun.source.tree.TypeCastTree) cur).getExpression();
            } else {
                return cur;
            }
        }
        return cur;
    }

    /**
     * Every METHOD REFERENCE in an expression, as `{owner, method, property}`.
     * `SysUserDepart::getDepId` is the only way a lambda wrapper names a column,
     * and the JavaBeans property behind the getter is what the bridge resolves —
     * so both the getter as written and the property it names are recorded.
     */
    static void collectMemberRefs(Tree t, final List<Object> out) {
        if (t == null) return;
        t.accept(new TreeScanner<Void, Void>() {
            @Override public Void visitMemberReference(MemberReferenceTree mr, Void p) {
                String owner = typeSimpleName(mr.getQualifierExpression());
                String method = mr.getName().toString();
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("owner", owner);
                m.put("method", method);
                m.put("property", propertyNameOf(method));
                out.add(m);
                return super.visitMemberReference(mr, p);
            }
        }, null);
    }

    /** The name of the method a call invokes, qualified as written (`X.y`), or null. */
    static String calleeName(MethodInvocationTree inv) {
        Tree sel = inv.getMethodSelect();
        if (sel instanceof IdentifierTree) return ((IdentifierTree) sel).getName().toString();
        if (sel instanceof MemberSelectTree) {
            MemberSelectTree ms = (MemberSelectTree) sel;
            String recv = null;
            ExpressionTree e = ms.getExpression();
            if (e instanceof IdentifierTree) recv = ((IdentifierTree) e).getName().toString();
            else if (e instanceof MemberSelectTree) recv = ((MemberSelectTree) e).getIdentifier().toString();
            return (recv == null) ? ms.getIdentifier().toString() : recv + "." + ms.getIdentifier().toString();
        }
        return null;
    }

    /** A line number, zero-padded, so a SORT KEY orders by line and not by digit. */
    static String pad(int line) {
        String s = Integer.toString(Math.max(line, 0));
        StringBuilder sb = new StringBuilder();
        for (int i = s.length(); i < 8; i++) sb.append('0');
        return sb.append(s).toString();
    }

    // ---- mapping detection ----------------------------------------------------
    static final class Mapping {
        final String httpMethod;
        final String path;
        Mapping(String httpMethod, String path) { this.httpMethod = httpMethod; this.path = path; }
    }

    static Mapping methodMapping(MethodTree m) {
        for (AnnotationTree a : m.getModifiers().getAnnotations()) {
            String simple = typeSimpleName(a.getAnnotationType());
            if (simple == null) continue;
            switch (simple) {
                case "GetMapping":    return new Mapping("GET", annPath(a));
                case "PostMapping":   return new Mapping("POST", annPath(a));
                case "PutMapping":    return new Mapping("PUT", annPath(a));
                case "DeleteMapping": return new Mapping("DELETE", annPath(a));
                case "PatchMapping":  return new Mapping("PATCH", annPath(a));
                case "RequestMapping":
                    return new Mapping(requestMethodOf(a), annPath(a));
                default:
                    // not a mapping annotation
            }
        }
        return null;
    }

    /** Annotations that make a type a DECLARATIVE HTTP CLIENT rather than a route holder. */
    static final String[] CLIENT_ANNOTATIONS = { "FeignClient", "HttpExchange" };

    /**
     * The client annotation a type carries, as evidence: which one, the service it
     * names, its base url and its path prefix — each as WRITTEN. `value` is very
     * often a constant reference (`ServiceNameConstants.SERVICE_SYSTEM`), which
     * this parse-only worker cannot resolve to a string; the reference itself is
     * recorded rather than dropped, and `serviceLiteral` says which it is, so a
     * reader is never shown a constant NAME as if it were the service name.
     */
    static Map<String, Object> clientAnnotationOf(List<AnnotationTree> anns) {
        for (String simple : CLIENT_ANNOTATIONS) {
            AnnotationTree a = annNamed(anns, simple);
            if (a == null) continue;
            ExpressionTree svc = annAttr(a, "name");
            if (svc == null) svc = annAttr(a, "value");
            String svcLiteral = firstString(svc);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("kind", simple);
            out.put("service", (svc == null) ? null : (svcLiteral != null ? svcLiteral : svc.toString()));
            out.put("serviceLiteral", svcLiteral != null);
            out.put("url", firstString(annAttr(a, "url")));
            out.put("path", clientPathAttr(a, simple));
            return out;
        }
        return null;
    }

    /** The path prefix a client annotation declares (@FeignClient(path=…), @HttpExchange("…")). */
    static String clientPathAttr(AnnotationTree a, String simple) {
        if ("HttpExchange".equals(simple)) {
            String v = firstString(annAttr(a, "value"));
            return (v != null) ? v : firstString(annAttr(a, "url"));
        }
        return firstString(annAttr(a, "path"));
    }

    /** The path prefix of whichever client annotation this type carries, or null. */
    static String clientPathOf(List<AnnotationTree> anns) {
        Map<String, Object> c = clientAnnotationOf(anns);
        return (c == null) ? null : (String) c.get("path");
    }

    // ---- imperative HTTP clients (javafacts/8) --------------------------------

    /** Type simple names that make a receiver one of the three standard clients. */
    static final String[][] HTTP_CLIENT_TYPES = {
        {"WebClient", "webclient"},
        {"RestClient", "restclient"},
        {"RestTemplate", "resttemplate"},
        {"RestOperations", "resttemplate"},
    };

    /**
     * The client kind a WRITTEN type name denotes, or null.
     *
     * Matched SEGMENT BY SEGMENT, so `WebClient.Builder` and the fully qualified
     * spelling both name a WebClient, and a package called `restclient` names
     * nothing. A substring test would do neither.
     */
    static String httpClientKindOf(String written) {
        if (written == null) return null;
        for (String seg : written.split("\\.")) {
            for (String[] pair : HTTP_CLIENT_TYPES) if (pair[0].equals(seg)) return pair[1];
        }
        return null;
    }

    /** The calls that SEND a fluent request: what ends a WebClient/RestClient chain. */
    static final java.util.Set<String> FLUENT_TERMINALS = new java.util.HashSet<>(Arrays.asList(
        "retrieve", "exchange", "exchangeToMono", "exchangeToFlux"));

    /** The step of a fluent chain that carries the url. */
    static final java.util.Set<String> FLUENT_URI_METHODS = new java.util.HashSet<>(Arrays.asList("uri", "url"));

    /** How many steps of one fluent chain are read before the walk gives up. */
    static final int FLUENT_CHAIN_LIMIT = 32;

    /** A fluent verb method and the HTTP method it names. */
    static final String[][] FLUENT_VERBS = {
        {"get", "GET"}, {"post", "POST"}, {"put", "PUT"}, {"delete", "DELETE"},
        {"patch", "PATCH"}, {"head", "HEAD"}, {"options", "OPTIONS"},
    };

    /** The HTTP methods this worker will name. Anything else is not one. */
    static final java.util.Set<String> HTTP_METHOD_NAMES = new java.util.HashSet<>(Arrays.asList(
        "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"));

    /**
     * The HTTP method an ARGUMENT names (`HttpMethod.POST`), or null.
     *
     * The name has to BE an HTTP method. `exchange(url, method, …)` hands the
     * verb in a variable called `method`, and reading that name as the verb
     * would put "method" in the record where a verb belongs — a value from the
     * source that says nothing about which request is sent.
     */
    static String httpMethodArgOf(ExpressionTree e) {
        String name = firstMemberName(e);
        return (name != null && HTTP_METHOD_NAMES.contains(name)) ? name : null;
    }

    /**
     * The HTTP method a chain step names, or null when the step is not a verb.
     *
     * A verb call takes NO arguments (`webClient.get()`), which is what keeps
     * `map.get(k)` out; `method(HttpMethod.X)` names its verb in an argument,
     * and an argument this file cannot read leaves the method unknown rather
     * than assumed.
     */
    static String fluentVerbOf(String name, MethodInvocationTree step) {
        if ("method".equals(name)) {
            return step.getArguments().isEmpty() ? null : httpMethodArgOf(step.getArguments().get(0));
        }
        if (!step.getArguments().isEmpty()) return null;
        for (String[] pair : FLUENT_VERBS) if (pair[0].equals(name)) return pair[1];
        return null;
    }

    /**
     * RestTemplate's request methods and the HTTP method each sends. An EMPTY
     * value means the verb is named by argument 1 (`exchange(url, HttpMethod.X, …)`,
     * `execute(url, HttpMethod.X, …)`) rather than by the method name.
     */
    static final Map<String, String> REST_TEMPLATE_VERBS = restTemplateVerbs();

    static Map<String, String> restTemplateVerbs() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("getForObject", "GET");
        m.put("getForEntity", "GET");
        m.put("postForObject", "POST");
        m.put("postForEntity", "POST");
        m.put("postForLocation", "POST");
        m.put("put", "PUT");
        m.put("delete", "DELETE");
        m.put("patchForObject", "PATCH");
        m.put("headForHeaders", "HEAD");
        m.put("optionsForAllow", "OPTIONS");
        m.put("exchange", "");
        m.put("execute", "");
        return m;
    }

    /** What stands in a url where the code interpolated a value this file cannot read. */
    static final String URL_HOLE = "{*}";

    /** How much of a url expression one record carries, so a record cannot hold a page. */
    static final int URL_TEXT_LIMIT = 200;

    /** A url as this worker could read it: how much of it is literal, and what it says. */
    static final class UrlRead {
        String kind;    // literal | template | concat | unresolved
        String value;   // the url as text, with {*} where a value was interpolated
        String base;    // the leading operand that is not a literal, as written
        String written; // the whole expression, as written
    }

    /**
     * One url argument, reduced no further than this file allows.
     *
     * A `+` chain is flattened and read left to right. A LEADING operand that is
     * not a literal is the BASE — a constant or a call holding `scheme://host/`,
     * which a parse-only, one-file-at-a-time worker cannot resolve — so it is
     * named as written and left out of the path; every later non-literal is a
     * value interpolated INTO the path, so it becomes a `{*}` hole the way the
     * web lane spells one. Nothing literal anywhere means the url is not in this
     * file at all: `unresolved`, with the expression as written and no path.
     */
    static UrlRead readUrl(ExpressionTree e) {
        UrlRead out = new UrlRead();
        out.written = writtenText(e);
        List<ExpressionTree> parts = new ArrayList<>();
        flattenPlus(e, parts);
        StringBuilder sb = new StringBuilder();
        boolean anyLiteral = false;
        boolean anyHole = false;
        String base = null;
        for (int i = 0; i < parts.size(); i++) {
            ExpressionTree part = parts.get(i);
            String lit = null;
            if (part instanceof LiteralTree) {
                Object v = ((LiteralTree) part).getValue();
                if (v instanceof String) lit = (String) v;
            }
            if (lit != null) { sb.append(lit); anyLiteral = true; continue; }
            if (i == 0) { base = writtenText(part); continue; }
            anyHole = true;
            sb.append(URL_HOLE);
        }
        if (!anyLiteral) { out.kind = "unresolved"; return out; }
        out.value = sb.toString();
        out.base = base;
        out.kind = (base != null || anyHole) ? "concat"
                : (out.value.indexOf('{') >= 0 ? "template" : "literal");
        return out;
    }

    /** Flatten a `+` expression into its operands, left to right. */
    static void flattenPlus(ExpressionTree e, List<ExpressionTree> out) {
        ExpressionTree x = unwrap(e);
        if (x instanceof BinaryTree && ((BinaryTree) x).getKind() == Tree.Kind.PLUS) {
            flattenPlus(((BinaryTree) x).getLeftOperand(), out);
            flattenPlus(((BinaryTree) x).getRightOperand(), out);
            return;
        }
        out.add(x);
    }

    /** An expression as the source wrote it, on one line and capped. */
    static String writtenText(Tree t) {
        if (t == null) return null;
        String s = t.toString().replace('\n', ' ').replace('\r', ' ').trim();
        return (s.length() > URL_TEXT_LIMIT) ? s.substring(0, URL_TEXT_LIMIT) : s;
    }

    /**
     * Split `scheme://host/rest` into its host and what follows it. A url with no
     * `://` is all path, and the host comes back null.
     */
    static String[] splitHost(String url) {
        int i = url.indexOf("://");
        if (i < 0) return new String[]{null, url};
        int j = url.indexOf('/', i + 3);
        String host = (j < 0) ? url.substring(i + 3) : url.substring(i + 3, j);
        String rest = (j < 0) ? "" : url.substring(j);
        return new String[]{host, rest};
    }

    /**
     * The type as WRITTEN (`WebClient.Builder`, `java.util.List`), so a nested
     * type is not read as its last segment alone. `typeSimpleName` answers the
     * other question and both are needed.
     */
    static String typeWrittenName(Tree t) {
        if (t == null) return null;
        if (t instanceof IdentifierTree) return ((IdentifierTree) t).getName().toString();
        if (t instanceof MemberSelectTree) {
            MemberSelectTree ms = (MemberSelectTree) t;
            String base = typeWrittenName(ms.getExpression());
            return (base == null) ? ms.getIdentifier().toString() : base + "." + ms.getIdentifier().toString();
        }
        if (t instanceof ParameterizedTypeTree) return typeWrittenName(((ParameterizedTypeTree) t).getType());
        if (t instanceof ArrayTypeTree) return typeWrittenName(((ArrayTypeTree) t).getType());
        return null;
    }

    /** Every method a type declares, as "name/arity"; constructors excluded, order kept. */
    static List<String> declaredMethodsOf(ClassTree ct) {
        return new ArrayList<>(declaredMethodKeys(ct));
    }

    /** The same list, deduplicated in declaration order — the one place the rule lives. */
    static List<String> declaredMethodKeys(ClassTree ct) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        for (Tree member : ct.getMembers()) {
            if (!(member instanceof MethodTree)) continue;
            MethodTree m = (MethodTree) member;
            String n = m.getName().toString();
            if ("<init>".equals(n)) continue; // a constructor is not a callable member here
            out.add(n + "/" + m.getParameters().size());
        }
        return new ArrayList<>(out);
    }

    /** Join two path halves, either of which may be null/empty; null when both are. */
    static String joinPathParts(String a, String b) {
        if (a == null || a.trim().isEmpty()) return b;
        if (b == null || b.trim().isEmpty()) return a;
        return joinPath(a, b);
    }

    static String classLevelBasePath(List<AnnotationTree> anns) {
        for (AnnotationTree a : anns) {
            String simple = typeSimpleName(a.getAnnotationType());
            if (simple == null) continue;
            switch (simple) {
                case "RequestMapping":
                case "GetMapping":
                case "PostMapping":
                case "PutMapping":
                case "DeleteMapping":
                case "PatchMapping":
                    String p = annPath(a);
                    if (p != null) return p;
                    break;
                default:
            }
        }
        return null;
    }

    // Path from an annotation's value/path attribute (positional or named).
    static String annPath(AnnotationTree a) {
        ExpressionTree e = annAttr(a, "value");
        if (e == null) e = annAttr(a, "path");
        return firstString(e);
    }

    // httpMethod from a @RequestMapping's method= attribute; ANY if absent.
    static String requestMethodOf(AnnotationTree a) {
        ExpressionTree e = annAttr(a, "method");
        String m = firstMemberName(e);
        return (m != null) ? m : "ANY";
    }

    // Return the expression for a named attribute, or the positional value for "value".
    static ExpressionTree annAttr(AnnotationTree a, String name) {
        for (ExpressionTree arg : a.getArguments()) {
            if (arg instanceof AssignmentTree) {
                AssignmentTree as = (AssignmentTree) arg;
                if (as.getVariable() instanceof IdentifierTree) {
                    String var = ((IdentifierTree) as.getVariable()).getName().toString();
                    if (var.equals(name)) return as.getExpression();
                }
            } else if ("value".equals(name)) {
                return arg; // single-element (positional) annotation value
            }
        }
        return null;
    }

    // First string literal of an expression that may be a literal or an array.
    static String firstString(ExpressionTree e) {
        if (e == null) return null;
        if (e instanceof LiteralTree) {
            Object v = ((LiteralTree) e).getValue();
            return (v instanceof String) ? (String) v : null;
        }
        if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) {
                for (ExpressionTree it : inits) {
                    String s = firstString(it);
                    if (s != null) return s;
                }
            }
        }
        return null;
    }

    // First member/identifier name (e.g. RequestMethod.POST -> "POST"), array-aware.
    static String firstMemberName(ExpressionTree e) {
        if (e == null) return null;
        if (e instanceof MemberSelectTree) {
            return ((MemberSelectTree) e).getIdentifier().toString();
        }
        if (e instanceof IdentifierTree) {
            return ((IdentifierTree) e).getName().toString();
        }
        if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) {
                for (ExpressionTree it : inits) {
                    String s = firstMemberName(it);
                    if (s != null) return s;
                }
            }
        }
        return null;
    }

    // Concatenate a base path and a method path with a single slash. Either may
    // be null/empty. The result keeps a leading slash and collapses "//".
    static String joinPath(String base, String method) {
        String b = (base == null) ? "" : base.trim();
        String mth = (method == null) ? "" : method.trim();
        String joined;
        if (b.isEmpty()) joined = mth;
        else if (mth.isEmpty()) joined = b;
        else joined = b + "/" + mth;
        if (joined.isEmpty()) return "/";
        // collapse repeated slashes
        StringBuilder sb = new StringBuilder();
        boolean prevSlash = false;
        for (int i = 0; i < joined.length(); i++) {
            char c = joined.charAt(i);
            if (c == '/') {
                if (!prevSlash) sb.append(c);
                prevSlash = true;
            } else {
                sb.append(c);
                prevSlash = false;
            }
        }
        String out = sb.toString();
        if (!out.startsWith("/")) out = "/" + out;
        // drop a trailing slash except for the root path
        if (out.length() > 1 && out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    // ---- JPA / Spring Data tables ---------------------------------------------

    /** Relation annotation simple name -> the `relation` value emitted for it. */
    static final String[][] RELATION_ANNOTATIONS = {
        {"ManyToOne", "manyToOne"},
        {"OneToMany", "oneToMany"},
        {"OneToOne", "oneToOne"},
        {"ManyToMany", "manyToMany"},
    };

    /** Spring Data base repository interfaces this worker recognises by simple name. */
    static final String[] REPOSITORY_BASES = {
        "JpaRepository", "CrudRepository", "ListCrudRepository",
        "PagingAndSortingRepository", "ListPagingAndSortingRepository", "Repository",
    };


    // ---- MyBatis-Plus ---------------------------------------------------------

    /**
     * MyBatis's four statement annotations, in the order they are looked for. The
     * SIMPLE name is matched, because a mapper interface imports them
     * (`org.apache.ibatis.annotations.Select`) and this worker resolves no types.
     */
    static final String[] MAPPER_SQL_ANNOTATIONS = {"Select", "Insert", "Update", "Delete"};

    /** The generic mapper interface an MP mapper extends. */
    static final String MP_MAPPER_BASE = "BaseMapper";
    /** The generic service INTERFACE an MP service interface extends. */
    static final String MP_SERVICE_IFACE = "IService";
    /** The generic service CLASSES an MP service implementation extends. */
    static final String[] MP_SERVICE_IMPL_BASES = { "ServiceImpl" };

    /** Member annotations that make a class MyBatis-Plus persistence evidence. */
    static final String[] MP_MEMBER_ANNOTATIONS = { "TableId", "TableField", "TableLogic", "Version" };

    static boolean hasMpAnnotation(List<AnnotationTree> anns) {
        List<String> names = annotationNames(anns);
        for (String a : MP_MEMBER_ANNOTATIONS) if (names.contains(a)) return true;
        return false;
    }

    /**
     * The condition-wrapper types this worker recognises by simple name, and the
     * `wrapperKind` each is recorded as. `Wrapper`/`AbstractWrapper` are the
     * abstract spellings a parameter often uses: the KIND is unknown there, which
     * is a fact about the source and is recorded as such rather than guessed.
     */
    static final String[][] MP_WRAPPER_TYPES = {
        {"LambdaQueryWrapper", "lambda-query"},
        {"LambdaQueryChainWrapper", "lambda-query"},
        {"LambdaUpdateWrapper", "lambda-update"},
        {"LambdaUpdateChainWrapper", "lambda-update"},
        {"QueryWrapper", "query"},
        {"QueryChainWrapper", "query"},
        {"UpdateWrapper", "update"},
        {"UpdateChainWrapper", "update"},
        {"AbstractWrapper", "unknown"},
        {"AbstractLambdaWrapper", "unknown"},
        {"Wrapper", "unknown"},
    };

    /** The wrapperKind for a wrapper type's simple name, or null when it is not one. */
    static String wrapperKindOf(String simple) {
        if (simple == null) return null;
        for (String[] pair : MP_WRAPPER_TYPES) if (pair[0].equals(simple)) return pair[1];
        return null;
    }

    /**
     * The static factories that MAKE a wrapper (`Wrappers.lambdaQuery()`), and the
     * fluent starters a service/mapper offers (`service.lambdaQuery()`), mapped to
     * the kind of wrapper they return.
     */
    static final String[][] MP_WRAPPER_FACTORIES = {
        {"lambdaQuery", "lambda-query"},
        {"lambdaUpdate", "lambda-update"},
        {"query", "query"},
        {"update", "update"},
        {"emptyWrapper", "unknown"},
    };

    static String factoryKindOf(String name) {
        if (name == null) return null;
        for (String[] pair : MP_WRAPPER_FACTORIES) if (pair[0].equals(name)) return pair[1];
        return null;
    }

    /** Annotations that make a GETTER persistence evidence (property access). */
    static final String[] JPA_MEMBER_ANNOTATIONS = {
        "Column", "Id", "EmbeddedId", "Embedded", "Transient", "Basic", "Lob", "Version",
        "Enumerated", "Temporal", "ElementCollection", "JoinColumn", "JoinTable",
        "ManyToOne", "OneToMany", "OneToOne", "ManyToMany",
    };

    static boolean hasJpaAnnotation(List<AnnotationTree> anns) {
        List<String> names = annotationNames(anns);
        for (String a : JPA_MEMBER_ANNOTATIONS) if (names.contains(a)) return true;
        return false;
    }

    /** The JavaBeans property a getter names, or null when it is not a getter. */
    static String propertyNameOf(String methodName) {
        String rest;
        if (methodName.startsWith("get") && methodName.length() > 3) rest = methodName.substring(3);
        else if (methodName.startsWith("is") && methodName.length() > 2) rest = methodName.substring(2);
        else return null;
        if (!Character.isUpperCase(rest.charAt(0))) return null;
        // JavaBeans: `getURL` -> "URL", `getName` -> "name".
        if (rest.length() > 1 && Character.isUpperCase(rest.charAt(1))) return rest;
        return Character.toLowerCase(rest.charAt(0)) + rest.substring(1);
    }

    /** The annotation with this simple name, or null. */
    static AnnotationTree annNamed(List<AnnotationTree> anns, String simple) {
        for (AnnotationTree a : anns) {
            if (simple.equals(typeSimpleName(a.getAnnotationType()))) return a;
        }
        return null;
    }

    /** Simple names of a parameterized type's arguments (`Map<K,V>` -> [K, V]). */
    static List<String> typeArgSimples(Tree t) {
        List<String> out = new ArrayList<>();
        if (t instanceof ParameterizedTypeTree) {
            for (Tree a : ((ParameterizedTypeTree) t).getTypeArguments()) {
                String s = typeSimpleName(a);
                if (s != null) out.add(s);
            }
        }
        return out;
    }

    /** Every member/identifier name in an expression that may be a single value or an array. */
    static List<String> memberNames(ExpressionTree e) {
        List<String> out = new ArrayList<>();
        collectMemberNames(e, out);
        return out;
    }

    static void collectMemberNames(ExpressionTree e, List<String> out) {
        if (e == null) return;
        if (e instanceof MemberSelectTree) out.add(((MemberSelectTree) e).getIdentifier().toString());
        else if (e instanceof IdentifierTree) out.add(((IdentifierTree) e).getName().toString());
        else if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) for (ExpressionTree it : inits) collectMemberNames(it, out);
        }
    }

    /** The `name` of each nested `@JoinColumn`, for @JoinTable's two column lists. */
    static List<String> joinColumnNames(ExpressionTree e) {
        List<String> out = new ArrayList<>();
        collectJoinColumnNames(e, out);
        return out;
    }

    static void collectJoinColumnNames(ExpressionTree e, List<String> out) {
        if (e == null) return;
        if (e instanceof AnnotationTree) {
            String n = firstString(annAttr((AnnotationTree) e, "name"));
            if (n != null) out.add(n);
        } else if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) for (ExpressionTree it : inits) collectJoinColumnNames(it, out);
        }
    }

    /** A boolean literal annotation attribute (`nativeQuery = true`), or null. */
    static Boolean boolOf(ExpressionTree e) {
        if (e instanceof LiteralTree) {
            Object v = ((LiteralTree) e).getValue();
            if (v instanceof Boolean) return (Boolean) v;
        }
        return null;
    }

    // ---- small tree helpers ---------------------------------------------------
    static String kindOf(ClassTree ct) {
        switch (ct.getKind()) {
            case INTERFACE:       return "interface";
            case ENUM:            return "enum";
            case ANNOTATION_TYPE: return "interface"; // an annotation is an interface kind
            case RECORD:          return "class";
            case CLASS:
            default:              return "class";
        }
    }

    static List<AnnotationTree> annotationsOf(List<? extends AnnotationTree> anns) {
        List<AnnotationTree> out = new ArrayList<>();
        for (AnnotationTree a : anns) out.add(a);
        return out;
    }

    static List<String> annotationNames(List<? extends AnnotationTree> anns) {
        List<String> out = new ArrayList<>();
        for (AnnotationTree a : anns) {
            String s = typeSimpleName(a.getAnnotationType());
            if (s != null) out.add(s);
        }
        return out;
    }

    // Simple (unqualified) name written for a type tree.
    static String typeSimpleName(Tree t) {
        if (t == null) return null;
        if (t instanceof IdentifierTree) {
            return ((IdentifierTree) t).getName().toString();
        }
        if (t instanceof MemberSelectTree) {
            return ((MemberSelectTree) t).getIdentifier().toString();
        }
        if (t instanceof ParameterizedTypeTree) {
            return typeSimpleName(((ParameterizedTypeTree) t).getType());
        }
        if (t instanceof ArrayTypeTree) {
            return typeSimpleName(((ArrayTypeTree) t).getType());
        }
        // PrimitiveTypeTree, WildcardTree, etc.: no class/interface simple name.
        return null;
    }

    // ---- file collection ------------------------------------------------------
    static void collectJava(File f, List<File> out) {
        if (f == null) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids == null) return;
            Arrays.sort(kids, (a, b) -> a.getName().compareTo(b.getName()));
            for (File k : kids) collectJava(k, out);
        } else if (f.isFile() && f.getName().endsWith(".java")) {
            out.add(f);
        }
    }

    static String relativize(Path root, URI uri) {
        Path p;
        try {
            p = Paths.get(uri);
        } catch (Exception e) {
            p = Paths.get(uri.getPath());
        }
        p = p.toAbsolutePath().normalize();
        if (root != null) {
            try {
                return root.relativize(p).toString().replace(File.separatorChar, '/');
            } catch (IllegalArgumentException e) {
                // different roots: fall back to just the file name
            }
        }
        return p.getFileName().toString();
    }

    // =========================================================================
    // Output
    // =========================================================================
    static void emit(Sink sink) {
        Collections.sort(sink.records);

        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);

        Map<String, Object> header = new LinkedHashMap<>();
        header.put("kind", "header");
        header.put("schema", SCHEMA);
        header.put("version", VERSION);
        header.put("files", sink.files);
        header.put("types", sink.types);
        header.put("endpoints", sink.endpoints);
        header.put("calls", sink.calls);
        header.put("methods", sink.methods);
        // The two halves of what this run did NOT emit an edge for. A per-RUN
        // tally, like every other number on the header: it rides on stdout so a
        // caller that never reads stderr can still say how much was skipped, and
        // it is dropped from the per-file shards on purpose (a run's tally means
        // nothing once its facts are cached per file).
        header.put("skippedCalls", sink.skippedCalls);
        header.put("skippedLocalReceivers", sink.skippedLocalReceivers);
        header.put("transactional", sink.transactional);
        header.put("entities", sink.entities);
        header.put("repositories", sink.repositories);
        header.put("mpEntities", sink.mpEntities);
        header.put("mpMappers", sink.mpMappers);
        header.put("mpServices", sink.mpServices);
        header.put("mpWrappers", sink.mpWrappers);
        header.put("mapperAnnotationSql", sink.mapperAnnotationSql);
        header.put("httpCalls", sink.httpCalls);
        header.put("parseErrors", sink.parseErrors);
        out.println(toJson(header));
        for (Rec r : sink.records) out.println(r.json);
        out.flush();

        PrintStream err = new PrintStream(System.err, true, StandardCharsets.UTF_8);
        for (Map<String, Object> d : sink.diagnostics) err.println(toJson(d));
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("level", "info");
        summary.put("code", "summary");
        summary.put("version", VERSION);
        summary.put("files", sink.files);
        summary.put("types", sink.types);
        summary.put("endpoints", sink.endpoints);
        summary.put("calls", sink.calls);
        summary.put("methods", sink.methods);
        summary.put("skippedCalls", sink.skippedCalls);
        summary.put("skippedLocalReceivers", sink.skippedLocalReceivers);
        summary.put("transactional", sink.transactional);
        summary.put("entities", sink.entities);
        summary.put("repositories", sink.repositories);
        summary.put("mpEntities", sink.mpEntities);
        summary.put("mpMappers", sink.mpMappers);
        summary.put("mpServices", sink.mpServices);
        summary.put("mpWrappers", sink.mpWrappers);
        summary.put("mapperAnnotationSql", sink.mapperAnnotationSql);
        summary.put("httpCalls", sink.httpCalls);
        summary.put("parseErrors", sink.parseErrors);
        err.println(toJson(summary));
        err.flush();
    }

    // Minimal, deterministic compact JSON writer (objects preserve insertion order).
    @SuppressWarnings("unchecked")
    static String toJson(Object o) {
        StringBuilder sb = new StringBuilder();
        writeJson(sb, o);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    static void writeJson(StringBuilder sb, Object o) {
        if (o == null) {
            sb.append("null");
        } else if (o instanceof String) {
            writeJsonString(sb, (String) o);
        } else if (o instanceof Integer || o instanceof Long) {
            sb.append(o.toString());
        } else if (o instanceof Boolean) {
            sb.append(((Boolean) o) ? "true" : "false");
        } else if (o instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeJsonString(sb, e.getKey());
                sb.append(':');
                writeJson(sb, e.getValue());
            }
            sb.append('}');
        } else if (o instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object it : (List<Object>) o) {
                if (!first) sb.append(',');
                first = false;
                writeJson(sb, it);
            }
            sb.append(']');
        } else {
            writeJsonString(sb, o.toString());
        }
    }

    static void writeJsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    static java.io.Writer nullWriter() {
        return new java.io.Writer() {
            public void write(char[] cbuf, int off, int len) { }
            public void flush() { }
            public void close() { }
        };
    }

    static String shortMsg(Throwable t) {
        String m = t.getMessage();
        String cls = t.getClass().getSimpleName();
        return (m != null) ? (cls + ": " + m) : cls;
    }
}
