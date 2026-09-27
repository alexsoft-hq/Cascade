[English](../../setup/ts-lane.md) | **한국어**

# TypeScript 레인(NestJS + Prisma) 설정

TypeScript 레인은 **NestJS 백엔드**를 읽습니다. 컨트롤러가 여는 라우트, 메서드끼리의
호출, 그리고 **Prisma** 호출 하나하나를 `schema.prisma`의 테이블·컬럼에 대한 SQL
문장으로 읽습니다. Spring 애플리케이션에서 Java 레인이 하는 일과 같은 왕복입니다
(`endpoint → handler → service → statement → table → column`). 그래서 웹 레인이 읽은
프런트엔드 호출이 Spring 라우트를 만나듯 Nest 라우트도 그대로 만납니다.

모르는 것을 아는 것처럼 적지 않습니다. 주소가 변수에 들어 있는 라우트는 만들지
않습니다. 읽지 못한 제외 패턴이 이름을 댈 수도 있는 라우트는 만들되 HEURISTIC(추정)
등급을 붙입니다. 이 레인이 읽지 못한 Prisma 인자는 문장에 이름을 남깁니다. 이런
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
웹 레인은 백엔드 파일을 **빼고** 읽습니다. 그 파일은 이 레인의 몫입니다.

레인 요약 줄은 이렇게 나옵니다.

```
TypeScript lane: 310 file(s), 118 route(s) from 34 registered controller(s), 1368 call(s) linked, 1001 into packages, 1777 on a receiver not typed here; Prisma: 149 statement(s) from 149 client call(s)
```

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
| `ts-function` | `f()`: 파일이 선언하거나 이름으로 import한 함수 |
| `ts-static-method` | `Cls.m()`: 파일이 가리키는 클래스의 static 메서드 |

등급이 SOUND_SET인 이유가 있습니다. 하위 클래스가 메서드를 덮어쓸 수 있고, 필드
타입에 실제로 묶이는 provider가 다른 클래스일 수도 있습니다. 패키지로 들어가는 호출은
따로 셉니다. 이 레인이 타입을 모르는 대상(지역 변수, 매개변수, 필드를 거친 체인)에
대한 호출과는 다릅니다. 앞의 것은 프로젝트 연결의 빈틈이 아니고, 뒤의 것은 빈틈입니다.
데코레이터는 메서드가 부르는 호출이 아닙니다. 클래스를 정의할 때 한 번 실행될 뿐입니다.

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
`_`로 쪼개서 필드를 짐작하지 않습니다. 규칙이 따라가지 못한 것은 문장에 남깁니다.

- `relation-not-followed`: `include`나 `select` 안의 relation 필드가 이 문장에 없는
  다른 테이블로 이어짐.
- `argument-not-read`: 규칙이 모르는 키(예: `include` 안의 relation `_count`).
- `columnsRuntimeOnly`: 인자를 변수로 넘겼거나, 펼치기나 계산된 키로 썼기 때문에
  어느 컬럼인지 실행해 봐야 아는 경우.
- `select` 값이 `true`도 `false`도 아니면(`email: showEmail`) 그 컬럼을 읽을 수도
  있습니다. 이 READS 엣지는 SOUND_SET 등급이고, 문장에 불확실하게 만든 키를 적습니다.

`select`가 없고 인자를 통째로 읽었으면, 모델의 스칼라 컬럼을 모두 읽는 것으로 봅니다.

schema에 있는 모델과 연산 이름으로 부르는데 이 레인이 클라이언트라고 알지 못하는
대상에 부른 호출(지역 변수에 담은 클라이언트, `$extends`로 만든 클라이언트)은 문장을
만들지 않습니다. 대신 `TS_PRISMA_CALL_UNREAD`로 개수와 몇 곳의 위치를 알려 줍니다.

