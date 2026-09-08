[English](../../setup/runtime-evidence.md) | **한국어**

# 런타임 증거(실행 트레이스)

엔진의 다른 모든 레인은 **소스**를 읽습니다. 이 레인만은 돌아간 시스템이 **무엇을
했는지**를 읽고, 그것을 소스가 만들어 낸 그래프 위에 겹쳐 놓습니다.

이 레인이 있는 이유는 소스가 넘지 못하는 벽이 하나 있기 때문입니다. 컨트롤러가
`brandService.listBrand()` 를 부를 때 소스가 지목하는 것은 **인터페이스**입니다.
어느 클래스가 응답하는지는 실행 시점에 Spring 이 정하므로, 그 호출의 정직한
읽기는 **후보 집합**이고 등급은 `SOUND_SET` 입니다. 구현체가 정확히 하나뿐일
때도 그렇습니다. 비관이 아닙니다. `@Transactional` 프록시, MyBatis 인터셉터,
`@DS` 데이터소스 전환, SQL 안의 `<if>` 는 각각 실제로 도는 클래스를 컴파일러가
지목할 클래스와 다르게 만들 수 있습니다. mapper 인터페이스는 한 걸음 더 나아가서
**소스에 구현체가 아예 없습니다.** 애플리케이션이 뜰 때 MyBatis 가 씁니다.

트레이스는 바로 그것을 풀어 줍니다. 어느 구현이 요청을 처리했고 어느 statement 를
돌렸는지를 관측하므로, 후보 집합 옆에 실제로 돈 구성원의 이름이 붙고 statement
바인딩에는 증인이 생깁니다. 그래프의 나머지는 아무것도 바뀌지 않습니다.

## 이 레인 전체를 지배하는 규칙

**한 번 관측된 것이 항상은 아닙니다.** 트레이스는 어떤 경로가 일어날 수 *있다*는
것을 증명할 뿐, 그것이 유일한 경로임을 증명하지는 않습니다. 그래서 이렇습니다.

- **등급을 절대 올리지 않습니다.** 확인된 엣지는 원래 등급을 그대로 유지하고 옆에
  `observed: true` 와 횟수를 얻습니다. `SOUND_SET` 에 관측이 더해져도 여전히
  `SOUND_SET` 입니다. 트레이스 때문에 답이 정적 읽기보다 더 강하게 주장하는 상태는
  이 엔진에 없습니다.
- **관측되지 않은 후보를 지우거나 낮추지 않습니다.** 구현체가 넷인 디스패치에서
  트레이스가 하나를 봤어도 넷 모두 그래프에 남습니다. 돈 것에는 표시가 붙고 나머지
  셋에는 붙지 않으며, 그 셋은 손대지 않습니다.
- **추가하는 것은 보여 주기만 하고 걷지 않습니다.** 트레이스는 보았지만 어떤 정적
  규칙으로도 설명되지 않는 홉은 `RUNTIME_ONLY` 등급의 `MAY_CALL` 엣지가 됩니다.
  이 등급은 모든 질의 모드의 바닥 아래에 있으므로 chain, impact, census 중 어느
  걷기도 이 엣지를 따라가지 않습니다.
- **커버리지는 실제로 지나간 것뿐이고, 답이 그렇게 말합니다.** 모든 응답이
  `basis.runtimeEvidence` 블록을 달고 다니며 트레이스 이름, span 수, 시간 창을
  밝힙니다. 그래서 어떤 행에 표시가 없는 것을 본 독자는 그것이 "여기서는 아무것도
  돌지 않는다"가 아니라 "이번 캡처가 여기를 지나가지 않았다"는 뜻임을 압니다.
- **발견은 하지 않습니다.** `--otel <file>` 이나 프로파일의 `runtimeEvidence.otel`
  은 사람이 "이것을 일부러 캡처했다"고 말하는 것입니다. 트리에서 트레이스를 찾아
  다니지 않습니다. 우연히 놓여 있던 JSON 파일이 이 pack 이 무엇을 돌았다고 주장할지
  정하게 두어서는 안 되기 때문입니다.

## 무엇이 필요한가

**OpenTelemetry 트레이스 익스포트**입니다. 실제 캡처가 나오는 모양은 둘이고, 둘 다
그대로 받습니다.

