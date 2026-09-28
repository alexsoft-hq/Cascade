[English](../../setup/ts-lane.md) | **한국어**

# TypeScript 레인(NestJS, Prisma, TypeORM) 설정

TypeScript 레인은 **NestJS 백엔드**를 읽습니다. 컨트롤러가 여는 라우트, 메서드끼리의
호출, 그리고 **Prisma**나 **TypeORM** 호출 하나하나를 SQL 문장으로 읽습니다. 그
문장이 건드리는 테이블·컬럼은 `schema.prisma`나 TypeORM 엔티티가 선언한 것입니다. Spring 애플리케이션에서 Java 레인이 하는 일과 같은 왕복입니다
(`endpoint → handler → service → statement → table → column`). 그래서 웹 레인이 읽은
프런트엔드 호출이 Spring 라우트를 만나듯 Nest 라우트도 그대로 만납니다.

모르는 것을 아는 것처럼 적지 않습니다. 주소가 변수에 들어 있는 라우트는 만들지
않습니다. 읽지 못한 제외 패턴이 이름을 댈 수도 있는 라우트는 만들되 HEURISTIC(추정)
등급을 붙입니다. 이 레인이 읽지 못한 Prisma·TypeORM 인자는 문장에 이름을 남깁니다. 이런
빈틈은 모두 진단 메시지로 이유를 알려 줍니다.

## 무엇이 필요한가

**Node, 그것뿐입니다.** 웹 레인이 동봉한 파서
(`adapters/web/vendor/babel-parser.cjs`)로 읽기 때문에 TypeScript 컴파일러도,
`npm install`도, 빌드도 필요 없습니다. 소스를 읽기만 하고 실행하지는 않습니다.

## 실행

```
cascade init --root .        # NestJS 애플리케이션을 찾아 프로필에 적는다
cascade analyze --root .     # 플래그 없이 그대로 읽는다
```

`cascade init`은 부트스트랩(애플리케이션을 띄우는 코드)으로 애플리케이션을 찾습니다.
`@nestjs/core`에 의존하는 패키지 아래에서 `NestFactory.create`를 부르는 `.ts` 파일입니다.
테스트 폴더는 뺍니다. 그 파일의 폴더가 `profile.tsBackend.app`이 되고,
`frameworkPacks`에 `nestjs`가 들어갑니다.

둘을 찾으면 아무것도 적지 않고 둘 다 알려 줍니다. pack 하나는 **애플리케이션 하나**만
읽습니다. 엔드포인트는 메서드와 경로만으로 구분하므로, 두 애플리케이션의 라우트가
섞이면 하나로 합쳐져 버립니다. 애플리케이션마다 프로젝트를 따로 두면 됩니다.

`--ts-src <dir>`로 이번 실행에서만 애플리케이션을 지정할 수 있고, `--no-ts`로 이
레인을 끌 수 있습니다. 프런트엔드 루트가 백엔드까지 품고 있는 경우도 있습니다.
ghostfolio 같은 Nx 워크스페이스는 `package.json` 하나로 둘을 함께 관리합니다. 이때
웹 레인은 백엔드 파일을 **빼고** 읽습니다. 그 파일은 이 레인의 몫입니다. 이 레인은
애플리케이션 루트를 읽고, import가 닿는 분석 루트 안의 다른 파일도 읽습니다(아래
"공유 라이브러리" 절).

레인 요약 줄은 이렇게 나옵니다.

```
TypeScript lane: 310 file(s), 118 route(s) from 34 registered controller(s), 1368 call(s) linked, 1001 into packages, 1777 on a receiver not typed here; Prisma: 149 statement(s) from 149 client call(s)
```

실행에서 더 찾은 것이 있으면 줄이 길어집니다. import를 따라가다 애플리케이션 밖에서
읽은 파일 수, 연결한 호출 가운데 그 파일로 들어간 수, 프로젝트 클래스가 상속·구현하는
타입을 거친 호출 수가 붙습니다. 마지막 것에는 모듈 바인딩으로 확정된 수와 HEURISTIC
등급을 받은 수도 함께 나옵니다. TypeORM 애플리케이션이면 Prisma 부분 뒤에 TypeORM 문장
수, 엔티티 수, 네이밍 전략(naming strategy, 이름을 만드는 규칙)이 붙습니다.
`schema.prisma`를 읽었으면 `TypeScript lane: schema.prisma:`로 시작하는 둘째 줄이
나옵니다. schema가 선언한 테이블·컬럼 수(SQL 카탈로그가 있으면 뒷받침한 수와 불일치
수), relation에서 나온 조인 수, relation을 따라간 문장 수, `$extends`로 만든
클라이언트를 거친 문장 수를 알려 줍니다.

## 라우트

컨트롤러 클래스가 있다고 라우트가 되지는 않습니다. 애플리케이션이 불러오는 모듈이
그 컨트롤러를 등록해야 서비스됩니다. 부트스트랩이 `NestFactory.create`에 넘긴
모듈에서 시작해 각 모듈의 `imports`를 따라갑니다. 모듈 클래스, `X.forRoot(...)`,
`forwardRef(() => X)`를 모두 따라갑니다. 어느 모듈도 등록하지 않은 컨트롤러는
`meta.laneStats.ts.unregisteredControllers`에 이름을 남기고, 라우트는 만들지 않습니다.

클래스는 Nest가 읽는 방식대로 읽습니다. 데코레이터는 패키지가 붙인 이름으로 봅니다.
`import { Controller as Ctl } from '@nestjs/common'`의 `Ctl`도, `import * as common`을
거친 `common.Controller`도 `Controller`입니다. 프로젝트가 직접 만든 `Controller`라는
데코레이터는 Nest의 것이 아닙니다. 컨트롤러는 자기 메서드뿐 아니라 프로젝트 안의 부모
클래스에서 물려받은 라우트 메서드도 서비스합니다. Nest가 프로토타입 체인을 훑는 것과
같습니다. 그런 라우트의 핸들러는 그 메서드를 선언한 클래스의 메서드입니다.

애플리케이션은 부트스트랩이 `listen`까지 하는 쪽입니다. 설정만 읽으려고 만들었다가
닫는 애플리케이션은 해당하지 않습니다. 설정은 그 애플리케이션에 대고 부르는
호출입니다. 부트스트랩 안에서도 찾고, 애플리케이션을 넘겨받는 프로젝트 함수 안에서도
찾습니다. `configure(app)`이면 그 함수의 매개변수 이름으로 따라갑니다. 주소 규칙은
Nest가 적용하는 방식 그대로 적용합니다.

| 소스 | 라우트 |
|---|---|
| `app.setGlobalPrefix('api')` | 모든 라우트 앞에 `/api/...` |
| 그 옵션의 `exclude: ['health']` | `/health`는 prefix 없이 서비스 |
| `exclude: [{ path: 'health', method: RequestMethod.GET }]` | `GET /health`만 prefix 없이 서비스 |
| `exclude: ['docs{/*rest}', 'users/:id']` | Nest 11 방식으로 맞춰 봄. `:name`은 한 구간, `*name`은 나머지 전부, `{...}`는 있어도 되고 없어도 됨, 대소문자 무시 |
| `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })` | `/api/v1/...` |
| `@Controller({ path: 'users', version: ['1', '2'] })` | 버전마다 라우트 하나씩 |
| 메서드의 `@Version('2')` | 컨트롤러 설정과 상관없이 그 라우트는 v2 |
| `@Version(VERSION_NEUTRAL)` | 버전 구간 없음 |
| `RouterModule.register([{ path: 'admin', module: AdminModule }])` | AdminModule이 선언한 컨트롤러의 라우트 앞에 `/admin` |
| `@Get(':id')` | `{id}`. 다른 레인이 경로 변수를 쓰는 방식과 같습니다 |

