[English](../../setup/agents.md) | **한국어**

# AI 클라이언트에 Cascade 연결하기

`cascade mcp` 는 **stdio** 위에서 JSON-RPC 를 말하는 평범한 MCP 서버입니다. 이
문서의 모든 설정은 같은 명령을 실행합니다.

```
node <absolute path to cascade>/bin/cascade.mjs mcp --project <id>
```

전부에 공통으로 적용되는 규칙이 셋 있습니다.

- **`bin/cascade.mjs` 는 절대 경로로 씁니다.** 클라이언트는 여러분이 통제하지
  않는 작업 디렉터리에서 서버를 띄우므로, 상대 경로는 클라이언트가 서버 실패를
  보고하는 가장 흔한 원인입니다.
- **`--project <id>` 는 선택입니다.** 붙이면 그 프로젝트 하나가 답하고 어떤
  도구도 `project` 인자를 받을 필요가 없습니다. 붙이지 않으면 서버가
  `~/.cascade/registry.json` 의 **모든** 프로젝트를 서빙하고, 프로젝트를 대지 않은
  호출은 id 목록과 함께 `ambiguous` 로 거부됩니다. 플래그를 반복하면 딱 두세
  개만 서빙할 수 있습니다.
- **pack 은 지연 로딩됩니다.** 서버를 띄우는 동작은 레지스트리만 읽으므로,
  로그인 때 서버를 띄우는 클라이언트도 첫 질문 전까지는 거의 비용을 치르지
  않습니다.

어디에 붙여 넣기 전에 명령을 손으로 먼저 확인합니다.

```bash
node /path/to/cascade/bin/cascade.mjs mcp --project mall
```

```
cascade mcp: serving 1 project(s) [mall]: packs load on first use, budget 512 MB of pack JSON
```

이 줄은 stderr 로 나갑니다. stdout 에는 JSON-RPC 스트림만 흐르고 그 밖에는
아무것도 없으며, 그래서 클라이언트가 그것을 읽을 수 있습니다.

## 언제 물어야 하는지를 에이전트에게 알려 줍니다

이 아래의 설정은 전부 서버를 연결하는 절반입니다. **언제 물어야 하는지**는
어디에도 없고, 이 도구의 값어치는 그 나머지 절반에 걸려 있습니다. 서버만 붙어
있고 그에 대한 규칙이 없는 모델은 매퍼를 묻지 않고 고칩니다. 지금 질문할 때라고
말해 주는 것이 문맥에 하나도 없기 때문입니다.

명령 하나가 둘 다 씁니다. 프로젝트 안에서 실행합니다.

```bash
cascade agent --write                     # Claude Code 용 .mcp.json + CLAUDE.md
cascade agent --client cursor --write     # .cursor/mcp.json + .cursor/rules/cascade.mdc
cascade agent --client codex --write      # AGENTS.md, 그리고 붙여 넣을 TOML 블록
```