- **OTLP/JSON 문서**(`{"resourceSpans": […]}`). 컬렉터의 파일 익스포터가 쓰는
  모양이고, Jaeger 나 Tempo 의 API 익스포트도 같은 모양입니다.
- **애플리케이션 자신의 로그**. Java 에이전트가 `logging-otlp` 로 내보낼 때 나오는
  것입니다. 이것은 문서가 아닙니다. 익스포트 배치 하나가 `ResourceSpans` 객체
  하나이고, 그 앞에는 로거가 붙인 접두사가 있으며, 앱이 찍은 다른 모든 줄 사이에
  섞여 있습니다.

어느 쪽인지는 **파일을 읽어서** 정하고 확장자로 정하지 않으므로, 넣는 방법은
같습니다. 읽을 수 없는 줄은 건너뛰고 세며, 그것 때문에 실행이 죽지 않습니다. 그
밖에는 아무것도 필요 없습니다. 우리 쪽 에이전트도, 분석 시점의 네트워크도,
데이터베이스도 쓰지 않습니다.

```
cascade analyze --root . --otel evidence/checkout-smoke.json
cascade analyze --project petclinic --otel evidence/petclinic.log
```

캡처가 여럿이면 `--otel` 을 반복합니다. 함께 접히므로, 같은 체인을 담은 두
트레이스는 두 횟수를 합한 하나의 표시가 됩니다.

## 처음부터 끝까지, 실제 레시피

아래 숫자는 이것을 실제로 돌려서 나온 것입니다. spring-petclinic, 공식 Java
에이전트, `curl` 요청 몇 개. 애플리케이션 코드는 한 줄도 고치지 않았고 컬렉터도 쓰지
않았습니다. 그 실행이 이 레시피와 다른 점이 하나 있는데, 두 홉이 `RUNTIME_ONLY` 로
돌아온 이유가 바로 그것이라 5 단계에서 밝혀 둡니다.

### 1. 에이전트 받기

OpenTelemetry 릴리스 페이지에서 한 번 내려받는 것이 전부입니다.

```
curl -L -o opentelemetry-javaagent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
```

### 2. 어떤 메서드를 계측할지 pack 에 묻기

기본 설정만으로도 에이전트는 HTTP 서버 span, Spring Data 리포지터리 span, JDBC
span 을 씁니다. 그래서 첫 실행에서 **라우트**와 **statement** 조인은 채워지고
**디스패치는 0** 으로 남습니다. 컨트롤러 메서드에도 서비스 메서드에도 span 이
없으니, 메서드 span 이 다른 메서드 span 안에 중첩되는 일 자체가 없기 때문입니다.

에이전트가 그 span 을 만들어 주기는 하는데, **명시적인 메서드 이름**을 요구합니다.
`pkg.Class[*]` 는 이름이 아닙니다. 와일드카드는 아무것도 잡지 못하고, 캡처는 앞과
똑같이 비어서 돌아옵니다. 에이전트가 원하는 이름은 핸들러와 statement 에 닿는
메서드들이고, 그것은 pack 이 이미 들고 있는 것입니다.

```
cascade otel-methods --project petclinic
```

stdout 으로 붙여 넣을 수 있는 한 줄이 나옵니다.

```
org.springframework.samples.petclinic.owner.OwnerController[findOwner,findPaginatedForOwnersLastName,initCreationForm,…];org.springframework.samples.petclinic.owner.OwnerRepository[findById,…];…
```

petclinic 에서는 10 개 클래스의 32 개 메서드입니다. 큰 프로젝트에서는 수만 글자가
되는데, 셸이 감당하기는 하지만 `.properties` 파일이나 JVM 인자 파일에 넣는 편이
읽기 편합니다.

### 3. 트래픽과 함께 한 번 실행하기

```
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.service.name=petclinic \
     -Dotel.traces.exporter=logging-otlp \
     -Dotel.metrics.exporter=none \
     -Dotel.logs.exporter=none \
     -Dotel.bsp.schedule.delay=1000 \
     "-Dotel.instrumentation.methods.include=$(cascade otel-methods --project petclinic)" \
     -jar target/spring-petclinic-4.0.0-SNAPSHOT.jar > petclinic.log 2>&1
```