**모르면 라우트를 만들지 않습니다.** 설정은 확실할 때만 압니다. 실행되지 않을 수
있는 호출(조건문 안, 반복문 안, 콜백 안), 서로 다른 값을 넣는 두 호출, 애플리케이션이
아닌 대상에 같은 이름으로 부르는 호출, 이 엔진이 읽지 못하는 코드에 애플리케이션을
넘기는 호출은 모두 그 설정을 "모름"으로 만듭니다. 아래는 모두 실행 결과에 진단으로
남습니다.

| 진단 | 소스가 한 일 | 결과 |
|---|---|---|
| `TS_APP_NOT_FOUND` | `NestFactory.create`가 없거나, 여러 개인데 `listen`하는 쪽이 하나로 정해지지 않음 | 라우트 없음 |
| `TS_PREFIX_UNREAD` | 전역 prefix를 설정에서 읽음(`configService.get('app.apiPrefix')`), 조건 안에서 정함, 서로 다른 값으로 두 번 정함, 읽지 못하는 코드에 애플리케이션을 넘김 | `tsBackend.globalPrefix`에 배포 값을 적기 전까지 라우트 없음 |
| `TS_VERSIONING_UNREAD` | 같은 이유로 버전 옵션을 모름 | 라우트 없음 |
| `TS_ROUTER_MODULE_UNREAD` | `RouterModule.register` 인자가 리터럴이 아님 | 라우트 없음 |
| `TS_ROUTE_PATH_UNREAD`, `TS_ROUTE_VERSION_UNREAD` | 라우트 하나의 경로나 버전이 변수에 있거나, 펼치기가 바꿀 수 있는 옵션에 있음(`@Controller({ ...base })`) | 그 라우트만 만들지 않음 |
| `TS_MODULE_UNREAD` | 모듈 옵션을 통째로 읽을 수 없음(변수, 목록을 덮어쓸 수 있는 펼치기) | 그 모듈이 import하거나 등록한 것은 서비스하지 않음 |
| `TS_MODULE_IMPORT_UNREAD` | 모듈 목록에 변수(`isDocumentDb ? A : B`)나 펼치기가 있음 | 그 안의 모듈은 따라가지 않음 |
| `TS_ROUTES_WITHOUT_CONTROLLER` | 메서드가 라우트를 선언했는데 Nest 컨트롤러 데코레이터가 붙지 않은 클래스(`Controller`를 감싼 프로젝트 자체 데코레이터) | 그 라우트는 서비스하지 않음 |
| `TS_PREFIX_EXCLUDE_UNREAD` | 이 엔진이 읽지 못하는 exclude 항목: 템플릿 문자열, 목록 펼치기, 다른 문법의 패턴 | prefix 아래 모든 라우트를 prefix 붙은 주소로 만들고 HEURISTIC 등급을 붙임. 그 항목이 이름을 댈 수도 있기 때문. `tsBackend.globalPrefixExclude`에 목록을 적으면 EXACT가 됨 |
| `TS_PREFIX_DECLARED` | 프로필의 `tsBackend.globalPrefix`가 부트스트랩의 리터럴과 다름 | 프로필 값을 씀 |

무언가를 모르는데도 만드는 주소는 딱 하나, 읽지 못한 exclude가 바꿀 수 있는 주소입니다.
라우트는 분명히 있고 핸들러도 확실합니다. 그래서 그 항목이 이름을 대지 않았다면 갖게
될 주소로 만들고, HANDLES 엣지를 HEURISTIC으로 매겨 근거에 이유를 적습니다. 기본
`conservative` 모드의 걷기는 이 엣지를 지나지 않고, `heuristic` 모드는 지나갑니다.

패키지에서 가져온 모듈(`ConfigModule.forRoot()`, `JwtModule`)은 그 패키지의 것이라
빈틈으로 치지 않습니다. 패키지 코드는 읽지 않으니, 그 모듈이 여는 라우트도 읽지
않습니다.

## 호출

메서드가 부르는 대상을 이 레인이 타입으로 알 수 있으면, SOUND_SET 등급의 `MAY_CALL`
엣지로 잇습니다.

| 규칙(`evidence.rule`) | 호출 |
|---|---|
| `ts-this-method` | `this.m()`: 같은 클래스나 상속한 클래스의 메서드 |
| `ts-injected-field` | `this.svc.m()`: 생성자로 주입한 필드의 타입 클래스의 메서드 |
| `ts-this-dispatch` | 프로젝트 클래스가 상속하는 클래스 안의 `this.m()`: 이 클래스와 하위 클래스 각각에서 가장 가까운 `m` 선언 |
| `ts-field-dispatch` | 필드 타입이 추상 클래스, 인터페이스, 또는 프로젝트가 상속하는 클래스인 `this.svc.m()`: 그 필드에 들어갈 수 있는 클래스 각각에서 가장 가까운 `m` 선언 |
| `ts-function` | `f()`: 파일이 선언하거나 이름으로 import한 함수 |
| `ts-static-method` | `Cls.m()`: 파일이 가리키는 클래스의 static 메서드 |

등급이 SOUND_SET인 이유가 있습니다. 하위 클래스가 메서드를 덮어쓸 수 있고, 필드
타입에 실제로 묶이는 provider가 다른 클래스일 수도 있습니다. 프로젝트 클래스가 그 타입을
실제로 상속하거나 구현하면, 호출을 그 클래스 각각으로 잇습니다(아래). 패키지로 들어가는 호출은
따로 셉니다. 이 레인이 타입을 모르는 대상(지역 변수, 매개변수, 필드를 거친 체인)에
대한 호출과는 다릅니다. 앞의 것은 프로젝트 연결의 빈틈이 아니고, 뒤의 것은 빈틈입니다.
데코레이터는 메서드가 부르는 호출이 아닙니다. 클래스를 정의할 때 한 번 실행될 뿐입니다.

### 추상 클래스나 인터페이스를 거친 호출

추상 클래스로 타입을 적은 필드에 `this.users.findById(id)`를 부르면, 실제로 도는 것은
Nest가 주입한 객체의 `findById`입니다. 본문 없는 추상 선언은 돌지 않습니다. 인터페이스는
아예 본문이 없습니다. 부모 클래스 안의 `this.m()`도 `this`가 하위 클래스 인스턴스면 하위
클래스가 덮어쓴 메서드가 돕니다. 그래서 프로젝트 클래스가 상속하거나 구현하는 타입을
거친 호출은, 그 타입 자신과 그런 클래스 각각(직접이든 다른 클래스·인터페이스를 거쳐서든)
에서 가장 가까운 메서드 선언으로 이어집니다. 추상 메서드는 대상이 되지 않습니다.
`evidence.dispatch`에 타입과 후보 메서드 수(`candidates`)가 남습니다. 프로젝트 안에서
아무 클래스도 상속·구현하지 않는 타입은 예전처럼 잇습니다.

