# 룰 팩

[English](../rules.md) | **한국어**

Cascade 가 프레임워크에 대해 아는 것을 엔진 코드에서 꺼내 룰 팩으로 옮기고 있습니다.
룰 팩은 사람이 읽을 수 있는 JSON 파일입니다. 엔진이 무엇을 결론 내리는지와 그 이유를
적고, 룰마다 그 룰을 지키는 예제를 붙입니다. 코드에는 작은 수의 룰 **종류(kind)** 만
남깁니다. 종류는 한 가지 질문을 어떻게 읽는지 알고, 답이 무엇인지는 팩이 말합니다.
프레임워크의 변형이 기존 종류에 맞으면 룰 항목을 하나 더할 뿐, 엔진에 분기를 더하지
않습니다. 어느 종류에도 맞지 않으면 새 종류를 코드로 만들고, 코드처럼 리뷰하고
테스트합니다.

`cascade rules list` 는 모든 팩과 룰을, `cascade rules show <id>` 는 룰 하나를 통째로,
`cascade rules test` 는 모든 예제를 실행해 보여 줍니다. `cascade rules explain <타입>` 은
프로젝트의 Java 타입이 왜 역할을 받았는지, 또는 왜 못 받았는지 설명합니다.
MCP 도구 `rules`는 pack을 보고 답합니다. 모든 팩과 룰을 보여 주고, 룰마다 그
프로젝트에서 무엇을 만들었는지(연결은 타입과 등급별로, 노드는 종류별로) 셉니다.
룰 하나를 물으면 그 룰 전체와, 그 룰이 만든 연결과 노드를 보여 줍니다
([mcp.md](../mcp.md#rules)). 예제는 돌리지 않습니다. 예제를 돌리려면 워커가 있어야
해서, 그건 `cascade rules test`가 맡습니다.
뷰어(`cascade view`)도 같은 팩을 읽기 전용으로 보여 줍니다. 자리는 **Analysis
status**(분석 상태)의 둘째 보기인 **Rules**(룰)입니다. 이 프로젝트에서 무언가를 만든 룰이
먼저 나옵니다. 룰마다 설명, 왜 있는지, 인자와 예제, 그리고 이 프로젝트의 pack에서 그
룰이 만든 연결 수가 나옵니다. 룰이 만든 연결은 근거에 그 룰 이름을 남깁니다
(`evidence.rule`, 이유 한 문장은 `evidence.basis`). 그래서 **Trace**(추적)가 그리는
경로에서, 어느 방향이든, 어느 룰이 그 단계를 만들었는지 볼 수 있습니다.
`web.wrapper-hop` 룰은 호출을 만드는 것이 아니라 호출이 지나는 단계 하나를 읽습니다.
그래서 그 이름은 단계가 있는 자리, `evidence.sink.hop.rule` 에 남습니다.

## 위치

엔진이 싣고 다니는 팩은 `src/core/rules/packs/` 에 있습니다. 팩은 엔진의 일부입니다.
캘리브레이션 게이트가 비교하는 엔진 지문에 포함되므로, 팩을 고치면 코드를 고친 것과
똑같이 엔진 변경으로 판정됩니다.

| 팩 | 담고 있는 것 | 종류 |
|---|---|---|
| `sql-dialects` | DDL·매퍼 파일이 어느 DB용인지, 경로의 단어로 | `sql.dialect-path` |
| `mybatis-plus` | 어느 타입이 MyBatis-Plus 매퍼·서비스인지 | `java.type-role` |
| `mybatis-plus-join` | jar가 `BaseMapper`로 선언한 mybatis-plus-join의 `MPJBaseMapper` | `java.type-role` |
| `spring-mvc` | Spring 설정 코드에서 경로 prefix를 정하는 호출, 그리고 대신 선언할 프로필 키 | `java.code-setting` |
| `spring-functional` | `RouterFunction`을 돌려주는 메서드가 라우트를 만들 때 쓰는 호출 | `java.route-function` |
| `openapi-generator` | openapi-generator가 인터페이스에 붙이는 이름. 그 인터페이스를 구현한 컨트롤러가 문서의 라우트를 처리합니다 | `java.contract-link` |
| `typescript` | 어느 TypeScript 파일이 애플리케이션이 아니라 테스트의 것인지 | `ts.test-support` |
| `nestjs` | 라우트를 만드는 NestJS 데코레이터와 부트스트랩 호출, 모듈의 `providers`가 묶는 것, 생성자 매개변수의 데코레이터가 무엇으로 채우는지 | `ts.route-decorator`, `ts.provider-binding` |
| `prisma` | Prisma 클라이언트 타입, 클라이언트 호출마다 읽고 쓰는 것, 암묵적 다대다 관계에 Prisma 가 만드는 테이블 | `ts.type-role`, `prisma.operation`, `table.join-table` |
| `typeorm` | TypeORM 엔티티와 naming strategy(이름 규칙), 호출을 받는 객체, repository 연산과 query builder | `typeorm.entity`, `typeorm.receiver`, `typeorm.operation`, `typeorm.query-builder` |
| `vben-admin` | vue-vben-admin 의 HTTP 클라이언트 클래스. 모든 호출이 지나는 단계가 어느 메서드인지, 그 단계가 URL, 메서드, base URL 에 무엇을 하는지 | `web.wrapper-hop` |

## 형식

형식과 필드는 영어 문서([rules.md](../rules.md))에 예시와 함께 있습니다. 요점은
이렇습니다.

- `id` 는 팩 이름, 점, 이름입니다. 결론이 자기 출처로 이 이름을 달기 때문에 바꾸지
  않습니다.
- `kind` 는 아래 종류 중 하나이고, `params` 는 그 종류가 정한 모양을 따릅니다.
- `grade` 는 엣지를 긋는 종류에서만 쓰며, 그 룰이 줄 수 있는 가장 강한 등급입니다.
  종류가 허용하는 등급을 넘을 수 없습니다.
- `examples` 는 필수입니다. 아무것도 기대하지 않는 예제(`null`)는 룰이 잡으면 안 되는
  경우라서, 무엇을 기대하는 예제만큼 중요합니다.

모양은 닫혀 있습니다. 엔진이 모르는 키는 무시하지 않고 거부합니다. 문제가 있는 팩은
파일과 룰 이름을 붙여 모든 문제를 한꺼번에 알리고 거부합니다. 같은 입력에 두 룰이 서로
다른 답을 내면 충돌로 보고 멈춥니다. 어느 쪽이 이기는지를 팩을 읽은 순서로 정하지
않습니다.

## 종류

| 종류 | 실행 시점 | 읽는 것 | 결론 | 가장 강한 등급 |
|---|---|---|---|---|
| `java.type-role` | Java 워커의 레코드를 모은 뒤, 레인을 고르기 전 | 타입 자신의 extends·implements 절이 적은 상위 타입과 그 타입 인자 | 타입이 맡는 역할(MyBatis-Plus 매퍼·서비스)과, 몇 번째 타입 인자가 엔티티·매퍼인지. 사슬의 뿌리만 맞춥니다. 프로젝트 자체 타입을 거쳐 닿는 타입은 역할을 읽는 브리지가 찾습니다 | EXACT |
| `java.code-setting` | `analyze`에서 레인이 다 돈 뒤, Java 워커의 레코드를 보고 | Java 파일마다의 호출과, 파일이 선언한 대로의 각 호출의 수신자(Java 워커의 `invocations` 레코드), 파일의 import, 그리고 트리가 선언한 타입과 필드 | 설정 코드가 한 호출 중, 프로필에 대신 선언해야 할 설정(`params.setting`)을 정하는 호출이 무엇인지. 프로필 키가 비어 있으면 `SETTING_IN_CODE`로 알립니다 | 없음. 엣지를 긋지 않습니다 |
| `java.route-function` | Java 레인 브리지에서, 매핑 애너테이션과 나란히 | `RouterFunction`(또는 그걸 담은 `Supplier`)을 돌려준다고 선언한 메서드의 본문. 워커가 호출의 트리로 기록한 것입니다(`routeFunction` 레코드) | 어느 호출이 빌더를 시작하는지, 라우트를 더하는지(메서드, 경로, predicate, 핸들러, springdoc operation id), 라우트를 경로 아래에 넣는지, 다른 router function의 라우트를 합치는지, 그대로 두는지. 그리고 메서드가 애너테이션(`@Bean`)으로 등록되는지, 다른 곳의 코드가 붙이는지. 핸들러가 어느 Java 메서드인지, 다른 곳에서 붙이는 라우트가 어디서 서빙되는지는 브리지가 정합니다 | EXACT |
| `java.contract-link` | OpenAPI 브리지에서, 문서의 라우트가 그래프에 올라간 뒤 | 클래스 자신의 애너테이션과 implements 절, 파일의 import로 본 각 이름의 뜻, 클래스가 선언한 메서드, 그리고 문서마다 따로 읽은 operation(메서드, 경로, 적힌 그대로의 경로, operationId, tag) | 코드 생성기가 빌드 때 문서로 만드는 인터페이스를 클래스가 구현할 때, 어느 메서드가 어느 선언된 라우트를 처리하는지. 그 인터페이스는 소스 트리에 없습니다. 연결 하나가 HANDLES 엣지 하나입니다 | HEURISTIC |
| `sql.dialect-path` | 트리를 발견할 때 | 파일 경로 | 경로의 온전한 단어로 DDL·매퍼 파일이 어느 DB용인지. 경로에 단어가 있는 첫 항목이 이기므로, 룰은 선호하는 항목을 먼저 적습니다 | 없음. 분류만 합니다 |
| `ts.route-decorator` | TS 레인 브리지에서 | TS 워커가 기록한 클래스·메서드의 데코레이터 | 어느 클래스가 컨트롤러이고 어느 메서드가 라우트인지, 그 경로와 버전. 어느 클래스가 모듈이고 무엇을 import하며 어떤 컨트롤러를 등록하는지. 부트스트랩이 부르는 이름(`NestFactory.create`, `setGlobalPrefix`, `enableVersioning`, `RouterModule.register`)도 여기 있습니다. 컨트롤러가 실제로 서비스되는지는 브리지가 모듈 그래프를 따라가서 정합니다 | EXACT |
| `ts.provider-binding` | TS 레인 브리지에서 | 모듈의 `providers` 목록. `@Module` 옵션에 있든, 모듈의 static 메서드가 돌려주는 객체(`X.forRoot()`)에 있든 읽습니다 | 모듈이 타입에 어느 클래스를 묶는지. 클래스만 적으면 자기 자신을, `{ provide: T, useClass: C }`는 T에 C를 묶습니다. 읽지 않는 바인딩(`useFactory`, `useValue`, `useExisting`)과 아예 읽을 수 없는 항목(적어 둔 목록이 아닌 것의 spread, 계산된 키)도 가려냅니다. 조건에 따라 펼치되 목록을 적어 둔 것(`...(on ? [A] : [])`)은 그 안의 것을 묶습니다. 생성자 매개변수의 데코레이터가 무엇으로 채우는지도 정합니다. `injectByToken`은 토큰으로 채우고, `harmless`는 아무것도 바꾸지 않고, 그 밖의 데코레이터는 모르는 것입니다. 패키지 모듈의 옵션에서 패키지가 읽기만 하는 키(`consumed`)도 적습니다. 거기 적힌 타입은 패키지에 넘긴 것으로 치지 않습니다. 어느 모듈을 셀지, 그게 호출에 어떤 영향을 주는지는 브리지가 정합니다 | 없음. 엣지를 긋지 않습니다 |
| `ts.test-support` | TS 레인이 읽을 파일을 고를 때 | 분석 루트 아래 파일 경로 | 그 파일이 테스트 지원 파일(spec, mock, stub, 테스트만 돌리는 도우미)인지. 폴더는 이름 전체로, 파일은 이름 끝으로 맞춥니다. 레인은 읽는 파일이 import 하지 않는 한 그런 파일을 뺍니다. 애플리케이션 루트 안이든 공유 라이브러리 안이든 같고, 뺀 것은 알립니다(`TS_FILES_LEFT_OUT`) | 없음. 분류만 합니다 |
| `ts.type-role` | TS 레인 브리지에서 | 타입을 가져온 패키지와 export 이름 | 그 타입이 맡는 역할(Prisma 클라이언트). 그 타입을 상속한 프로젝트 클래스도 같은 역할을 맡습니다 | EXACT |
| `prisma.operation` | TS 레인 브리지에서 | Prisma 호출의 연산과 인자의 키 하나하나 | 보내는 문장(select, insert, update, upsert, delete), 읽고 쓰는 필드, 행 전체를 돌려주는지. 호출이 적은 relation(연관 관계)은 닿는 모델까지 따라갑니다. `include`·`select` 안, relation 필터, `_count`, 중첩 쓰기(nested write)가 여기 해당합니다. null로 거르는 relation은 연결만 확인하고, 아무것도 바꾸지 않는 값을 받은 중첩 쓰기는 Prisma가 그래도 보내는 것만 그립니다(팩의 `idle` 항목). 바꾸기 전에 행을 먼저 찾아야 하는 중첩 쓰기는 그 테이블과 키를 먼저 읽습니다(`lookup`). `extensions`에는 클라이언트로 클라이언트를 만드는 호출(`$extends`)과, 호출이 보내는 것을 바꿀 수 있는 확장 부분이 적혀 있습니다. 따라가지 못한 것(넘겨받지 않은 모델로 가는 relation, 모르는 키, 변수에 담긴 인자)은 그렇다고 남깁니다 | EXACT |
| `table.join-table` | 요약 지도가 닿은 테이블을 계열로 나눌 때 | 테이블 이름과 카탈로그가 선언한 컬럼 | 프레임워크가 두 테이블을 잇기 위해서만 만든 테이블인지. 이름이 `params.prefix` 로 시작하고, 룰이 `params.columns` 를 적었으면 컬럼이 정확히 그것이어야 합니다. 요약은 그런 테이블을 이름으로 묶지 않고, 그래프가 잇는 테이블 쪽에 둡니다 | 없음. 분류만 합니다 |
| `typeorm.entity` | TS 레인 브리지에서 | TypeORM 데코레이터가 붙은 클래스, 그 속성이 선언한 컬럼과 relation, 상속한 클래스, 애플리케이션이 어디에 적었든 DataSource 옵션 | 어느 클래스가 엔티티인지, 그리고 매핑하는 테이블·컬럼·조인 테이블. 이름은 옵션이 정한 naming strategy, 테이블 prefix, schema대로 짓습니다. 전략으로 만든 이름은 전략을 알고, 모든 TypeORM 버전이 같은 철자로 쓸 때만 EXACT입니다. 테이블 이름은 소스에 적힌 것까지 포함해서, prefix를 알고 schema를 적지 않은 엔티티라면 schema도 알 때만 EXACT입니다. 아니면 이유와 함께 HEURISTIC입니다. 테이블 이름 앞에 schema와 엔티티 자신의 database 중 무엇이 붙는지는 드라이버가 정합니다(`tablePath`). 팩이 모르는 드라이버면 이름은 HEURISTIC이고, 옵션에 드라이버가 적혀 있지 않을 때도 앞에 무언가 붙을 수 있는 테이블이면 HEURISTIC입니다. 프로필이 드라이버를 선언하면(`tsBackend.typeorm.type`) 그렇지 않습니다. SQLite 드라이버가 붙이는 데이터베이스(`attached`)에 있는 테이블은 이름이 HEURISTIC입니다. TypeORM이 스스로 채우는 컬럼(`autoColumns`: 생성 날짜, 수정 날짜, 버전)도 여기서 정합니다 | 없음. 엣지를 긋지 않고, 이름마다 등급이 따로 붙습니다 |
| `typeorm.receiver` | TS 레인 브리지에서 | 클래스의 필드와 그 타입·주입 데코레이터, 호출 사슬이 거치는 함수와 멤버, 트랜잭션 콜백의 매개변수 | TypeORM 호출을 받는 객체가 무엇인지(엔티티의 repository, entity manager, data source), 그리고 어느 엔티티를 가리키는지. 선언한 뒤 한 번 받았거나, 그런 객체를 담은 필드를 받은 지역 변수는 그 객체를 담습니다. 조건이 값을 고르는 지역 변수는 다른 값을 담을 수 있어서, 그 변수로 부른 호출은 읽지 않습니다 | 없음. 분류만 합니다 |
| `typeorm.operation` | TS 레인 브리지에서 | repository·entity manager 연산의 이름과 인자, 부분 하나하나 | 보내는 문장, 거르고 돌려주고 정렬하고 쓰는 컬럼, eager로 표시된 relation까지 행 전체를 돌려주는지, 그리고 소스에 적히지 않은 인자라서 실행 때만 알 수 있는 것. count, exists, 집계 연산은 eager relation을 행 없이 조인하므로(TypeORM 0.3) 그 테이블과 조인 컬럼은 SOUND_SET입니다. 쓰기는 TypeORM의 문장 중 하나를 보내고(`sends`), 그 문장이 날짜·버전 컬럼을 스스로 채웁니다. 보낼 수 있는 문장 모두가 채우는 컬럼은 쓰는 것이고, 일부만 채우는 컬럼은 SOUND_SET입니다. 값이 그 컬럼을 직접 적으면 값이 쓰고, 옛 버전을 읽는 것은 SOUND_SET입니다(TypeORM 0.2.34 부터는 값이 적은 버전에 아무것도 더하지 않고, 그 전에는 1을 더했습니다). 삭제 날짜 컬럼이 있는 엔티티를 고르는 select 는 그 컬럼을 읽습니다. find 가 지운 행도 달라고 하면(`withDeleted`) 읽지 않습니다 | EXACT |
| `typeorm.query-builder` | TS 레인 브리지에서 | `createQueryBuilder` 사슬과 그걸 담은 이름에 뒤이어 부른 호출, 단계 하나하나와 조건의 텍스트 | 쿼리가 쓰는 alias, 조건 안의 `alias.property`가 가리키는 컬럼, join이 더하는 테이블, `select`가 좁힌 것, 그리고 select·update·delete·insert 중 무엇인지와 그 문장이 스스로 채우는 날짜·버전 컬럼. 조건문 안에 적힌 단계는 실행될 수도 있는(MAY) 것이라, 거기서 읽는 것은 SOUND_SET입니다. `clone`과 `subQuery`는 builder를 하나 더 만들고, 그 단계는 읽지 않습니다. builder 는 그 지역 변수를 쓰는 곳이 모두 값을 버리는 단계이거나 쿼리를 실행하는 단계로 끝나는 사슬일 때만 통째로 읽습니다. 다른 쓰임(넘기기, 다른 이름에 담기, 클로저에 잡히기, 돌려주기)이 있으면 읽는 것이 SOUND_SET 입니다(`builder-escapes`). 삭제 날짜 컬럼이 있는 엔티티의 select 나 join 은 `withDeleted` 가 먼저 오지 않으면 그 컬럼을 읽습니다 | EXACT |
| `web.wrapper-hop` | web 레인 브리지에서, 래퍼 사슬을 추적하고 걸을 때 | web 워커가 기록한 클래스(선언한 메서드, 채우는 필드와 그 필드를 만드는 것), 그 단계 자신의 클라이언트 호출, 그리고 호출마다 호출자가 단계에 넘기는 것(객체 인자가 쓰는 모든 키, `params` 를 객체로 썼는지) | 프레임워크 클라이언트 클래스의 어느 메서드가 룰이 말하는 래퍼 단계인지, 그리고 그 단계가 넘기는 요청의 키마다 무엇을 하는지. `keep`, `set`(단계가 자기 값을 적음. 정해지지 않음), `prefix`(`by` 에 적은 요청 옵션이 정하는 접두사 뒤로), `append`(요청의 키 값이 텍스트면 URL 뒤에 붙임), `query`(쿼리 문자열을 더함), 그리고 URL 이 아닌 키에는 `change`(라우트와 상관없는 키. 걷기가 따라가지 않음)입니다. 룰이 이름을 대지 않은 단계는 코드대로 읽습니다 | 없음. 엣지를 긋지 않습니다. 그 단계를 지나는 호출은 다른 래퍼처럼 매기고, 가장 높아야 SOUND_SET 입니다 |

### 전체 이름으로 적은 상위 타입

`java.type-role` 룰은 상위 타입을 전체 이름으로 적을 수 있고, MyBatis-Plus 팩은
그렇게 적습니다(`com.baomidou.mybatisplus.core.mapper.BaseMapper`). 이렇게 적은
상위 타입은 파일이 그 단순 이름으로 다른 타입을 가리킨다는 증거가 없는 한 룰의
타입으로 읽습니다. 증거란 다른 `BaseMapper`의 import(tk.mybatis에도 있고, 직접
만든 프로젝트도 있습니다)나, 프로젝트가 파일과 같은 패키지 또는 파일이 패키지째
import한 패키지에 선언한 같은 이름의 타입입니다. 소스에 전체 이름을 직접 적었으면
읽을 단서가 없으니 룰의 타입으로 읽습니다. 단순 이름만 적은 상위 타입은 이름으로
읽습니다.

### 라이브러리가 선언한 역할

어떤 라이브러리는 프로젝트와 프레임워크 사이에 자기 기반 타입을 끼워 넣습니다.
mybatis-plus-join은 `MPJBaseMapper<T>`를 `BaseMapper<T>`의 하위 타입으로 선언합니다.
그래서 매퍼가 `MPJBaseMapper`를 상속하는 프로젝트에는 `BaseMapper`라는 글자가
어디에도 없습니다. 이 관계는 jar 안에 있어서 프로젝트 소스만으로는 알 수 없습니다.
이런 타입을 다루는 `java.type-role` 룰은 `params.library`에 그 타입을 적습니다.

```json
"grade": "SOUND_SET",
"params": {
  "role": "mybatis-plus-mapper", "supertypes": ["MPJBaseMapper"], "entityArg": 0,
  "library": {
    "type": "com.github.yulichang.base.MPJBaseMapper",
    "declares": "public interface MPJBaseMapper<T> extends BaseMapper<T>, JoinMapper<T>",
    "source": "mybatis-plus-join-core, com/github/yulichang/base/MPJBaseMapper.java"
  }
}
```

- `type`, `declares`, `source` 셋 다 필수입니다. 어떤 타입인지, 룰이 그 타입을
  무엇으로 믿는지, 누구든 어디서 확인할 수 있는지를 적습니다.
- 이런 룰은 등급을 EXACT보다 낮게 매기고, EXACT 미만 등급은 이런 룰만 쓸 수
  있습니다. 이 룰에서 나온 역할이 만드는 연결(메서드에서 일반 CRUD 문장으로,
  문장에서 테이블·컬럼으로)은 모두 그 등급을 넘지 않습니다. 문장의 근거에는
  룰 이름과 라이브러리 타입이 남습니다.
- 상위 타입 이름이 그 라이브러리 타입이라고 인정하는 건 파일이 실제로 그 타입을
  가리킬 때뿐입니다. 판정은 javac가 이름을 읽는 순서를 따릅니다. 그 이름을 직접
  import했으면 그것으로 정하고, 아니면 파일과 같은 패키지의 타입, 그다음이 패키지째
  import한 타입입니다. 다른 곳의 같은 이름 타입은 해당하지 않습니다.
- 프레임워크 자체 타입을 읽는 룰과 라이브러리 룰이 한 타입에 같은 답을 내면 역할은
  하나이고, 등급은 더 확실한 쪽을 따릅니다.

### 코드로 정하는 설정

라우트가 어디서 서빙되는지를 선언이 아니라 설정 코드가 정할 때가 있습니다. Spring은
predicate가 고른 컨트롤러 앞에 경로 prefix를 붙일 수 있습니다.
`RequestMappingHandlerMapping.setPathPrefixes(...)`를 쓰거나, `WebMvcConfigurer`나
`WebFluxConfigurer` 안에서 `PathMatchConfigurer.addPathPrefix(prefix, predicate)`를
부르는 방식입니다. predicate는 람다이고, prefix는 보통 프로퍼티 값입니다. 이 엔진은
둘 다 읽지 않습니다. 상수로 적은 prefix는 원리상 읽을 수 있지만 그것도 읽지 않습니다.
그래서 프로필에 `pathPrefixes` 키를 두었습니다
([Java 레인 설정](../setup/java-lane.md#a-prefix-set-in-configuration-code-pathprefixes)).
`java.code-setting` 룰은 프로젝트에 그 키가 필요하다는 걸 엔진이 알아차리는
방법입니다.

```json
"params": {
  "setting": "pathPrefixes",
  "effect": "the controllers it picks are served under a path prefix, and every route of theirs is recorded here without it",
  "calls": [
    { "on": "PathMatchConfigurer", "method": "addPathPrefix",
      "types": ["org.springframework.web.servlet.config.annotation.PathMatchConfigurer",
                "org.springframework.web.reactive.config.PathMatchConfigurer"] }
  ]
}
```

- `setting`은 프로필 키입니다. `effect`는 그 호출이 무엇을 정하고, 그래서 pack에서
  무엇이 빠지는지를 한 구절로 적습니다.
- `types`에는 그 메서드를 선언한 타입을 전체 이름으로 모두 적습니다. 룰은 메서드를
  이름만이 아니라 선언한 타입으로 가리킵니다.
- Java 워커는 호출마다 수신자(메서드를 받는 객체)를 파일이 선언한 대로 기록합니다.
  지역 변수, 매개변수, 필드, `new X()`, 캐스트, `this`, `new`로 타입이 정해지는
  `var`(`var m = new X()`), 그리고 클래스가 어디서도 선언하지 않은 이름입니다. 마지막은
  상위 클래스가 선언한 필드일 수 있습니다. 그 타입이 `types`에 있는 타입이거나, 그런
  타입을 몇 단계 위에서든 상속·구현한 트리 안의 클래스면 그 호출은 설정입니다.
- 타입 이름은 javac가 그 파일에서 읽는 방식대로 읽습니다. 전체 이름으로 적었으면 그
  이름입니다. 아니면 파일이 선언한 타입, 단일 타입 import, 같은 패키지의 타입을 먼저
  보고, 패키지 전체 import는 그다음에 봅니다. 그래서 룰의 타입보다 두 단계 아래
  클래스에서 `this`로 부른 호출도 설정이고, 상위 클래스가 선언한 필드로 부른 호출도
  설정입니다.
- 파일이 수신자의 타입을 밝히지 않았는데 그 파일에서 그 이름이 룰의 타입을 가리키면,
  증명된 게 없으니 한 단계 낮은 알림(severity `info`)으로만 말합니다. 다른 타입으로
  선언한 수신자에 부른 호출은 다른 메서드이고, 알리지 않습니다. 트리 어디서도, 상위
  클래스에서도 선언하지 않은 이름은 타입을 밝히지 않은 수신자로 봅니다. 상속 사슬이
  `types`에 닿기 전에 트리 밖으로 나가는 클래스는 놓칩니다. 짐작하지 않습니다.
- Java facts에 그런 호출이 있는데 프로필 키가 비어 있으면, `cascade analyze`가
  `SETTING_IN_CODE` 경고로 파일, 줄, 채울 키를 알려 줍니다. 키를 선언했으면 그게
  프로젝트의 말이므로 아무것도 알리지 않습니다.
- 엣지를 긋지도, 등급을 매기지도 않습니다. 그래서 이 종류의 룰에는 등급이 없습니다.

### 호출로 만드는 라우트

Spring의 함수형 엔드포인트(functional endpoint)는 애너테이션이 아니라 호출로 라우트를
선언합니다.

```java
@Bean RouterFunction<ServerResponse> routes(OwnerHandler handler) {
  return route().nest(path("/owners"), b -> b.GET("/{id}", handler::show)).build();
}
```

Java 워커는 `RouterFunction`(또는 그걸 담은 `Supplier`)을 돌려준다고 선언한 메서드마다
본문을 호출의 트리로 기록합니다. 아무것도 판단하지 않고 기록만 합니다. 그 트리를 읽을
어휘가 `java.route-function` 룰입니다. `calls`의 항목 하나는 메서드 이름, static 호출이면
그 클래스(`on`), 호출이 하는 일, 그리고 형태마다 인자의 역할(`"path predicate handler"`,
`"predicate routes"` 같은)을 적습니다. `spring-functional` 팩은 WebFlux와 WebMvc의
Spring 빌더, 그리고 springdoc의 `SpringdocRouteBuilder`를 읽습니다.

| `does` | `spring-functional`의 호출 | 라우트에 하는 일 |
|---|---|---|
| `start` | `RouterFunctions.route()`, `SpringdocRouteBuilder.route()` | 빌더를 시작합니다 |
| `route` | 빌더의 `GET`, `POST` 같은 메서드, `route(predicate, handler)`, `andRoute` | 라우트를 하나 더합니다. 형태에 있는 경로, predicate, 핸들러, springdoc operation consumer를 같이 읽습니다 |
| `nest` | `nest`, `andNest`, 빌더의 `path(...)` | 안쪽 라우트를 그 경로 아래에 넣습니다. 안쪽은 router function일 수도, 그걸 담은 `Supplier`일 수도, 새 빌더를 받는 consumer일 수도 있습니다 |
| `combine` | `and`, `andOther`, `add` | 다른 router function의 라우트를 합칩니다 |
| `build` | `build` | 그 시점에 빌더가 담고 있는 router function입니다 |
| `keep` | `filter`, `before`, `after`, `onError`, `withAttribute`, `withAttributes` | 라우트를 그대로 둡니다 |
| `resources` | `resources` | 정적 파일을 서빙합니다. 세기만 하고 라우트로 만들지 않습니다 |

`predicates`는 `RequestPredicates`에 대해 같은 일을 합니다. `GET("/x")` 같은 메서드별
호출, `path("/x")`, `method(HttpMethod.GET)`은 경로나 메서드를 말하고, `and`로
이어집니다. `accept`, `contentType` 같은 것은 라우트를 좁힐 뿐 경로를 말하지 않습니다.
`mountAnnotations`(`Bean`)는 Spring이 메서드의 라우트를 등록하게 만드는 애너테이션이고,
`operationId`는 springdoc operation consumer 안에서 operation 이름을 정하는 호출입니다.

라우트가 어디서 서빙되는지는 Java 브리지가 정합니다.

- `@Bean` 메서드의 라우트는 호출이 조립한 경로에서 서빙됩니다. 같은 클래스의 라우트
  메서드를 인자 없이 부르면, 그 메서드는 부른 자리에서 부른 쪽의 prefix 아래로
  읽습니다. 나머지는 다른 곳의 코드가 붙이는 메서드라서, 경로가 그 파일에 없는
  prefix에 상대적입니다.
- 그런 라우트는 OpenAPI 문서가 그 라우트의 operation id를 같은 메서드로, 라우트 자신의
  경로로 끝나는 경로에 선언한 곳에만 놓습니다. 이때 HANDLES 엣지는 HEURISTIC입니다.
  소스가 밝힌 마운트가 아니라, 낡았을 수도 있는 문서만이 그 자리를 주기 때문입니다.
  프로필이 그 문서를 지금 코드로 쓴 문서라고 선언하면(`openapi.generatedFromCode`),
  문서가 코드가 그 라우트를 서빙하는 자리를 말해 주므로 엣지는 핸들러를 읽은 만큼
  등급을 받습니다.
  operation id는 빌더가 마지막으로 받은 값입니다. 마지막 값이 리터럴이 아니면 모르는
  것으로 둡니다. 코드의 두 라우트가 같은 operation을 가리키거나,
  문서가 같은 operation id를 두 라우트에 선언했으면 어느 쪽도 놓지 않습니다.
- 모든 라우트는 모든 레인이 쓰는 엔드포인트 id를 받습니다. 그래서 문서가 선언한
  라우트와 같은 노드가 되고, 중복되지 않고 서로를 뒷받침합니다.
- `@Bean`이 서빙 위치를 밝힌 라우트라면, HANDLES는 소스가 클래스와 메서드를 직접
  가리키고 트리 안에서 그 메서드를 덮어쓴 곳이 없을 때 EXACT입니다(`this::list`,
  또는 트리가 그 메서드와 함께 선언한 타입의 `OwnerHandler::list`). 선언 타입(필드,
  매개변수, 지역 변수, 아래에 덮어쓴 메서드가 있는 `this`)을 거치면 SOUND_SET이고,
  후보는 그 타입의 객체가 실행할 수 있는 메서드 전부입니다. 타입 자신의 메서드나
  상속받은 메서드, 그리고 트리 안에서 그 아래 덮어쓴 메서드 전부입니다. 메서드 하나만
  부르는 람다는 그 메서드를 가리키는 것으로 봅니다.
- 빌더는 어떤 이름으로 담든 한 객체입니다. 그래서 다른 이름으로 더한 라우트도 그
  빌더의 것이고, `build()`는 그 시점에 빌더가 담고 있는 것입니다. 다시 대입되는 지역
  변수(경로, prefix, 빌더)는 쓰이는 자리에서 담고 있는 값으로 읽습니다. 읽는 쪽이
  대입을 따라갈 수 없는 곳(분기, `+=`, 식 안의 대입)부터는 그 변수를 읽지 않습니다.
- 이 레인이 핸들러를 알아내지 못하면(메서드 하나를 부르는 것보다 많은 일을 하는 람다,
  변수에 담긴 핸들러) 라우트를 `handlerUnread: true`인 엔드포인트 노드로 남기고
  HANDLES 엣지는 긋지 않습니다.
- 읽지 못한 것은 `laneStats.functionalRoutes`에 세고, 처음 몇 개는
  `JAVA_ROUTE_NOT_READ`로 출력합니다. 변수에 담긴 경로, 팩에 없는 predicate나 호출,
  인자를 받는 helper가 여기 해당합니다. 코드가 적은 operation id를 문서가 다른
  라우트에 주고 있으면 `operationIdDisagreements`에 세고 `OPERATION_ID_DISAGREES`로
  출력합니다.

프로젝트나 라이브러리가 더한 빌더는 코드 변경이 아니라 팩 항목 하나입니다. 한 호출을
두 룰이 다르게 읽으면 실행을 멈춥니다.

### 빌드만 쓰는 계약

계약 우선(contract-first) 프로젝트는 API를 OpenAPI 문서에 두고, 빌드가 그 문서로 코드
생성기를 돌립니다. openapi-generator는 operation 묶음마다 인터페이스를 하나씩
만듭니다(`OwnersApi`). 메서드 이름은 operationId이고, 메서드마다 매핑 애너테이션이
붙습니다. 프로젝트의 컨트롤러는 이 인터페이스를 구현합니다. 그런데 이 인터페이스는
소스 트리에 없습니다. 그래서 Java 레인에는 매핑 없는 컨트롤러만 보이고, 문서의
라우트 아래에는 아무것도 없습니다.

`java.contract-link` 룰은 생성기의 이름 규칙으로 둘을 짝짓습니다.

- `serverClass.annotations`(`RestController`, `Controller`): 이 중 하나를 클래스
  자신이 달고 있어야 핸들러입니다. 같은 인터페이스를 구현한 API 클라이언트는 아무것도
  서빙하지 않습니다. 상위 클래스나 메타 애너테이션으로 애너테이션을 받는 컨트롤러도
  잇지 않습니다. 연결을 빠뜨릴 뿐, 추측해서 만들지는 않습니다.
- `interfaceName`: 접미사(`Api`)와, 생성기가 묶음 이름을 어디서 가져오는지입니다.
  `tag`는 operation의 tag 하나하나, `path`는 문서에 적힌 경로의 첫 구간입니다.
  철자는 생성기 자신의 정리 규칙과 camel case 변환을 따릅니다.
- `generator`: 어느 생성기인지, 룰이 그 생성기의 어떤 동작을 믿는지, 그게 어디
  적혀 있는지(`name`, `declares`, `source`). 셋 다 필수입니다.

이런 애너테이션을 단 구체 클래스가 자기 implements 절에 프로젝트가 선언하지 않은
인터페이스를 적었고, 그 이름이 접미사로 끝나며 생성기가 어떤 operation 묶음에 붙이는
이름과 같다면, operationId와 이름이 같은 그 클래스의 메서드가 그 operation의 라우트를
처리합니다. 연결은 HANDLES 엣지이고, 등급은 이 종류의 상한인 HEURISTIC입니다.
인터페이스도 생성기 설정도 읽지 않으니, 둘을 잇는 건 이름 규칙뿐이기 때문입니다.
근거에는 룰, operationId, 문서, 인터페이스가 남습니다.

빌드가 정말 그 문서로 인터페이스를 만든다는 것은 트리가 보여 줄 수 없습니다. 그것은
프로필이 말합니다: `openapi.generatesCode`. 여기 선언한 문서 위의 링크는, 생성기가
operation 을 묶는 방식에 인터페이스 이름이 기대지 않을 때 브리지가 EXACT 로 매깁니다.
클래스가 선언한 그 메서드입니다. 종류는 링크마다 두 집합을 적습니다. 이 operation 을 그
인터페이스에 넣는 묶음 방식(`tag`, `path`)이 `namedBy`, 문서의 어떤 operation 에든 그
인터페이스 이름을 주는 방식이 `nameFrom` 입니다. 앞의 것이 뒤의 것을 다 덮을 때만,
빌드가 어느 방식을 쓰든 링크가 성립합니다. 그렇지 않으면 HEURISTIC 으로 남고, 근거가
어느 묶음 방식에 기대는지 말합니다(`naming`). 어느 쪽이든 근거에 선언을 적습니다
(`declared: {key, document}`). 반대 방향으로 선언한 문서(`openapi.generatedFromCode`)는
어떤 링크도 정하지 않습니다.

아깝게 빗나간 것은 잇지 않고 알립니다(`CONTRACT_NOT_LINKED`). 인터페이스 이름이 맞는
operationId가 서로 다른 두 라우트에 있는 경우(base path가 다른 문서 둘)와, operationId와
이름이 같은 메서드인데 그 operation이 다른 인터페이스로 생성될 경우입니다. 두 문서가
같은 라우트에 operationId를 두었으면 연결은 하나이고, 두 문서를 모두 적습니다.
프로젝트가 선언한 인터페이스는 Java 레인이 직접 읽습니다. 생성기가 다른 메서드 이름으로
바꾸는 operationId(하이픈이 든 것, Java 키워드)는 맞추지 않습니다. 코드가 이미 같은
메서드로 매핑한 라우트에는 엣지를 더 긋지 않고, 연결이 아니라 `alreadyHandled`로
따로 셉니다.

`analyze`는 룰이 핸들러를 준 라우트 수를 출력하고, `laneStats.openapi.contractLinks`에
그 목록과 잇지 않은 메서드, 선언에 기대지 않는 링크 수(`undeclared`)가 남습니다.
overview 의 `contract-links` 공백 항목은 추측인 링크만 셉니다. 선언에 기대지 않는 링크가
있는 동안에는 `openapi.generatesCode` 를 선언하라고 하고, `analyze` 도
`CONTRACT_FROM_DOCUMENT` 로 그렇게 말합니다. drift 집계는 여전히 이 라우트를 "선언됐지만 서빙되지 않음"으로
셉니다. 소스의 어떤 매핑도 이 라우트를 서빙하지 않기 때문입니다.

탐색은 라우트에서 핸들러로 가는 연결도 경로의 한 칸으로 봅니다. pack 전체를 보는 화면은
모드가 받아들이는 핸들러에서만 출발하고, 닿은 것의 등급을 그 연결 등급보다 높게
매기지 않습니다. `flow`도 같습니다. 그래서 이 라우트들은 `mode=heuristic`에서는 SQL까지
닿고, 기본값인 `conservative`에서는 닿지 않습니다. conservative에서는 탐색이 라우트에서
멈추고 그 이유를 말합니다. 선언으로 EXACT 가 되면 conservative 에서도 닿습니다.

### 프레임워크가 가진 래퍼 단계

web 레인은 래퍼 단계의 코드가 URL, 메서드, base URL 을 호출자가 준 그대로 넘긴다고
보여 줄 때만 그 단계를 정합니다([web 레인 설정](setup/web-lane.md)). 프레임워크의
클라이언트 클래스는 요청을 지역 변수에 담아 훅이 그 변수에 다시 대입하게 할 수
있습니다. 그런 단계는 위의 읽기로 정할 수 없고, 그게 맞습니다. 그런데 그 단계가 무엇을
하는지는 프레임워크 자신의 소스가 말해 줍니다. vue-vben-admin 의
`VAxios.request(config, options)` 는 요청을 복사하고, 템플릿의 `beforeRequestHook` 이
다시 돌려주게 하고, `requestOptions` 를 적고, `supportFormData` 가 본문을 바꾸게 한 뒤,
자기가 가진 axios 인스턴스에 넘깁니다.

`web.wrapper-hop` 룰은 그런 단계를 이름이 아니라 클래스의 모양으로 찾고, 그 단계가
키마다 무엇을 하는지 적습니다. `vben-admin` 팩의 룰은 이렇습니다.

```json
"params": {
  "client": { "module": "axios", "factory": "create" },
  "class": { "methods": ["getTransform", "setupInterceptors", "supportFormData", "uploadFile", "get", "post", "put", "delete", "request"] },
  "hop": { "method": "request", "config": 0, "options": 1 },
  "keys": {
    "url": [
      { "does": "prefix", "by": ["apiUrl", "urlPrefix", "joinPrefix"] },
      { "does": "append", "from": "params", "when": "text" },
      { "does": "query", "by": ["joinTime", "joinParamsToUrl"] }
    ],
    "method": [{ "does": "keep" }],
    "baseURL": [{ "does": "keep" }],
    ...
  },
  "framework": { "name": "...", "declares": "...", "source": "..." }
}
```

- `client`, `class`, `hop` 이 모양입니다. 클라이언트의 팩토리(`axios` 의 `axios.create`)로
  만든 필드가 있고, `class.methods` 에 적은 메서드를 모두 선언한 클래스입니다.
  `hop.method` 가 그 단계이고, `hop.config` 는 요청이 들어오는 매개변수, `hop.options` 는
  호출 자신의 옵션이 들어오는 매개변수입니다. 단계 함수는 둘 다 받아야 합니다. 클래스
  이름은 읽지 않습니다. 단계의 클라이언트 호출은 클래스가 가진 인스턴스를 거쳐야
  합니다. 걷기는 그 호출이 단계가 다시 대입하는 지역 변수를 넘기고, 호출자의 URL 이
  `hop.config` 의 객체 안에 들어올 때만 룰대로 읽습니다. 다른 모양은 코드대로 읽습니다.
- `keys` 는 단계가 키마다 무엇을 하는지 효과 하나에 한 단어로 적습니다. URL 은 `keep`,
  `set`, `prefix`, `append`, `query` 를, 다른 키는 `keep`, `set`, `change` 를 받습니다.
  `keep` 은 키를 그대로 넘깁니다. `set` 은 단계 자신의 값을 적으므로 정해지지 않습니다.
  `prefix` 는 `by` 에 적은 요청 옵션이 정하는 접두사 뒤로 URL 을 넘깁니다. `append` 는
  요청이 `from` 아래 들고 있는 값이 텍스트면 URL 경로 뒤에 붙입니다. `query` 는 쿼리
  문자열을 더하므로 경로는 그대로입니다. `change` 는 라우트와 상관없는 키(본문, 헤더)를
  바꾸는 것이고, 걷기는 따라가지 않습니다. `keep` 과 `set` 은 다른 효과와 함께 쓸 수
  없습니다. `url` 과 `method` 는 꼭 적어야 합니다.
- `framework` 는 어느 프레임워크인지, 룰이 그 단계의 어떤 동작에 기대는지, 누구든 어디서
  확인할 수 있는지 적습니다. 셋 다 필요합니다.

룰이 정하지 못하는 것은 엣지에 적고, 엣지는 HEURISTIC 으로 남습니다. 호출 자신의 옵션이
`prefix` 키 중 하나를 적거나 적을 수 있으면 `evidence.sink.unsettled.why: "hop-option"`
입니다. 옵션을 알면 함께 적습니다. 그 키를 하나도 적지 않은 객체 리터럴은 아무것도 바꾸지
않고, 이름이나 spread 는 담고 있을 수 있습니다. `append` 키 아래로 텍스트를 넘길 수 있는
호출은 `"hop-append"` 입니다. 객체나 배열로 쓴 `params` 는 텍스트가 아니고, 이름은
텍스트일 수 있습니다.

`prefix` 단계가 URL 앞에 붙이는 접두사는 클라이언트 클래스를 만들 때 받는 요청 옵션이
정하고, 이 레인은 그것을 읽지 않습니다. 그래서 그런 단계를 지나는 호출은 클라이언트
자신의 base URL 과 빈 접두사 중에서 매칭 개수로 접두사를 고릅니다
(`evidence.prefix.from: "auto"`. `evidence.prefix.hop` 이 룰과 옵션 키를 적습니다).
web 축은 `degraded` 가 되고 그렇다고 말합니다. 그 접두사는 `gatewayRoutes` 의 키
`"*"` 로만 선언합니다. 선언하면 룰이 정한 호출은 SOUND_SET 입니다.

엣지는 룰과 단계를 적습니다(`evidence.sink.hop`). 접두사 집계(`laneStats.web.prefix`)는
단계가 보는 클라이언트를 클라이언트 옆에 적고, `laneStats.web.calls.throughNamedStep` 은
룰마다 이름을 댄 단계를 지난 호출 수와 그중 정해진 수를 셉니다. `analyze` 는 룰마다 한
줄을 출력합니다. 두 룰이 한 단계를 가리키면 실행을 멈춥니다. 예제는 작은 프런트엔드이고,
실제 web 워커가 읽고 web 레인이 그 룰 하나만으로 걷습니다.

`vben-admin` 팩은 jeecg-boot 가 가진 프레임워크 사본
(`jeecgboot-vue3/src/utils/http/axios`)을 보고 썼습니다. 단계가 돌리는 훅은 프레임워크
템플릿의 것으로, 프로젝트 자신의 `src/utils/http/axios/index.ts` 에 적혀 있습니다.
`beforeRequestHook` 이 URL 에 접두사, 텍스트 params, 쿼리 문자열보다 더 많은 일을 하는
프로젝트는 이 룰이 말하는 것이 아닙니다.

### TypeScript 백엔드의 종류

NestJS, Prisma, TypeORM 팩(`nestjs.json`, `prisma.json`, `typeorm.json`)에는 TS 레인이
세 프레임워크에 대해 아는 것이 들어 있습니다. 데코레이터 이름, 부트스트랩 호출,
클라이언트 타입, 그리고 Prisma 호출이 받는 키마다의 역할입니다(`where`는 조건,
`select`는 가져올 컬럼, `data`는 쓰기, `include`는 연관 테이블). 프로젝트가 데코레이터
이름을 바꿨거나 새 Prisma 버전이 연산을 더했다면 코드가 아니라 팩을 고치고, 그걸 보여
주는 예제를 하나 붙입니다. `prisma.nestjs-prisma-service` 룰은 위의 라이브러리 타입과 같은 경우입니다.
무엇을 믿는지와 어디서 확인하는지를 적고, 그 룰이 만든 연결은 SOUND_SET 등급을 받습니다.

- `prisma.operations`에는 relation을 따라가는 방법도 적혀 있습니다. relation 필터
  (`some`, `every`, `none`, `is`, `isNot`), 그중 `null`을 받으면 연결만 확인하는 것
  (`relationNullFilters`), `_count`가 읽는 것, 중첩 쓰기마다 관련 행과 연결에 하는 일,
  그리고 중첩 쓰기가 아무것도 바꾸지 않게 만드는 리터럴 값(`idle`)입니다. 항목마다
  값, 적용되는 relation, 그리고 엣지를 전부 빼는지 쓰기만 빼는지를 적습니다.
  `delete: []`도 관련 행을 찾아보기는 하기 때문입니다. `lookup`에는 중첩 쓰기와
  relation 종류마다, Prisma가 쓰기 전에 어떤 행을 SELECT하는지 적습니다. 값이 이름을 댄
  행(`named`, connect가 찾는 행)과, 매달린 행에 연결된 행(`linked`, delete가 찾는
  행)입니다. `nests`와 `argumentRows`는 어느 행이 새로 만드는 행인지 적습니다. 새 행에는
  아직 연결된 것이 없기 때문입니다. `extensions`에는 `$extends`, 호출이 보내는 것을 바꿀
  수 있는 부분(`query`), `Prisma.defineExtension`, 그리고 `result` 부분에서 계산 필드가
  어떤 필드를 필요로 하는지 적는 곳이 들어 있습니다.
- `nestjs.providers`(종류 `ts.provider-binding`)는 모듈이 타입에 묶는 것을 읽습니다.
  클래스만 적으면 자기 자신을 묶고, `{ provide: T, useClass: C }`는 T에 C를 묶습니다.
  `useFactory`, `useValue`, `useExisting`으로 한 바인딩은 이름만 남기고 읽지 않습니다.
  생성자 매개변수의 데코레이터가 하는 일도 적습니다. `@Inject(token)`은 타입이 아니라
  그 토큰으로 채웁니다(`injectByToken`). `@Optional`, `@Self`, `@SkipSelf`, `@Host`는
  아무것도 바꾸지 않습니다(`harmless`). 그 밖의 데코레이터는 모르는 것이라, 무엇으로
  채우는지 정하지 않습니다. `@Inject`를 감싼 프로젝트 자체 데코레이터도 여기
  해당합니다. `consumed`에는 패키지 모듈의 async 옵션에서 패키지가 읽기만 하는
  키(`imports`, `inject`, `useClass`, `useExisting`, `useFactory`)를 적습니다. 거기 적힌
  타입은 패키지에 넘겨 묶게 한 것으로 치지 않습니다. 레인은 이 바인딩으로, 추상
  클래스나 인터페이스를 거친 호출이 어느 클래스에 닿을 수 있는지 좁힙니다. 클래스를
  거친 호출이 그 자리에 묶인 다른 클래스로 가는지도 이것으로 정합니다.
- `typescript.test-support`(종류 `ts.test-support`, 팩 `typescript.json`)에는 파일을
  테스트 지원 파일로 만드는 폴더 이름(`__mocks__`, `testing`, `e2e` 등)과 파일 이름
  끝(`.spec.ts`, `.mock.ts`, `.stub.ts`, `.stories.ts` 등)이 있습니다. 레인은 그런
  파일을 뺍니다. 애플리케이션 루트 안이든 공유 라이브러리 안이든 같습니다. mock
  클래스를 애플리케이션 코드로 읽으면, 호출이 닿을 클래스가 하나 더 생기기 때문입니다.
  다만 레인이 읽는 파일이 import 하면 애플리케이션의 것으로 읽습니다. 애플리케이션은
  import 한 것을 실행하기 때문이고, `testing` 기능 모듈도 그렇습니다. barrel 이 다시
  export 만 하는 파일은 계속 뺍니다. 뺀 것은 알립니다(`TS_FILES_LEFT_OUT`).
- `typeorm` 팩은 종류마다 룰이 하나씩입니다. `typeorm.entities`에는 엔티티·컬럼·
  relation 데코레이터, 읽지 않는 데코레이터(`@ChildEntity`, `@ViewEntity`,
  `@TableInheritance`, `@Tree`), 애플리케이션이 DataSource 옵션을 적는 곳
  (`TypeOrmModule.forRoot`와 `forRootAsync`, `createConnection`, `new DataSource`),
  그리고 아는 naming strategy 둘이 있습니다. `default`(TypeORM의
  `DefaultNamingStrategy`)와 `snake`(typeorm-naming-strategies의 `SnakeNamingStrategy`)이고,
  테이블, 컬럼, 조인 컬럼, 조인 테이블과 그 컬럼에 각각 어떤 변환을 하는지 적혀
  있습니다. 프로필의 `tsBackend.typeorm.namingStrategy`에는 이 둘 중 하나를 적습니다.
  `tablePath`에는 드라이버 `type`마다 테이블 이름 앞에 무엇이 붙는지 적습니다.
  스키마(PostgreSQL, CockroachDB, Oracle, SAP), database(MySQL, MariaDB, Spanner),
  둘 다(SQL Server), 엔티티가 가리키는 데이터베이스 파일에 드라이버가 붙이는 이름
  (`attached`: `sqlite`, `better-sqlite3`, `react-native`), 아무것도 없음(`sqljs`,
  `capacitor`, `cordova`, `nativescript`, `expo`)입니다. 프로필의
  `tsBackend.typeorm.type` 에는 이 드라이버 중 하나를 적습니다.
  `autoColumns`에는 어느 문장이 생성 날짜, 수정 날짜, 버전을 스스로 채우는지 적고,
  `insertKey`는 컬럼을 insert에서 빼는 컬럼 옵션입니다.
  `typeorm.receivers`에는 repository, entity manager, data source를 주는 타입, 주입
  데코레이터, 함수, 멤버가 있습니다. `typeorm.operations`에는 모든 연산과 그 연산이
  보내는 문장, 인자 부분마다의 역할, 그리고 TypeORM 0.2에서 find의 옵션과 조건을
  구별하는 방법이 있습니다. `eagerJoined`는 eager relation을 고르지 않고 조인하는
  연산(count, exists, 집계)을 표시하고, `sends`는 쓰기가 거치는 문장을 적습니다(`save`는
  insert 아니면 update). find 옵션 `withDeleted` 는 `with-deleted` 역할입니다.
  `typeorm.query-builder`에는 builder 메서드마다의 역할(`clone`과 `subQuery`는 builder를
  하나 더 만들고, `withDeleted` 는 `with-deleted` 입니다)과, 조건 안에서 컬럼이 아니라
  SQL 단어인 것들이 있습니다.

자세한 내용은 [TS 레인 설정](setup/ts-lane.md)에 있습니다.

예제가 소스 코드인 종류는 실제 워커로 예제를 돌립니다. Java 종류의 예제
(`java.type-role`, `java.code-setting`, `java.route-function`, `java.contract-link`)는
Java 라서 분석 때와 같은 Java 워커가 읽고, 그래서 JDK 가 필요합니다. `java.contract-link`
예제에는 OpenAPI 문서도 들어 있는데, 이건 엔진의 OpenAPI 리더가 프로세스 안에서 읽습니다.
TS 종류의 예제는 TS 워커가 프로세스 안에서 바로 읽으니 Node 말고는 필요한 게 없습니다.
JDK 가 없으면 Java 예제는 "실행 안 됨"으로 보고되고, `cascade rules test` 는 0 이 아니라
2 로 끝납니다. 아무도 실행하지 않은 예제를 통과로 치지 않기 때문입니다.
