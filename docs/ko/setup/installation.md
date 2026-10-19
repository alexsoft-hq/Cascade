# 설치·업데이트·복구

[English](../../setup/installation.md)

Cascade 는 Node 20 이상에서 macOS, Linux, Windows 실행을 지원합니다. SQL 분석은
Python 과 `adapters/sql/requirements.txt` 에 고정된 정확한 sqlglot 버전
(현재 `30.17.0`)이 필요합니다. CI 기준 Python 은 3.12 입니다. Java 분석은
`java` 와 `javac` 가 있는 JDK 17 이상이 필요합니다. 웹 파서는 동봉됩니다.

## 설치와 확인

```sh
npm install -g @alexsoft-hq/cascade
cascade --version
cascade setup
cascade doctor
```

`setup` 은 Python 패키지를 내려받을 수 있습니다. 엔진에는 npm 런타임 의존성이
없습니다. `doctor --json` 은 기계가 읽을 수 있는 보고서를 출력하며 필수 항목이
모두 통과해야 종료 코드가 0 입니다. 선택 항목인 DB 드라이버와 Docker 는 성공
여부를 결정하지 않습니다. JDK 는 별도로 설치합니다. [Java 레인](../../setup/java-lane.md)을
참고하세요.

저장소 체크아웃에서는 `cascade` 대신 `node bin/cascade.mjs` 를 사용합니다.
전역 설치 패키지는 `<cascade home>/venv`, 체크아웃은 기본적으로 `<engine>/.venv`
에 Python 환경을 만듭니다. 체크아웃에서도 `setup --home` 으로 홈 환경을 선택할
수 있습니다. 도구 홈은 보통 `~/.cascade` 이며 `CASCADE_HOME` 으로 바꿉니다.
Windows 는 가상환경의 `Scripts\python.exe`, macOS 와 Linux 는 `bin/python` 을 씁니다.

`cascade analyze --help` 같은 하위 명령 도움말은 작업 없이 0 으로 종료합니다.
전체 도움말(`cascade --help`, `-h`, `help`, 인수 없음)은 stderr 에 출력하고
의도적으로 2 로 종료합니다. `cascade --version` 은 프로젝트 파일·레지스트리·캐시를
만들지 않고 버전을 출력한 뒤 0 으로 종료합니다.

## 업데이트와 복구

```sh
npm install -g @alexsoft-hq/cascade@latest
cascade --version
cascade setup
cascade doctor
```

업데이트 뒤에는 MCP 클라이언트를 다시 시작하여 서버 프로세스가 새 버전을 읽게
하세요. 특정 버전으로 업데이트하거나 되돌리려면 `latest` 를 원하는 공개 버전으로
바꾸고, 이후에도 `setup` 과 `doctor` 를 실행합니다. 워커와 파서 고정 버전이
바뀔 수 있으므로 오래된 분석으로 보고되면 프로젝트를 갱신하거나 다시 분석하세요.

관리하는 Python 환경의 sqlglot 이 없거나 손상되었거나 버전이 다르면 `setup` 이
복구합니다. `setup --force` 는 버전이 맞아도 재설치합니다. 교체 환경이 검증될
때까지 이전 환경을 보관하고, 실패하면 복구합니다. venv 바깥의 레지스트리·캐시·프로젝트
데이터는 보존합니다. 실패 시 안내된 Python·pip·네트워크·권한 문제를 해결하고
다시 실행하세요. venv 복구를 위해 도구 홈 전체를 삭제할 필요는 없습니다.

`CASCADE_PYTHON` 으로 지정한 외부 인터프리터는 항상 읽기 전용입니다. `--force`
로도 변경하지 않습니다. 정확한 고정 버전이면 검증에 성공하고, sqlglot 이 없거나
버전이 다르면 실패하며 직접 실행할 pip 명령을 안내합니다.

```sh
# CASCADE_PYTHON 으로 지정한 실행 파일로 바꾸세요.
python -m pip install sqlglot==30.17.0
```

또는 POSIX 셸에서는 `unset CASCADE_PYTHON`, PowerShell 에서는
`Remove-Item Env:CASCADE_PYTHON` 으로 해제한 다음 `cascade setup` 을 실행합니다.
체크아웃의 `.venv` 는 홈 환경보다 우선할 수 있습니다. `doctor` 가 선택된
인터프리터를 알려 줍니다.

## CI 검증 범위

다음은 설치 워크플로에 정의된 검사입니다. 이 변경이 이미 모든 러너에서
통과했다는 뜻은 아닙니다. 실제 측정 결과는 워크플로 실행에서 확인하세요.
실행 지원 범위와 CI 에서 검사하는 조합은 구분합니다.

| 실행 시점 | OS·아키텍처 | Node / Python / JDK | 검사 |
|---|---|---|---|
| PR·main push | macOS 15, Apple Silicon | 22 / 3.12 / Temurin 21 | 전체 Node 테스트와 필수 CLI e2e 픽스처 |
| PR·main push | Linux x64 | 20 / 3.12 / Temurin 17 | 설치된 npm tarball smoke |
| PR·main push | Linux x64 | 22 / 3.12 / Temurin 21 | 설치된 npm tarball smoke |
| PR·main push | Windows x64 | 22 / 3.12 / Temurin 21 | 설치된 npm tarball smoke |
| PR·main push | macOS 15, Apple Silicon | 22 / 3.12 / Temurin 21 | 설치된 npm tarball smoke |
| 주간·수동 | macOS 15, Intel | 22 / 3.12 / Temurin 21 | 설치된 npm tarball smoke |

설치 smoke 작업들은 같은 tarball 을 별도 소비자 디렉터리와 도구 홈에서
설치해 검사합니다. 체크아웃 소스 테스트와 별도로 npm 에 실리는 결과물을
확인합니다. 기존 Linux·Windows·DB·고정 프로젝트 검사도 유지됩니다.

## 릴리스 전 패키지 검증

체크아웃에서 배포 없이 임시 tarball 을 만들고 설치해 검사합니다.

```sh
npm run test:package
npm run test:package -- --tarball /path/to/cascade.tgz
```

릴리스 식별 정보와 설치를 확인하려면 대상 버전을 지정합니다.

```sh
npm run verify:release -- --tag vX.Y.Z
npm run verify:release -- --npm-version X.Y.Z
npm run verify:release -- --tag vX.Y.Z --npm-version X.Y.Z
npm run verify:release -- --tarball /path/to/cascade.tgz --expected-version X.Y.Z
```

이 명령은 검증만 하며 배포·태그 생성·패키지 버전 변경은 하지 않습니다.
`--npm-version` 검증은 공개된 패키지를 읽으므로 레지스트리 접근이 필요합니다.
실제 검사 대상과 결과는 명령 출력에서 확인하세요.