후보 집합은 프로젝트 소스의 `extends`, `implements` 절만 보고 만듭니다. 그런데
TypeScript는 둘 다 적지 않은 객체도 모양만 맞으면 그 타입으로 받아 줍니다. 그래서
무언가가 집합을 확정해 줄 때만 완전한 집합으로 봅니다.

- 필드라면 NestJS 모듈이 그 타입에 무엇을 묶었는지(바인딩)가 확정합니다(규칙
  `nestjs.providers`, 종류 `ts.provider-binding`). `providers`에 클래스만 적으면 그
  클래스 자신이 묶이고, `{ provide: T, useClass: C }`는 `T`에 `C`를 묶습니다. 먼저
  애플리케이션이 실제로 불러오는 모듈을 읽습니다. 루트 모듈에서 시작해 각 모듈의
  imports를 따라가고, 이 길을 빠짐없이 읽었을 때만 이것으로 정합니다. 그러지 못하면
  트리 안의 모든 모듈을 읽고, 모듈의 static 메서드(`forRoot()`)가 돌려주는 모듈도 함께
  봅니다. 바인딩이 집합을 확정하면 엣지는 묶인 클래스로만 갑니다. 이때
  `evidence.dispatch`에 바인딩한 모듈(`bound`), 어느 쪽 읽기로 정했는지(`boundBy`),
  원래 후보가 몇 개였는지(`narrowedFrom`)가 남습니다.
- `this.m()`이라면 `this`는 늘 이 트리 안 클래스의 인스턴스입니다. 다만 그 타입의
  패키지가 배포될 수 있으면 그렇게 볼 수 없습니다.

집합이 완전하면 엣지는 SOUND_SET입니다. 빠진 것이 있을 수 있으면 HEURISTIC이고, 이유를
`evidence.dispatch.incomplete`에 적습니다.

- `useFactory`, `useValue`, `useExisting`으로 묶었습니다. 이 방식은 읽지 않습니다.
- 이 엔진이 읽지 못하는 provider, providers 목록, 모듈이 있습니다.
- imports에서 패키지 모듈에 그 타입을 넘겼습니다. 그 모듈이 타입을 묶을 수 있습니다.
- 어느 모듈도 그 타입을 묶지 않았습니다.
- 생성자 매개변수에 `@Inject(token)`이 붙었습니다. 무엇을 넣을지는 타입이 아니라 토큰이
  정합니다.
- 필드가 그 클래스 자신의 생성자 매개변수가 아닙니다. Nest는 그런 필드를 채우지 않습니다.
- 코드가 그 클래스를 `new`로 직접 만듭니다. 그러면 무엇이든 넘길 수 있습니다.
- 타입을 선언한 패키지가 배포될 수 있습니다. 애플리케이션 자신의 패키지도 아니고
  `"private": true`도 아니면, 이 트리 밖의 클래스가 그 타입을 상속할 수 있습니다.

`TS_DISPATCH_INCOMPLETE`는 HEURISTIC이 된 호출 수와 가장 흔한 이유를 알려 줍니다.
`TS_BINDING_NOT_READ`는 이 엔진이 읽지 못하는 방식으로 묶인 타입을 하나씩 알려 줍니다.

## 공유 라이브러리

모노레포의 애플리케이션은 자기 루트 밖의 코드를 import합니다. tsconfig의 `paths`
별칭, `baseUrl`, 상대 경로로 닿는 공유 라이브러리입니다. 이 레인은 애플리케이션 파일을
읽은 다음, 그 파일들의 import와 re-export가 닿는 파일을 분석 루트 안에서 한 바퀴씩 더
읽습니다. 새 파일이 나오지 않을 때까지 되풀이합니다. import 경로는 브리지와 똑같은
방식으로 풉니다. 그래서 import 하나를 두고 이 단계가 읽는 파일과 브리지가 그 import의
뜻으로 보는 파일이 같습니다. `node_modules`, 테스트 파일과 테스트 폴더, 분석 루트 밖
파일은 읽지 않습니다. 이런 라이브러리에서 가져온 이름은 애플리케이션 자신의 코드처럼
잇고, 패키지로 세지 않습니다.

애플리케이션 밖에서 읽은 파일은 `meta.laneStats.ts.reached`에 남고, 레인 요약 줄에도
개수가 나옵니다. 이 파일도 다른 파일처럼 분석 입력이라, 하나라도 HEAD와 다르면 pack이
dirty로 표시됩니다.

웹 레인도 읽는 파일(프런트엔드와 백엔드가 같이 쓰는 라이브러리)은 레인마다
shard(파일별 캐시 조각)를 따로 둡니다. 그래서 한 레인 때문에 다른 레인이 그 파일을
다시 읽는 일이 없습니다. 두 레인이 같이 만든 함수는 코드가 하나이므로 노드도 하나이고,
`lanes`에 두 레인이 모두 적힙니다. `TS_SYMBOL_SHARED_WITH_WEB`이 그런 함수를 알려
줍니다. 웹 레인은 그 함수가 보내는 요청의 주소를 프런트엔드 규칙으로 정합니다. 그래서
백엔드 라우트에서 출발한 걷기가 그 함수를 지나면, 그 요청도 프런트엔드가 쓸 주소로
따라갑니다.

## Prisma

필드가 Prisma 클라이언트인 경우는 셋입니다. `@prisma/client`의 `PrismaClient`로
타입을 적은 경우, 그걸 상속한 프로젝트 클래스(흔히 쓰는 `PrismaService`)로 적은
경우, `nestjs-prisma`의 `PrismaService`로 적은 경우입니다. 마지막은 라이브러리의
타입이라 연결을 SOUND_SET으로 매기고, 근거에 라이브러리를 적습니다. 규칙 팩
(`src/core/rules/packs/prisma.json`)에 그렇게 정해 두었습니다.

**호출한 자리마다 문장 하나입니다.** `statement:prisma:<file>#<Class.method>/<n>`은
그 메서드의 n번째 클라이언트 호출입니다. 같은 모델을 두 번 부르면서 `select`가
다르면 문장도 둘입니다. 그래서 한쪽이 읽는 컬럼이 다른 쪽 호출자에게 번지지
않습니다. 모델은 델리게이트 이름으로 찾습니다(`this.prisma.userProfile`이면
`UserProfile`). 테이블은 `@@map` 또는 모델 이름이고, 스키마는 `@@schema`가 정한
것입니다(Prisma의 멀티 스키마). 컬럼은 `@map` 또는 필드 이름입니다.

대화형 트랜잭션 `this.prisma.$transaction(async (tx) => { ... })`은 콜백에
클라이언트를 넘깁니다. 콜백 안에서 `tx`로 부른 호출은 `this.prisma`로 부른 것과
똑같이 읽고, 같은 메서드의 순서에 넣으며, 근거에 `transaction: "$transaction"`을
남깁니다. 배열 형태 `$transaction([this.prisma.a.update(...), ...])`은 호출
하나하나로 읽습니다.

무엇을 읽고 쓰는지는 인자에서 나옵니다. `prisma.operation` 규칙이 `select`,
`where`, `orderBy`, `data` 같은 키마다 역할을 정해 두고 그대로 읽습니다. 필터의
`AND`, `OR`, `NOT` 안으로도 들어갑니다. 복합 unique·id 키는 schema가 그 이름으로
묶은 필드를 읽습니다(`@@unique([a, b], name: "pair")`, 이름이 없으면 `a_b`). 키를
`_`로 쪼개서 필드를 짐작하지 않습니다. 호출이 이름을 댄 relation은 그 relation이
닿는 모델까지 따라갑니다(아래 "relation 따라가기" 절). 규칙이 따라가지 못한 것은
문장에 남깁니다.

