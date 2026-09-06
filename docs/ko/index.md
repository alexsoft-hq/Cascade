[English](../index.md) | **한국어**

# <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/cascade-mark-dark.svg"><img src="../assets/cascade-mark.svg" width="28" alt=""></picture> Cascade 한국어 문서

AI 코딩 에이전트와 그 옆에서 일하는 사람을 위한, 코드에서 컬럼까지 이어지는
변경 영향 지식 그래프입니다. Apache-2.0.

[한국어 README](../../README.ko.md) | [English README](../../README.md)

![Cascade 뷰어의 Overview 탭. SQL 까지 닿는 엔드포인트, 닿은 statement, 테이블,
컬럼, 테이블까지 닿는 화면의 다섯 다이얼과 프로젝트 전체
지도](../assets/screens/overview-ko.png)

## 왕복

얕은 코드 인덱스가 주지 못하는 것은 끝에서 끝까지 양방향으로 걷는 일입니다.

```
screen → frontend function → endpoint → service → mapper/ORM → SQL → table → column
column ← SQL ← mapper ← service ← endpoint ← frontend function ← screen
```

레인 셋이 이것을 만듭니다. **SQL 레인**(Python 과 sqlglot)은 DDL 파일이나 고정된
카탈로그 스냅샷을 스키마로, MyBatis XML 을 파싱 가능한 statement 로, 그
statement 를 테이블과 컬럼의 읽기와 쓰기로 바꿉니다. **Java 레인**(JDK 자체
파서. Gradle 도 Maven 도 의존성 classpath 도 쓰지 않습니다)은 그 위에
`endpoint → controller → service → mapper` 를 잇고, SQL 로 쓰이지 않고 `@Entity`
나 Spring Data 로 선언된 영속성도 함께 다룹니다. **웹 레인**(동봉된 파서, 설치
없음)은 엔드포인트 위쪽의 코드, 즉 프런트엔드 호출과 화면이 되는 라우터 선언을
읽습니다.

## 정직성 계약

모든 답은 네 개의 필드를 달고 다니며, 직렬화 전에 검사받습니다. 비슷하게 생긴
객체를 손으로 만들어 넘기면 나가기 전에 `assertContract()` 에서 죽습니다.

- **basis** 는 이 답이 어느 커밋과 어느 pack 다이제스트에 근거하는지, 그리고 그
  상태가 `current`, `behind`, `provisional-overlay`, `unknown` 중 무엇인지입니다.
  `unknown` 은 절대 `current` 로 읽히지 않습니다.
- **trust** 는 **계산된** 수준(`UNCERTIFIED`, `GOLDEN_FAIL`, `GOLDEN_PASS`)이며
  타이핑해 넣은 값이 아닙니다. 골든 코퍼스가 없으면 `UNCERTIFIED` 입니다.
- **limits** 는 엔진이 보지 못한 것을 범위와 함께 말로 적은 것입니다.
- **truncated** 는 목록별로 얼마나 잘렸는지와 진짜 전체 개수입니다.

빈 목록은 왜 비었는지를 말합니다. `not-shipped`(축이 아예 만들어지지 않음),
`degraded`(필요한 것 없이 만들어짐), `none`(찾아봤고 없었음)입니다. 이 셋은 서로
다른 답이며 `[]` 하나로 뭉개지지 않습니다.

### 주장하지 않는 것

SAST 나 CodeQL 의 대체품이 아닙니다. "완전한" 영향 분석이 아닙니다. "안전한
리팩터링 보장"이 아닙니다. 언어 중립도 아니고 100% 정확하지도 않습니다. 내놓는
것은 측정된 하한값입니다.

## 빠른 시작

준비물과, 무엇이 빠졌는지 알려 주는 명령 하나입니다.

```bash
python3 -m venv .venv && .venv/bin/pip install -r adapters/sql/requirements.txt
# plus a JDK 17+ for the Java lane (`brew install openjdk`; set JAVA_HOME)
# the web lane needs nothing: its parser is vendored

node bin/cascade.mjs doctor        # every prerequisite, its state, the remedy
```

그다음 Spring 에 MyBatis 나 JPA 를 쓰는 아무 트리에나 이렇게 씁니다.

```bash
node bin/cascade.mjs init --root <repo> --project <id>
node bin/cascade.mjs analyze --root <repo>
node bin/cascade.mjs estimate --root <repo>
node bin/cascade.mjs mcp --project <id>
node bin/cascade.mjs view --project <id>     # http://127.0.0.1:4319/
```

실제 출력과 함께 같은 길을 걷는 설명은 한국어 README 에 있습니다.
[내 프로젝트에 10분](../../README.ko.md#내-프로젝트에-10분),
[AI 에이전트에 연결하기](../../README.ko.md#ai-에이전트에-연결하기),
[편집 루프](../../README.ko.md#편집-루프) 입니다.

## 한국어로 옮긴 문서

| 문서 | 무엇이 있는가 |
|---|---|
| [concepts.md](concepts.md) | 등급, 답이 달고 다니는 네 필드, 두 개의 속도, 부분 pack, 보정 |
| [viewer.md](viewer.md) | 로컬 웹 뷰어. 탭, 딥 링크, 언어 토글, 무엇이 번역되고 무엇이 되지 않는가 |
| [setup/agents.md](setup/agents.md) | MCP 클라이언트 설정 전체. Claude Code, Claude Desktop, Cursor, 일반 stdio 클라이언트 |
| [setup/web-lane.md](setup/web-lane.md) | 프런트엔드 레인. 동봉 파서, 래퍼, 접두사, 화면, OpenAPI, 기록 |

## 옮기지 않은 문서

아래 두 쪽은 영어 원문만 있습니다. 내용의 대부분이 영어 식별자로 된 표이고,
그 이름들은 번역 대상이 아니라 여러분이 그대로 입력하게 될 문자열이기
때문입니다. 표 옆의 설명 문장까지 옮기면 원문과 번역본이 갈라졌을 때 어느 쪽이
맞는지 알 수 없게 됩니다.

- [cli.md](../cli.md): 모든 명령과 모든 플래그입니다. 테스트가 바이너리의 사용법
  출력과 대조합니다.
- [mcp.md](../mcp.md): 도구 카탈로그, `project` 인자, 두 개의 전송 방식, 오류
  표입니다.

같은 이유로 아래 네 쪽도 영어 원문을 보십시오.

- [measured.md](../measured.md): 일반성 게이트의 코퍼스 표, 골든, 그리고 검증되지
  않은 것의 목록입니다.
- [setup/sql-lane.md](../setup/sql-lane.md): Python 과 sqlglot, 방언, DDL 의 출처.
- [setup/java-lane.md](../setup/java-lane.md): JDK, 이 레인이 해석하는 것과 하지
  않는 것, JPA 와 MyBatis-Plus.
- [setup/db-catalog.md](../setup/db-catalog.md): 컬럼 주석을 얻는 세 가지 방법과
  각각의 비용.

기여: [CONTRIBUTING.md](../../CONTRIBUTING.md).
보안: [SECURITY.md](../../SECURITY.md).
변경 기록: [CHANGELOG.md](../../CHANGELOG.md).