`logging-otlp` 가 span 을 그 로그에 쓰므로 컬렉터도, 열어 둘 포트도 없습니다.
`metrics` 와 `logs` 는 이 레인이 둘 다 읽지 않으므로 껐습니다.
`bsp.schedule.delay=1000` 은 에이전트가 5 초가 아니라 1 초마다 flush 하게 합니다.
1 분밖에 돌지 않는 실행에서는 이것이 차이를 만듭니다.

그다음 무언가를 말할 수 있게 되고 싶은 트래픽을 보냅니다. 통합 테스트 묶음, 스모크
스크립트, 스테이징 트래픽의 한 조각 같은 것입니다. 아래 캡처는 petclinic 의 화면들을
지나는 `curl` 요청 13 개이고, 모양은 이렇습니다.

```
curl -s localhost:8080/ > /dev/null
curl -s "localhost:8080/owners?lastName=" > /dev/null
curl -s localhost:8080/owners/1 > /dev/null
curl -s localhost:8080/vets.html > /dev/null
```

그리고 **애플리케이션을 멈춥니다.** 그래야 프로세스가 끝나기 전에 마지막 배치가
로그로 flush 됩니다.

여기서 값을 만드는 것은 확인된 체인이지 담긴 양이 아니므로, 중요한 화면들을 지나는
5 분짜리 스모크 실행이 하루치 트래픽보다 훨씬 쓸모 있습니다.

### 4. 로그를 그대로 넣기

로그는 있는 그대로 들어갑니다. 감싸는 단계도, `jq` 도 없습니다.

```
cascade analyze --project petclinic --otel petclinic.log
```

실행은 파일을 어떻게 읽었는지 말하고, 이어서 집계를 찍습니다.

```
Runtime evidence: petclinic.log was read as an agent log, one export per line: 169 span(s) in it, 56 line(s) carried none
Runtime evidence: 1 trace(s), 169 span(s) (25 carried nothing this lane reads), 31 observation(s):
  5 dispatch, 9 statement and 10 route observation(s) matched this pack, 7 matched none
Runtime evidence: 8 static edge(s) marked observed (3 a call the source states,
  0 a candidate set the trace narrowed), 2 RUNTIME_ONLY edge(s) added for a hop no
  static rule explains, 5 statement(s) and 10 route(s) observed, window
  2026-09-08T00:39:16.236Z to 2026-09-08T00:39:18.252Z
Runtime evidence: a grade was neither raised nor lowered by any of this.
  What the trace did not visit is unknown, not absent
```

세 가지 질문으로 읽으면 됩니다.

- **파일에 무엇이 있었나.** span 이 몇 개였고, 그중 이 레인이 읽는 속성을 하나도
  담지 않은 것이 몇 개였나(프레임워크 자신의 span, 트랜잭션 커밋, Hibernate 세션
  같은 것들입니다).
- **무엇이 붙었나.** 이 pack 이 들고 있는 심볼, statement, 라우트에 맞은 관측이
  몇 개이고 아무것에도 맞지 않은 것이 몇 개인가. 여기서 맞지 않은 7 개는 Hibernate
  의 스키마 부트스트랩과 지연 로딩이 낸 JDBC span 입니다. 리포지터리 메서드 아래에서
  돌지 않았으므로 붙일 statement 가 없고, 추측해서 붙이지도 않습니다.
- **무엇이 쓰였나.** 이미 있던 엣지에 붙은 표시와, 새로 더해진 홉입니다.

### 5. 그래서 무엇을 얻었나

spring-petclinic 에서 위 실행의 결과입니다.

| | 관측됨 |
| --- | --- |
| 호출된 라우트 | 17 개 중 10 개 |
| 돌아간 statement | 6 개 중 5 개 |
| 확인된 디스패치 홉 | 3 개(`showOwner` → `findById`, `processCreationForm` → `save`, `showResourcesVetList` → `findAll`) |
| `RUNTIME_ONLY` 로 더해진 홉 | 2 개 |

더해진 두 홉은 `OwnerController#processFindForm` →
`OwnerRepository#findByLastNameStartingWith` 와 `VetController#showVetList` →
`VetRepository#findAll` 입니다. 둘 다 소스가 하는 호출이 아닙니다. 두 컨트롤러 모두
**private 헬퍼**(`findPaginatedForOwnersLastName`, `findPaginated`)를 거치는데 이번
캡처는 그 헬퍼를 계측하지 않았고, 그래서 트레이스에는 컨트롤러가 리포지터리 바로
위에 있는 것으로 보였습니다. 레인은 본 그대로만 기록했고 정적 엣지를 지어내지
않았습니다.