- `relation-not-followed`: schema만으로는 이 레인이 자리를 정할 수 없는 relation.
  이유를 함께 적습니다.
- `argument-not-read`: 규칙이 모르는 키. 어느 경로에서 나온 키인지 함께 적습니다.
- `columnsRuntimeOnly`: 인자를 변수로 넘겼거나, 펼치기나 계산된 키로 썼기 때문에
  어느 컬럼인지 실행해 봐야 아는 경우. 문장에 그 키 이름을 남깁니다.
- `select` 값이 `true`도 `false`도 아니면(`email: showEmail`) 그 컬럼을 읽을 수도
  있습니다. 이 READS 엣지는 SOUND_SET 등급이고, 문장에 불확실하게 만든 키를 적습니다.

`select`가 없고 인자를 통째로 읽었으면, 모델의 스칼라 컬럼을 모두 읽는 것으로 봅니다.

schema에 있는 모델과 연산 이름으로 부르는데 이 레인이 클라이언트라고 알지 못하는
대상에 부른 호출(매개변수로 넘겨받은 클라이언트, 다시 대입한 지역 변수)은 문장을
만들지 않습니다. 대신 `TS_PRISMA_CALL_UNREAD`로 개수와 몇 곳의 위치를 알려 주고,
이유를 알면 이유도 적습니다.

`schema.prisma`는 애플리케이션 루트나 그 위의 `prisma/schema.prisma`에서 찾습니다.
Prisma가 가장 먼저 보는 자리입니다. 다른 곳에 있다면 패키지의
`"prisma": { "schema": ... }`나 프로필의 `tsBackend.prismaSchema`로 지정합니다. 이
파일은 실행할 때마다 다시 읽고, 경로와 sha256, provider를 `meta.laneStats.ts`에
남깁니다.

### schema.prisma가 카탈로그입니다

`schema.prisma`의 모델은 모두 테이블이 되고, 스칼라 필드는 모두 컬럼이 됩니다. 호출이
이름을 댔는지와 상관없습니다. `view` 블록도 똑같이 읽습니다. 노드 모양은 SQL 레인이
DDL로 만드는 것과 같습니다. 컬럼에는 schema에 적힌 그대로의 타입(`String`,
`String[]`, enum 이름, `@db.X` 속성이 있으면 `nativeType`)이 붙습니다. `?`에서
`nullable`을, `@id`나 `@@id`에서 `pk`를 읽습니다. 노드마다 `declaredBy: "prisma"`가
붙습니다. relation 하나는 두 테이블 사이의 `JOINS` 엣지 하나입니다. `fields`와
`references`가 가리키는 컬럼으로 잇고, schema가 직접 말하는 것이라 EXACT입니다.

암묵적 다대다(implicit many-to-many)는 양쪽이 목록이고 어느 쪽에도 `fields`가 없는
relation입니다. 이 경우 Prisma가 만드는 테이블이 됩니다. 이름은 `_`에 relation 이름을
붙인 것이고, 이름이 없으면 두 모델 이름을 알파벳 순으로 `To`로 이은 것입니다
(`_OrderToTag`). 컬럼 `A`와 `B`는 첫째 모델과 둘째 모델의 id를 가리키고, 두 모델과
각각 조인됩니다. `(A, B)`가 기본키인지 unique 인덱스인지는 Prisma 버전마다 달라서,
어느 컬럼도 키라고 적지 않습니다. 목록 컬럼이 NULL을 허용하는지는 schema에 없어서,
목록의 `nullable`은 null입니다. DDL이 없으면 pack의 `meta.catalog`는
`{source: "prisma", path, sha256}`이고, catalog 축은 `axes.catalog.sources`에
`schema.prisma`를 적고 shipped가 됩니다. 이름이 어디서 왔는지는 답을 제한하는 것이
아니므로 note로 달지 않습니다.

SQL 카탈로그(DDL로 지정한 마이그레이션이나 스냅샷)도 함께 읽으면, 그 카탈로그가
선언한 테이블을 두 번 선언하지 않습니다. 노드는 SQL 레인 것으로 두고, schema가 그
노드를 뒷받침합니다(`prismaModel`, `prismaField`). 둘이 다르게 말하는 것은 불일치로
셉니다. 한쪽에만 있는 테이블이나 컬럼(`table-not-in-catalog`,
`column-not-in-catalog`, `table-not-in-schema`, `column-not-in-schema`), 기본키
(`pk-differs`), null 허용 여부(`nullable-differs`)입니다.

어느 쪽이 더 새것인지는 정하지 않습니다. 마이그레이션이 schema보다 늦을 수도 있고,
schema가 DB보다 늦을 수도 있기 때문입니다. 그래서 키나 null 허용 여부가 서로 다른
컬럼은 두 값을 출처별로 노드에 함께 남깁니다.
`declarationsDiffer: { pk: { catalog, prisma }, nullable: { catalog, prisma } }`
입니다. 노드 자신의 `pk`는 노드와 마찬가지로 SQL 카탈로그 쪽 값입니다. 불일치는 모두
`meta.laneStats.ts.prisma.catalog`에 세고, `PRISMA_CATALOG_DISAGREES` 진단 하나로
알리고, catalog 축에 note로 답니다. schema에만 있는 컬럼은 schema 것으로 더합니다.
클라이언트가 그 컬럼을 보내기 때문입니다. SQL 카탈로그에만 있는 컬럼은 알리기만
합니다. 어떤 Prisma 호출도 그 컬럼을 이름으로 댈 수 없기 때문입니다. 타입은 비교하지
않습니다. Prisma의 `String`과 DB의 `TEXT`는 어휘가 다를 뿐 불일치가 아닙니다.

### relation 따라가기

호출이 이름을 댄 relation은 그 relation이 닿는 모델까지 따라갑니다. `include`나
`select` 안(`true`면 그 행 전체, 객체면 그 자리에서 따로 하는 find 하나), 필터
(`some`, `every`, `none`, `is`, `isNot`, 또는 to-one 필터를 바로 쓴 것), `orderBy`,
`_count`, 그리고 중첩 쓰기(nested write: `create`, `createMany`, `connect`,
`connectOrCreate`, `set`, `disconnect`, `update`, `updateMany`, `upsert`, `delete`,
`deleteMany`)가 여기 해당합니다. 그러면 문장은 관련 테이블과 컬럼을 읽거나 쓰거나
지우고, 양쪽에서 조인이 맞추는 컬럼을 읽습니다. 연결을 걸거나 끊는 쓰기는 연결을 담은
컬럼을 씁니다. 그 컬럼이 어느 쪽에 있든 마찬가지이고, 암묵적 테이블이면 그 행을 넣거나
지웁니다. 이런 엣지는 모두 `evidence.relation`에 relation 이름을 남깁니다. 이름
목록은 팩 데이터입니다(`prisma.json`: `relationFilters`, `relationNullFilters`,
`relationCount`, `nestedWrites`).