`schema.prisma`는 애플리케이션 루트나 그 위의 `prisma/schema.prisma`에서 찾습니다.
Prisma가 가장 먼저 보는 자리입니다. 다른 곳에 있다면 패키지의
`"prisma": { "schema": ... }`나 프로필의 `tsBackend.prismaSchema`로 지정합니다. 이
파일은 실행할 때마다 다시 읽고, 경로와 sha256, provider를 `meta.laneStats.ts`에
남깁니다. DDL이 선언하지 않은 테이블은 `declaredBy: "prisma"` 스텁으로 넣고,
마이그레이션 DDL이 선언한 테이블이면 같은 노드를 씁니다.

## 프로필

```json
"frameworkPacks": ["nestjs"],
"tsBackend": { "app": "../apps/api/src", "prismaSchema": null, "globalPrefix": null, "globalPrefixExclude": null }
```

- `tsBackend.app`: 애플리케이션 루트. manifest 기준 상대 경로이고, `frameworkPacks`에
  `nestjs`가 있을 때 읽습니다.
- `tsBackend.prismaSchema`: schema가 Prisma가 먼저 보는 자리에 없을 때 지정합니다.
- `tsBackend.globalPrefix`: 부트스트랩이 prefix를 설정에서 읽을 때, 실제 배포에 쓰는
  값을 적습니다. `""`도 정상 값입니다. prefix가 없다는 뜻입니다.
- `tsBackend.globalPrefixExclude`: 그 prefix가 빼는 라우트 패턴을 Nest 문법 그대로
  적습니다(`["health", "docs{/*rest}"]`). 부트스트랩이 실행 중에 목록을 만들 때 씁니다.
  적으면 부트스트랩의 목록 대신 이 목록을 씁니다.

이 키들을 하나도 적지 않은 프로젝트는 키가 생기기 전과 같은 프로필 digest를
유지합니다. 그래서 업그레이드가 보정 게이트에게 "분석 대상이 바뀐 것"으로 보이지
않습니다. 반대로 다른 애플리케이션을 읽으면 대상이 바뀐 것으로 봅니다. 읽는 루트가
대상 고정 값(pin)에 들어가기 때문입니다.

`cascade init`은 `schema.prisma`의 datasource `provider`를 `sqlDialects.main`에도
적습니다. 프로필이 받는 방언(`postgresql`, `mysql`)일 때만 적습니다. Prisma를 쓰는
프로젝트는 어느 DB에서 도는지 schema에 직접 적어 두고, 마이그레이션도 그 DB의 SQL로
씁니다.

## 캐시하는 것과 하지 않는 것

파일마다의 사실은 웹 레인처럼 파일 바이트를 기준으로 캐시합니다. 두 번째 실행부터는
바뀐 파일만 다시 읽습니다. 파일을 넘나드는 판단은 매번 애플리케이션 전체를 놓고
다시 합니다. import가 어느 파일을 가리키는지, 필드 타입이 어느 클래스인지, 어떤
컨트롤러가 등록됐는지가 그렇습니다. tsconfig `paths`와 `schema.prisma`도 함께 다시
읽습니다. 그래서 캐시된 파일에 다른 파일에 대한 결론이 들어가지 않습니다.

커밋하지 않은 변경에 대한 `cascade impact`(작업 트리 오버레이)는 아직 TypeScript를
다시 읽지 못합니다. 이 레인이 들어간 pack에서는 `ts-not-overlaid`로 거절하고,
`--mode base-only`는 pack 기준으로 계속 답합니다.

## 이 버전에 없는 것

- guard, interceptor, pipe를 엣지로 잇기.
- Prisma relation(`include`)을 따라 이어진 테이블까지 가기, relation의 `_count`,
  `$extends`로 만든 클라이언트, raw SQL(`$queryRaw`).
- 인터페이스나 추상 클래스를 거쳐 그 구현 클래스로 가는 호출.
- TypeORM, Mongoose, Next.js 라우트 핸들러, Nest 없는 Express.
- tsconfig 경로로 닿는 애플리케이션 루트 밖 파일(모노레포의 공유 라이브러리). 거기서
  가져온 이름은 패키지 것으로 셉니다.