**`RUNTIME_ONLY` 홉은 대개 그런 뜻입니다. 중간에 있는, 계측하지 않은 메서드입니다.**
이 캡처는 라우트 핸들러만 손으로 적은 목록으로 떴고, 그것이 위 2 단계와 다른
점입니다. `cascade otel-methods` 는 그 두 헬퍼도 이름에 넣습니다. 둘 다 statement 에
닿기 때문입니다. 그리고 그 주위의 네 홉(`processFindForm` →
`findPaginatedForOwnersLastName` → `findByLastNameStartingWith`, vet 쪽도 같은 모양)은
정적 그래프가 이미 들고 있는 엣지입니다. 그러니 그 목록으로 뜬 캡처에는 헬퍼의 span 이
있고, 관측은 그 엣지들에 붙으며, 레인이 더할 홉은 남지 않습니다.

### 6. 표시를 있는 그대로 읽기

**한 번 관측된 것이 항상은 아닙니다.** 그래서 표시는 등급 **옆에** 그려지고 위에
그려지지 않습니다. 표시가 없는 라우트는 **이번 캡처가 지나가지 않은** 것이고, 그것은
"여기서는 아무것도 돌지 않는다"와 다릅니다. 커버리지는 실행된 만큼일 뿐이고, 모든
답에는 트레이스 이름과 span 수와 기간을 담은 `basis.runtimeEvidence` 가 실려 있어서
읽는 사람이 둘을 구분할 수 있습니다.

**그리고 여러분의 데이터는 pack 에 들어가지 않습니다.** statement 의 SQL 은 거기
적힌 테이블 이름을 읽고 버리며, 바인딩된 파라미터는 아예 읽지 않고, 페이로드는
건드리지 않습니다(아래 *pack 에 절대 들어가지 않는 것*).

## span 에서 무엇을 읽는가

이 레인이 쓸 수 있는 것을 담은 속성 모양은 셋입니다. 그중 아무것도 없는 span 은
**쓸 수 없음**으로 세고, 추측하지 않습니다.

| 무엇을 말하는가 | 읽는 속성 |
| --- | --- |
| 이름 있는 구체 클래스에서 메서드가 돌았다 | `code.namespace` + `code.function`(또는 `code.function.name`) |
| statement 가 돌았다 | `db.statement`(또는 `db.query.text`) |
| 엔드포인트가 호출되었다 | `http.route`(또는 `http.target`) + `http.method`(또는 `http.request.method`) |

각각의 옛 표기와 새 표기를 모두 받습니다. 어느 쪽이 나오는지는 여러분의 코드가
아니라 에이전트 버전이 정하기 때문입니다.

## 무엇이 무엇에 붙는가

**디스패치.** 메서드 span 안에서 돈 메서드 span 은 "호출 대상이 호출자 안에서
돌았다"고 말합니다. 그것을 그래프에서 두 모양으로, 이 순서로 찾습니다.

1. `caller --MAY_CALL--> callee` 직접 엣지. 정적 레인이 이미 갖고 있던 것이므로
   관측 표시를 붙이고 등급은 손대지 않습니다.
2. `caller --MAY_CALL--> interface#m --MAY_CALL--> callee`. **중요한 것은
   이쪽입니다.** 이 두 홉 모양이 바로 인터페이스 디스패치 후보 집합이고,
   트레이스는 그중 어느 구성원이 돌았는지를 방금 말한 것입니다. 두 홉 모두 관측
   표시를 얻고, 둘 다 `SOUND_SET` 등급을 그대로 유지합니다.

두 모양 중 어느 것도 없고, **또한** 트레이스가 두 span 을 직접 중첩했으며,
**또한** 이 pack 이 두 심볼을 이미 갖고 있을 때만 `RUNTIME_ONLY` 등급의 새
`MAY_CALL` 엣지를 씁니다. 그 엣지는 호출 대상이 호출자 안에서 **돌았다**고 말할
뿐, 소스가 그것을 부른다고 말하지 않습니다. 중첩에 대한 정직한 읽기가 그것입니다.
컨트롤러를 감싸는 Spring 애스펙트가 정확히 이 모양이고, 소스의 어느 줄도 그것을
말하지 않습니다. 트레이스가 본 나머지는 놓을 자리를 찾지 못한 키와 함께
**매칭되지 않음으로 셉니다.** 이 pack 이 한 번도 읽지 않은 심볼은 이 레인이 만들어
낼 심볼이 아니기 때문입니다.