relation은 따로 문장이 되지 않고, 그 호출의 문장에 들어갑니다. Prisma가 relation에
보내는 SQL은 호출 자리만 봐서는 정해지지 않기 때문입니다.
`relationLoadStrategy: "join"`이면 조인 쿼리 하나이고, `"query"`(relationJoins
preview 기능이 없을 때의 기본값)면 relation 단계마다 쿼리가 하나씩 늡니다. 중첩
쓰기는 트랜잭션 하나 안의 여러 문장입니다. 이 모두가 공유하는 것은 호출 자리이고,
메서드가 구현하는 것도 호출 자리입니다.

호출 하나는 테이블과 접근 종류(읽기, 쓰기, 지우기)마다 `EXECUTES` 엣지를 하나씩
둡니다. SQL 레인과 같은 방식입니다. 그래서 한 테이블을 읽고 쓰는 호출은 두 질문 모두에
걸립니다. 엣지마다 그 접근에 대해 어떤 경로가 준 가장 강한 등급을 받습니다. 컬럼은
종류마다 엣지 하나이고, 역시 가장 강한 등급을 받습니다.

실행 중에만 알 수 있는 relation 값(`include: { posts: flag }`, `data: { account }`)은
일어날 수도 있는(MAY) 것으로 따라갑니다. 그 엣지는 SOUND_SET이고, 문장은 그 키를
`columnsRuntimeOnly`에 적습니다. schema만으로 이 레인이 자리를 정할 수 없는
relation은 `relation-not-followed`로 남기고 이유를 적습니다. 반대쪽이 없거나 후보가
하나가 아닌 경우, `fields`와 `references`가 맞지 않는 경우, schema가 자리를 정해 주지
않는 암묵적 다대다인 경우입니다. 마지막은 모델이 자기 자신과 맺은 경우(어느 쪽이
`A`인지 schema가 말하지 않습니다), 필드 하나짜리 id가 없는 모델 사이, 서로 다른
`@@schema` 블록에 걸친 경우입니다.

**리터럴 값이 바꾸는 것.** null로 거르는 relation(`author: null`, `{ is: null }`,
`{ isNot: null }`. 어느 키인지는 팩의 `relationNullFilters`에 있습니다)은 연결만
확인합니다. 외래키가 거르는 모델 자신의 테이블에 있으면, 문장은 그 키 컬럼만 읽고
상대 테이블은 읽지 않습니다. Prisma 엔진이 그렇게 검사하기 때문입니다. 키가 상대
테이블에 있으면 다른 필터처럼 그 테이블을 따라갑니다.

아무것도 바꾸지 않게 만드는 리터럴을 받은 중첩 쓰기는, Prisma가 그래도 보내는 것만
그립니다. 중첩 쓰기마다 그런 리터럴을 팩의 `idle` 항목에 적어 둡니다. 값(`[]`나
`false`, 값 전체 또는 인자 하나), 적용되는 relation, 그리고 무엇을 빼는지(엣지 전부
또는 쓰기만)입니다. relation에 맞는 첫 항목이 이깁니다.

- `create`, `connect`, `connectOrCreate`, `update`, `updateMany`, `upsert`,
  `deleteMany`의 `[]`, 그리고 `createMany: { data: [] }`: 엣지가 없습니다. Prisma가
  아무것도 보내지 않기 때문입니다.
- `delete: false`, 그리고 일대일 relation의 `disconnect: false`: 엣지가 없습니다.
  일대다의 to-one 쪽에서는 Prisma가 불리언 값과 상관없이 연결을 끊으므로, 그 쓰기는
  남습니다.
- 다대다의 `disconnect: []`: 엣지가 없습니다. 쿼리를 아예 만들지 않기 때문입니다.
- `delete: []`, 그리고 일대다의 `disconnect: []`: 쓰기는 없지만, Prisma는 바꿀 것이
  없다는 걸 알기 전에 관련 행을 SELECT합니다. 그래서 문장에는 관련 테이블 읽기, 조인,
  다대다라면 암묵적 테이블, 관련 행의 키가 남습니다.

`set`은 연결을 바꿔 끼웁니다. 먼저 끊고 다시 걸기 때문에, `set: []`도 끊는 일은
합니다.

### `$extends`로 만든 클라이언트

클라이언트 필드에 `$extends`를 불러 만든 것을 담은 지역 변수
(`const x = this.prisma.$extends({...})`)는, 그 줄부터 그 변수로 부른 호출에 대해
클라이언트입니다. 클래스의 메서드가 돌려준 것을 담은 지역 변수
(`const x = this.client()`)도, 그 메서드의 `return`이 모두 그런 호출이거나 클라이언트
필드 자체라면 클라이언트입니다. 확장을 이 레인이 통째로 읽었고(그 자리에 적었거나,
같은 메서드의 지역 변수에서 `Prisma.defineExtension`으로 만든 경우) `query` 부분이
없으면, 그 호출은 원래 클라이언트만큼 확실합니다. 읽지 못한 확장이나 `query` 부분이
있는 확장은 호출을 HEURISTIC으로 만듭니다. `query`는 연산을 가로채서 보내는 내용을
바꿀 수 있기 때문입니다. 문장은 어느 경우인지를 `prismaEvidence.extension`(메서드,
읽었는지, 들어 있는 부분)에 적고, 클라이언트가 어느 메서드에서 왔는지는
`prismaEvidence.returnedBy`에 적습니다. 이름 목록은 팩 데이터입니다(`prisma.json`:
`extensions`).

확장의 `result` 부분이 계산하는 필드는 컬럼이 아닙니다. 그 필드를 고르면 `needs`가
true로 둔 필드를 읽습니다. 그 계산 필드가 필요로 하는 다른 계산 필드도 따라가고, 모델
하나에 선언했든 `$allModels`에 선언했든 똑같습니다. `needs`가 없는 필드는 더 읽는 것이
없습니다. `needs`를 이 레인이 읽지 못한 필드는 `columnsRuntimeOnly`에 이름을
남깁니다. 계산 필드 목록에 spread나 계산된 키가 있어서 필드가 더해지거나 바뀔 수
있으면, 그 목록은 열려 있다고 봅니다. 모델의 객체에 있든 `result` 부분 자체에 있든
같습니다. 열린 목록의 필드를 고르면 그 `needs`는 하나도 주장하지 않습니다. 문장에는
실행해야 알 수 있다고 적고, 같은 이름의 진짜 필드가 있으면 그 필드는 그대로 읽습니다.

### 어느 지역 변수가 클라이언트인가

지역 변수는 이름이 아니라 선언 그 자체로 클라이언트를 담습니다. 워커는 파일마다
언어와 같은 방식으로 변수 범위를 나누고(`adapters/ts/tsscope.mjs`), 호출을 받는 쪽이
어느 선언인지 적습니다. 안쪽 블록에서 같은 이름을 다시 선언했거나, 안쪽 함수의
매개변수가 트랜잭션 클라이언트의 이름을 가리면, 그건 다른 지역 변수입니다. 그 변수로
부른 호출은 클라이언트 호출이 아닙니다. 범위 안 어디서든 다시 대입되는 지역 변수
(`x = other`, `x++`, `for...of`의 대상)는 호출 시점에 무엇이든 담고 있을 수 있습니다.
그래서 어디서도 클라이언트로 보지 않습니다. 그 변수로 부른 호출은 읽지 않고,
`TS_PRISMA_CALL_UNREAD`가 그 이유와 함께 알려 줍니다.

