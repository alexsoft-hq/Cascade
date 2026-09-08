[English](README.md) | **한국어**

# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/cascade-mark-dark.svg"><img src="docs/assets/cascade-mark.svg" width="28" alt=""></picture> Cascade

AI 코딩 에이전트와 그 옆에서 일하는 사람을 위한, 코드에서 컬럼까지 이어지는
변경 영향 지식 그래프입니다. Apache-2.0.

- [그림부터 봅니다](#그림부터-봅니다)
- [무엇에 답하는가](#무엇에-답하는가)
- [지원하는 스택](#지원하는-스택)
- [설치](#설치)
- [내 프로젝트에 10분](#내-프로젝트에-10분)
- [AI 에이전트에 연결하기](#ai-에이전트에-연결하기)
- [편집 루프](#편집-루프)
- [여러 프로젝트, 한 서버](#여러-프로젝트-한-서버)
- [정직성, verify, doctor](#정직성-verify-doctor)
- [뷰어](#뷰어)
- [프로파일과 프레임워크 팩](#프로파일과-프레임워크-팩)
- [무엇을 어떻게 측정했는가](#무엇을-어떻게-측정했는가)
- [저장소 구조](#저장소-구조)
- [기여, 보안, 행동 규범](#기여-보안-행동-규범)
- [라이선스](#라이선스)

## 그림부터 봅니다

![Cascade 뷰어 둘러보기. litemall 의 개요 다이얼, 이어서 컬럼 하나가 닿는 SQL
statement 와 HTTP 엔드포인트로 뻗어 나가는 모습, statement 하나의 소스, 프로젝트
전체 그래프, 그리고 mall 에서 SQL 의 조인으로 복원한 스키마](docs/assets/cascade-demo.gif)

컬럼 하나를 바꿨을 때의 답을 양방향으로, 실제 오픈소스 프로젝트 두 곳에서 본
것입니다. 아래 정지 화면은 같은 뷰를 하나씩 다시 짚습니다.

Cascade 는 하나의 질문에 양방향으로 답합니다. **이 DB 컬럼을 바꾸면 어떤 SQL
statement, 서비스 메서드, HTTP 엔드포인트, 사용자 화면이 영향을 받는가. 그리고
이 화면을 열면 결국 어떤 컬럼에 도달하는가.** 답은 MCP 로 나가므로 AI 코딩
에이전트가 코드를 고치기 전에 물어볼 수 있고, 같은 답을 로컬 뷰어에 그려 주므로
사람이 직접 읽을 수도 있습니다.

모든 엣지는 자기 등급을 답니다. 그래서 답은 그것을 어디까지 믿어도 되는지
정확히 말해 줍니다. 무엇이 증명됐고, 무엇이 타당한 후보 집합이고, 무엇이
힌트인지. AI 에이전트는 그 등급을 읽고 이 답에 바로 손대도 되는지 아니면 먼저
확인해야 하는지 압니다. 스스로 코드를 고치는 도구에게 영향도 그래프를 안심하고
넘길 수 있게 하는 게 바로 이 지점입니다. 파서가 볼 수 없는 것은 지어내지 않고
없다고 표시합니다. 런타임 와이어링, 리플렉션, AOP 프록시가 그렇습니다. 이
보정(calibration)이 곁다리가 아니라 제품 그 자체입니다.

### 어디에 쓰는가

SAST 와 CodeQL 은 취약점을 찾습니다. Cascade 는 변경이 어디까지 닿는지를, 화면
에서 DB 컬럼까지의 왕복을 찾습니다. 그것도 모든 엣지에 등급을 달고, 빌드 한 번
없이 소스만 읽어서 답합니다. 어떤 SAST 나 의존성 스캐너도 그 왕복을 답하지
않습니다. 소스만으로 호출이 확정되지 않는 곳은 엣지를 지어내는 대신 그렇다고
표시합니다. 보정할 수 있는 답이라야 에이전트가 손댈 수 있는 답이고, 그것이
핵심이기 때문입니다.

## 무엇에 답하는가

질문 여섯 개와 각각에 답하는 도구입니다. 전체 목록은 `tools/list` 가 알려 주며,
아래 여섯 개가 먼저 익힐 값어치가 있는 것들입니다.

| 질문 | 도구 |
|---|---|
| 이 컬럼을 바꾸려고 합니다. 어떤 HTTP 엔드포인트가 영향을 받습니까? | `endpoint_impact` |
| 그 컬럼이 프런트엔드의 호출을 타고 어떤 **화면**까지 닿습니까? | `screen_impact` |
| 어떤 SQL statement 가 그 컬럼을 읽거나 씁니까? 그중 쓰는 것은 무엇입니까? | `column_impact` |
| 이 엔드포인트를 부르거나 이 화면을 열면 어떤 코드를 지나 어떤 테이블에서 끝납니까? | `flow` |
| 파일을 고쳤고 아직 커밋하지 않았습니다. 지금 시점의 영향 범위는 어디까지입니까? | `changed_impact` |
| 서로 호출하지 않으면서 DB 를 통해 데이터를 공유하는 API 그룹 쌍은 어디입니까? | `coupling` |

## 지원하는 스택

| 스택 | 무엇을 읽는가 | 등급 상한 | 읽지 않는 것 |
|---|---|---|---|
| Java Spring MVC 컨트롤러 | `@RestController` / `@Controller` 의 매핑 애너테이션을 JDK 자체 컴파일러의 파싱 전용 모드로 읽습니다. Gradle 도 Maven 도 의존성 classpath 도 쓰지 않습니다 | 구체 컨트롤러 메서드의 매핑은 `EXACT`, 인터페이스 선언의 매핑을 구현체가 서빙하는 경우는 `SOUND_SET` | 런타임에 조립되는 컨트롤러, 프로그램적으로 등록되는 핸들러 |
| MyBatis XML 과 애너테이션 | `<mapper namespace>` 파일, 전역 fragment 인덱스로 해석되는 `<include refid>`, 그리고 `@Select` / `@Insert` / `@Update` / `@Delete` 안에 쓰인 SQL | `EXACT`. statement id 는 매퍼 인터페이스 FQN 과 메서드 이름 그 자체이기 때문입니다 | `${}` 치환. 추측하지 않고 진단으로 기록합니다 |
| MyBatis-Plus | `@TableName`, `@TableField`, `@TableId`, `@TableLogic`, `BaseMapper` / `IService` / `ServiceImpl` 의 빌트인, 그리고 condition wrapper 가 들고 있는 메서드 레퍼런스와 리터럴 | 소스가 테이블이나 컬럼 이름을 직접 쓴 경우 `EXACT`, 네이밍 규칙을 가정해야 했던 경우 `HEURISTIC` | 조건이 HTTP 쿼리 스트링에서 오는 wrapper. 테이블은 사실로 남기고 컬럼은 런타임 결정으로 표시합니다 |
| JPA 와 Spring Data | `@Entity`, `@Table`, `@Column`, `@Id`, `@JoinColumn`, `@JoinTable`, `@MappedSuperclass`, 파생 쿼리 메서드 이름, JPQL `@Query`, SQL 분석기를 거치는 네이티브 `@Query`, 그리고 호출자가 실제로 도달한 리포지터리 빌트인 | 매핑이 이름을 직접 쓰거나 `jpa.namingStrategy` 가 선언된 경우 `EXACT`, 전략을 가정한 경우 `HEURISTIC` | `@Embedded`, `@SecondaryTable`, `@Inheritance`, `@AttributeOverride`, `@Convert`, `@ElementCollection`, named query |
| SQL DDL 카탈로그 | `CREATE TABLE` 과 `ALTER TABLE` 의 타입, null 허용 여부, 기본키, 주석을 방언별로 읽습니다. MySQL 과 MariaDB, PostgreSQL, Oracle, 그리고 ANSI 파서를 쓰는 H2 와 HSQLDB. 방언마다 식별자 대소문자 규칙이 따로 있습니다 | `EXACT` | 이 엔진이 라우팅할 수 없는 방언. MySQL 로 간주하지 않고 거부합니다 |
| 라이브 카탈로그 fetch | 읽기 전용 커넥션 하나로 테이블, 컬럼, 주석, 기본키를 읽어 스냅샷으로 고정합니다 | `EXACT` | 메타데이터 이외의 모든 것. 테이블 데이터는 절대 select 하지 않고, 분석 자체는 DB 에 접속하지 않습니다 |
| 프런트엔드 | `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx` 와 `.vue` 단일 파일 컴포넌트의 `<script>` 블록. `axios`, `fetch`, `XMLHttpRequest` 와 프로젝트가 직접 만든 래퍼를 실제로 요청을 보내는 지점까지 추적합니다. `vue-router` 와 `react-router` 선언은 화면으로 합성되고, OpenAPI 3 과 Swagger 2 문서는 선언된 라우트로, HAR 기록은 런타임 증거로 읽습니다 | 요청을 보내는 클라이언트까지 추적된 호출은 `SOUND_SET`, 라우트가 선언한 파일로 가는 `RENDERS` 엣지는 `EXACT` | import 된 컴포넌트의 어느 함수가 실제로 실행되는지. 이것은 런타임 질문이므로 `SOUND_SET` 에 머무릅니다 |

**지원하지 않는 것, 그리고 엔진이 추측 대신 그렇다고 말하는 것.** Kotlin
소스입니다. 레인이 없는 백엔드는 OpenAPI 문서를 발행하지 않는 한 지원하지
않으며, 발행한다면 라우트는 존재하되 그 아래로는 걸어 내려가지 않습니다.
Angular 와 Svelte 라우터, 런타임 와이어링, 리플렉션, AOP 프록시, GraphQL,
WebSocket, 그리고 소스가 직접 선언한 라우트를 넘어서 앱 구동 시 서버가 내려
주는 메뉴입니다.

## 설치

```bash
npm install -g @alexsoft-hq/cascade     # 명령 이름은 `cascade` 입니다
cascade doctor                          # 그 밖에 빠진 것이 있으면 말해 줍니다
```

설치 없이 바로 써 보려면 `npx @alexsoft-hq/cascade doctor` 입니다. 이 저장소를
클론해서 쓰신다면 같은 명령이 `node bin/cascade.mjs …` 이고, 이 문서의 나머지는
아직 아무것도 설치하지 않은 상태에서도 그대로 따라 할 수 있도록 그 형태로
적었습니다.

엔진 자체에는 **Node 20 이상**만 있으면 됩니다. 엔진과 서버에는 자체 npm
의존성이 없으므로 패키지 바깥에서 받아 오는 것이 없습니다.

Java 레인에는 **JDK 17 이상**이 필요합니다. 이 레인은 JDK 자체 컴파일러의 Tree
API 를 파싱 전용으로 쓰므로 `javac` 와 `java` 면 충분합니다.

```bash
brew install openjdk                          # macOS
export JAVA_HOME=/opt/homebrew/opt/openjdk
sudo apt-get install default-jdk              # Debian, Ubuntu
```

SQL 레인에는 **Python 3** 이 필요하고, 연결은 명령 하나로 끝납니다. `sqlglot`
버전은 설치 시점에 고르지 않고 requirements 파일에 고정되어 있습니다. 버전이
다르면 일부 statement 를 다르게 파싱해서 pack 다이제스트가 움직이기 때문에,
고정된 조합을 도구가 직접 설치하게 둡니다.

```bash
node bin/cascade.mjs setup
```

`python3` 을 찾아서 실행이 실제로 들여다보는 자리에 가상환경을 만들고, 고정된
requirements 를 설치한 뒤, 그 인터프리터로 `sqlglot` 을 직접 import 해서
확인합니다. 이미 `sqlglot` 이 들어 있는 인터프리터가 있다면 `CASCADE_PYTHON` 으로
가리키고 이 명령은 건너뛰면 됩니다.

웹 레인에는 **아무것도 필요하지 않습니다.** 파서가 `adapters/web/vendor/` 아래에
동봉되어 있어서, 프런트엔드를 읽는 데 설치도 네트워크 호출도 없습니다.

그다음에는 도구에게 무엇이 빠졌는지 물어봅니다.

```bash
node bin/cascade.mjs doctor
```

```
ok      node >= 20                                      v24.20.0
ok      git                                             git version 2.50.1 (Apple Git-155)
ok      python venv (SQL lane)                          .venv/bin/python: Python 3.9.6
ok      sqlglot importable (SQL lane)                   sqlglot 30.17.0
ok      JDK 17+ (java lane)                             javac 26.0.2.1 via homebrew keg (arm64)
ok      web lane parser (vendored)                      adapters/web/vendor/babel-parser.cjs loads and parses
missing mysql driver (optional, catalog fetch)          ModuleNotFoundError: No module named 'pymysql'
                                                        -> .venv/bin/pip install pymysql. This is only needed for `cascade catalog fetch` against mysql
missing postgres driver (optional, catalog fetch)       ModuleNotFoundError: No module named 'psycopg'
                                                        -> .venv/bin/pip install psycopg[binary]. This is only needed for `cascade catalog fetch` against postgres
missing oracle driver (optional, catalog fetch)         ModuleNotFoundError: No module named 'oracledb'
                                                        -> .venv/bin/pip install oracledb. This is only needed for `cascade catalog fetch` against oracle
ok      docker (optional, live-catalog container test)  server 29.7.2
ok      project registry readable                       ~/.cascade/registry.json: 12 project(s)
ok      cache directory writable                        ~/.cache/cascade/doctor-probe

all 7 required prerequisite(s) ok (9 ok, 0 warn, 3 missing)
```

`doctor` 는 **필수** 항목이 전부 ok 일 때만 0 으로 끝납니다. DB 드라이버 세 개와
Docker 는 선택 항목이라 보고만 하고 실패시키지 않습니다. 분석 경로는 DB 에
접속하지 않으므로, 드라이버가 없으면 `cascade catalog fetch` 만 못 쓸 뿐입니다.

이 문서의 모든 출력 발췌에 공통으로 적용되는 편집 규칙이 하나 있습니다. 엔진이
출력한 절대 경로는 여러분이 직접 입력하게 될 상대 경로나 `~` 로 시작하는
형태로 바꿔 적었습니다. 그 밖에는 어떤 발췌도 손대지 않았습니다.

## 내 프로젝트에 10분

아래 실행이 이 문서의 모든 숫자를 만들어 낸 그 실행입니다. 커밋 `0504e86b` 의
[macrozheng/mall](https://github.com/macrozheng/mall)(Apache-2.0, Spring Boot 에
MyBatis XML 매퍼, 저장소 안에 MySQL 덤프)과 커밋 `81fc17e5` 의 Vue 관리자
프런트엔드 [macrozheng/mall-admin-web](https://github.com/macrozheng/mall-admin-web)
을 읽었습니다. 같은 명령을 여러분의 트리에 겨누면 됩니다.

```bash
git clone https://github.com/macrozheng/mall ../target-examples/mall
git clone https://github.com/macrozheng/mall-admin-web ../target-examples/mall-admin-web
```

### 1. `init`: 이 트리에 무엇이 있는가

```bash
node bin/cascade.mjs init --root ../target-examples/mall --project mall
```

```
project mall at ../target-examples/mall
repositories (1): .@0504e86b
files scanned 717: 524 java (48 spring handlers, 0 JPA entities), 104 mybatis mapper xml, 1 DDL, 0 kotlin, 0 frontend package.json
build tool maven; package prefixes [com.macro.mall]; lanes [sql,java]
wrote ../target-examples/mall/.cascade/manifest.json
wrote ../target-examples/mall/.cascade/profile.json
registered mall -> ../target-examples/mall/.cascade in ~/.cascade/registry.json
diagnostics: none
```

세 가지를 쓰고 그 이상은 쓰지 않습니다. `manifest.json`(저장소마다 전체 커밋
해시로 핀 고정), `profile.json`(읽기 규약이며 직접 편집할 수 있습니다), 그리고
`pack/` 과 `catalog/` 를 무시하는 `.cascade/.gitignore` 입니다. 뒤의 두
디렉터리에는 여러분의 SQL 텍스트와 컬럼 주석이 들어가기 때문입니다. 여기에 홈
레지스트리에 한 줄이 추가되므로, 이후 명령에서는 경로 대신 `--project mall` 로
부를 수 있습니다.

엔진에 레인이 없는 기술은 조용히 건너뛰지 않고 `UNSUPPORTED_TECHNOLOGY` 진단으로
돌아옵니다. 두 번째 실행은 `--force` 를 주지 않는 한 여러분의 편집을 보존하고,
`--json` 은 발견 보고서 전체를 출력합니다.

### 2. `analyze`: 레인들, 그리고 내용 주소 기반 pack 하나

레인 플래그를 주지 않으면 입력은 프로젝트 자신에게서 옵니다. DDL 은
프로파일에서, 매퍼 디렉터리와 Java 소스 루트는 발견 결과에서 옵니다. 실행은 어느
레인이 무엇을, 어디에서 받았는지 출력합니다.

```bash
node bin/cascade.mjs analyze --root ../target-examples/mall
```

```
lanes [sql,java]: ddl 1 file(s) (profile): ../target-examples/mall/document/sql/mall.sql; mappers 4 dir(s) (discovery); java-src 7 root(s) (discovery; 4 test root(s) excluded (the standard src/test layout; pass --java-src to include): mall-admin/src/test, mall-demo/src/test/java, mall-portal/src/test/java, mall-search/src/test/java); web none; openapi none; har none
SQL lane: lineage (dialect mysql, identifiers fold-lower) over 904 statement(s)…
Java lane: 246 endpoints, 9876 calls, 251 dispatch, 904 stmt-bindings (358 unresolved, 439 external, 0 mapper method(s) with no statement in this pack)
wrote ../target-examples/mall/.cascade/pack/pack.json: 12674 nodes, 19269 edges, lanes [sql,java], digest 99141d55e969
axes: catalog=shipped statements=shipped jpa=not-shipped mybatisPlus=not-shipped column=shipped code=shipped web=not-shipped screen=not-shipped
cold (no previous facts-index.json beside the pack, so there is nothing to reuse): parsed 519 java file(s), 904 lineage shard(s) over 906 statement(s), pack digest 99141d55e969
```

읽어야 할 것은 **lane 줄**입니다. 모든 입력과 그 출처, 그리고 무엇이 빠졌는지를
이름으로 말합니다. 여기서는 플래그 없는 실행이 읽지 않는 `src/test` 루트 네
개입니다. 그 아래 **axes 줄**은 누가 질문하기도 전에 이 pack 이 축별로 무엇에
답할 수 있는지 스스로 선언한 것입니다.

mall 의 프런트엔드는 별도 저장소에 있으므로 플래그 하나로 붙입니다.

```bash
node bin/cascade.mjs analyze --root ../target-examples/mall \
  --web-src ../target-examples/mall-admin-web/src
```

```
Web lane: 128 file(s) (83 .vue, 45 .ts/.tsx, 0 .js/.jsx), 0 parse error(s); 155 call site(s) carry a URL (89 literal, 59 template, 2 constant, 5 unresolved), 54 route declaration(s), 1 alias(es), 0 proxy rule(s)
Web lane: 153 call site(s), 145 resolved (145 sound, 0 heuristic), 8 unresolved (expression 4, noMatch 3, parameter 1), 3 outside-pack; prefix ../mall-admin-web: (none) (derived)
Web lane: 54 screen(s) from 54 route declaration(s), 54 with a component (0 unresolved), 121 exact and 64 candidate RENDERS edge(s); 301 frontend function node(s) (148 send a request, 153 lead to one), 174 CALLS edge(s) (174 exact, 0 sound, 0 heuristic; 0 of them a function handed over as a value)
wrote ../target-examples/mall/.cascade/pack/pack.json: 13032 nodes, 19797 edges, lanes [sql,java,web], digest 7994e1a5fd22
axes: catalog=shipped statements=shipped jpa=not-shipped mybatisPlus=not-shipped column=shipped code=shipped web=shipped screen=shipped
```

레인을 추가하니 pack 이 넓어졌고, 처음에는 비율 하나가 움직였다는 이유로 보정
게이트가 이 실행을 막았습니다. 실제 거부 출력과 유일한 우회 방법은 아래
[정직성, verify, doctor](#정직성-verify-doctor) 에 있습니다.

두 번째 `analyze` 는 바뀌지 않은 것을 재사용합니다. 아무것도 고치지 않은
상태에서는 이렇습니다.

```
incremental: reparsed 0 java files (519 reused, 0 dropped), reparsed 0 web file(s) (127 reused, 0 dropped), lineage recomputed 0 statements (904 reused), mapper statements reused, catalog reused, pack digest 7994e1a5fd22
```

다이제스트가 cold 실행과 같습니다. 그것이 요점입니다. 증분 pack 은 같은 상태의
cold pack 과 바이트 단위로 같아야 하고, 무작위로 변형한 프로젝트를 상대로 그것을
지키는 테스트가 있습니다.

### 3. `estimate`: 무엇에 답할 수 있고 무엇에 답할 수 없는가

```bash
node bin/cascade.mjs estimate --root ../target-examples/mall
```

```
MEASURED. What the pack that exists actually answers:
  pack 7994e1a5fd22 built 2026-09-06T19:32:15.901Z lanes [sql,java,web]
  statementsWithColumnFacts       753 / 906    83.1%
  statementsWithStringSubst       396 / 906    43.7%
  endpointsReachingAStatement     205 / 242    84.7%
  webCallsResolved                145 / 153    94.8%
  mapperMethodsBound              904 / 904    100.0%
  callsResolved                  9437 / 10234  92.2%
  exactAnswerable                 509 / 906    56.2%
```

분석 **전에** 실행하면 발견 결과만으로 답합니다. 이 트리가 축별로 무엇을
shipped, degraded, not-shipped 로 내놓을지, 각 줄에 이유까지 붙여서 알려 줍니다.
분석 후에 실행하면 위의 측정된 절반이 더해집니다.

### 4. `view`: 직접 눈으로 봅니다

```bash
node bin/cascade.mjs view --project mall
```

```
cascade viewer at http://127.0.0.1:4319/  serving 1 project(s) [mall], budget 512 MB of pack JSON
```

화면 설명은 아래 [뷰어](#뷰어) 에 있습니다.

### 5. `mcp`: 에이전트에게 내보냅니다

```bash
node bin/cascade.mjs mcp --project mall
```

```
cascade mcp: serving 1 project(s) [mall]: packs load on first use, budget 512 MB of pack JSON
```

stdio 위에서 JSON-RPC 를 말하는 평범한 MCP 서버입니다. `initialize`, `tools/list`,
`tools/call` 순서로 씁니다. 다음 절에서 클라이언트에 연결합니다.

## AI 에이전트에 연결하기

```bash
cascade agent --write                     # Claude Code: .mcp.json + CLAUDE.md
cascade agent --client cursor --write     # Cursor: .cursor/mcp.json + 규칙 파일
```

프로젝트 안에서 실행합니다. 두 가지를 씁니다. 하나는 MCP 서버 설정이고, 절대
경로와 프로젝트 id 는 레지스트리에서 읽어 채웁니다. 다른 하나는 짧은 블록이고,
**언제 물어야 하는지**(매퍼, 엔티티, 컨트롤러, 화면을 고치기 전), 무엇으로 물어야
하는지, 돌아온 답의 `trust` 와 `limits` 와 등급을 어떻게 읽어야 하는지를
에이전트에게 알려 줍니다. 사람들이 빠뜨리는 쪽이 이 블록이고, 값어치가 걸린
쪽도 이 블록입니다. 규칙 없이 붙어만 있는 서버는 모델이 부르지 않는 서버입니다.
지금 물어야 할 때라고 말해 주는 것이 문맥에 하나도 없기 때문입니다.

블록은 `CLAUDE.md`(Codex 는 `AGENTS.md`) 안에 마커 두 줄 사이로 들어갑니다.
그래서 다시 실행해도 그 자리에서 교체되고 주변에 쓴 여러분의 글은 그대로
남습니다. `--write` 를 빼면 쓸 파일을 출력만 하고 아무것도 쓰지 않습니다.
그다음 Claude Code 에서는 승인이 한 번 필요합니다. 프로젝트 `.mcp.json` 으로
들어온 서버는 그 디렉터리에서 `claude` 를 한 번 실행하고 `cascade` 를 승인하기
전까지 *Pending approval* 상태로 있습니다.

### 손으로 직접 하고 싶다면, 이 명령이 쓰는 것들

아래 설정은 모두 같은 명령을 실행합니다. `node <path>/bin/cascade.mjs mcp
--project <id>` 입니다. `bin/cascade.mjs` 는 반드시 절대 경로로 적습니다. MCP
클라이언트는 여러분이 통제하지 않는 작업 디렉터리에서 서버를 띄우기 때문입니다.

**Claude Code**, 셸에서 실행합니다.

```bash
claude mcp add cascade -- node /path/to/cascade/bin/cascade.mjs mcp --project mall
```

**Claude Desktop**, `claude_desktop_config.json` 에 적습니다.

```jsonc
{
  "mcpServers": {
    "cascade": {
      "command": "node",
      "args": ["/path/to/cascade/bin/cascade.mjs", "mcp", "--project", "mall"]
    }
  }
}
```

`--project mall` 을 빼면 레지스트리에 등록된 모든 프로젝트를 서빙하고, 그때는
각 도구가 `project` 인자를 받습니다. 여러 개를 지정하면 딱 그것들만 서빙합니다.

Cursor 와 일반 stdio 클라이언트도 같은 세 필드를 씁니다. 클라이언트별 전체
설정과 서버가 실패했다고 나올 때 확인할 항목은
[`docs/ko/setup/agents.md`](docs/ko/setup/agents.md) 에 있습니다.

### 실제 세션 하나

할인 필드를 추가하라는 요청을 받은 에이전트는 먼저 이 pack 이 무엇인지부터 묻고
좁혀 갑니다. 아래는 위 실행에서 나온 실제 답이며, 지금 이야기하는 필드만 남기고
줄였습니다.

**1. 여기 무엇이 있습니까?**

```jsonc
{"name": "overview", "arguments": {}}
```

```jsonc
{ "answer": {
    "pack": { "project": "mall", "digest": "7994e1a5fd22", "lanes": ["sql", "java", "web"] },
    "nodes": [ {"kind": "symbol", "count": 11085}, {"kind": "statement", "count": 906},
               {"kind": "column", "count": 669}, {"kind": "endpoint", "count": 242},
               {"kind": "table", "count": 76}, {"kind": "screen", "count": 54} ],
    "reach": { "endpoints": 239, "statementsReached": 208, "tablesReached": 49,
               "columnsReached": 461, "endpointsWithoutStatement": 34 } },
  "basis": { "project": "mall", "buildDigest": "7994e1a5fd22",
             "builtAt": "2026-09-06T19:32:15.901Z", "freshness": { "verdict": "unknown" } },
  "trust": { "trustLevel": "UNCERTIFIED", "axes": ["overview"],
             "knownGaps": ["no-project-golden", "jpa-axis-not-shipped", "mybatisPlus-axis-not-shipped"] },
  "limits": [ { "scope": "axis:jpa",
                "reason": "the jpa axis of this pack is not-shipped: the JPA bridge did not run, because there is no Java lane or the profile declares no jpa pack. Persistence declared by @Entity or Spring Data is absent, not empty" } ],
  "truncated": { "any": true, "fields": [ { "field": "nodes", "shown": 6, "total": 6, "nextOffset": null } ] } }
```

위쪽의 답보다 아래쪽의 네 필드를 먼저 읽어야 합니다. 그 답을 쓸 수 있게 만드는
것이 그 네 필드이기 때문입니다.

- **`basis`** 는 이 답이 무엇에 매여 있는지입니다. 어느 프로젝트, 어느 pack
  다이제스트, 언제 만들어졌는지, 그리고 `current`, `behind`,
  `provisional-overlay`, `unknown` 중 하나의 최신성 판정입니다. `unknown` 은
  절대 `current` 로 읽히지 않습니다.
- **`trust`** 는 **계산된** 신뢰 수준이며 사람이 타이핑해 넣은 값이 아닙니다.
  여기의 `UNCERTIFIED` 는 이 프로젝트에 승인된 골든 코퍼스가 없다는 뜻이고,
  숨기지 않고 그렇게 말합니다. `knownGaps` 는 degraded 이거나 아예 만들어지지
  않은 축을 하나씩 이름으로 밝힙니다.
- **`limits`** 는 엔진이 보지 못한 것을, 범위를 붙인 문장으로 적은 것입니다. 위
  문장은 JPA 축이 비어 있는 것이 아니라 아예 없다는 뜻이며, 이는 "이 프로젝트는
  JPA 를 쓰지 않는다"와는 다른 주장입니다.
- **`truncated`** 는 목록별로 전체 몇 건 중 몇 건을 보여 주었는지, 어떤 순서로,
  어디서부터 이어 받을지를 말합니다. 잘린 목록이 스스로를 완전하다고 말하는
  사고를 막으려고 있는 필드입니다.

다섯 번째로 읽을 것이 하나 더 있는데, 빈 목록의 모양입니다. `empty` 는
`not-shipped`(축이 아예 만들어지지 않음), `degraded`(필요한 것 없이 만들어짐),
`none`(찾아봤고 없었음) 중 하나로 답합니다. 이 셋은 서로 다른 답이며 절대 `[]`
하나로 뭉개지지 않습니다.

**2. 어떤 statement 가 이 컬럼을 건드립니까?**

```jsonc
{"name": "column_impact", "arguments": {"column": "pms_product.price"}}
```

```jsonc
{ "column": "pms_product.price", "type": "DECIMAL(10, 2)",
  "statements": [ { "id": "com.macro.mall.mapper.PmsProductMapper.insert", "access": "write", "grade": "EXACT" },
                  { "id": "com.macro.mall.mapper.PmsProductMapper.updateByExample", "access": "write", "grade": "EXACT" } ] }
```

statement 18 개입니다. 8 개가 쓰고 10 개가 읽으며 전부 `EXACT` 입니다. 이 축이
exact 인 이유는 MyBatis statement id 가 매퍼 인터페이스에 메서드 이름을 붙인 것
**그 자체**이고, 컬럼 계보는 실제 카탈로그를 놓고 실제로 SQL 을 파싱해서 나온
것이기 때문입니다.

**3. 그것이 어떤 엔드포인트까지 닿습니까?**

```jsonc
{"name": "endpoint_impact", "arguments": {"column": "pms_product.price"}}
```

엔드포인트 27 개이고, 그중 12 개가 `/product/*` 아래, 나머지는 `/home/*`,
`/member/*`, `/brand/*`, `/esProduct/*`, `/cart/*`, `/productCategory/*`,
`/flashProductRelation/*` 에 흩어져 있습니다. 모든 행이 `EXACT` 가 아니라
`SOUND_SET` 이며, 그것이 정직한 등급입니다. 체인의 등급은 가장 약한 고리를
따르고, 파싱 전용 레인이 이름으로 해석한 호출은 진짜 대상이 반드시 그 안에 있는
후보 집합이지 증명이 아니기 때문입니다.

**4. 그러면 화면은 어디입니까?**

```jsonc
{"name": "screen_impact", "arguments": {"column": "pms_product.price"}}
```

```jsonc
{ "screen": "/pms/updateProduct", "grade": "SOUND_SET", "observed": false,
  "endpoints": ["GET /product/updateInfo/{id}", "POST /product/create",
                "POST /product/update/deleteStatus", "POST /product/update/{id}"] }
```

화면 12 개입니다. `observed` 는 브라우저 기록이 그 호출을 확인해 주었는지를
말하며, 여기의 `false` 는 기록을 주지 않았다는 뜻이지 그 호출이 일어나지 않는다는
뜻이 아닙니다.

**5. 이제 화면 하나에서 테이블까지 내려갑니다.**

```jsonc
{"name": "flow", "arguments": {"screen": "/pms/product", "direction": "down"}}
```

이 걷기는 레인 여섯 개를 지나 테이블에서 멈춥니다. 프런트엔드 함수 20 개, 그다음
엔드포인트 10 개, 서비스 메서드 35 개, 매퍼 statement 7 개, 테이블 5 개이며,
따라간 링크 79 개 중 38 개가 `EXACT`, 41 개가 `SOUND_SET` 입니다. 깊이 제한이나
모드 하한이 무언가를 잘랐다면 `walk.cut` 이 그것을 보고하므로, 짧은 답은 왜
짧은지를 말합니다.

## 편집 루프

파일을 고쳤고 아직 커밋하지 않았습니다. 무엇을 건드렸을 수 있는지 물어봅니다.

```bash
node bin/cascade.mjs impact --project mall --verbose
```

```
overlay 4ed662d103d9 (fresh): re-parsed 1 java + 0 frontend file(s), dropped 0, provisional 2 node(s) / 2 edge(s)
timings ms: load-base 27 + java 133 + web 39 + sql 31 + graph 81 = 311
  reused 645 cached java shard(s); dirty documents: mall-admin/src/main/java/com/macro/mall/controller/PmsProductController.java@0478df64
changed files: 1  (matched 1, unmatched 0)
touched: 10 symbols, 0 statements, 11 endpoints

upstream endpoints affected (11):
  GET /product/list  [EXACT]
  GET /product/priceCheck/{id}  [EXACT]  PROVISIONAL (only in the overlay)
  GET /product/simpleList  [EXACT]
  ...

downstream columns affected (88):
  ...

(provisional-overlay) provisional overlay: the dirty files were RE-PARSED and this answer describes the bytes on disk. Rows marked provisional exist only in the overlay (no certified run has seen them); nothing here is published and the pack digest is unchanged.
```

MCP 로 하는 같은 질문이 `changed_impact` 이고, 그 답은 같은 내용을 필드로
들고 옵니다.

```jsonc
{ "overlay": { "applied": true, "state": "fresh",
    "overlaySessionId": "4ed662d103d9ef080bd477fe9e5cde08c2222ac135497970bc66c4747c38be06",
    "baseCommit": "0504e86b…", "headCommit": "0504e86b…",
    "docVersions": { "mall-admin/…/PmsProductController.java": "0478df64…" },
    "provisionalIds": { "symbols": ["symbol:com.macro.mall.controller.PmsProductController#priceCheck"],
                        "endpoints": ["endpoint:GET /product/priceCheck/{id}"], "statements": [] },
    "timingsMs": { "loadBase": 25, "java": 132, "web": 40, "sql": 26, "build": 78, "total": 301 } },
  "basis": { "freshness": { "verdict": "provisional-overlay", "overlaySessionId": "4ed662d103d9…" } } }
```

**`provisional`** 은 등급이 아니라 표식입니다. 이 노드나 엣지가 오버레이에만
있고 인증된 실행이 한 번도 본 적이 없다는 뜻입니다. 등급 격자는 이 표식에
영향받지 않습니다. 위의 새 엔드포인트가 `EXACT` 인 것은 구체 컨트롤러 메서드의
매핑 애너테이션이 그 핸들러 **그 자체**이기 때문이고, 동시에 `PROVISIONAL` 인
것은 인증된 그 무엇도 아직 그 메서드를 본 적이 없기 때문입니다.

**`overlaySessionId`** 는 이 오버레이의 sha256 신원입니다. 베이스 커밋에 더러운
문서 각각의 sha256 을 더한 값입니다. 세션 id 가 같은 두 답은 디스크의 같은
바이트를 설명합니다. 다르면 1 초 차이여도 다른 바이트이므로, 답을 캐시하는
에이전트는 이 값을 키로 삼아야 합니다.

**`behind`** 는 커밋한 뒤에 받게 되는 답입니다. 오버레이는 움직여 버린 베이스
위에 얹히는 대신 폐기됩니다.

```
overlay NOT applied (stale-commit): the pack was built at 0504e86b1f1b but HEAD is now 9477dd387ecc, so the overlay is discarded rather than laid onto a base that has moved
limit [overlay]: HEAD moved past the pack's base commit; the answer below is the BASE pack's, not the working tree's. Run `cascade analyze` (it is incremental) to certify the new commit
(behind) provisional: computed from the base pack (files as last analyzed). Edited regions may add or remove connections. Re-run `cascade analyze` for a certified result.
```

**1 초 규칙.** 이 루프는 편집과 다음 질문 사이의 틈에 들어가야만 쓸모가 있으므로
오버레이에는 1 초 예산이 있고, 위 실행은 519 개 파일의 백엔드와 128 개 파일의
프런트엔드를 상대로 그중 311 ms 를 썼습니다. 실행 중에는 아무것도 기록하지
않습니다. pack 도, 팩트 캐시도 쓰지 않습니다. 오버레이는 과대 근사할 수는 있어도
빠뜨릴 수는 **없으며**, 그것은 문서 속 약속이 아니라 같은 바이트를 전체
재분석한 결과와 비교하는 테스트입니다.

## 여러 프로젝트, 한 서버

`cascade init` 은 `~/.cascade/registry.json` 에 프로젝트당 한 줄을 씁니다. 그
파일에는 주소만 들어갑니다. `{id, dotCascadePath, source, stack,
lastCertifiedAt}` 이며, 분석 결과 자체는 프로젝트 자신의 `.cascade/` 밖으로
나가지 않습니다.

플래그가 없으면 `cascade mcp` 와 `cascade view` 는 등록된 모든 프로젝트를
서빙합니다.

```bash
node bin/cascade.mjs mcp                                 # every registered project
node bin/cascade.mjs mcp --project mall --project shop   # just these two
node bin/cascade.mjs mcp --pack .cascade/pack            # one pack directly
node bin/cascade.mjs mcp --memory-budget 256             # MB of pack JSON held
```

pack 은 **지연 로딩**됩니다. 서버를 띄우는 동작은 레지스트리만 읽습니다.

```jsonc
{"name": "projects", "arguments": {}}
```

```jsonc
{ "answer": {
    "projects": [ { "id": "jpetstore", "stack": ["sql", "java"], "loaded": false, "bytes": null },
                  { "id": "mall", "stack": ["sql", "java", "web"], "loaded": false, "bytes": null } ],
    "cache": { "loaded": 0, "bytes": 0, "budgetBytes": 536870912, "evictions": 0, "hits": 0, "misses": 0 } },
  "basis": { "project": "*", "scope": "server", "buildDigest": null } }
```

나머지 도구는 모두 선택적 `project` 인자를 받습니다. 서빙 중인 프로젝트가 하나면
이름을 대지 않아도 답합니다. 여럿인데 `project` 가 없으면 거부합니다.

```
error [ambiguous]: several projects are registered: jpetstore, mall. Pass "project"
```

"첫 번째 것을 고른다" 같은 폴백은 없습니다. 엉뚱한 프로젝트에 대해 자신 있게
답하는 것이야말로 이 도구가 막으려고 존재하는 실패이기 때문입니다.

**캐시 예산.** `--memory-budget <MB>` 는 메모리에 들고 있는 pack JSON 의 양을
제한하며 기본값은 512 MB, 축출은 LRU 입니다. 이 숫자는 힙 측정값이 아니라
대리값입니다. Node 는 살아 있는 객체 그래프의 크기를 가격 매길 수 없고, 진짜
크기를 재려면 예산이 거부해야 할 pack 을 먼저 적재해야 하기 때문입니다. 독립적인
두 도구가 측정한 상주 그래프 대 대리값 비율과, 여러분의 pack 에서 다시 재 볼 수
있는 스크립트 두 개는 [`docs/mcp.md`](docs/mcp.md#the-memory-budget) 에 있습니다.
예산에 **혼자서도** 들어가지 않는 pack 은 반쯤 적재되는 대신 두 숫자를 다 밝히며
거부됩니다.

뷰어 헤더에도 같은 집합을 고르는 프로젝트 선택기가 있고, 선택은 URL 해시에
실립니다.

## 정직성, verify, doctor

### 등급 격자

모든 엣지는 다섯 등급 중 하나를 달고 있으며, 격자를 **거슬러 올라가는** 일은
절대 없습니다.

| 등급 | 뜻 | 예 |
|---|---|---|
| `EXACT` | 구문과 심벌과 상수로 유일하게 증명됨 | MyBatis statement id. 매퍼 인터페이스에 메서드를 붙인 것 그 자체입니다 |
| `SOUND_SET` | 진짜 대상이 반드시 그 안에 있는 보수적 후보 집합 | 인터페이스 디스패치 뒤의 구현체들 |
| `HEURISTIC` | 프로젝트 관행으로 보아 그럴듯함, 또는 복구된 부분 바인딩 | 네이밍 전략 선언 없이 필드 이름에서 유도한 컬럼 이름 |
| `RUNTIME_ONLY` | 정적으로 결정 불가. 런타임 증거가 필요함 | 브라우저 기록에서 관측된 요청 |
| `UNRESOLVED` | 분석이 실패했거나 지원하지 않는 형태 | 해석은 되었지만 이 pack 의 어떤 라우트와도 맞지 않는 URL |

**원소가 하나인 후보 집합도 절대 `EXACT` 로 승격되지 않습니다.** 좁히는 것은
증명하는 것이 아닙니다. 격자는 `src/core/policy.mjs` 한 파일에서만 계산되고,
워커들은 등급이 아니라 증거를 내보냅니다. 걷기의 등급은 **가장 약한 고리**를
따르므로 `SOUND_SET` 홉이 하나만 있어도 체인 전체가 `SOUND_SET` 입니다. 질의
모드는 하한을 고릅니다. `strict` 는 확인된 엣지만, `conservative` 는 후보 호출을
더하고, `heuristic` 은 추측 규칙까지 허용합니다. `RUNTIME_ONLY` 는 셋 모두의
아래에 있으며, 그래서 기록된 호출은 보여 주기만 하고 절대 걷지 않습니다.

### 모든 답이 달고 다니는 네 필드

`basis`, `trust`, `limits`, `truncated` 이며 위의 세션에서 설명했습니다. 이
필드들은 응답을 만들 수 있는 유일한 파일에서 비공개 `Symbol` 로 도장이 찍히므로,
모양만 같은 객체는 직렬화 전에 거부됩니다. HTTP 위에서 그 거부는 200 이 아니라
500 `contract-violation` 입니다. 자세한 내용은
[`docs/ko/concepts.md`](docs/ko/concepts.md) 에 있습니다.

### `verify`

```bash
node bin/cascade.mjs verify --project mall
```

```
verified ../target-examples/mall/.cascade: 7 check(s) agreed: pack, fact index and gate state match the receipt, the running engine is the one that signed it, and it is valid until 2026-10-06T19:32:05.381Z
gate NO_CHANGE -> GREEN
```

영수증에 적힌 모든 다이제스트를 디스크의 파일에서 다시 계산하고, 지금 돌고 있는
엔진이 그 영수증에 서명한 그 엔진인지 확인하고, 만료된 영수증은 거부합니다.
하나라도 어긋나면 종료 코드 4 이며, 부분 통과는 없습니다.

### `doctor`

위 [설치](#설치) 에서 보였습니다. 빠진 준비물을 명령마다 하나씩 발견하는 대신 한
번의 보고서로 받기 위해 존재합니다.

### 보정: 모든 실행은 직전 인증 실행을 기준으로 판정됩니다

프로젝트마다 `.cascade/calibration/` 에 봉인된 기준선을 두고, 모든 `analyze` 를
그것과 비교합니다. 게이트는 먼저 이 실행이 **왜** 다른지를 묻습니다. `NO_SEAL`
(기준선이 아직 없어 이번 실행이 기준선이 됨), `NO_CHANGE`(같은 엔진, 같은 핀),
`ENGINE_MOVED`(엔진 업그레이드), `REPIN`(분석 대상 커밋이 이동), `BOTH_MOVED`
입니다.

아래는 게이트가 실제 실행을 거부한 장면입니다. 같은 트리, 같은 엔진에 웹 레인만
추가했습니다.

```
gate: NO_CHANGE -> RED - endpointsReachingAStatement dropped 1.28% (>0%)
  [error] endpointsReachingAStatement: same engine and same pin, but endpointsReachingAStatement moved from 85.8% (205/239) to 84.7% (205/242). Identical inputs must produce identical measurements
  [error] node:endpoint: same engine and same pin, but node:endpoint moved from 239 to 242
REJECTED: the pack was written to ../target-examples/mall/.cascade/pack-rejected/pack.json and the certified pack at ../target-examples/mall/.cascade/pack/pack.json was NOT touched
  a regression is not a new snapshot: fix it. If this drop is the intended new normal, re-run with `--accept-baseline`,
  which re-seals the baseline from THIS run. That is the only override, and it is a human decision.
```

이 출력은 게이트의 오작동이 아니라 정상 작동이므로 찬찬히 읽어야 합니다. 분자는
움직이지 않았습니다. 여전히 205 개 엔드포인트가 statement 에 닿습니다. 분모가
239 에서 242 로 커졌는데, 웹 레인이 프런트엔드가 호출하지만 이곳의 무엇도
서빙하지 않는 라우트 세 개를 찾아냈기 때문입니다. 그래서 나빠진 것이 없는데도
비율이 떨어졌습니다. 게이트는 절대값이 아니라 **비교** 기준이므로, 발견을 보고할
뿐 판단은 사람에게 넘깁니다.

```bash
node bin/cascade.mjs analyze --root <repo> --web-src <front/src> --accept-baseline
```

이 명령은 기준선을 **그 실행에서** 다시 봉인하므로, 내일의 비교 대상은 오늘이
됩니다. 우회 방법은 이것 하나뿐입니다. `RED` 실행이 조용히 버려지는 일도
없습니다. 그 pack 은 `<packDir>-rejected/` 로 가고, 인증된 pack 은 있던 자리에
그대로 남고, 명령은 종료 코드 3 으로 끝납니다.

게이트 옆에서 `cascade golden` 이 프로젝트 자신의 라벨링된 코퍼스를 관리합니다.
도구는 사례를 **제안**하고 **사람**이 승인하며, 해시가 어느 것을 홀드아웃으로
뺄지 정하고, `check` 가 승인된 사례를 실제 배포되는 MCP 도구를 통해 채점합니다.
도구가 스스로를 승인하는 일은 없으며, 그래서 모든 답에 붙는 신뢰 수준이 의미를
가질 수 있습니다.

### 없는 축은 치명적 오류가 아니라 선언입니다

모든 레인 입력은 선택 사항이고, 모든 레인은 이름으로 끌 수 있습니다.
`--no-ddl`, `--no-mappers`, `--no-java`, `--no-web`, `--no-openapi` 입니다.
그래도 실행은 유효한 pack 을 만들고, pack 은 축별로 `meta.axes` 를 기록합니다.
아래는 DB 카탈로그 없이 돌린 mall 입니다.

```bash
node bin/cascade.mjs analyze --root ../target-examples/mall --no-ddl \
  --out ../mall-no-ddl-pack
```

```
{"code":"summary","columnFacts":1248,"defaultSchema":null,"diagnostics":2,"dialect":"mysql","identifierCase":"fold-lower","identifierCollisions":0,"joinFacts":0,"level":"info","statements":904,"tableFacts":948,"unresolvedColumns":5135,"unresolvedJoins":46,"unresolvedRate":0.8045,"version":"lineage/2"}
wrote ../mall-no-ddl-pack/pack.json: 12598 nodes, 13479 edges, lanes [sql,java], digest f0ba9c2b4d78
axes: catalog=not-shipped statements=shipped jpa=not-shipped mybatisPlus=not-shipped column=degraded code=shipped web=not-shipped screen=not-shipped
```

컬럼 팩트가 6342 에서 1248 로 떨어지고, 해석하지 못한 컬럼 참조가 396 에서
5135 로 올라갑니다. 답을 깔끔해 보이게 하려고 버리는 것은 없습니다. 카탈로그
없이는 귀속할 수 없는 것을 unresolved 로 기록하고, `column` 축이 스스로
`degraded` 를 선언하며, 그 선언이 모든 답의 `trust.knownGaps` 에 실리고, 그때부터
빈 목록은 `none` 이 아니라 `degraded` 라고 말합니다.

## 뷰어

`cascade view` 는 MCP 서버가 쓰는 바로 그 도구 카탈로그 위에서 로컬 웹 앱
하나를 띄웁니다. 이 페이지는 질의를 다시 구현하지 않습니다. 화면의 모든 숫자는
엔진이 계약을 지켜 만든 답으로 도착하므로, 이 페이지와 MCP 로 묻는 모델이 서로
다른 이야기를 들을 수 없습니다. `127.0.0.1` 에만 바인딩하고 인증은 하지
않는데, 다른 데서 닿을 물건이 아니기 때문입니다.

머리글에는 데이트라인(어느 프로젝트가 답했는지, 다이제스트, 어떤 레인이 돌았는지,
어느 커밋으로 만들었는지), 단계마다 개수가 붙은 체인, 최신성과 신뢰도와 한계
개수를 나타내는 칩 세 개, 프로젝트 선택기, 언어 토글, 테마 토글이 있습니다. 테마
두 개는 하나의 토큰 위에 놓여 있습니다. **어둡게**는 신호실이며 기본값이고,
**밝게**는 흑백으로 인쇄해도 읽히는 도면입니다.

### Overview

![밝은 테마의 Overview 탭. 같은 다섯 개 다이얼과 프로젝트 전체 지도가 종이 위의
잉크처럼 그려져 있습니다](docs/assets/screens/overview-light.png)

상단의 다이얼 다섯 개는 `overview` 답의 `reach` 필드에서 그대로 옵니다. 몇 개의
엔드포인트가 SQL 에 닿는지, 몇 개의 statement 와 테이블과 컬럼이 닿았는지, 몇
개의 화면이 테이블에 닿는지입니다. 각 숫자 아래에는 그 단계의 용어로 무엇이
빠졌는지가 적혀 있습니다. 비율은 나머지와 나란히 놓일 때만 뜻이 있기
때문입니다. 그 옆은 살아 있는 전체 지도이며, 한 번만 물어 Graph 탭과
공유합니다. 그 아래로 캐스케이드 리본, pack 안에 무엇이 있는지, 타입과 등급별
엣지, 허브 테이블과 엔드포인트, 그리고 엔진이 못 본 것을 모은 패널이 있습니다.

### Explore

![Explore 탭의 화면 카드. 마운트하는 컴포넌트 파일, 그 화면이 실행하는
프런트엔드 함수 14 개, 그 함수들이 닿는 API 라우트 7
개](docs/assets/screens/explore-screen-card.png)

테이블, 컬럼, statement, 엔드포인트, 메서드, 화면 중 하나를 골라 무엇을 건드리는지
봅니다. 위 카드는 화면입니다. 라우트가 선언한 `.vue` 파일, 그 위의 함수들이
`leads to` 인지 `sends` 인지, 그리고 그 함수들이 닿는 라우트가 등급과 함께 있습니다.
**My edits** 는 커밋하지 않은 변경에 대해 같은 질문을 던집니다.

### Flow

![Flow 탭. 왼쪽에 화면, 그다음 프런트엔드 함수, 엔드포인트, 서비스 메서드, 매퍼
statement 가 홉 이름이 붙은 열로 늘어서
있습니다](docs/assets/screens/flow-from-screen-ko.png)

호출 하나를 왼쪽에서 오른쪽으로 읽습니다. 진입점, 프런트엔드 함수, 엔드포인트, 그
엔드포인트가 지날 수 있는 서비스 메서드, 그것들이 닿는 매퍼 statement, 그리고
끝의 테이블입니다. 실선은 엔진이 증명할 수 있는 호출이고, 점선은 일어난다고
보지만 확인하지 못한 호출입니다. **by hop** 은 같은 행을 한 단계씩 묶어 홉마다
집계를 보여 줍니다.

### Impact

![Impact 탭. 왼쪽에 컬럼, 그다음 매퍼 statement, 서비스 메서드, 엔드포인트,
프런트엔드 함수를 거꾸로 걸어 올라갑니다](docs/assets/screens/impact-column.png)

같은 기계를 컬럼, 테이블, statement, 메서드에서 거꾸로 돌려 거기에 닿을 수 있는
엔드포인트와 화면까지 올라갑니다. 왼쪽 레일에서는 테이블마다 캐럿이 있어 그
테이블의 컬럼 목록으로 펼칠 수 있으므로, 테이블에서 바꾸려는 컬럼까지 걸어 내려갈
수 있습니다.

### Coupling

![Coupling 탭. API 그룹을 쓰는 쪽과 읽는 쪽으로 놓은 행렬이고 각 칸에 공유
컬럼 수가 들어 있으며, 옆에 결합된 쌍의 순위
목록이 있습니다](docs/assets/screens/coupling.png)

두 API 그룹은 서로 호출하지 않고도 서로에게 의존할 수 있습니다. 한쪽이 컬럼을
쓰고 다른 쪽이 그것을 읽습니다. 행렬은 그 쌍을 보여 줍니다. 세로가 쓰는 쪽,
가로가 읽는 쪽입니다. mall 에서는 32 개 그룹에 걸쳐 61 쌍, 결합된 컬럼 267 개,
한 그룹만 건드리는 컬럼 93 개입니다. 칸을 누르면 두 그룹이 공유하는 컬럼과 그것을
나르는 statement 가 나옵니다.

### Graph

![Graph 탭. 프로젝트 전체가 한 장의 지도이며, 가운데에 API 그룹이 있고 그 둘레에
엔드포인트와 그것들이 닿는 테이블이 있습니다](docs/assets/screens/graph-map.png)

pack 전체가 한 장의 그림입니다. 가만히 있을 때는 API 그룹과 테이블만 그리고,
그룹과 테이블을 잇는 선 하나가 그 그룹에서 그 테이블을 건드리는 모든
엔드포인트를 대표합니다. 그룹을 누르면 그 엔드포인트들이 위성처럼 펼쳐집니다.
노드 반지름은 차수의 제곱근을 따르고, 선 색은 엔드포인트가 테이블에 무엇을
하는지를, 두께는 몇 개의 statement 가 그것을 나르는지를 나타냅니다. 지도는 가만히
있을 때 움직이지 않습니다. 노드를 더블클릭하면 **Around \<node\>** 로 들어가서,
가운데에 그 노드, 링 1 에 그것에 닿는 것, 링 2 에 다시 그것들에 닿는 것을
봅니다.

### ERD

![ERD 탭. 매퍼 SQL 이 만드는 조인으로 배치한 스키마 전체와, 옆의 허브 테이블
순위](docs/assets/screens/erd.png)

스키마 전체를 매퍼 SQL 이 테이블 사이에 만드는 조인으로 배치합니다. 외래 키는
절대 읽지 않으므로, 여기의 관계는 어떤 statement 가 실제로 만드는 조인입니다.
mall 에서는 76 개 테이블에 27 개 관계가 있고 그중 32 개 테이블이 조인에
참여합니다. 나머지 44 개는 버려지지 않고 지도 아래 띠에 그렇게 이름 붙여
놓입니다.

### Transactions

![Transactions 탭. `@Transactional` 메서드마다 쓰기 수, 읽기 수, 커밋 하나가
건드릴 수 있는 테이블 수가 붙어 있습니다](docs/assets/screens/transactions.png)

모든 `@Transactional` 메서드와, 그것을 통해 커밋 하나가 건드릴 수 있는 범위입니다.
mall 에는 35 개가 있고 가장 큰 것은 15 개 테이블에 닿습니다.

### 소스 창

![Flow 탭 오른쪽에 붙은 소스 창. 디스크의 컴포넌트 파일을 파일 자신의 줄 번호와
함께 보여 주고 답이 가리키는 줄을 표시합니다](docs/assets/screens/source-pane.png)

그림이 주장이라면 소스는 증거입니다. 창 하나가 그것을 오른쪽 가장자리에 붙여
보여 주고, 주장을 담은 모든 행에서 그 창을 열 수 있습니다. 로컬 라우트로 디스크의
파일을 읽으므로 pack 에 구워 넣은 사본이 아니라 지금 그 자리에 있는 내용을
보여 줍니다. 파일 자신의 줄 번호를 달고, 답이 가리키는 줄을 표시하며, **Open in
editor** 는 그 파일과 줄을 VS Code 나 IntelliJ 로 넘깁니다.

### 브라우즈 레일

Explore, Flow, Impact 는 빈 검색창이 아니라 **목록**으로 열립니다. 그 탭이 보여
줄 수 있는 종류와 개수, 필터, 정렬, 그리고 고를 때 근거가 될 숫자가 붙은 행들이
있습니다. 모든 행은 하나의 `browse` 답이므로 페이지는 스스로 아무것도 세지
않습니다. 입력창에 치면 이미 들고 있는 행을 걸러 낼 뿐 요청을 보내지 않습니다.
`/` 는 필터로 커서를 옮기고, 방향키가 강조를 옮기고, Enter 가 고릅니다. 1100px
아래에서는 레일이 **Browse** 버튼 뒤의 서랍이 됩니다.

인터페이스 언어 토글은 **크롬만** 바꿉니다. 등급, 신뢰도, 한계, 빈 목록의 이유,
각 도구가 직접 쓴 메시지는 엔진이 쓴 그대로 남습니다. 번역된 등급은 이
프로젝트가 지어낸 등급이고, 어떤 독자도 그것을 엔진의 답과 대조할 수 없기
때문입니다.

전체 설명과 언어를 추가하는 방법은 [`docs/ko/viewer.md`](docs/ko/viewer.md) 에
있습니다.

## 프로파일과 프레임워크 팩

`cascade init` 이 `.cascade/profile.json` 을 쓰고, 그다음은 여러분이 편집합니다.
이것은 **읽기 규약**입니다. 파서가 스스로 알 수 없는 자리에서 이 프로젝트의 코드가
무엇을 뜻하는지 적어 두는 곳입니다. 이 파일의 모든 키는 CONSUMED(엔진의 동작을
바꿈)이거나, 설정하는 순간 RECORDED 되고 진단으로 알려집니다. 죽은 키는 없으며,
그것을 지키는 테스트가 있습니다.

```json
{
  "build": { "tool": "maven", "javaRelease": null, "profiles": [] },
  "packagePrefixes": ["com.macro.mall"],
  "schema": { "default": null, "propertyNames": [], "rewriteLayer": null },
  "sqlDialects": { "main": "mysql" },
  "sqlIdentifierCase": null,
  "gatewayRoutes": { "/dev-api": "" },
  "screenAxis": {
    "enabled": null,
    "nameSource": "route-meta",
    "pathRule": "last-segment",
    "codeRegex": "([A-Z]{2}\\d{4})"
  },
  "moduleAttribution": { "packageDepth": null, "codeLength": 2 },
  "frameworkPacks": ["spring-mvc", "mybatis-xml", "jpa", "mybatis-plus", "web", "vue-router", "react-router"],
  "jpa": { "namingStrategy": "spring-snake-case" },
  "mybatisPlus": { "namingStrategy": "underscore", "tablePrefix": null,
                   "logicDeleteValue": "1", "logicNotDeleteValue": "0" },
  "openapi": { "documents": ["api/openapi.yaml"] },
  "runtimeEvidence": { "har": ["evidence/admin-session.har"],
                       "otel": ["evidence/checkout-smoke.json"] },
  "catalog": { "source": "file", "connectionFrom": "../document/sql/mall.sql" },
  "calibration": { "firstRun": "bootstrap", "maxRelativeDrop": 0.05,
                   "maxRelativeDropOnRepin": 0.25, "receiptTtlDays": 30 }
}
```

**`frameworkPacks`** 가 레인을 켭니다. `spring-mvc` 는 매핑 애너테이션을,
`mybatis-xml` 은 매퍼 XML 을 읽고, `jpa` 는 엔티티와 리포지터리를 매핑하고,
`mybatis-plus` 는 제네릭 CRUD 와 condition wrapper 를 읽고, `web` 은 프런트엔드를
읽으며, `vue-router` 와 `react-router` 는 어떤 라우터 선언을 알아볼지 지정합니다.
`cascade init` 은 눈에 보이는 것을 써 줍니다. `@Entity` 파일이 있으면 `jpa`,
`extends BaseMapper<` 나 `@TableName` 이 있으면 `mybatis-plus`, Vue 나 React 에
의존하는 `package.json` 이 있으면 `web` 과 그 라우터입니다.

**`gatewayRoutes`** 는 **프런트엔드**가 쓰는 접두사를 **백엔드**가 서빙하는
접두사로 매핑합니다. `{"/dev-api": ""}` 는 개발 서버가 그것을 떼어 낸다는 뜻이고,
`"*"` 는 프로젝트의 모든 호출에 적용됩니다. 이것을 선언하면 `web` 축이
`degraded` 에서 `shipped` 로, 그 엣지들이 `HEURISTIC` 에서 `SOUND_SET` 으로
올라갑니다. 엔진이 더는 매칭 개수를 세어 접두사를 알아맞힐 필요가 없기
때문입니다.

**`screenAxis`** 는 라우터 선언을 화면으로 만들지 결정합니다. `enabled` 에는
세 가지 상태가 있습니다. `true` 와 `false` 는 여러분의 말이고 실행이 무엇을 읽든
그대로 따릅니다. 기본값인 `null` 은 이 실행이 실제로 읽는 것을 보고 결정하라는
뜻입니다. 그 세 번째 상태 덕분에 `--web-src ../front/src` 로 분석하는 백엔드가
아무 설정 없이도 화면을 만들 수 있습니다. `nameSource`, `pathRule`, `codeRegex`
는 라벨과 그룹핑만 바꾸고 경로는 건드리지 않습니다.

**`openapi.documents`** 는 선언된 라우트로 읽을 OpenAPI 3 또는 Swagger 2 문서를
지정합니다. 코드도 서빙하는 라우트는 교차 확인되고, 이곳의 무엇도 서빙하지 않는
라우트는 **핸들러 엣지 없이** 추가됩니다. 선언은 라우트가 있다는 말일 뿐 그 아래에
무엇이 도는지는 말하지 않기 때문입니다. 선언했지만 서빙하지 않는 것과 서빙하지만
선언하지 않은 것, 양쪽 드리프트를 모두 보고하고 어느 쪽도 판단하지 않습니다.

**`runtimeEvidence.har`** 는 브라우저 기록을 지정합니다. 그 안에서 이 pack 이
서빙하는 라우트와 맞는 요청은 `RUNTIME_ONLY` 등급의 `screen` 에서 `endpoint` 로
가는 엣지가 됩니다. 이 등급은 모든 모드의 하한 아래이므로 **보여 주기만 하고 절대
걷지 않으며**, 옆에 있는 정적 엣지의 등급을 올리지도 않습니다. 기록은 일부러
발견 대상에서 뺐습니다. 기록이란 의도적으로 만드는 것이고, 트리에 우연히 있다는
이유로 주워 오면 무관한 캡처가 이 pack 이 무엇을 관측했다고 주장할지를 정하게
되기 때문입니다.

**`runtimeEvidence.otel`** 은 OpenTelemetry 트레이스 익스포트(OTLP/JSON)를
지정합니다. 트레이스는 어느 **구체 구현**이 실제로 요청을 처리했고 어느 statement
를 돌렸는지를 말합니다. 소스를 아무리 읽어도 정할 수 없는 것이 그것입니다. mapper
인터페이스는 소스에 구현체가 아예 없고, 인터페이스 호출은 코드가 무엇을 말하든
후보 집합입니다. 확인된 홉은 등급을 그대로 유지한 채 옆에 `observed: true` 를
얻고, 관측되지 않은 후보는 있던 그대로 남으며, 어떤 정적 규칙으로도 설명되지 않는
홉은 보여 주기만 하고 걷지 않는 `RUNTIME_ONLY` 엣지가 됩니다. 아무것도 승격되지
않고, SQL 텍스트나 바인딩된 파라미터는 pack 에 들어가지 않으며, 발견 단계도
없습니다. 파일은 OTLP/JSON 문서여도 되고, OpenTelemetry Java 에이전트가
`logging-otlp` 로 남긴 애플리케이션 로그 그대로여도 됩니다. 그 에이전트가 호출자
스팬을 남기게 하려면 `otel.instrumentation.methods.include` 값이 먼저 필요한데,
그 줄은 `cascade otel-methods` 가 출력합니다. 실제 petclinic 실행에서 나온
숫자와 함께 정리한 전체 레시피는
[`docs/ko/setup/runtime-evidence.md`](docs/ko/setup/runtime-evidence.md) 에 있습니다.

레인별 상세는 [`docs/setup/sql-lane.md`](docs/setup/sql-lane.md),
[`docs/setup/java-lane.md`](docs/setup/java-lane.md),
[`docs/ko/setup/web-lane.md`](docs/ko/setup/web-lane.md),
[`docs/setup/db-catalog.md`](docs/setup/db-catalog.md),
[`docs/ko/setup/runtime-evidence.md`](docs/ko/setup/runtime-evidence.md) 에 있습니다.

## 무엇을 어떻게 측정했는가

기제는 셋이고, 명령까지 붙은 전체 기록과 **검증되지 않은 것**의 목록은
[`docs/measured.md`](docs/measured.md) 에 있습니다.

### 일반성 게이트

`scripts/generality-gate.mjs` 는 이 엔진을 고치지 않은 채, 아무 설정도 주지 않고,
이곳의 누구도 이 엔진을 겨냥해 쓰지 않은 실제 저장소들의 고정된 코퍼스 위에서
돌려 무엇에 닿았는지 출력합니다. `test/generality_gate.test.mjs` 가 그 결과를
`test/fixtures/generality-gate.baseline.json` 과 비교하고, **어떤 저장소든 전보다
적게 닿으면 실패**합니다. 올라간 값은 누군가 `--accept` 를 돌려 기준선을 다시
쓰고 그 차이를 출력하기 전까지 아무것도 바꾸지 않습니다. 조용히 좋아진 숫자는
아무도 확인하지 않은 숫자이기 때문입니다.

| 저장소 | statement 에 닿는 엔드포인트 | 닿은 테이블 | 닿은 컬럼 | 해석된 프런트엔드 호출 | 테이블에 닿는 화면 |
|---|---|---|---|---|---|
| jeecgboot/JeecgBoot | 744 / 969 | 73 / 177 | 836 / 2092 | 538 / 929 | 19 / 166 |
| jishenghua/JSH_ERP | 330 / 339 | 32 / 32 | 409 / 413 | 165 / 221 | 0 / 7 |
| apache/dolphinscheduler | 204 / 239 | 42 / 65 | 457 / 622 | 219 / 233 | 0 / 44 |
| macrozheng/mall (+ mall-admin-web) | 205 / 239 | 49 / 76 | 461 / 669 | 145 / 153 | 44 / 54 |
| linlinjava/litemall | 198 / 219 | 34 / 34 | 376 / 376 | 172 / 191 | 40 / 89 |
| yangzongzhuan/RuoYi-Vue (+ RuoYi-Vue3) | 123 / 147 | 22 / 33 | 224 / 305 | 122 / 142 | 8 / 21 |
| jeequan/jeepay | 126 / 134 | 22 / 23 | 302 / 314 | 프런트엔드를 읽지 않음 | 프런트엔드를 읽지 않음 |
| xuxueli/xxl-job | 31 / 42 | 7 / 8 | 70 / 71 | 프런트엔드를 읽지 않음 | 프런트엔드를 읽지 않음 |
| mybatis/jpetstore-6 | 11 / 22 | 12 / 13 | 77 / 86 | 프런트엔드를 읽지 않음 | 프런트엔드를 읽지 않음 |
| spring-projects/spring-petclinic | 9 / 17 | 4 / 7 | 18 / 24 | 프런트엔드를 읽지 않음 | 프런트엔드를 읽지 않음 |
| spring-petclinic-microservices | 13 / 15 | 5 / 7 | 20 / 24 | 프런트엔드를 읽지 않음 | 프런트엔드를 읽지 않음 |

```bash
node scripts/generality-gate.mjs --fetch     # clone every pin, then run
node scripts/generality-gate.mjs             # run over whatever is cloned
node scripts/generality-gate.mjs --accept    # rewrite the baseline, printing the diff
```

클론은 이 저장소 밖 캐시 디렉터리에 놓이고, 실행마다 자기 레지스트리를 따로
쓰므로 게이트가 여러분의 레지스트리에 쓰는 일은 없습니다. 숫자는 있는 그대로
읽어야 합니다. "239 개 중 204 개 엔드포인트가 statement 에 닿는다"는 엔진이
204 개의 체인을 이었다는 말이지, 나머지 35 개가 틀렸다는 말이 아닙니다.

### 골든

실제 프로젝트 두 개를 커밋에 고정해 두고 끝에서 끝까지 확인합니다.

- **mall**, MyBatis 와 Spring MVC 골든입니다. 엔드포인트 239 개, 매퍼 statement
  906 개, 테이블 76 개, 컬럼 669 개, 심벌 10784 개입니다. 새 절대 경로에 새로
  클론해서 문서에 적힌 무플래그 경로로 다시 만들어도 같은 pack 다이제스트가
  나오고, `pms_product.price` 는 쓰는 statement 8 개와 읽는 statement 10 개, 그리고
  엔드포인트 27 개에 닿습니다.
- **jpetstore-6**, HSQLDB 와 MyBatis 골든입니다. 테이블 13 개, 컬럼 86 개, 매퍼
  statement 25 개, 엔드포인트 22 개이며 그중 11 개가 statement 에 닿습니다.

```bash
node --test test/mall_demo.test.mjs
node --test test/jpetstore.test.mjs
node --test test/petclinic.test.mjs      # the JPA golden, spring-petclinic
```

이 테스트들은 픽스처가 없으면 **소리 내어** 건너뜁니다. 어떤 픽스처가 필요하고
어떤 명령이 그것을 만드는지 이름으로 말합니다. CI 는 셋 모두를 고정 커밋으로
클론하고, 그중 하나라도 건너뛰면 실패합니다. 새로 클론한 곳에서 영구히 자기를
생략하는 것은 통과가 아니라 결함이기 때문입니다.

### 증분 오라클

`test/incremental.test.mjs` 는 git 저장소 안에 Spring, MyBatis, MySQL 로 된 합성
프로젝트를 만들고, 매 라운드마다 시드가 고정된 PRNG 로 파일의 무작위 부분집합을
변형한 뒤, 증분 pack 이 cold pack 과 **바이트 단위로** 같기를 요구합니다. 재사용에
대한 정확성 주장은 문서 속 약속이 아니라 그 테스트입니다.

```bash
node --test test/incremental.test.mjs
node --test test/overlay_integration.test.mjs   # the overlay omits nothing a full re-analysis finds
```

## 저장소 구조

```
bin/cascade.mjs          the CLI: doctor | init | analyze | estimate | verify | golden |
                         catalog discover|fetch | pack | impact | mcp | view
src/core/                the pure engine, the project layer and the incremental core
src/mcp/                  the response contract, the query tools, the tool catalog, the stdio and
                         HTTP servers, and the multi-project host
src/adapters/            the lane-output to graph bridges
src/viewer/              the viewer's pure logic under test
adapters/sql/            Python workers: catalog_ddl, catalog_live, mybatis_extract, lineage
adapters/java/           the Java worker: JavaFacts, the parse-only javac Tree API pass
adapters/web/            the frontend worker (webfacts) and its declaration packs
viewer/index.html        the self-contained viewer page, served by `cascade view`
viewer/i18n/             one JSON catalogue per non-English interface language
viewer/vendor/           the two vendored MIT browser bundles every graph picture renders with
scripts/                 generality-gate.mjs, the memory measurements, the java smoke check, the DCO check
test/                    the suite: goldens, the incremental oracle, the gates, the docs drift checks
docs/                    the docs site: concepts, cli, mcp, viewer, measured, setup/, and ko/
<project>/.cascade/      per-project state: manifest.json, profile.json, and pack/ and catalog/
~/.cascade/registry.json where the tool remembers which project lives where
$XDG_CACHE_HOME/cascade/  the regenerable fact shards, always outside your source tree
```

## 기여, 보안, 행동 규범

- [`CONTRIBUTING.md`](CONTRIBUTING.md): 라운드가 어떻게 도는지, 세 개의 테스트
  스위트, 게이트마다 무엇을 검사하는지, 아홉 개 불변식과 각각을 지키는 테스트,
  그리고 아직 닫히지 않은 둘의 정직한 상태, 받지 않는 기여, DCO 서명
  (`git commit -s`) 입니다.
- [`SECURITY.md`](SECURITY.md): 공개 이슈가 아니라 GitHub Security Advisories 로
  비공개 제보를 받습니다. 여기가 **취약점이 아닌 것**도 밝혀 둡니다. 도달성 답이
  틀린 것은 정확성 버그이며, 그것을 보여 주는 픽스처와 함께 공개된 자리로
  가야 합니다.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md): Contributor Covenant 2.1.
- [`CHANGELOG.md`](CHANGELOG.md): 라운드마다 무엇이 더해졌는지, 그리고 측정된 것과
  측정되지 않은 것을 가르는 마지막의 두 목록입니다.
- 문서 사이트: [`docs/ko/index.md`](docs/ko/index.md).

## 라이선스

Apache-2.0 (`LICENSE`). 엔진과 서버에는 npm 의존성이 없습니다. 남의 것을 가져다
쓴 것은 셋이며 모두 `NOTICE` 에 밝혀 두었습니다.

- `viewer/vendor/` 아래의 브라우저 번들 `force-graph` 와, 안에 `three` 가 들어
  있는 `3d-force-graph`. 모두 MIT 입니다.
- `adapters/web/vendor/` 아래의 웹 레인 파서 `@babel/parser`. MIT 이며, 자체
  README 가 공개한 sha256 으로 고정되어 있습니다.
- 뷰어의 라틴 웹폰트 서브셋 세 개. IBM Plex Sans 와 IBM Plex Mono 이며 OFL-1.1
  입니다.

선택적인 네이티브 분석 레인은, 예를 들어 앞으로 LGPL 솔버를 쓰는 JVM 데이터플로
레인 같은 것은, 각자의 라이선스 아래 별도 서브프로젝트로 살며 Apache-2.0 코어에
링크되지 않습니다. 그 경계는 `NOTICE` 에 전부 적혀 있습니다.