**statement.** SQL 을 담은 span 은 그것이 돈 mapper 메서드에 귀속되고,
`owner.method` statement 노드와 그리로 들어가는 `IMPLEMENTS_STMT` 엣지에 관측
표시가 붙습니다. SQL 이 실제로 지목한 테이블은 노드에 `observedTables` 로
기록되는데, 정적으로 유도된 `EXECUTES` 엣지 **옆에** 놓이지 그것을 대신하지
않습니다. 동적 SQL 이나 `@DS` 전환이 실행 시점에 고른 테이블은 보여 줄 발견이지
적용할 정정이 아닙니다.

**엔드포인트.** 서버 span 의 라우트를 이 pack 이 서빙하는 라우트와 맞춰 봅니다.
먼저 정확한 경로로, 그다음 라우트 템플릿으로 맞추므로 `/brand/detail/12` 는
`/brand/detail/{brandId}` 에 닿습니다. 그리고 엔드포인트 노드에 관측 표시가
붙습니다.

## pack 에 절대 들어가지 않는 것

페이로드도, SQL 텍스트도 들어가지 않습니다. statement 의 SQL 은 그 안의 **테이블
이름**을 얻기 위해 읽고 나서 버립니다. 바인딩된 파라미터는 아예 읽지 않습니다.
트레이스가 pack 에 남기는 것은 `observed` 표시들, 횟수, 테이블 이름, 트레이스 파일
이름, 시간 창입니다. 그러므로 돌아가는 시스템에서 뜬 트레이스라도 그 시스템의
데이터를 분석에 들여오지 않습니다.

트레이스 파일의 **내용 해시는 facts index 에 들어갑니다.** pack 의 다른 모든
입력이 내용 주소로 다뤄지는 것과 같습니다. 그래서 pack 과 그것이 만들어진 캡처가
어느 캡처를 주장하는지에 대해 어긋날 수 없고, 같은 트레이스는 언제나 같은 pack
다이제스트를 냅니다.

## 그다음에 보이는 것

실행이 찍는 집계(위 4 단계) 옆에서, 답은 이렇습니다.

- `flow` 의 행 중 트레이스가 본 메서드와 statement 에 `observed: true` 가 붙고,
  구간 전체가 관측된 단계의 `link` 에도 붙습니다.
- `endpoint_impact` 의 행 중 실제로 요청을 서빙한 라우트에 `observed: true` 가
  붙습니다.
- `overview` 는 `runtime-evidence` gap 을 달고, 얼마가 확인되었고 후보 집합이 몇
  개나 좁혀졌으며 아무것도 승격되지 않았음을 말합니다.
- 모든 응답이 출처와 span 수와 시간 창을 담은 `basis.runtimeEvidence` 를 달고
  다닙니다. `observed` 표시는 그것이 나온 커버리지 옆에서만 읽을 수 있기
  때문입니다.
- 집계 자체는 `meta.laneStats.otel` 에 있습니다.

## 프로파일 키

```json
{ "runtimeEvidence": { "har": [], "otel": ["evidence/checkout-smoke.json"] } }
```

경로는 manifest 디렉터리 기준입니다. `runtimeEvidence.otel` 은 `analyze` 가
`--otel` **없이** 돌 때 읽히고, 둘 다 있으면 플래그가 이깁니다.

## 이 레인이 하지 않는 것

여러분의 애플리케이션을 실행하지 않고, 운영 접근을 요구하지 않으며, 트레이스가
담고 오지 않은 것을 풀어 보려 하지 않습니다. 그래프를 완전하게 만들지 않습니다.
**지나간** 경로를 관측된 것으로 만들고, 그것이 어느 것이었는지를 말할 뿐입니다.

관련 문서: [웹 레인과 브라우저 기록](web-lane.md),
[CLI 레퍼런스](../../cli.md), [English](../../setup/runtime-evidence.md)