## TypeORM

TypeORM을 쓰는 NestJS 애플리케이션도 Prisma를 쓰는 애플리케이션과 같은 방식으로
읽습니다. 엔티티가 카탈로그이고, SQL을 보내는 호출 하나가 문장 하나입니다. 이 레인이
TypeORM에 대해 아는 것은 `typeorm` 룰 팩(`src/core/rules/packs/typeorm.json`)에
있습니다. 종류 넷(`typeorm.entity`, `typeorm.receiver`, `typeorm.operation`,
`typeorm.query-builder`)으로 읽고, `cascade rules test`가 예제를 돌립니다.

### 엔티티가 카탈로그입니다

`@Entity`가 붙은 클래스는 테이블이고, 컬럼 데코레이터(`@Column`, `@PrimaryColumn`,
`@PrimaryGeneratedColumn`, `@ObjectIdColumn`, `@CreateDateColumn`,
`@UpdateDateColumn`, `@VersionColumn`, `@DeleteDateColumn`)가 붙은 속성은 컬럼입니다.
클래스가 상속한 프로젝트 클래스의 컬럼도 자기 컬럼입니다. TypeORM이 프로토타입 사슬
전체를 읽기 때문입니다. `@ManyToOne`, 그리고 `@JoinColumn`이 붙은 `@OneToOne`은
연결을 담는 조인 컬럼을 더합니다. `@JoinTable`이 붙은 `@ManyToMany`는 조인 테이블과
그 컬럼 둘을 더합니다. 조인 컬럼을 가진 relation과 조인 테이블은 각각 `JOINS`
엣지입니다. 호출이 읽든 말든 모든 컬럼이 pack에 들어갑니다. 하위 클래스가 TypeORM
데코레이터 없이 속성을 다시 선언하기만 했으면(`declare email: string`), 상속한
클래스가 매핑한 컬럼은 하나도 가려지지 않습니다.

엔티티만 선언한 테이블은 `declaredBy: "typeorm"`인 stub 노드입니다. 엔티티는
애플리케이션이 선언한 것이지, DB에 실제로 있는 것이 아니기 때문입니다. DDL이 선언한
테이블은 같은 노드가 되고, `typeormCatalogMatch` 표시가 붙습니다.

### 이름은 TypeORM의 naming strategy, prefix, schema를 따릅니다

데코레이터가 적지 않은 이름은 TypeORM의 메타데이터 빌더가 만드는 방식 그대로
만듭니다. DataSource 옵션의 `namingStrategy`가 정한 naming strategy(이름을 만드는
규칙)를 따릅니다. 옵션에는 모든 테이블 이름 앞에 붙는 `entityPrefix`와, schema를
적지 않은 엔티티에 주는 `schema`도 있습니다. 셋 다 같은 방식으로, 하나씩 따로
읽습니다.

- 옵션은 애플리케이션이 적는 자리에서 읽습니다. `TypeOrmModule.forRoot({...})`,
  `forRootAsync`의 `useFactory`가 돌려주는 것, 그 `useClass`나 `useExisting`의
  `createTypeOrmOptions()`, `createConnection({...})`, `new DataSource({...})`입니다.
  `dataSourceFactory` 안의 `new DataSource(options)`는 같은 옵션이지 다른 자리가
  아닙니다.
- 전략을 적지 않은 옵션은 `DefaultNamingStrategy`입니다. typeorm-naming-strategies의
  `new SnakeNamingStrategy()`가 팩이 아는 나머지 전략입니다.
- 모든 자리를 읽었고 서로 같으면 그 값을 아는 것입니다.
- 어떤 자리가 소스에 적혀 있지 않거나(인자 없는 `forRoot()`는 ormconfig나 환경
  변수를 읽습니다. 변수나 spread에 담긴 옵션, 이 엔진이 읽지 않는 코드가 만든 옵션,
  팩이 모르는 전략 클래스), 두 자리가 서로 다르거나, 자리를 하나도 찾지 못하면 그
  값을 모르는 것입니다. 이유는 `meta.laneStats.ts.typeorm.naming`에 남고,
  `TS_TYPEORM_NAMING_ASSUMED`가 그 때문에 HEURISTIC이 된 이름을 알려 줍니다.
- 만든 이름은 전략을 알 때만 EXACT입니다. 테이블 이름은 데코레이터가 적은 것까지
  포함해서, prefix를 알고, schema를 적지 않은 엔티티라면 schema도 알 때만 EXACT입니다.
  옵션의 schema가 있으면 테이블은 SQL 레인처럼 `schema.table`로 구분합니다.
- TypeORM의 `snakeCase`는 0.2.35와 0.2.38에서 바뀌었습니다. 버전마다 철자가 다른
  이름은 전략을 알아도 HEURISTIC입니다. 설치된 버전이 정하기 때문입니다. 만든 조인
  테이블 이름이 29자를 넘어도 HEURISTIC입니다. 0.3의 드라이버가 줄일 수 있기
  때문입니다(Oracle의 alias 길이 한도).
- `@JoinColumn`이나 `@JoinTable`의 이름을 리터럴이 아니라 값에 담아 넘기면, 기본
  이름은 HEURISTIC입니다.

옵션이 실행 시점에 맡긴 값은 프로필의 `tsBackend.typeorm`에 선언합니다.
`namingStrategy`(팩이 붙인 이름, `default`나 `snake`), `entityPrefix`, `schema`입니다.
`null`은 선언하지 않았다는 뜻이고, `""`는 "없음"이라고 선언한 것입니다. 선언한 값은
옵션이 말하는 값 대신 쓰고, 옵션에 적힌 값과 다르면 `TS_TYPEORM_NAMING_DECLARED`로
알립니다. 테이블 이름은 모두 prefix에 기대므로, 옵션이 소스에 없는 애플리케이션은
블록을 선언하기 전까지 기본 `conservative` 모드에서 어느 테이블에도 닿지 않습니다. 팩이 모르는 전략 이름을 적으면 분석을 멈추고, 아는 이름을 늘어놓은 프로필
오류를 냅니다.

### 호출한 자리마다 문장 하나입니다

SQL을 보내는 TypeORM 호출은 따로 문장이 됩니다.
`statement:typeorm:<file>#<Class.method>/<n>`은 그 메서드의 n번째 TypeORM 호출이고,
번호는 Prisma 호출처럼 붙입니다. 아무것도 보내지 않는 호출(`create`, `merge`)은
번호를 받지 않습니다. 대상은 `typeorm.receivers` 룰이 아는 객체에 부른 호출입니다.

- repository: `@InjectRepository(E)`가 주입한 필드, `Repository<E>`나
  `TreeRepository<E>`로 타입을 적은 필드, `Repository<E>`를 상속했거나
  `@EntityRepository(E)`가 붙은 프로젝트 클래스, 그리고 data source나 entity manager에
  부른 `getRepository(E)`, TypeORM 0.2의 `getRepository` 함수.
- entity manager: `EntityManager`로 타입을 적었거나 `@InjectEntityManager()`가
  주입한 필드, data source나 repository의 `manager`, TypeORM 0.2의 `getManager()`,
  그리고 `transaction` 콜백이 받는 manager. 이 객체의 연산은 첫 인자로 엔티티를 댑니다.