`--write` 없이 실행하면 쓸 파일을 내용까지 그대로 출력만 하고 아무것도 건드리지
않습니다. `bin/cascade.mjs` 의 절대 경로와 프로젝트 id 는 도구가 스스로
채웁니다. 둘 다 알고 있기 때문입니다. 플래그 전체는
[CLI 문서](../../cli.md#cascade-agent) 에 있습니다.

규칙 쪽은 아래와 같고, `CLAUDE.md` 나 `AGENTS.md` 안에 마커 두 줄 사이로
들어갑니다. 그래서 다시 실행해도 그 자리에서 교체되고 위아래에 쓴 여러분의
글은 그대로 남습니다. Cursor 는 같은 본문을 `alwaysApply: true` 가 붙은 `.mdc`
파일 하나로 받습니다.

```markdown
<!-- cascade:begin -->
## Cascade: ask the impact graph before touching data-facing code

This project has a change-impact graph served over MCP by the `cascade` server
(project `mall`). It knows which SQL statements, HTTP endpoints and screens reach
every table and column, with a grade on each edge.

Ask before you edit any of these:
- a MyBatis mapper XML or an annotated mapper, a JPA entity or repository, a DDL file
- a controller, a route, or a service method a controller reaches
- a frontend screen, or a frontend function that calls the backend

How to ask:
1. `changed_impact` with the files you are about to change, or have changed and
   not committed. It lists the endpoints, screens, tables and columns in the
   blast radius, and it reads your working tree, so it is never behind.
2. Before renaming or retyping a column, run `column_impact`, then
   `endpoint_impact` and `screen_impact` on it, and put every reader AND writer
   they name into your plan.
3. `flow` on an endpoint or a screen shows the whole path down to the tables it
   ends at. `overview` first when you do not know what is in the pack.

How to read an answer:
- `trust`, `limits` and `truncated` come with every answer. Read them before
  the list. Each `limits` entry names something the graph could not see.
- `EXACT` is proved. `SOUND_SET` is a candidate set, so check each member.
  `HEURISTIC` and `RUNTIME_ONLY` are hints, not evidence.
- An empty list means "none" only when `empty` says `none`. `not-shipped` and
  `degraded` mean unknown, which is not the same as zero.
- A `basis.freshness` of `behind` means the pack predates the code you see.
  `changed_impact` still answers from the working tree.

After the edit, run `changed_impact` again and put the endpoints and screens it
names into the commit message or the pull request, so a reviewer sees the same
radius you did.
<!-- cascade:end -->
```

블록은 에이전트가 읽는 지시문이므로 영어 그대로 씁니다.

그다음 Claude Code 에서는 승인이 한 번 필요합니다. 프로젝트 `.mcp.json` 으로
들어온 서버는 그 디렉터리에서 `claude` 를 한 번 실행하고 `cascade` 를 승인하기
전까지 *Pending approval* 상태로 있고, `claude mcp get cascade` 가 그 상태를
출력합니다.

이 아래는 손으로 직접 하고 싶을 때 이 명령이 무엇을 쓰는지, 그리고 이 명령이
아직 다루지 않는 클라이언트를 설명합니다.

## Claude Code

서버를 쓰고 싶은 저장소 안에서 셸로 실행합니다.

```bash
claude mcp add cascade -- node /path/to/cascade/bin/cascade.mjs mcp --project mall
```

하나가 아니라 등록된 모든 프로젝트를 쓰려면 이렇게 합니다.

```bash
claude mcp add cascade -- node /path/to/cascade/bin/cascade.mjs mcp
```

그다음 Claude Code 안에서 `/mcp` 를 치면 서버와 도구 목록이 나옵니다.

## Claude Desktop

`claude_desktop_config.json` 을 편집합니다. macOS 에서는
`~/Library/Application Support/Claude/` 아래, Windows 에서는 `%APPDATA%\Claude\`
아래에 있습니다.

```json
{
  "mcpServers": {
    "cascade": {
      "command": "node",
      "args": [
        "/path/to/cascade/bin/cascade.mjs",
        "mcp",
        "--project", "mall"
      ]
    }
  }
}
```

한 서버에 여러 프로젝트를 붙이려면 이렇게 합니다.

```json
{
  "mcpServers": {
    "cascade": {
      "command": "node",
      "args": [
        "/path/to/cascade/bin/cascade.mjs",
        "mcp",
        "--project", "mall",
        "--project", "shop"
      ]
    }
  }
}
```

파일을 고친 뒤에는 앱을 재시작합니다. Claude Desktop 이 서버를 직접 띄우므로
`node` 가 데스크톱 앱이 물려받는 PATH 위에 있어야 합니다. 없다면 `command` 에
`node` 바이너리의 절대 경로를 적습니다.

## Cursor

Cursor 는 프로젝트의 `.cursor/mcp.json` 을 읽습니다. 모든 프로젝트에 적용하려면
`~/.cursor/mcp.json` 입니다. 모양은 같습니다.

```json
{
  "mcpServers": {
    "cascade": {
      "command": "node",
      "args": ["/path/to/cascade/bin/cascade.mjs", "mcp", "--project", "mall"]
    }
  }
}
```

## 일반 stdio 클라이언트

MCP stdio 전송을 말하는 것이면 무엇이든 세 가지가 필요합니다. 실행 파일, 인자,
그리고 환경입니다. Cascade 는 환경 변수를 하나도 요구하지 않고, 아래 둘 말고는
읽지도 않습니다.

| 필드 | 값 |
|---|---|
| transport | stdio |
| command | `node`, 또는 Node 20 이상 바이너리의 절대 경로 |
| args | `["/path/to/cascade/bin/cascade.mjs", "mcp", "--project", "mall"]` |
| env | 필수 항목 없음 |

상태가 저장되는 위치를 바꾸는 환경 변수가 둘 있는데, 일상적으로 쓰라고 있는
것이 아니라 격리를 위한 것입니다. `CASCADE_HOME` 은 레지스트리를 `~/.cascade`
밖으로, `XDG_CACHE_HOME` 은 재생성 가능한 팩트 샤드를 `~/.cache/cascade` 밖으로
옮깁니다.

프로토콜을 직접 눈으로 보려면 이렇게 굴려 봅니다.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node /path/to/cascade/bin/cascade.mjs mcp --project mall
```

## 클라이언트가 서버 실패라고 말할 때 확인할 것

1. **그 명령을 직접 실행해 봅니다.** 클라이언트가 들고 있는 것과 똑같이요. 거의
   모든 실패가 셸에서 1 초 만에 재현됩니다.
2. **절대 경로인지 봅니다.** `bin/cascade.mjs` 는 물론이고, `node` 가 클라이언트
   PATH 에 없다면 `node` 도 절대 경로여야 합니다.
3. **`node --version` 이 20 이상인지 봅니다.** 데스크톱 앱은 종종 셸보다 오래된
   Node 를 물려받습니다.
4. **프로젝트 id 가 존재하는지 봅니다.** 모르는 `--project` 는 추측하지 않고
   등록되어 *있는* id 목록을 보여 줍니다. 플래그 없는
   `node bin/cascade.mjs mcp` 는 전부를 서빙하고, `projects` 도구는 pack 을 하나도
   적재하지 않고 목록을 알려 줍니다.
5. **그 프로젝트에 pack 이 있는지 봅니다.** `cascade init` 은 프로젝트를 등록할
   뿐이고, 답의 근거가 되는 pack 을 만드는 것은 `cascade analyze` 입니다. 그
   전까지는 호출이 `pack-unreadable` 로 돌아오며 어느 경로를 봤는지 밝힙니다.

## 에이전트가 먼저 물어야 할 것

`overview` 로 시작하십시오. 한 번의 호출이고, 이 pack 에 무엇이 있고 그중 얼마가
끝에서 끝까지 이어져 있는지를 말해 주며, `limits` 와 `trust.knownGaps` 가 이
pack 이 답할 수 없는 질문이 무엇인지를 그 질문을 던지기 전에 알려 줍니다. 그다음
이름이 아직 없으면 `browse`, 이름의 일부가 있으면 `search`, 대상이 정해지면
영향 도구들입니다. 각 도구가 받는 인자까지 포함한 전체 카탈로그는
[mcp.md](../../mcp.md) 에 있습니다.