- data source: `DataSource`나 `Connection`으로 타입을 적은 필드.

repository나 manager를 담은 지역 변수(`const repo = this.ds.getRepository(User)`)는
Prisma 클라이언트 변수처럼 선언한 자리로 묶습니다. 안쪽 블록에서 같은 이름으로 선언한
것은 다른 지역 변수입니다. 다시 대입되는 지역 변수는 호출 시점에 무엇을 담고 있을지
모르므로 그 호출을 읽지 않고, `TS_TYPEORM_RECEIVER_UNREAD`로 알립니다.

연산은 인자마다 맡은 역할로 읽습니다(`typeorm.operations`).

- find 옵션은 역할대로 읽습니다. `where`는 거르고(where 배열은 OR입니다), `select`는
  적은 것을 돌려주고, `order`는 읽고, `relations`는 적은 relation을 불러옵니다.
  TypeORM 0.2의 `findOne(conditions)`와 `findOne(id)`는 TypeORM 자신의 판별 방식으로
  구별합니다. 키가 모두 find 옵션이고 속성이 하나도 없는 객체는 옵션으로 봅니다.
  그래서 TypeORM 0.3의 `{ select: { email: true } }`를 조건으로 읽지 않습니다.
- `select`가 없는 find는 엔티티의 모든 컬럼을 돌려줍니다. find는 eager relation과 그
  relation의 eager relation을 TypeORM이 조인하는 대로 불러오고(최대 여덟 단계, 한
  엔티티에 두 번 들어가지 않습니다), 옵션이 적은 relation도 불러옵니다. 둘 다
  `select`가 무엇을 적었든 통째로 불러옵니다. TypeORM의 SelectQueryBuilder가 그렇게
  조인하기 때문입니다. 옵션이 적은 relation은 그 대상의 eager relation도 데려옵니다.
  한 단계 아래까지는 EXACT이고, 그보다 깊으면 SOUND_SET입니다.
  `loadEagerRelations: false`면 eager relation은 멈춥니다.
- update와 insert는 값에 적힌 속성을 씁니다. 소스에 적히지 않은 값을 `save`하거나
  insert하면 어느 컬럼이든 쓸 수 있습니다(MAY). 그 WRITES는 SOUND_SET이고, 문장에
  `columnsRuntimeOnly`를 적습니다.
- `softDelete`, `restore`, `softRemove`, `recover`는 엔티티의 `@DeleteDateColumn`을
  씁니다.

`createQueryBuilder` 사슬은 그걸 만든 호출 자리에서 읽습니다. 사슬에 적힌 단계와,
같은 메서드에서 그 사슬을 담은 지역 변수에 나중에 부른 호출까지 함께 읽습니다. 그
지역 변수는 선언한 자리로 찾습니다. alias부터 읽습니다. TypeORM은 쿼리를 실행할 때
SQL을 만들기 때문입니다. 쿼리를 실행할 때마다 그 시점에 고른 것을 돌려주므로, 두 번
실행하면서 고른 것이 다르면 둘 다 남깁니다. 조건 텍스트의
`alias.property`는 그 alias가 가리키는 엔티티의 컬럼입니다. join은 그 테이블을 더하고,
`...AndSelect` join은 그 테이블의 행을 돌려줍니다. `select`는 돌려줄 것을 좁히고,
`update`, `delete`, `insert`는 그 종류의 문장으로 만들고, `set`과 `values`는 적은
것을 씁니다. 조건문, 반복문, 콜백 안에 적은 단계는 실행될 수도 있는(MAY) 것이라,
거기서 읽는 것은 SOUND_SET입니다. 그런 자리의 `select`는, 그대로 남을 수도 있는
원래 선택을 후보로 함께 남깁니다. 이 룰이 자리를 정하지 못한 단계(`Brackets`로 만든
조건, 팩이 모르는 메서드)는 문장에 `builder-step-not-read`로 남습니다. 만든 자리에서
쿼리를 실행하는 단계가 하나도 없는 builder는 `builder-not-run-here`를 남기고, 그
엣지는 SOUND_SET입니다.

읽지 못한 것은 알립니다.

| 진단 | 소스가 한 일 |
|---|---|
| `TS_TYPEORM_CALL_UNREAD` | raw SQL(`query()`), 팩이 모르는 연산, 이 엔진이 읽은 엔티티가 없는 호출 |
| `TS_TYPEORM_RECEIVER_UNREAD` | 엔티티를 댄 연산인데, 받는 쪽이 repository나 entity manager인지 모르는 경우. 그런 객체를 담았다가 다시 대입된 지역 변수에 부른 경우도 여기 들어갑니다 |
| `TS_TYPEORM_MAPPING_UNREAD` | 이 엔진이 읽지 않는 매핑. embedded 엔티티(`@Column(() => Address)`), `@ChildEntity`, `@ViewEntity`, `@TableInheritance`, `@Tree`가 붙은 클래스, 소스에 적히지 않은 조인 옵션, 대상이 이 엔진이 읽은 엔티티가 아닌 relation |
| `TS_TYPEORM_NAMING_ASSUMED` | 이 엔진이 옵션을 읽지 못해서 naming strategy, prefix, schema 중 무엇을 모르고, 그 값에 기대는 이름이 HEURISTIC인 경우 |
| `TS_TYPEORM_NAMING_DECLARED` | 프로필의 `tsBackend.typeorm`이 옵션에 적힌 것과 다른 값을 선언한 경우. 프로필 값을 씁니다 |

`where` 안의 relation은 문장에 `relation-not-followed`로 남고, 엔티티에 없는 키는
`argument-not-read`로 남습니다.

catalog 축은 테이블·컬럼 이름이 모두 데코레이터에 적혀 있거나 이번 실행이 아는 전략을
따를 때 shipped입니다. 이때 `axes.catalog.sources`에
`TypeORM entities (N table(s), M column(s))`가 들어갑니다. 이번 실행이 확인하지 못한
규칙으로 이름을 만들어야 했다면(모르는 전략·prefix·schema, TypeORM 버전마다 다른 철자) catalog 축과
column 축은 이유와 함께 degraded입니다. 엔티티 옆에 DDL이 있어도 달라지지 않습니다.

## 프로필

```json
"frameworkPacks": ["nestjs"],
"tsBackend": { "app": "../apps/api/src", "prismaSchema": null, "globalPrefix": null, "globalPrefixExclude": null,
               "typeorm": { "namingStrategy": null, "entityPrefix": null, "schema": null } }
```

- `tsBackend.app`: 애플리케이션 루트. manifest 기준 상대 경로이고, `frameworkPacks`에
  `nestjs`가 있을 때 읽습니다.
- `tsBackend.prismaSchema`: schema가 Prisma가 먼저 보는 자리에 없을 때 지정합니다.
- `tsBackend.globalPrefix`: 부트스트랩이 prefix를 설정에서 읽을 때, 실제 배포에 쓰는
  값을 적습니다. `""`도 정상 값입니다. prefix가 없다는 뜻입니다.
- `tsBackend.globalPrefixExclude`: 그 prefix가 빼는 라우트 패턴을 Nest 문법 그대로
  적습니다(`["health", "docs{/*rest}"]`). 부트스트랩이 실행 중에 목록을 만들 때 씁니다.
  적으면 부트스트랩의 목록 대신 이 목록을 씁니다.
- `tsBackend.typeorm`: TypeORM DataSource가 쓰는 `namingStrategy`, `entityPrefix`,
  `schema`. 소스에 옵션이 적혀 있지 않을 때 선언합니다(위 *이름은 TypeORM의 naming
  strategy, prefix, schema를 따릅니다* 참조).

이 키들을 하나도 적지 않은 프로젝트는 키가 생기기 전과 같은 프로필 digest를
유지합니다. 그래서 업그레이드가 보정 게이트에게 "분석 대상이 바뀐 것"으로 보이지
않습니다. `typeorm` 블록은 다른 키보다 나중에 생겼으므로, 셋이 모두 `null`이면
블록 하나만 따로 digest에서 뺍니다. 그래서 블록이 생기기 전에 `tsBackend`를 적어 둔
프로젝트도 digest가 그대로입니다. 반대로 다른 애플리케이션을 읽으면 대상이 바뀐 것으로 봅니다. 읽는 루트가
대상 고정 값(pin)에 들어가기 때문입니다.

`cascade init`은 `schema.prisma`의 datasource `provider`를 `sqlDialects.main`에도
적습니다. 프로필이 받는 방언(`postgresql`, `mysql`)일 때만 적습니다. Prisma를 쓰는
프로젝트는 어느 DB에서 도는지 schema에 직접 적어 두고, 마이그레이션도 그 DB의 SQL로
씁니다.

## 캐시하는 것과 하지 않는 것

파일마다의 사실은 웹 레인처럼 파일 바이트를 기준으로 캐시합니다. 두 번째 실행부터는
바뀐 파일만 다시 읽습니다. 어떤 파일을 읽을지는 실행마다 다시 정합니다.
애플리케이션의 파일과, 그 import가 분석 루트 안에서 닿는 다른 파일입니다. shard
하나에는 여전히 파일 하나의 레코드만 들어가고, facts 인덱스는 읽은 파일을 웹 레인과
따로 `tsFiles` 맵에 적습니다. 파일을 넘나드는 판단은 매번 애플리케이션 전체를 놓고
다시 합니다. import가 어느 파일을 가리키는지, 필드 타입이 어느 클래스인지, 어떤
컨트롤러가 등록됐는지, 모듈이 타입에 어느 클래스를 묶는지가 그렇습니다. tsconfig
`paths`, `schema.prisma`, 그리고 타입의 패키지가 배포될 수 있는지 알려 주는
`package.json`도 함께 다시 읽습니다. 그래서 캐시된 파일에 다른 파일에 대한 결론이
들어가지 않습니다.

## 커밋하지 않은 편집(작업 트리 오버레이)

커밋하지 않은 변경에 대한 `cascade impact`와 MCP `changed_impact` 도구는, 이 레인이
들어간 pack에도 Java pack과 똑같이 작업 트리 오버레이를 얹습니다. 오버레이는
`analyze`와 같은 방식으로 이 레인을 훑되, 팩트 캐시에는 아무것도 쓰지 않습니다.

- 바이트가 그대로라 샤드 키가 맞는 파일은 샤드에서 읽습니다. 고친 파일은 워커가
  다시 읽습니다(`parsedTsFiles`).
- 어떤 파일을 읽을지 다시 정합니다. 애플리케이션 루트 아래 파일과, 그 파일들의
  import가 지금 닿는 모든 파일입니다. 편집으로 새로 import하게 된 파일은 처음 읽고,
  이제 어떤 import도 닿지 않는 파일은 뺍니다(`droppedTsFiles`). 다음 `analyze`도
  그렇게 뺄 것이기 때문입니다.
- tsconfig 사슬, `schema.prisma`, `package.json`은 매 실행처럼 통째로 다시 읽습니다.
  바뀐 파일은 `tsConfigFiles`에 적습니다.
- 브리지는 `analyze`가 만드는 옵션 그대로(`src/cli/ts_inputs.mjs`) 전체 흐름 위에서
  돕니다. 그래서 파일을 넘나드는 판단을 다시 합니다. 모듈이 추상 타입에 어느 클래스를
  묶는지, 어느 필드가 Prisma 클라이언트인지, TypeORM 호출이 어느 repository를
  거치는지, DataSource 옵션이 정한 naming strategy, prefix, schema가 무엇인지입니다.
- 인증된 실행이 본 적 없는 statement, 테이블, 컬럼은 `provisional`이고, 그것에 닿는
  엣지도 모두 그렇습니다. 메서드에 새로 넣은 Prisma 호출, 엔티티가 이름을 바꾼 컬럼,
  `schema.prisma`에 새로 넣은 필드가 그런 경우입니다.

아무것도 고치지 않은 트리에 얹으면 오버레이는 분석한 그래프를 digest까지 똑같이
만들고, 고친 트리에 얹으면 `analyze`가 그 트리로 만들 그래프를 만듭니다
(`test/overlay_equivalence.test.mjs`, `test/overlay_ts.test.mjs`). 이 레인과 웹
레인이 함께 읽은 함수는 여전히 노드 하나이고, `lanes`에 두 레인이 모두 적힙니다.

거절하는 경우와 알리는 것은 이렇습니다.

- git이 바뀌지 않았다고 보는 파일인데 샤드가 더는 맞지 않으면 `overlay-stale`로
  오버레이를 거절합니다. pack을 만든 뒤 TypeScript 워커가 바뀌었거나, 샤드가 캐시에서
  사라졌거나, git이 보지 않는 곳에서 파일이 바뀐 경우입니다. `cascade analyze`를
  돌리면 됩니다.
- 오버레이는 pack이 읽은 애플리케이션을 읽습니다. facts 인덱스에 적힌 그대로입니다.
  그 뒤 프로필이 다른 애플리케이션을 가리키게 됐으면 `limits`에 적고, 다음
  `analyze`가 그 애플리케이션을 읽습니다.
- Prisma·TypeORM 문장 번호는 메서드 안 호출 순서로 붙습니다. 그래서 앞쪽에 호출을
  하나 넣으면 뒤 번호가 밀립니다. `provisional`은 pack에 없던 id에만 붙습니다. 번호가
  밀린 문장의 엣지는, 고친 파일에서 나온 다른 엣지처럼 오버레이의 세션 id를 답니다.
- 예전 엔진이 쓴 facts 인덱스, 즉 TypeScript 샤드를 다른 레인 것과 섞어 둔 인덱스는
  `ts-not-overlaid`로 거절합니다. `cascade analyze`를 한 번 돌려 인덱스를 새로 쓰면
  됩니다.

## 이 버전에 없는 것

- guard, interceptor, pipe를 엣지로 잇기.
- raw SQL. Prisma의 `$queryRaw`와 `$executeRaw`, TypeORM의 `query()`.
- Prisma의 fluent relation API(`findUnique(...).posts()`), `$extends`로 만든
  클라이언트를 담은 클래스 필드, 모델이 자기 자신과 맺은 암묵적 다대다.
- TypeORM의 embedded 엔티티, 테이블 상속(`@ChildEntity`, `@TableInheritance`), view
  엔티티와 tree 엔티티, Active Record 호출(`BaseEntity`를 상속한 `User.find()`),
  `Repository.extend({...})`로 만든 커스텀 repository, `save`나 `remove`가 관련
  엔티티로 번지는 cascade.
- Mongoose, Next.js 라우트 핸들러, Nest 없는 Express.
