[English](../../setup/web-lane.md) | **한국어**

# 웹 레인(프런트엔드) 설정

웹 레인은 왕복 중 **화면 쪽**을 읽습니다. 엔진의 나머지는 HTTP 엔드포인트에서
시작해 아래로 내려가지만(`endpoint → service → mapper → SQL → table → column`),
이 레인은 엔드포인트 위쪽 코드를 읽습니다. 그 엔드포인트를 부르는 프런트엔드
코드와, 사용자가 지금 어느 화면에 있는지를 정하는 라우트입니다.

**먼저 이것부터 읽어 주세요. 이 버전이 하는 일의 전체 그림입니다.** 이 레인은
프런트엔드의 호출을 **이 pack 이 서빙하는 엔드포인트에 붙여서**, 등급이 매겨진
`CALLS_HTTP` 엣지로 만듭니다. 그리고 라우터 자신의 선언을 **화면**으로 바꾸어,
각 화면이 마운트하는 컴포넌트의 함수들과 잇습니다. 그래서 컬럼 영향 답이
컨트롤러를 지나 위로, 라우트를 부르는 api 함수와 그 함수를 부르는 뷰를 거쳐,
사용자가 보고 있는 화면까지 닿습니다. 브라우저 기록(`--har`)은 같은 엣지 위에
런타임 증거로 겹쳐 놓을 수 있지만, 보여 주기만 하고 걷지는 않습니다.

이 레인이 만드는 엣지는 모두 근거를 적어 둡니다. `web` 축은 프런트엔드에
대해 아무것도 추측하지 않았을 때만 `shipped` 가 됩니다. 엔진이 매칭 개수를 세어
알아낸 접두사나 가정한 경로 별칭이 있으면 축은 `degraded` 가 되고, 무엇을
선언하면 되는지 이름으로 알려 줍니다.

## 무엇이 필요한가

**Node, 그것뿐입니다.** 파서가 동봉되어 있으므로
(`adapters/web/vendor/babel-parser.cjs`, `@babel/parser` 7.29.8, MIT) `npm
install` 도, 락 파일도, 분석 시점의 네트워크도 없습니다. 저장소 `NOTICE` 가
그것을 밝히고, `adapters/web/vendor/README.md` 가 정확한 바이트와 고정된 sha256,
그리고 갱신 방법을 적어 둡니다. `cascade doctor` 에는 파서를 실제로 적재해서
statement 하나를 파싱해 보는 `web lane parser (vendored)` 줄이 있으므로, 잘린
체크아웃은 "프런트엔드 호출 0 개"가 아니라 이름 붙은 실패로 드러납니다.

## 무엇을 읽는가

각 소스 루트 아래를 재귀적으로 훑어 `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
`.tsx`, `.vue` 단일 파일 컴포넌트의 `<script>` 블록, 그리고 Nexacro 클라이언트의
`.xfdl` 폼과 `.xjs` 스크립트의 `<Script>` 블록, WebSquare 클라이언트의 `.xml`
페이지 안 `<script>` 블록을 읽습니다. `.vue` 파일의 줄
번호는 템플릿까지 포함한 `.vue` 파일 안의 줄이므로, 사실이 가리키는 자리가
여러분이 커서를 놓을 자리입니다.

건너뛰는 것은 이렇습니다.

| 건너뛰는 것 | 어디서 | 왜 |
|---|---|---|
| `node_modules`, `.git`, `.cascade` | 깊이 무관 | 1차 소스인 적이 없습니다 |
| `plugins`, `libs`, 그리고 동봉된 라이브러리 이름의 디렉터리 | 깊이 무관, **발견 단계에서** | 이름으로 알 수 있는 남의 프런트엔드입니다. 목록은 `adapters/web/packs/vendor-dirs.json` 입니다 |
| `__tests__`, `__mocks__` | 깊이 무관 | 테스트는 어디에 있든 다른 프로그램입니다 |
| `dist`, `build`, `coverage`, `public` | **소스 루트나 그 패키지 디렉터리의 직계 자식일 때만** | 거기서는 출력물이고, 더 깊은 곳에서는 그냥 평범한 이름입니다 |
| `*.d.ts` | 전부 | 타입 선언에는 호출이 없습니다 |
| `*.test.*`, `*.spec.*` | 전부 | `__tests__` 와 같은 이유입니다 |
| `*.min.js` | 전부 | 소스가 아니라 번들입니다 |
| 2 MB 초과 파일 | 전부 | `skipped: "too-large"` 로 기록하며 조용히 버리지 않습니다 |

세 번째 줄의 위치 규칙이 핵심입니다. 그냥 조심하자는 얘기가 아닙니다.
"`build` 라는 이름은 무조건 건너뛴다"로 하면 `src/views/tool/build/` 를 조용히
버립니다. 이 레인을 측정한
프런트엔드 중 하나에서 그것은 폼 빌더이고 진짜 화면 여섯 개였습니다. 빌드
디렉터리는 출력이 나가는 자리에 있을 때만 빌드 디렉터리입니다. 패키지의
꼭대기이거나 소스 루트의 꼭대기입니다. 그 밖의 자리에서 그 단어는 그냥
단어입니다.

알아 둘 만한 결과가 하나 있습니다. `cascade init` 의 발견 단계는 **일괄** 스킵
목록(`src/core/discover.mjs`)을 쓰는데, 같은 목록이 Java 레인을 Gradle 의
`build/` 출력으로부터 지키기 때문입니다. 그래서 발견이 보고하는 `webFiles` 와
`vueFiles` 개수는, 그리고 `cascade estimate` 가 그것으로 출력하는 개수는, 레인이
실제로 읽는 것보다 몇 개 **적을** 수 있습니다. 측정한 프런트엔드 하나에서는
발견이 `.vue` 91 개를 세는 동안 레인은 97 개를 읽었습니다. 실행 후에 출력되는
lane 줄이 측정된 숫자이고, estimate 의 숫자는 하한입니다.

파서가 아예 읽지 못한 파일은 줄과 열과 메시지를 붙여 `parse_error` 로 기록하고
**lane 줄에 출력**합니다. 파싱에 실패한 파일은 호출도 라우트도 내놓지 않으며,
실행 중 다른 어떤 것도 그 사실을 말해 주지 않습니다.

소스 루트와는 별개로, 패키지 디렉터리(가장 가까운 `package.json` 이 있는
디렉터리)마다 한 번씩 다음을 읽습니다. dotenv 파일(`.env`, `.env.local`,
`.env.<mode>`, `.env.<mode>.local`), 개발 서버 프록시 표를 위한 `vue.config.js`
와 `vite.config.*`, 그리고 경로 별칭을 위한 `tsconfig.json` 이나
`jsconfig.json` 또는 번들러 설정입니다. 이 셋이 함께 호출 속의 `'/api'` 가 실제로
어디에 닿는지를 정하고, 브리지는 셋을 모두 씁니다.

### 서버가 그리는 페이지

애플리케이션에 화면이 있는 방법이 프런트엔드 라우터뿐인 것은 아닙니다. 이 도구가
쓰이는 시스템의 상당수에는 라우터가 아예 없습니다. `@Controller` 가 뷰 이름을
돌려주면 템플릿 엔진이 그것을 그리고, 페이지 자신의 `<script>` 가 백엔드를 부르고,
`<form>` 이 라우트로 전송하고, 링크가 다른 라우트를 엽니다. 이 레인은 프로파일이
이름을 댄 **템플릿 루트**에서 그 페이지도 읽습니다.

| 엔진 | 확장자 | 루트를 찾는 방법 |
|---|---|---|
| Thymeleaf | `.html` | `spring.thymeleaf.prefix` / `.suffix`, 없으면 `classpath:/templates/` + `.html` |
| FreeMarker | `.ftl` | `spring.freemarker.template-loader-path` / `.suffix`, 없으면 `classpath:/templates/` + `.ftl` |
| JSP | `.jsp` | `spring.mvc.view.prefix` / `.suffix`, Spring XML 의 `ViewResolver` **빈**, 없으면 `.jsp` 들이 실제로 놓인 `webapp` / `WEB-INF` 아래 |
| Velocity | `.vm` | `spring.velocity.resource-loader-path` / `.suffix` |
| 순수 HTML | `.html` | 엔진 설정도 없고 안에 `th:` 속성도 없는 `.html` 페이지들의 루트 |

설정된 접두사는 클래스 경로나 서블릿 컨텍스트의 위치이지 저장소 안의 경로가
아닙니다. 그래도 그것이 말해 주는 것은 **디렉터리가 어떻게 끝나는가** 이므로,
`classpath:/templates/` 는 `src/main/resources/templates` 를 집어내고
`/WEB-INF/jsp/` 는 `src/main/webapp/WEB-INF/jsp` 를 집어냅니다. 설정이 아무것도
없으면 루트는 한 리소스 루트의 모든 템플릿이 함께 놓인 디렉터리가 되며, 그래야
멀티 모듈 저장소의 모듈들이 서로 섞이지 않습니다.

#### 빈으로 쓴 리졸버

Boot 이전에 쓰인 Spring MVC 애플리케이션은 그 설정을 XML 빈 정의에 둡니다.
eGovFrame 이 그렇고, 한국 공공부문의 상당수가 그렇게 돌아갑니다.

```xml
<bean class="org.springframework.web.servlet.view.UrlBasedViewResolver" p:order="1"
    p:viewClass="org.springframework.web.servlet.view.JstlView"
    p:prefix="/WEB-INF/jsp/" p:suffix=".jsp"/>
```

발견 단계가 이것을 읽습니다. 같은 질문, 같은 기록, 다른 철자입니다. 클래스 이름이
`ViewResolver` 로 끝나면서 prefix 나 suffix 를 설정하는 빈을, 파일 **이름**이
아니라 **루트 엘리먼트**(`<beans>`)로 판별합니다. `dispatcher-servlet.xml`,
`egov-com-servlet.xml`, `spring-mvc.xml` 은 같은 문서이고, 이름 목록으로 했다면
다음 프로젝트의 철자에서 멈췄을 것입니다. `p:` 축약으로 쓴 속성과
`<property name=… value=…/>` 자식으로 쓴 속성을 똑같이 읽습니다. 주석 처리된
빈은 빈이 아닙니다. prefix 도 suffix 도 없는 리졸버(`BeanNameViewResolver`)는
뷰 이름을 디렉터리가 아니라 빈으로 해석하므로 어떤 루트도 이름 대지 않습니다.

그 빈이 무슨 엔진으로 그리는지는 먼저 suffix(`.jsp`, `.ftl`, `.vm`, `.html`)에서,
그다음 자기 클래스나 `viewClass`(`JstlView`, `InternalResourceView`,
`FreeMarker…`, `Velocity…`, `Thymeleaf…`)에서 옵니다.

이것이 얼마나 값어치가 있는지는 측정된 숫자로 말합니다. 이 규칙 이전에
`eGovFramework/egovframe-enterprise-business-template` 는 JSP 92 개를 싣고도
화면을 **0 개** 만들었고, `egovframe-common-components` 는 747 개를 싣고 **1 개**
를 만들었습니다. 둘 다 루트가 `src/main/webapp` 으로 떨어져서
`uat/uia/EgovLoginUsr` 이 아무것으로도 해석되지 않았기 때문입니다. 빈을 읽고
나서는 **84 개**와 **657 개**를 만듭니다.

**Apache Tiles 는 읽지 않으며**, 이번에는 가정하지 않고 실제로 찾아봤습니다.
RM55 에서 측정한 eGovFrame·Nexacro 저장소 11 개 중 어디에도 `TilesConfigurer`
도, tiles 정의 파일도, `put-attribute` 도 없습니다. Apache Tiles 는 2021 년에
은퇴했고 Spring Framework 6 이 지원을 뺐으므로 eGovFrame 4.x 에는 없습니다.
`forward:` 뷰 이름은 RM48 부터 읽고 있습니다. `redirect:` 와 똑같이 같은
애플리케이션의 다른 라우트를 향한 호출입니다.

`static/` 아래의 `.html` 은 템플릿이 **아닙니다.** 서버가 그대로 내려 주고
리졸버가 그리지 않으며, 그것들을 다 읽으면 프로젝트가 거기 무엇을 넣어 두었든
전부 훑는 비용이 듭니다. `.html` 템플릿은 `templates` 나 `WEB-INF` 디렉터리
아래, 또는 설정이 말하는 자리에 있습니다.

`cascade init` 은 찾은 것을 프로파일의 `templateRoots` 에 쓰고 한 줄로 그렇게
말합니다. 이미 목록이 있으면 그것은 여러분의 것이고 손대지 않습니다. `webRoots`
와 같은 규칙입니다. `cascade analyze` 는 이번 실행의 발견이 아니라 **프로파일**
에서 루트를 읽습니다. 템플릿 루트는 pack 의 내용을 정합니다. pack 이 아무도
기록하지 않은 입력에 따라 달라져서는 안 되기 때문입니다.

템플릿 하나에서 읽는 것은 네 가지이고, 그 밖에는 없습니다.

- **인라인 `<script>` 블록.** 템플릿 자신의 지시자를 먼저 **무력화**합니다.
  FreeMarker 의 `<#…>`, `</#…>`, `<@…>`, `${…}`, JSP 의 `<%…%>`, `<%=…%>`,
  `${…}`, Thymeleaf 의 `[[…]]`, `[(…)]` 를 줄 위치를 그대로 유지하는 자리표로
  바꾸고, 남은 것을 모든 `.js` 파일이 지나는 **같은** JavaScript 리더에 넣습니다.
  JSP **커스텀 태그**(`<prefix:name …>`, `<prefix:name …/>`, `</prefix:name>`)는
  스크립트가 아니라 페이지의 것이므로 같은 방식으로 뺍니다. `<c:url>` 과
  `<spring:url>` 은 애플리케이션 루트에서 쓴 자기 `value` 가 됩니다(값 안의
  표현식은 구멍입니다). 닫는 태그와 제어 태그(`c:if`, `c:forEach`, `c:choose`,
  `c:when`, `c:otherwise`, `c:set` 같은 것)는 아무것도 남기지 않습니다. 나머지
  태그는 값 자리표가 됩니다. 셋 다 따옴표를 남기지 않습니다. 예전에는 그
  따옴표가 JavaScript 문자열을 일찍 끝내 버렸습니다.
  `var pagetitle = "<spring:message code="comCmm.unitContent.20"/>";` 와
  `buttonImage: '<c:url value='/images/…/bu_icon_carlendar.gif'/>'` 가 각각 블록
  전체를 날렸고, 재 보니 eGovFrame common components 페이지 739 개 중 347 개(블록
  348 개), business template 90 개 중 21 개가 스크립트 호출을 전부 잃고 있었습니다.
  지금은 하나도 실패하지 않습니다. 그러고도 파싱되지 않는 블록은 그 블록의
  `parse_error` 이며 실행에는 아무 대가도 없습니다. `<script src=…>` 는 그 자체가 파일이고 인라인 블록이 아닙니다.
- **폼.** `<form action>`, `th:action="@{…}"`, `<form:form action>`. 각각 호출
  지점 하나이고, 메서드는 속성에서, 없으면 GET 입니다.
- **링크.** 앱 루트에서 시작하는 경로를 가리키는 `href` 나 `th:href` 입니다.
  정적 자산은 라우트가 아니므로 접두사(`/webjars`, `/resources`, `/static`,
  `/css`, `/js`, `/images`, `/fonts`)와 확장자로 뺍니다. 질의 문자열은 라우트의
  일부가 아니므로 떼고, 호스트가 붙은 주소는 남의 것이라 뺍니다.
- **인클루드.** `<%@ include file>`, `<jsp:include page>`, `<#include>`,
  `<#import>`, `th:replace` / `th:insert` / `th:include`. JSP 와 FreeMarker 는
  인클루드를 **포함하는 파일**의 디렉터리 기준으로 풀고(앞의 슬래시는 루트를
  뜻합니다), Thymeleaf 는 프래그먼트 표현식을 언제나 루트 기준으로 풉니다. 해석은
  어휘적입니다. 파일을 열지 않으므로 shard 는 자기 파일의 바이트만 서술합니다.

**컨텍스트 경로가 앱 루트입니다.** `${request.contextPath}`,
`${pageContext.request.contextPath}`, `@{/…}`, `<c:url>`, `<spring:url>` 은 전부
이 배포가 어디에 마운트되었는지를 가리키며, 그것은 pack 이 서빙하는 어떤 라우트의
일부도 아닙니다. 그래서 페이지의 접두사는 빈 문자열이고 `prefix.from` 은
`context-path` 입니다. 추측한 것이 없습니다. 레이아웃에
`var base_url = '${request.contextPath}'` 를 쓰고 그것을 인클루드하는 페이지에서
`base_url + "/things/list"` 를 쓰는 경우도 같은 방식으로 읽습니다. 워커는 URL 이
올라탄 **이름**을 기록하고, 브리지가 인클루드 그래프로 그 구멍을 메웁니다.

**스크립트 안에 써 넣은 경로도 경로입니다.** 템플릿 엔진은 브라우저가 페이지를
보기 전에 `<c:url>` 이나 `<spring:url>` 을 채워 넣습니다. 그래서
`location.href = "<c:url value='/things/list.do'/>"` 는
`<a href="<c:url value='/things/list.do'/>">` 와 똑같이 주소 `/things/list.do`
입니다. 페이지 스크립트가 URL 리더에 넘기는 모든 문자열 리터럴은 속성이 지나는
바로 그 규칙을 지납니다. 태그는 채워 넣고, 앱 자신의 표현식(`${…}`)은 원래대로
구멍으로 둡니다. 질의 문자열은 떼고, 정적 자산은 라우트로 세지 않습니다.

#### 스크립트가 전송하는 폼은 요청입니다

모든 eGovFrame 페이지가 이 모양으로 쓰여 있고, 그 안에 HTTP 클라이언트는 어디에도
없습니다.

```jsp
<form:form modelAttribute="sampleVO" id="listForm" name="listForm" method="post">
…
function fn_egov_select(id) {
    document.listForm.id.value = id;
    document.listForm.action = "<c:url value='/updateSampleView.do'/>";
    document.listForm.submit();
}
function fn_egov_link_page(pageNo) {
    document.listForm.pageIndex.value = pageNo;
    document.listForm.action = "<c:url value='/egovSampleList.do'/>";
    document.listForm.method = "get";
    document.listForm.submit();
}
```

폼의 `action` 에 주소를 대입하고 같은 폼에서 `submit()` 을 부르면, 그것은 그
주소를 향한 HTTP 호출입니다. 규칙 이름은 `form-submit` 입니다.

**같은 폼**이란 **쓰인 그대로** 같은 수신자 표현식이라는 뜻입니다.
`document.listForm`, `document.forms['listForm']`, `document.forms.listForm`,
`document.all['listForm']`, `document.getElementById('listForm')`, 그중 하나에
묶인 변수(오래된 브라우저를 위해 옛 전자정부 페이지가 쓰는
`getElementById('listForm') || document.forms['listForm']` 도 포함), 그리고 jQuery 의
`$('#listForm').attr('action', url)` / `.prop('action', url)` 뒤에 오는
`$('#listForm').submit()` 을 모두 읽습니다. 같은 텍스트가 두 번 나오면 같은
폼입니다. 뒤따르는 `submit()` 이 없는 `.action` 대입은 호출이 **아닙니다.**
그것은 사용자가 버튼으로 전송하는 폼이고, 그 주소는 템플릿 리더가 마크업에서 이미
갖고 있습니다.

**submit 은 자기 스코프만 읽습니다.** submit 은 **같은 스코프** 안에서 자기 앞의
가장 가까운 대입을 주소로 씁니다. 스코프는 둘러싼 함수이고, 모듈 본문 전체는
하나의 스코프입니다. 이 관용구가 나오는 페이지에는 주소를 대입하고 전송하는
페이징 함수 옆에, 전송만 하는 검색 함수가 있습니다.

```js
function linkPage(pageNo) { document.listForm.pageIndex.value = pageNo;
  document.listForm.action = "<c:url value='/sym/ccm/cde/EgovCcmCmmnDetailCodeList.do'/>";
  document.listForm.submit(); }
function fnSearch() { document.listForm.pageIndex.value = 1; document.listForm.submit(); }
```

`fnSearch` 가 보내는 것은 `linkPage` 가 대입한 주소가 아닙니다. 페이지는 전송할
때마다 새로 그려지므로, 다른 함수가 해 둔 대입은 이 함수가 돌 때 이미 남아 있지
않습니다. 이 함수가 보내는 것은 `<form>` 엘리먼트가 마크업에 달고 있는
`action` 이고, 마크업 폼이 지나는 바로 그 리더로 읽습니다. 증거가 어느 쪽이었는지
말합니다(`form.actionFrom`: `assigned` 또는 `form element`). 자기 스코프에서 아무
것도 대입하지 않았고 폼 엘리먼트에도 이 레인이 읽을 수 있는 주소가 없는 submit
은 엣지를 놓지 않고 셉니다(`laneStats.web.calls.formSubmitsWithoutAddress`).
주소 전체가 페이지 표현식(`"${url}"`)인 경우도 같습니다. 스코프는 이름이 아니라
함수 그 자체이므로, 페이지가 마침 같은 이름을 붙인 함수 둘(`fn_x`, `fn_x~2`)은
스코프도 둘입니다. 스코프를 가르기 전에 재 보니, business template 의 form-submit
엣지 139 개 중 11 개, common components 의 569 개 중 56 개가 이웃 함수의 주소를
빌려 쓰고 있었습니다.

**메서드**는 이 순서로 정합니다.

1. 같은 스코프 안에서 submit 앞에 같은 폼에 대입된 `.method = "get"` /
   `"post"`. 주소 대입보다 앞이든 뒤든 셉니다. 페이지가 스스로 말한 것입니다.
2. 없으면, 그 이름이나 id 로 같은 페이지에서 찾아지는 `<form>` 엘리먼트의
   `method` 속성. Spring 의 `<form:form>` 은 POST 로, HTML 의 `<form>` 은 GET 으로
   보냅니다. 둘 다 추측이 아니라 이 페이지가 그려지는 규격에 쓰여 있는 값입니다.
   Spring 태그는 `id` 가 없으면 `id="<modelAttribute>"` 로 그립니다. 그래서
   `document.getElementById('groupManage')` 는 `<form:form modelAttribute="groupManage">`
   를 찾고, 이 레인도 똑같이 찾습니다.
3. 페이지가 직접 만든 폼(`document.createElement('form')`)이면 GET. 아무도
   메서드를 정하지 않았을 때 HTML 이 보내는 값입니다.
4. 그것도 없으면 메서드 없이 `ANY` 로 라우트를 대조하고, 증거가 이 파일에서 폼
   엘리먼트를 찾지 못했다고 말합니다. 폼을 인자로 받는 함수(`function save(form)`)가
   이 경우입니다.

증거에는 소스가 쓴 그대로의 폼 이름과 메서드의 출처(`assigned`, `form element`,
`created by the page`, `not found`)가 실리고, 집계가 출처별로 셉니다(`methodBySource`,
`laneStats.web.calls.formSubmits`). 대조와 등급은 페이지 링크와 같습니다. 호출은
무엇도 SOUND_SET 위로 올라가지 않습니다. 어느 핸들러가 그 경로에 답하는지는
마크업이 아니라 라우트 표가 정하기 때문입니다.

고정된 코퍼스에서 측정한 결과, 이것이 이 레인에 남아 있던 가장 큰 구멍
하나였습니다. `egovframe-sample` 은 호출 **0 개**에서 **8 개**가 되었고, 목록
화면은 아무 테이블에도 닿지 못하던 상태에서 자기가 나열하는 그 테이블에
닿았습니다. business template 은 form submit 189 개(스코프 안 대입 177, 폼
엘리먼트 12)를, common components 는 1207 개를 읽습니다. 위의 폼 이름 형태와
메서드 출처는 첫 측정이 남은 것을 보여 준 뒤에 넓혔습니다. 메서드를 모르는
submit 이 business template 에서 47 개에서 12 개로, common components 에서 281 개에서
98 개로 줄었고, 그만큼 form-submit 엣지 35 개와 181 개가 HEURISTIC 에서 SOUND_SET
으로 올라갔습니다. common components 에 남은 98 개는 인자로 받은 폼 29, 이
페이지에 없는 폼 이름 25, 함수 밖에서 선언한 변수 24, 페이지를 감싼 프레임
(`parent.document`) 12, 기타 8 입니다.

#### 페이지 안에서 `location.href` 는 GET 요청입니다

RM59 는 요청과 화면 전환을 가르는 것이 싱크이지 파일 종류가 아니라고 썼습니다.
측정해 보니 브라우저 자신의 전역에 대해서는 그 말이 틀렸습니다. eGovFrame
코퍼스의 모든 `location.href` 는 같은 애플리케이션의 컨트롤러를 가리키는
`<c:url>` 이고, 서버가 그리는 페이지에는 **라우터가 없습니다.** 그 주소에 답해 줄
것은 서버뿐이므로 브라우저가 가서 받아 옵니다. 같은 페이지의 링크와 똑같습니다.
그래서 템플릿 파일 안의 `location.href = …`, `window.location.href = …`,
`location.assign(…)`, `location.replace(…)` 는 같은 URL 규칙을 쓰는 GET 호출이고
(규칙 `location-request`), 페이지의 링크와 똑같이 대조되고 등급이 매겨집니다.
소스 파일 안에서는 그대로 화면 전환으로 남습니다.

경로로 해석되지 않는 주소 — `location.href = ""`, `#`, 다운로드, 호스트가 붙은
주소 — 는 라우트가 아니므로 템플릿 안에서도 화면 전환으로 남습니다.

### Nexacro 클라이언트

한국 공공부문과 기업 시스템의 아주 큰 몫은 위의 어느 것과도 다르게 생긴
프런트엔드를 갖고 있습니다. 화면 하나가 `.xfdl` 파일입니다. 폼과 위젯을 선언하는
XML 이고, 그 화면의 JavaScript 전부가
`<Script type="xscript5.0"><![CDATA[ … ]]></Script>` 블록 하나 안에 들어 있습니다.
공용 라이브러리는 `.xjs` 이며, 아무도 마운트하지 않는 스크립트를 같은 껍데기로
감싼 것입니다. 애플리케이션 파일은 `.xadl` 이고, 모든 url 이 기준으로 삼는 서비스
접두사는 그것이 이름 대는 typedef XML 에 있습니다.

`cascade init` 은 `.xfdl` 을 담은 디렉터리를 **`nexacro` 종류의 웹 루트**라고
부르고, 어떤 패키지도 선언하지 않는 다른 루트와 똑같이 `webRoots` 에 씁니다.

```json
"webRoots": [{ "root": "../src/main/nxui", "kind": "nexacro", "from": "discovery" }],
"frameworkPacks": ["spring-mvc", "mybatis-xml", "web", "nexacro"]
```

루트는 폼이 놓인 디렉터리가 아니라 **애플리케이션**이 놓인 디렉터리입니다. 그래야
애플리케이션 여럿을 담은 트리에서 화면 경로에 각자의 이름이 남습니다
(`packageB/Pattern/Pattern_01`).

Nexacro 루트 아래에서 이 레인은 `.xfdl` 과 `.xjs` 만 읽고 **그 밖에는 아무것도**
읽지 않습니다. 이유는 그 아래 무엇이 더 있느냐입니다. Nexacro 애플리케이션은 자기
화면 옆에 벤더의 런타임 전체를 함께 싣습니다(`nexacro14lib/`, 수백 개의 `.js`).
그것들을 읽으면 프레임워크 내부가 그래프에 들어가고 하나하나가 프런트엔드 소스
파일로 세어집니다. Nexacro 루트 아래의 `.js` 는 런타임이고, `.xfdl` 과 `.xjs` 가
사람이 쓴 것입니다.

파일 하나가 주는 것은 이렇습니다.

- **화면.** 폼 하나가 화면 하나입니다. `<Form id>` 가 애플리케이션이 부르는
  이름이고, `titletext` 가 사용자가 읽는 것이며, 루트 아래 경로가 그 경로입니다.
  자기 스크립트를 그리고(`template-own`, EXACT), `include "Lib::Comm.xjs";` 나
  `<Script … url="…">` 를 통해 포함된 스크립트의 함수들을 한 홉 밖까지
  그립니다(`template-include`, SOUND_SET).
- **스크립트.** `xscript5` 는 매개변수에 타입 표기가 선택적으로 붙는 JavaScript
  이므로 TypeScript 문법으로 읽습니다. `include` 는 Nexacro 지시자이므로 파싱
  전에 줄을 남긴 채 비웁니다. 폼은 자기 핸들러를 `this` 에 선언하므로
  (`this.fn_search = function(obj, e) {…}`) 각각이 함수 기록이 되고, 호출이
  모듈이 아니라 핸들러에 매달립니다.
- **호출.** Nexacro 클라이언트는 모든 요청을 프레임워크 호출 하나
  (`transaction(…)`)로 보내므로, 추적할 클라이언트 라이브러리도 따라갈 래퍼 사슬도
  없습니다. 두 철자를 다 읽습니다. 네이티브
  `this.transaction(id, "svcurl::userSelectVO.do", inDs, outDs, args, cb)` 와,
  제품마다 그것을 감싼 옵션 객체 형태
  `Iject.transaction(this, oDatas, cb)` + `oDatas = { sController: "userSelectVO.do", … }`
  입니다. 보는 키는 `sController`, `svcUrl`, `strSvcUrl`, `sSvcUrl`, `sUrl`,
  `url` 이고, 규칙이 아니라 `adapters/web/lib/nexacro.mjs` 의 선언입니다. 다른
  철자를 쓰는 제품은 거기에 한 줄을 더하면 됩니다. 옵션 객체는 그것을 들고 있는
  핸들러 안에서 풀므로, 둘 다 `oDatas` 라고 부르는 핸들러 둘은 url 도 둘입니다.

`prefix::path` 형태의 url 은 접두사를 typedef 의 `<Service prefixid url>` 목록으로
풀고, 그 url 의 **경로** 부분이 기준이 됩니다.
`<Service prefixid="svcurl" type="JSP" url="…/nexacro-sample/"/>` 아래의
`svcurl::userSelectVO.do` 는 `/nexacro-sample/userSelectVO.do` 입니다.
`file`/`form`/`js` 서비스는 클라이언트 자신의 자산을 가리키고 어떤 요청에도
답하지 않으므로 transaction 의 기준이 아닙니다. 그것은 `include` 를 푸는 데
쓰입니다. 접두사 없는 `x.do` 는 쓰인 그대로의 경로입니다.

엣지는 `evidence.rule` 이 `nexacro-transaction` 인 `CALLS_HTTP` 이고, 메서드는
`ANY`(Nexacro 는 POST 로 보내고 라우트 대조는 아무 메서드나 받습니다)이며, 다른
프런트엔드 호출과 똑같이 라우트 대조로 등급이 매겨집니다. url 을 이 레인이 볼 수
없는 곳에서 만드는 transaction 은 버리지 않고
**셉니다**(`laneStats.web.calls.nexacroUnreadable`). 일어나는데 어떤 엣지도
나르지 않는 요청은 요청이 없는 것과 다른 발견입니다.

transaction 이 이름 대는 in/out **데이터셋**(이번에 읽은 샘플에서 75 개)은 읽지
않으며, 측정해 보니 읽을 필요도 없었습니다. 그것은 브라우저 안의 데이터 흐름이고,
영향 분석에 필요한 것은 호출인데 transaction 기록이 이미 그것을 싣고 있습니다.

### WebSquare 클라이언트

한국 공공·금융 시스템에서 Nexacro 다음으로 자주 보는 프런트엔드가 WebSquare 입니다.
이것도 XML 입니다. 화면 하나가 `.xml` 페이지 하나이고, 요청은 모델에 미리
선언해 두고 스크립트에서 그 이름을 불러 보냅니다.

```xml
<html xmlns:w2="http://www.inswave.com/websquare" xmlns:xf="http://www.w3.org/2002/xforms">
  <head meta_screenId="SP001M01" meta_screenName="Sample list">
    <xf:model>
      <xf:submission id="sbm_search" action="/sample/searchSample" method="post"/>
    </xf:model>
    <script type="text/javascript"><![CDATA[
      scwin.btn_search_onclick = function () { $c.sbm.execute(sbm_search); };
    ]]></script>
```

그런데 `.xml` 은 Spring 설정, MyBatis 매퍼, Maven 빌드 파일의 확장자이기도
합니다. 그래서 위치가 아니라 **내용**으로 페이지를 가립니다. 루트 요소에
`xmlns:w2="http://www.inswave.com/websquare"` 네임스페이스가 있으면 페이지입니다.
`cascade init` 은 페이지 열에 아홉 이상을 담은 가장 깊은 디렉터리를 **`websquare`
종류의 웹 루트**로 잡습니다. 도구 폴더에 페이지 템플릿 하나가 떨어져 있어도
루트가 저장소 꼭대기로 끌려 올라가지 않게 하려는 규칙입니다.

```json
"webRoots": [{ "root": "../WebContent", "kind": "websquare", "from": "discovery" }],
"frameworkPacks": ["spring-mvc", "mybatis-xml", "web", "websquare"]
```

WebSquare 루트 아래에서는 페이지만 읽고 **나머지는 읽지 않습니다**. 엔진 런타임이
애플리케이션 옆 `websquare/` 에 같이 들어 있기 때문입니다. 수백 개의 `.js` 와
엔진 자체의 XML 페이지가 있는데, 이건 벤더 것입니다. Nexacro 의 `nexacro14lib/`
를 안 읽는 것과 같은 이유입니다.

페이지 하나에서 얻는 것은 이렇습니다.

- **화면.** 페이지 하나가 화면 하나입니다. `meta_screenId` 는 애플리케이션이
  부르는 이름, `meta_screenName` 은 사용자가 화면에서 읽는 제목입니다. 주소는
  루트 아래 경로에 `.xml` 을 붙인 그대로입니다(`/ui/SP/SP001.xml`). 애플리케이션이
  실제로 그 주소로 페이지를 열기 때문입니다. `<w2:type>` 이 `COMMON` 인 페이지는
  화면이 아니라 공용 함수 모음으로 봅니다.
- **스크립트.** `src` 가 없는 `<script>` 는 CDATA 껍데기를 벗겨서 `.js` 와 같은
  JavaScript 리더로 읽습니다. 줄 번호는 페이지 파일의 줄 번호를 그대로 씁니다.
  핸들러는 `scwin` 에 선언하므로(`scwin.btn_search_onclick = function () {…}`)
  호출이 모듈이 아니라 그 핸들러에 매달립니다.
- **호출.** submission 을 보내는 호출 하나가 `call` 기록 하나가 됩니다. 주소와
  메서드는 `<xf:submission>` 선언에서 가져옵니다. 읽는 철자는 셋이고, 어떤 호출이
  보내는 호출인지는 규칙이 아니라 `adapters/web/packs/websquare.json` 의 선언입니다.

  | 호출 | submission 을 가리키는 방법 |
  |---|---|
  | `$p.executeSubmission("sbm_x")` | id 문자열 (엔진 자체 호출) |
  | `$c.sbm.execute(sbm_x)` | 페이지가 그 id 에 묶어 둔 객체 (WebSquare 템플릿이 주는 공통 라이브러리) |
  | `$c.sbm.executeDynamic({ id, action, method })` | 주소를 직접 담은 옵션 객체 |

  `method` 가 없는 submission 은 WebSquare 동작대로 POST 로 봅니다.
- **화면 전환.** `$c.win.openPopup(url)` 과 `$c.win.openMenu(name, url)` 은 다른
  페이지를 여는 동작입니다. 요청이 아니라 화면 전환으로 기록합니다.
- **요청이 아닌 것.** 엔진 자체 네임스페이스인 `WebSquare.*` 아래 호출은 요청으로
  보지 않습니다. 예를 들어 `WebSquare.core.getConfiguration(…)` 은 XPath 로 엔진
  설정을 읽을 뿐입니다.

엣지는 `evidence.rule` 이 `websquare-submission` 인 `CALLS_HTTP` 이고, 등급은 다른
프런트엔드 호출과 똑같이 라우트 대조로 정합니다. 페이지가 선언하지 않은
submission 을 부르거나, 이 레인이 읽을 수 없는 옵션 객체를 넘기면 버리지 않고
**셉니다**(`laneStats.web.calls.websquareUnreadable`).

submission 이 주고받는 데이터 목록(`ref`, `target`)은 읽지 않습니다. Nexacro
데이터셋을 안 읽는 것과 같은 이유입니다. 브라우저 안의 데이터 흐름이고, 영향
분석에 필요한 건 호출 자체입니다.

### Next.js: 파일 트리가 곧 라우트 표

Next.js 는 라우트를 선언하지 않습니다. `pages/index.tsx` 가 `/` 에 답하고,
`pages/content/[id].tsx` 가 `/content/{id}` 에 답하며, 소스의 무엇도 그렇게 말하지
않습니다. 그 관례가 자기 모양을 가진 선언 팩
`adapters/web/packs/next-pages.json` 입니다. 그 `filesystem` 항목이 어느
디렉터리가 루트인지, 어떤 확장자가 세어지는지, 어느 잎 이름이 디렉터리 자신인지,
매개변수를 어떻게 쓰는지, 어떤 이름이 프레임워크 자신의 것인지, 어느 하위
디렉터리가 서버 핸들러를 담는지를 말합니다.

| 파일 | 라우트 |
|---|---|
| `pages/index.tsx` | `/` |
| `pages/privacy/index.tsx` | `/privacy` |
| `pages/content/[id].tsx` | `/content/{id}` |
| `pages/docs/[...slug].tsx` | `/docs/{slug}/**` |
| `pages/_app`, `_document`, `_error`, `404`, `500` | 페이지가 아님. 프레임워크 자신의 것 |
| `pages/api/**` | 이 프런트엔드가 서빙하는 서버 핸들러. 세고 건너뜁니다 |
| `app/**/page.tsx` | app 라우터. 잎 이름을 `page` 로 두고 같은 규칙 |

이 규칙은 `next` 에 **의존하는** 패키지 안에서만 발동하므로, 마침 `pages/`
디렉터리에 템플릿을 두고 있는 백엔드에서는 화면이 하나도 나오지 않습니다.
페이지는 그 자체가 자기 컴포넌트입니다. 어떤 선언도 이름 대지 않고 어떤 것도
import 하지 않으므로, RENDERS 와 페이지 자신의 호출은 라우터가 선언한 화면과
똑같이 동작하고 해석할 것이 없습니다. 실행은 두 숫자를 다 말합니다.

```
the file tree: 62 page(s) declared by where they sit, 9 file(s) under the router's api directory read as server handlers instead
```

## 무엇을 기록하는가

사실 하나에 JSONL 레코드 하나이며, 전부 **파일 국소적**입니다. 워커는 파일을
넘나드는 해석을 전혀 하지 않습니다. 그것은 브리지의 일입니다.

| 레코드 | 무엇을 말하는가 |
|---|---|
| `file` | 언어, Vue 스크립트 블록, 파서가 복구한 오류 수 |
| `import` / `export` | 이 파일이 무엇을 받고 무엇을 주는가. 동적 `import()` 포함 |
| `function` | 이름 있는 함수들. 콜백은 자기 이름을 갖지 않고 가장 가까운 이름 있는 함수에 귀속됩니다 |
| `constant` | 문자열 멤버로 된 enum 이나 객체 리터럴, 그리고 `export const X = '/x'` |
| `binding` | 초기화가 호출이나 `new` 또는 다른 이름인 최상위 `const`, 그리고 거기서 만들어진 `baseURL` |
| `class` | 클래스와 그것이 선언하는 메서드와 필드. 클라이언트를 클래스로 쓰는 것은 함수로 쓰는 것만큼 흔합니다 |
| `assign` | 클래스 본문 어디서든 나오는 `this.<field> = …`. `binding` 과 같은 `init` 모양을 갖습니다. 클래스가 요청을 보낼 클라이언트를 넣어 두는 자리입니다 |
| `call` | import 나 지역 바인딩을 거치거나, URL 처럼 생긴 인자를 들고 있거나, `fetch` 또는 `XMLHttpRequest.open` 인 호출 지점 |
| `route` | 라우트 선언. **쓰인 그대로의** 경로, 컴포넌트, 부모, 자식 수 |
| `config` | 위에서 말한 env 값, 프록시 규칙, 별칭 |

`function` 은 본문 최상위의 마지막 `return` 이 호출이나 `new` 일 때 무엇을
**반환하는지**도 함께 기록합니다. 팩토리(`return new Client(opts)`)와 전달
메서드(`return this.request(…)`)를 이렇게 따라갑니다. 클래스 본문 안의
`this` 로 시작하는 피호출자는 자기가 어느 클래스에 속하는지 밝히므로
(`binding: {kind: "this", class: "…"}`), `this.inner.request(cfg)` 를 생성자가
대입한 필드까지 추적할 수 있습니다.

`call` 은 URL 인자를 **한 파일이 허용하는 만큼** 해석해 들고 있습니다. 리터럴,
템플릿(`'/things/' + id` 와 `` `/things/${id}` `` 둘 다 `/things/{*}` 가 됩니다),
같은 파일에 선언된 상수의 멤버, 또는 한 번 따라간 지역 `const` 입니다. 해석하지
못한 것은 이유를 밝힙니다. `parameter`, `expression`, `imported-constant` 이며,
import 된 상수는 브리지가 찾아갈 수 있도록 바인딩을 유지합니다.

## 플래그

```
cascade analyze [--web-src <dir>... | --no-web] [--openapi <file>... | --no-openapi]
                [--har <file>...]
```

- `--web-src <dir>`: 프런트엔드 소스 루트입니다. 반복 가능합니다.
- `--no-web`: 프로젝트가 선언했더라도 프런트엔드를 읽지 않습니다.
- `--openapi <file>`: OpenAPI 3 또는 Swagger 2 문서입니다. 반복 가능합니다.
- `--no-openapi`: 프로파일이나 발견이 이름을 대더라도 문서를 읽지 않습니다.
- `--har <file>`: 브라우저 기록입니다. 반복 가능합니다. 아래 *기록* 절을
  보세요.

플래그가 없으면 레인은 발견이 찾은 루트 위에서 돌지만, **프로파일이 `web`
프레임워크 팩을 선언한 경우에만** 그렇습니다. `cascade init` 은 `vue`, `react`,
`@angular/core`, `svelte` 에 의존하는 `package.json` 을 찾으면 그것을 선언하고,
같은 패키지가 라우터에 의존하면 `vue-router` / `react-router` / `angular-router`
를 더합니다. 문서는 선언할 팩 없이 같은 3 단 규칙을 따릅니다. `--openapi` 가
먼저, 그다음 프로파일의 `openapi.documents`, 그다음 발견이 찾은 것입니다.

## package.json 이 없는 프런트엔드

프런트엔드를 옛날 방식으로 싣는 제품이 아주 많습니다. HTML 페이지의
`<script src>` 태그, `src/main/resources/static/` 아래의 소스, 그리고 어디에도
없는 `package.json` 입니다. 거기서는 아무것도 프레임워크 의존성을 선언하지
않으므로 위의 규칙이 패키지를 찾지 못하고, RM47 전까지 이 레인은 그 파일들을 아예
읽지 않았습니다. spring-petclinic-microservices 의 게이트웨이에는 그런 파일이
22 개, 화면 아홉, `$http` 호출 열셋이 있었고 전부 보이지 않았습니다.

이제 `cascade init` 은 그런 디렉터리를 **동봉 웹 루트(vendored web root)** 라고
부르고 프로파일에 씁니다. 다음 셋이 모두 참일 때 자격이 있습니다.

1. 최소화되지 않은 프런트엔드 소스 파일이 적어도 하나 있고, 그 경로 어디에도 남의
   코드가 없습니다. 그것을 말하는 목록이 둘입니다. **역할** 이름
   (`node_modules`, `bower_components`, `webjars`, `vendor`, `lib`, `dist`,
   `build`, `target`)과, 남의 프런트엔드 디렉터리가 실제로 달고 있는 이름들 —
   `plugins`, `libs`, 그리고 모두가 동봉하는 라이브러리들(`codemirror`, `layer`,
   `nprogress`, `adminlte`, `select2`, …). 두 번째는 **선언**
   (`adapters/web/packs/vendor-dirs.json`)이므로, 자기 트리가 쓰는 이름 하나를
   규칙을 건드리지 않고 더할 수 있습니다. 발견 단계가 그것을 그대로 쓰고,
   `test/webfacts.test.mjs` 가 둘이 어긋나면 실패합니다. 측정: 코퍼스의 한
   프로젝트는 동봉 루트가 13 개였는데 12 개가 플러그인 디렉터리 하나씩이었고, 다른
   하나는 16 개 중 12 개가 그랬습니다. 목록을 넣고 나서 각각 1 개와 4 개가 되었고,
   둘 다 자기 것은 그대로 갖고 있습니다.
2. **자기 저장소 안**의 어떤 상위 디렉터리에도 `package.json` 이 없습니다(중첩된
   체크아웃은 질문을 처음부터 다시 시작합니다).
3. 트리가 그 디렉터리를 **서빙한다**고 말합니다. `static`, `public`, `webapp`,
   `www` 라는 이름이거나 그 아래이거나, `resources/templates` 아래이거나, **또는**
   옆의 `index.html` 이 그 안의 파일을 `<script src>` 로 불러옵니다.

루트는 매퍼 루트나 Java 루트와 똑같이 최소화되므로, 디렉터리와 그 자식이 둘 다
읽히는 일은 없습니다. `init` 은 루트마다 한 줄을 출력하고 프로파일에 씁니다.

```
frontend without a package: reading src/main/resources/static/scripts (1 root(s), 22 file(s), router angular-router). Set webRoots to [] in the profile to stop
```

루트가 몇 개든 줄은 하나입니다. 위의 동봉 디렉터리 목록이 생기기 전, `static/`
아래에 플러그인 스크립트를 두는 트리에서는 그런 루트가 열셋이었고, 같은 말을 하는
열세 줄은 발견이 아니라 읽는 사람이 넘겨 버리는 벽입니다. 앞의 다섯을 이름 대고
`and N more` 를 붙이며, 개수는 언제나 정확합니다.

```jsonc
"webRoots": [
  { "root": "../src/main/resources/static/scripts", "kind": "vendored", "from": "discovery" }
]
```

`root` 는 그 파일의 다른 모든 경로와 마찬가지로 프로파일 자신의 디렉터리 기준
상대 경로입니다. `kind` 는 `vendored`(발견이 찾음) 또는 `declared`(여러분이 씀)
입니다. 목록은 **존재하는 순간 여러분의 것입니다.** 나중의
`cascade init --force` 는 비어 있지 않은 목록을 그대로 두고 무엇을 찾았고 무엇을
적용하지 않았는지 말하며, **빈** 목록은 프로젝트가 "하나도 읽지 마라" 고 말하는
방법입니다. 한 번의 실행에 대해서는 `--web-src` 가 여전히 이깁니다.

`cascade analyze` 는 `package.json` 이 준 루트와 나란히 `webRoots` 를 읽고,
집계 줄이 어느 쪽이 어느 쪽인지 말합니다.

```
web src/main/resources/static/scripts (profile); …
web roots from the profile: 1 vendored (no package manifest): src/main/resources/static/scripts
```

**그래서 프레임워크가 무엇인가?** 어떤 의존성 목록도 말해 주지 않으므로 발견
단계가 소스를 읽습니다. 동봉 루트마다 최대 400 개 파일을 열어 라우터 팩이 이름
대는 등록자 철자를 찾습니다(AngularJS 의 `$stateProvider`, `$routeProvider`,
`$urlRouterProvider`, 그리고 `createRouter(` / `VueRouter(`,
`createBrowserRouter(` 와 그 형제들). 찾은 것이 `frameworkPacks` 로 들어가고,
`cascade estimate` 가 `web` 축에서 그렇게 말합니다.

```
web  degraded  22 frontend source file(s) in 1 root(s). 1 of those root(s) are vendored (no
                package manifest): src/main/resources/static/scripts (22 file(s)). No dependency
                list names the framework there, so the router pack is chosen from the source
                alone (angular-router). …
```

소스가 어떤 라우터도 이름 대지 않는 동봉 루트도 그대로 읽습니다. 두 줄 모두 그
사실을 말할 뿐 조용히 넘어가지 않습니다. `init` 줄에는
`no router declaration in any of them`, 축에는
`and nothing in those roots names one` 입니다.

**아무 말도 하지 않은 루트는 보고됩니다.** 남의 플러그인 스크립트 디렉터리는
바깥에서 보면 프런트엔드와 똑같이 생겼습니다. 실행이 끝나면, 읽을 수 있는 HTTP
호출도 라우트 선언도 등록도 없는 동봉 루트를 경고 하나에 모아 이름 댑니다.

```
  [warn] WEB_ROOT_SAID_NOTHING 10 root(s) have no readable HTTP call and no route declaration
  in them: …/plugins/codemirror/addon/hint, …/plugins/codemirror/mode/clike, and 5 more.
  Take them out of webRoots in the profile if they are not a frontend of yours
```

## 라우터 선언 팩

라우트 객체에는 자기만의 문법이 없습니다. 그냥 객체이고, 프레임워크가 정한 **키
이름**을 갖고 있을 뿐입니다. 그 이름들은 관례마다 파일 하나씩
`adapters/web/packs/*.json` 에 있고, 워커는 시작할 때 그 디렉터리의 모든 파일을
읽습니다.

```json
{
  "pack": "vue-router",
  "routeObject": {
    "pathKey": "path",
    "componentKeys": ["component", "components"],
    "childrenKey": "children",
    "nameKey": "name",
    "metaKey": "meta",
    "titleKey": "title",
    "redirectKey": "redirect",
    "hiddenKey": "hidden"
  },
  "registrars": ["createRouter", "VueRouter", "Router"],
  "routesKey": "routes"
}
```

객체 리터럴이 라우트가 되려면 **문자열** `pathKey` 를 갖고, `componentKeys`,
`childrenKey`, `redirectKey`, `indexKey` 중 하나 이상이 설정되어 있으며, 배열
리터럴 안이나 등록자 호출의 `routesKey` 안에 있거나 최상위에서 export 된 객체여야
합니다. 등록자를 하나도 부르지 않는 파일도 라우트를 내놓습니다. 평범한 배열을
export 하고 등록은 다른 데서 하는 프로젝트가 아주 많기 때문입니다.

`jsx` 블록(`react-router.json` 이 갖고 있습니다)은 어느 JSX 엘리먼트가 라우트이고
어느 속성이 경로와 컴포넌트를 이름 대는지 말하므로, `<Routes><Route …>` 트리를
같은 트리로 읽습니다.

두 팩이 한 객체를 함께 주장할 수 있을 때는, 그 객체가 들고 있는 **구별되는** 키를
가진 쪽이 이깁니다(`meta`/`hidden`/`redirect`/`name` 대
`element`/`lazy`/`index`). 그래도 갈리지 않으면 파일이 실제로 부르는 등록자가
정합니다. 관례를 더하려면 그 디렉터리에 JSON 파일을 하나 더 놓으면 됩니다. 고칠
코드는 없습니다.

### 사슬 형태 (`angular-router`)

AngularJS 와 ui-router 는 라우트 객체의 배열을 쓰지 않습니다. **사슬**을 씁니다.
라우트마다 호출 하나이고, 각각이 앞의 결과 위에 붙습니다.

```js
$stateProvider
    .state('app',    { abstract: true, url: '', template: '<ui-view></ui-view>' })
    .state('owners', { parent: 'app', url: '/owners', template: '<owner-list></owner-list>' });
```

`adapters/web/packs/angular-router.json` 이 그 모양을 서술합니다.

```jsonc
{ "pack": "angular-router",
  "routesFrom": "chain",
  "chain":    { "receivers": ["$stateProvider"], "method": "state", "nameArg": 0, "routeArg": 1 },
  "chainAlt": { "receivers": ["$routeProvider"], "method": "when",  "pathArg": 0, "routeArg": 1 },
  "routeObject": { "pathKey": "url", "parentKey": "parent", "abstractKey": "abstract",
                   "controllerKey": "controller",
                   "componentKeys": ["component", "template", "templateUrl"], "nameKey": null },
  "registrars": ["$stateProvider", "$routeProvider", "$urlRouterProvider"],
  "declarationCalls": [ … ],
  "registrations": { … } }
```

- **`routesFrom: "chain"`** 은 이 팩의 라우트 객체를 자기 등록자가 이름 대는
  자리에서만 읽는다는 뜻입니다. `{url: '/x', template: '<y>'}` 는 `$stateProvider`
  사슬 안에서는 라우트이고 다른 어디서는 평범한 옵션 객체입니다. 이 스위치가
  없으면 생태계에서 `url` 과 `component` 를 가진 모든 옵션 객체가 화면이 됩니다.
- 각 고리가 라우트 하나이고, 사슬이 시작하는 줄이 아니라 자기 `.state(` 의 줄에
  기록됩니다.
- 상태의 경로는 자기 `url` 을 **부모 것 위에 합성한** 것입니다. 부모는 `parent`
  키이거나 점 찍은 이름의 앞부분입니다(`app.owners` 는 `app` 을 뜻합니다). 부모는
  다른 파일에 있는 일이 잦으므로, 워커는 부모의 **이름**을 기록하고 브리지가 둘을
  잇습니다.
- **abstract** 상태는 화면이 아닙니다. 합성에는 참여합니다. url 이 `''` 인
  abstract `app` 아래의 `/owners` 는 `/owners` 입니다.
- `$routeProvider.when('/legacy', {templateUrl, controller})` 는 같은 것의 ngRoute
  철자이고, 경로가 첫 인자입니다.

### 라우트 선언은 결코 HTTP 호출이 아닙니다

`$stateProvider.state('owners', {url: '/owners'})` 가 워커에서 `/owners` 를 향한
호출로 나오고, `$urlRouterProvider.otherwise('/welcome')` 가 `/welcome` 을 향한
호출로 나오던 때가 있었습니다. petclinic 게이트웨이에서 그것은 레인이 보고하던
"URL 을 가진 호출" 아홉 중 여덟이었고, 페더레이션이 생긴 뒤로는 그 가짜 호출이
다른 서비스로 넘어가기까지 했습니다. 규칙 둘이 그것을 닫으며, 둘 다 코드가 아니라
선언입니다.

- **어느** 라우터 팩이든 라우트 객체로 알아보는 객체 인자는, 피호출자가 무엇이든
  호출에 URL 을 보태지 않습니다.
- 팩의 `declarationCalls` 에 오른 호출(`$stateProvider.state`,
  `$routeProvider.when` / `.otherwise`, `$urlRouterProvider.otherwise` / `.when`
  / `.rule`)은 선언이고 아무것도 보내지 않습니다. 그 인자는 그대로 걷습니다. 진짜
  호출이 그 안에 들어앉아 있을 수 있기 때문입니다.

### 화면 전환도 HTTP 호출이 아닙니다

`router.push('/auth/login')` 은 한 층 위의 같은 실수입니다. 단일 페이지 앱은 자기
라우터에게 물어서 화면을 바꾸고 브라우저는 아무것도 보내지 않습니다. 화면에 있던
컴포넌트가 앱이 이미 갖고 있는 다른 컴포넌트로 바뀔 뿐입니다. 이것을 HTTP 호출로
읽으면 아무도 서빙하지 않는 라우트가 되어 UNRESOLVED 등급이 되고, 서비스 여럿이
든 pack 에서는 그 가짜 호출이 형제 서비스로 넘어가려 들기까지 합니다. eGovFrame
MSA 템플릿에서 그것은 "URL 을 가진 호출" 217 개 중 39 개였습니다.

싱크는 선언입니다(`adapters/web/packs/navigation.json`). 라우터마다 철자가 다르고
각 철자는 그 프레임워크가 고정해 놓은 것이기 때문입니다.

| 라우터 | 무엇을 읽는가 |
|---|---|
| `next/router`, `next/navigation` | `useRouter().push` / `.replace` / `.prefetch` |
| `next/link` | `<Link href=...>` |
| `vue-router` | `this.$router.push` / `.replace`, `useRouter()` 를 대입한 이름 위의 같은 둘, 앱 자신의 라우터 모듈에서 import 한 이름 위의 같은 둘, 그리고 컴포넌트 마크업의 `<router-link to=...>` |
| `react-router`, `react-router-dom` | `useNavigate()(...)`, `redirect(...)`, `<Link to=...>`, `<Navigate to=...>` |
| 브라우저 | `window.location.href = ...`, `location.href = ...`, `window.location.assign(...)` / `.replace(...)` — **소스 파일에서**. 서버가 그리는 페이지에서는 같은 싱크가 GET 요청입니다. 페이지에는 라우터가 없기 때문입니다 |

호출을 화면 전환으로 만드는 것은 코드가 라우터에 붙인 **이름**이 아닙니다. 그것을
만든 훅(`const nav = useRouter()` 는 `const router = useRouter()` 와 똑같이
읽힙니다), 프레임워크가 컴포넌트마다 직접 얹어 주는 속성(`this.$router`), JSX
엘리먼트를 import 해 온 모듈(컴포넌트 라이브러리의 `Link` 는 링크가 아니라
컴포넌트입니다), import 한 이름이 온 모듈, 또는 파일의 무엇도 선언하지 않는
전역(`window.location`)입니다. 이 레인이 라우터임을 보일 수 없는 것 위의 `push`
는 여전히 호출입니다.

**앱 자신의 라우터 모듈.** Vue 애플리케이션은 라우터를 자기 모듈 하나에서 한 번
만들고, 다른 모든 파일은 거기서 import 한 이름 위에 `router.push('/x')` 를
씁니다. `this` 도 없고 훅도 없고, `router` 가 무엇인지 말해 주는 것이 그 파일에
아무것도 없습니다. 그래서 워커는 어느 모듈이 라우터**인지**, 그리고 그 모듈의
어떤 이름이 라우터를 담는지 기록합니다. `createRouter({routes})` 에 묶인 이름,
클래스를 `vue-router` 에서 가져온 `new VueRouter({routes})` / `new Router({routes})`
에 묶인 이름, 라우터의 **타입으로 선언한** 이름(`Router` 를 `vue-router` 에서
import 한 `export let router: Router`. 시작할 때 setter 가 채우는 라우터를 앱이 이렇게
씁니다), 그리고 기본 export 가 그중 하나이거나 그런 호출을 `export default` 에
곧바로 넘긴 것인지입니다. import 된 이름 위의 `router.push` / `.replace` 는 지시자와
import 한 이름을 실은 **후보**로 기록합니다.

브리지는 이 레인의 다른 모든 파일 간 질문이 지나는 그 모듈 색인으로 지시자를
풉니다. 기본 import 는 그 모듈의 기본 export 가 라우터인지 묻습니다. 이름 있는
import 는 re-export(`export { router } from './router'`, 또는
`import { router } from './router'; export { router }`)를 끝까지 따라가 그 이름을
선언한 파일에 닿고, 그 파일이 그 이름을 라우터를 담은 이름으로 기록해 두었어야
합니다. 그러면 후보는 화면 전환이 되고(`via` 가 `router-module`), 아니면 이 규칙이
있기 전과 똑같이 버려집니다. import 한 배열 위의 `list.push(x)` 는, 그 배열을
라우터와 같은 모듈에서 export 했더라도 원래 그대로입니다.

규칙이 기대는 사실은 setter 가 아니라 선언된 타입입니다. jeecg-boot 는
`export let router: Router = null as unknown as Router` 로 선언하고 `setRouter(r)` 에서
채웁니다. setter 가 넣는 값을 따라가는 것은 추측이고, 타입이 있으니 그럴 필요가
없습니다. 측정해 보니 jeecg-boot 의 화면 전환이 35 개에서 54 개로 늘었고, 그중 19 개가
라우터 모듈을 거칩니다. 어느 리포지토리의 호출 지점도 바뀌지 않았습니다.

**`<router-link to="/x">`** 는 단일 파일 컴포넌트의 `<template>` 에 쓰이며,
JavaScript 파서는 그것을 보지 못합니다. 그래서 템플릿 리더 자신의 태그
스캐너로 읽습니다. 엘리먼트 이름 하나, 속성 하나, 템플릿 언어 없음이고,
`<script>` 블록을 비운 `.vue` 파일 위에서 훑으므로 모든 줄 번호는 여전히 `.vue`
파일 안의 줄입니다. `<RouterLink>` 와 `<router-link>` 는 같은 태그입니다. 바인딩된
`:to` 는 컴포넌트가 계산하는 값이므로, 이 레인이 따라갈 수 없는 화면 전환으로
세어집니다.

경로는 텍스트로 읽거나(`push('/x')`) 라우터가 대신 받는 객체에서
읽으며(`push({pathname: '/x', query})`, `push({path: '/x'})`), 질의 문자열은 그것이
가는 곳의 일부가 아닙니다.

그다음, 브리지에서만, 그 경로를 이 프로젝트가 선언하는 화면들과 대조합니다.
호출을 라우트에 대조하는 바로 그 규칙입니다. `/user/{*}` 는 `/user/{id}` 에도
`/user/:id` 에도 내려앉습니다. 대조가 만들어 내는 것은 **엣지가 아니라 화면
노드 위의 데이터**입니다.

```json
"navigatesTo": [
  { "to": "screen:/auth/login", "path": "/auth/login", "match": "exact",
    "rule": "router-navigation", "framework": "next", "sink": "router.push",
    "file": "src/components/App/App.tsx", "line": 79 }
]
```

엣지가 없는 이유는, 화면 전환이 화면에서 컬럼까지 가는 왕복의 홉이 아니고, 그것을
그래프에 얹으면 모든 걷기가 그것을 따라가게 되기 때문입니다. 항목은 그 전환이
**쓰인** 화면, 즉 그 파일을 컴포넌트로 갖는 화면에 붙습니다. 공용 컴포넌트에 쓰인
전환은 어느 한 화면의 것이 아니므로 세기만 하고 아무 데도 기록하지 않습니다. 그
컴포넌트를 마운트하는 모든 화면의 것이라고 말하는 것은 추측일 테니까요.

무슨 일이 있었는지는 숫자 셋이 말합니다(`laneStats.web.navigation`).
`navigations`, `navigationsToScreen`, `navigationsUnmatched` 이고,
`unmatchedPaths` 가 어떤 화면도 이름 대지 못한 경로를 나열합니다. `bySource` 는
위의 규칙 중 무엇이 각각을 찾았는지 말하고(`hook`, `receiver`, `global`,
`import`, `element`, `router-module`, `router-link`), `unmatchedByKind` 는 아무것과
맞지 않은 것들이 왜 그랬는지 말합니다. `named` 는 라우터가 경로가 아니라 선언된
이름으로 찾아가는 라우트(`push({ name: 'user' })`), `bound` 는 컴포넌트가 계산하는
`:to`, `path` 는 이 레인이 찾은 어떤 화면도 이름 대지 못한 주소, `expression` 은
파일이 진술하지 않은 목적지입니다. 어떤 화면도 이름 대지 못한 경로는 어느 쪽으로
읽어도 진짜 발견입니다. 이 레인이 못 찾은 화면이거나, 프레임워크가 가진
페이지입니다(Next 의 `/404` 는 `next-pages` 팩이 화면 목록에서 빼므로
`router.push('/404')` 는 정직하게 아무것과도 맞지 않습니다).

**서버가 그리는 페이지는 링크를 GET 호출로 유지하며**, 주소창도 함께 그렇습니다.
거기서 링크는 요청 그 자체입니다. 브라우저가 서버에 다음 페이지를 달라고 하고,
페이지에는 대신 답해 줄 라우터가 없습니다. 브라우저 전역을 뺀 모든 곳에서는
**싱크**가 정하고, 브라우저 전역에서는 파일 종류가 정합니다. 위의 "페이지 안에서
`location.href` 는 GET 요청입니다" 를 보세요.

## 브리지가 하는 일과 그 정직한 등급

`src/adapters/web_bridge.mjs` 는 Java 브리지 다음에 돌고(라우트가 필요합니다),
각 호출 지점을 그것이 닿는다고 보일 수 있는 라우트마다 하나의 엣지로 바꿉니다.

| 증거 | 등급 | 왜 |
|---|---|---|
| 라우트를 선언하는 OpenAPI 문서 | 선언으로서 **EXACT** | 문서는 그 라우트가 존재한다는 프로젝트 자신의 진술이므로, 엔드포인트 노드는 **그것에 대해서만** 정확하고 다른 것에 대해서는 아닙니다. 코드도 서빙하는 라우트는 서로 뒷받침하며 코드 레인이 준 등급을 유지합니다. 문서만 이름 대는 라우트는 **핸들러 엣지를 얻지 못하므로**, 프런트엔드 호출이 엔드포인트에 닿고 거기서 멈추고 `code` 축이 그 이유로 `degraded` 가 됩니다. 아래 *OpenAPI 문서* 를 보세요 |
| 플랫폼 싱크(`fetch`, `XMLHttpRequest.open`)의 URL 이 이 pack 이 서빙하는 라우트와 맞음 | **SOUND_SET** | 요청을 브라우저가 직접 보내고 URL 인자가 계약상 URL 입니다. 이것이 HTTP 호출이라는 판단이 필요 없습니다 |
| 선언 팩이 이름을 아는 HTTP 클라이언트 인스턴스를 그 라이브러리의 동사 메서드로 호출 | **SOUND_SET** | 라이브러리가 요청을 보내고, URL 은 라이브러리가 읽는 인자입니다 |
| 각 이름이 무엇에 묶였는지를 따라가 위의 둘 중 하나까지 도달한 **래퍼** | **SOUND_SET** | 모든 홉이 레인이 실제로 읽은 바인딩이고, 그 홉들이 엣지에 실립니다(`evidence.sink.chain`) |
| 어떤 싱크로도 추적하지 **못한** 호출에 넘겨진 URL 모양의 인자 | **HEURISTIC** | 그 호출이 이 URL 을 보낼 수도, 그저 만들기만 할 수도 있습니다. 규칙 하나를 추측했습니다 |
| 위의 어느 경우든 접두사를 매칭 개수로 골랐거나, 경로 별칭을 가정했거나, 호출에 메서드가 아예 없는 경우 | **HEURISTIC** | 답의 한 부분이 추측이면 엣지 전체가 추측입니다 |
| 브라우저 기록(HAR) | **RUNTIME_ONLY** | 기록은 요청이 한 번 일어났음을 증명할 뿐 코드가 무엇을 할 수 있는지는 증명하지 않으므로, 엣지는 모든 질의 모드의 하한 아래에 있습니다. **보여 주고**(`observed: true`) **절대 걷지 않으며**, 옆의 정적 엣지의 등급을 올리지도 않습니다. APM 트레이스나 액세스 로그는 여전히 읽지 않습니다. 아래 *기록(HAR)* 을 보세요 |
| 해석은 되었지만 이곳의 어떤 라우트도 답하지 않거나, 다른 호스트를 가리키는 URL | **UNRESOLVED** | 모든 모드의 하한 아래이므로 어떤 걷기도 따라가지 않습니다. 라우트는 pack 을 떠나는 Feign 호출과 똑같이 `outbound`, `source: "web"` 으로 표시된 노드로 남습니다 |

URL 을 아예 해석하지 못한 호출은 **엣지를 얻지 못하고**, 워커가 준 이유
(`parameter`, `expression`, `importedConstant`)로 집계됩니다. 브리지에서 오는
이유가 셋 더 있습니다. `noMatch`(해석은 되었으나 이곳의 무엇도 서빙하지 않음),
`outsidePack`(다른 호스트), `allHoles`(아래 참조)입니다. 조용히 사라지는 것은
없습니다.

### 래퍼란 무엇인가

프런트엔드가 `axios` 를 직접 부르는 일은 거의 없습니다. 자기 함수를 부르고, 그
함수가 또 다른 함수를 부르고, 결국 라이브러리에 닿습니다. 이 레인은 그 사슬을
이름이 아니라 **모양**으로 따라갑니다.

- **인스턴스**는 라이브러리 모듈을 직접 쓴 것(`axios.get(…)`), 라이브러리 자신의
  팩토리로 초기화한 최상위 `const`(`axios.create(…)`), 또는 그것을 대입받은
  클래스 필드(`this.inner = axios.create(…)`)입니다.
- **래퍼**는 싱크나 다른 래퍼를 부르되 **자기 것이 아닌 URL 인자**로 부르는 함수나
  클래스 메서드입니다. 받은 것을 그대로 넘깁니다. 깊이는 자기가 부르는 것보다
  하나 큽니다.
- 안쪽 호출이 URL 을 직접 적는 함수가 **API 함수**이고, 엣지는 그 함수에서
  나옵니다. 래퍼는 노드도 엣지도 얻지 않습니다. 래퍼는 배관일 뿐입니다. 래퍼에
  노드를 주면 모든 API 함수가 거기로 몰리는 허브가 되어 정작 아무 말도 하지
  않게 되기 때문입니다.

그래서 `get(config)` 가 `this.request({ …config, method: 'GET' })` 을 반환하고
`request(config)` 가 `this.inner.request(config)` 를 반환하는 클래스는
`axios.create` 까지 끝까지 따라가고, 엣지가 그 사슬과 깊이를 기록합니다. 메서드는
래퍼 자신의 동사가 있으면 거기서, 없으면 호출의 config 에서, 그다음 라이브러리의
문서화된 기본값에서 옵니다(`method.from` 이 어느 쪽인지 말합니다).

### 접두사, 그리고 그것을 선언하는 법

소스 속의 URL 은 거의 언제나 백엔드가 서빙하는 URL 이 아닙니다. 그 사이에
클라이언트의 `baseURL` 과 개발 서버 프록시가 있습니다. 브리지는 클라이언트
인스턴스마다 이 순서로 결정하고, 그 답을 모든 엣지에 `evidence.prefix.from` 으로
싣습니다.

1. **`declared`**: 프로파일의 `gatewayRoutes` 가 이름을 댔습니다. 추측이 없으므로
   엣지는 등급을 유지합니다.
2. **`derived`**: 소스에서 base URL 을 읽었고(리터럴, `.env` 파일의 값, 절대
   주소의 경로 부분), 그중 무엇이 서버에 닿는지를 개발 프록시 규칙이 설명해
   줍니다. `rewrite` 가 있는 규칙은 떼어 내고, 없는 규칙은 유지합니다. base URL
   **없이** 만든 클라이언트도 빈 접두사로 `derived` 입니다. 추측이 아니라
   라이브러리가 그렇게 동작하기 때문입니다.
3. **`auto`**: 소스의 무엇도 그것을 말해 주지 않습니다. base URL 이 어떤 `.env`
   파일도 선언하지 않는 env 값을 가리키거나, 모드마다 값이 다른데 정리해 줄
   프록시 규칙이 없거나, 상대 접두사에 프록시 규칙이 아예 없는 경우입니다. 그때는
   모든 후보를 이 pack 이 서빙하는 라우트와 대조해 정확히 맞는 것이 가장 많은
   후보가 이깁니다. **그것은 추측이므로** 그 접두사를 지나는 모든 엣지가
   HEURISTIC 이고, 후보별 개수가 엣지에 실립니다.
4. **`none`**: 그마저도 아무것과 맞지 않아 URL 을 쓰인 그대로 씁니다.

추측을 멈추려면 `.cascade/profile.json` 에 매핑을 선언합니다.

```json
{ "gatewayRoutes": { "/dev-api": "" } }
```

키는 **프런트엔드**가 쓰는 접두사, 값은 **백엔드**가 서빙하는 접두사입니다.
`"/dev-api": ""` 는 "개발 서버가 이것을 떼어 낸다"는 뜻입니다. 키 `"*"` 는
프로젝트의 모든 호출에 적용됩니다. 이것을 선언하면 축이 `degraded` 에서
`shipped` 로, 엣지가 HEURISTIC 에서 SOUND_SET 으로 올라갑니다.

키는 접두사가 놓일 수 있는 두 자리 모두에 적용됩니다. 클라이언트의 base URL, 그
리고 호출이 접두사를 직접 달고 있을 때는 **호출 경로 자체**입니다(base URL 이
아예 없는 `$http.get('/api/customer/owners')` 가 그렇고, 게이트웨이가 서빙하는
프런트엔드가 그렇게 생겼습니다). 가장 긴 키가 이깁니다.

### 타이핑하지 않아도 되는 게이트웨이 라우트

Spring Cloud Gateway 는 이미 같은 매핑을 진술하고 있고, `cascade init` 이 그것을
읽습니다. `spring.cloud.gateway…routes` 아래에서 `Path=` 술어를 가진 라우트마다
항목 하나가 되며, `StripPrefix`, `PrefixPath`, `RewritePath` 를 적용해 백엔드
접두사를 계산하고, `uri` 에서 게이트웨이가 넘겨 주는 서비스를 읽습니다. 고전적인
키 경로와 최신 `server.webflux` / `server.webmvc` / `mvc` 철자를 YAML 과
`.properties` 양쪽에서 읽습니다.

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
            - StripPrefix=2
```

...는 이렇게 됩니다.

```json
{ "gatewayRoutes": {
    "/api/order": { "to": "", "service": "orders-service",
                    "from": "src/main/resources/application.yml" } } }
```

그러므로 값은 사람이 쓰는 평범한 문자열(백엔드 접두사)이거나 저 객체입니다.
`to` 는 같은 접두사, `service` 는 게이트웨이가 넘겨 주는 배포 단위, `from` 은 그것
을 읽어 온 파일입니다. 두 모양을 두 리더가 모두 읽으며, `service` 는 둘이 같은
경로를 서빙할 때 답을 올바른 프로젝트로 넘겨 줍니다
([개념](../concepts.md) 의 "경계 넘기" 를 보세요).

`RewritePath` 는 Spring 자신의 레퍼런스가 보여 주는 형태로 읽는데, 레퍼런스는
그것을 역슬래시와 함께 보여 줍니다.

```yaml
            - RewritePath=/portal-service/(?<segment>.*), /$\{segment}
```

역슬래시는 오타가 아닙니다. Spring 은 설정 값 안의 `${...}` 를 게이트웨이가 보기
전에 프로퍼티 자리표로 먼저 해석하므로, 게이트웨이가 캡처 참조를 받으려면 YAML
작성자가 `$\{segment}` 라고 써야 합니다. 세 철자 모두 같은 그룹을 뜻하고 셋 다
읽습니다. `/${segment}`, `/$\{segment}`, `/$\\{segment}`(따옴표가 한 겹 더 씌워진
같은 값)입니다. 이름 없는 `(.*)` 그룹에 `/$1` 도 같은 규칙입니다.

패턴은 구분자를 접두사의 어느 쪽에 두어도 됩니다. `Path=/portal-service/**` 는
접두사를 `/portal-service` 로 이름 대고, 위의 rewrite 는 `/portal-service/` —
구분자까지 포함한 접두사 — 를 씁니다. 그래서 넘겨지는 것은 접두사 아래 전부에서
서비스 이름을 떼어 낸 것입니다. 두 철자가 같은 접두사 규칙으로 읽힙니다.

읽지 **않는** 것은 추측하지도 않습니다. Spring 이 문서화한 평범한
`/prefix/(?<name>.*)` 형태를 벗어난 `RewritePath`, 패턴이 아예 다른 데서 시작하는
것, 넘겨지는 경로 전체를 설정하는 필터, 가운데에 와일드카드가 있는 패턴은
`GATEWAY_ROUTE_UNREADABLE` 진단을 내고 항목을 만들지 않습니다. 저장소가 아니라
설정 서버에 있는 라우트 표도 읽지 않으며, `cascade init` 이 그렇다고 한 번
말합니다.

프로파일에 **이미** 있는 맵은 여러분의 것입니다. `cascade init --force` 는 그것을
그대로 두고, 몇 개를 찾았고 적용하지 않았는지 말합니다.

`gatewayRoutes` 는 두 곳에서 읽습니다. 프런트엔드 호출을 위한
`src/adapters/web_bridge.mjs` 와, 명령형 Java HTTP 호출을 위한
`src/adapters/java_bridge.mjs` 입니다. 같은 재작성을 전선 반대쪽에서 보는 것입니다.
읽어 줄 레인이 하나도 없는데 선언되어 있으면, `cascade analyze` 는 조용히 무시하지
않고 `RECORDED_NOT_ACTED` 진단으로 그렇게 말합니다.

### HTTP 클라이언트 팩

어떤 라이브러리가 요청을 보내고 그중 어떤 메서드가 동사인지는 코드가 아니라
**선언**입니다. `adapters/web/packs/http-clients.json` 입니다.

```json
{ "module": "axios",
  "instanceFactories": ["create"],
  "verbs": { "get": "GET", "post": "POST", "put": "PUT", "delete": "DELETE" },
  "generic": ["request", "(call)"],
  "configUrlKey": "url", "configMethodKey": "method", "configBaseUrlKey": "baseURL",
  "defaultMethod": "GET" }
```

`"(call)"` 은 인스턴스 자체를 호출할 수 있다는 뜻입니다(`service({ url })`).
레인이 모르는 라이브러리를 가르치려면 그 파일에 행을 하나 추가하면 됩니다. 고칠
코드는 없고, 브리지의 어디에도 라이브러리 이름은 나오지 않습니다.

**페이지가 불러오는 클라이언트.** jQuery 는 `<script>` 태그로 와서 `window` 에
내려앉으므로 어떤 파일도 import 하지 않고 아무것도 묶지 않습니다. `fetch` 와 같은
이유로 플랫폼 싱크입니다. 라이브러리가 직접 요청을 보내고 어느 인자가 URL 인지
말해 줍니다. 팩이 그것이 내려앉는 전역을 이름 댑니다.

```json
{ "name": "jquery",
  "globals": ["$", "jQuery"],
  "config": { "methods": ["ajax"], "urlArg": 0, "urlKey": "url", "methodKeys": ["type", "method"] },
  "verbs": { "get": "GET", "post": "POST", "getJSON": "GET" },
  "urlArg": 0, "defaultMethod": "GET" }
```

`$.ajax({url, type})`, `$.ajax(url, settings)`, `$.post(url, data)`,
`$.get(url)`, `$.getJSON(url)` 은 호출 지점입니다. `$('#x').val()` 은 아닙니다.
피호출자가 호출의 결과 위에 앉아 있어서 뿌리 이름이 아예 없기 때문입니다.
`$.each` 도 아닙니다. 팩이 그것을 이름 대지 않기 때문입니다. `.js` 파일에서도
페이지의 인라인 `<script>` 에서도 똑같이 동작합니다.

**프레임워크가 건네주는 클라이언트.** AngularJS 는 파일이 HTTP 클라이언트를
import 하게 두지 않습니다. `$http` 는 이름으로 채워지는 **매개변수**로 오므로,
파일의 무엇도 그것을 묶지 않고 위의 모든 추적 규칙은 모르는 객체 위의 호출을
봅니다. 팩에는 그것을 위한 `injected` 목록이 있습니다.

```json
{ "name": "$http", "framework": "angularjs",
  "verbs": { "get": "GET", "post": "POST", "put": "PUT", "delete": "DELETE", "patch": "PATCH", "head": "HEAD" },
  "generic": ["(call)"],
  "registrars": ["controller", "service", "factory", "provider", "directive", "component", "filter", "run", "config", "decorator"] }
```

매개변수가 그 클라이언트가 되려면 **두 조건이 다** 맞아야 합니다. 팩의 `name` 과
정확히 같은 철자이고, 그 함수가 프레임워크가 채워 주는 자리에 있어야 합니다.
워커는 그런 자리 둘을 알아봅니다. 프레임워크 자신이 받아 주는 바로 그 둘입니다.
`registrars` 중 하나에 넘겨진 함수(`component({controller})` 포함)와, 어디에
쓰였든 인라인 애너테이션 배열 `['$http', function ($http) { … }]` 입니다. 이
맵은 아래로 상속되므로 `$http.get(url).then(function () { $http.post(…) })` 는 한
스코프 안쪽의 같은 클라이언트입니다. 엣지는 다른 선언된 클라이언트와 똑같이
**SOUND_SET** 이고, 증거는 `sink.kind: "injected"` 라고 말합니다.

**상대** 경로가 URL 로 세어지는 유일한 자리이기도 합니다.
`$http.get('api/customer/owners')` 에는 앞 슬래시가 없고, 그래도 맨
`get('size')` 는 여전히 호출이 되지 않습니다. 차이를 만드는 것은 문자열이 아니라
클라이언트입니다.

### 상수 위에 올려 쓴 URL

대부분의 프런트엔드는 호출 지점에 경로를 쓰지 않습니다. 파일 위쪽에 한 번 쓰고,
모든 호출이 그 이름 더하기 호출자가 넘기는 것입니다.

```ts
const POSTS_URL = '/board-service/api/v1/posts'

export const boardService = {
  getPost: (id) => axios.get(`${POSTS_URL}/${id}`),
  getComments: (id) => axios.get(`${POSTS_URL}/${id}/comments`),
}
```

글자 그대로 읽으면 그 템플릿은 `{*}/{*}` 이고 어떤 라우트도 이름 대지 않으므로,
그 호출들은 예전에는 아무 데도 닿지 못했습니다. 이제 **이 레인이 텍스트까지
따라갈 수 있는 이름**인 구멍은 채워지고, 엣지가 무엇이 들어갔는지 말합니다.

```json
"url": {
  "written": "{*}/{*}",
  "template": "/board-service/api/v1/posts/{*}",
  "substituted": [{ "name": "POSTS_URL", "value": "/board-service/api/v1/posts", "from": "same-file" }]
}
```

값은 언제나 누군가 쓴 리터럴이므로 치환은 추측이 아니라 사실을 진술하고, 호출은
다른 호출과 똑같이 라우트 대조로 등급이 매겨집니다. `from` 은 리터럴을 어디서
읽었는지 말합니다. `same-file` 은 워커의 답, `import` 는 브리지의 답입니다.
import 를 따라가려면 별칭과 export 사슬이 필요한데 한 파일에는 둘 다 없기
때문입니다. 사슬은 갈 수 있는 데까지 따라가고(`ROOT` 에서 `V1` 로
`REPORTS_URL` 로) 원을 만나면 멈춥니다. `const` 만 셉니다. `let t = '0'` 이후에
`if` 가 `t` 를 다시 대입하는 것은 실제 코드이고, 그 이름이 실제로 들고 있는
값은 초기화 값이 아니기 때문입니다.

**구멍으로 남은 것은 어떤 종류인지 말합니다.** 사실 기록의 `url.holes` 에 있고
`pack.meta.laneStats.web.url` 에 종류별로 세어집니다.

| 종류 | 무엇인가 | 왜 아무것도 채우지 못하는가 |
|---|---|---|
| `parameter` | 둘러싼 함수가 받은 값(`id`, `page`)이거나 자기 변수 | 호출이 쓰인 자리에서 진술되지 않았고, 대개는 그것이 라우트 자신의 구멍입니다 |
| `env` | `process.env.X`, `import.meta.env.X`, 또는 그것에 묶인 상수 | 환경 값은 소스의 사실이 아니라 배포의 사실입니다 |
| `call` | 호출(`${slug(id)}`) | 그것이 반환하는 것은 철자가 아니라 프로그램입니다 |
| `import` | 다른 모듈이 export 하는 이름인데 이번 실행이 따라가지 못한 것 | 지정자가 프로젝트 밖으로 나갔거나, 그것이 이름 대는 것이 리터럴이 아닙니다 |
| `unknown` | 그 밖의 전부 | 따라갈 이름이 없습니다 |

남은 `import` 구멍이 조치할 수 있는 것입니다. 대개는 이번 실행이 읽지 못한
별칭이거나, 그 자체가 `process.env` 위에 올려진 상수를 뜻합니다.
`laneStats.web.url.substituted` 가 반대쪽 절반을, 각 리터럴을 어디서 읽었는지로
셉니다.

### URL 이 세어지려면 어떻게 생겨야 하는가

그래프가 라우트가 아닌 것들로 차지 않게 하는 규칙이 셋이고, 셋 다 조용히
적용하지 않고 셉니다.

- 어떤 싱크로도 추적하지 못한 호출인데 인자가 **경로처럼 쓰이지 않은** 경우(앞
  슬래시 없음, 절대 주소 아님)는 애초에 HTTP 호출이 아닙니다.
  `Cookies.get('size')` 는 HTTP 클라이언트가 아닌 라이브러리 위의 동사 이름 호출
  입니다. `calls.notUrlShaped` 로 셉니다.
- 어떤 싱크로도 추적하지 못한 호출인데 피호출자가 **경로를 요청하는 대신 뜯어보는**
  경우입니다. `pathname.startsWith('/auth/login/naver')` 는 브라우저가 이미 어디에
  있는지를 묻는 것이고, `p.split('/')`, `s.replace('/a', '/b')`, `re.test(path)` 는
  모든 프런트엔드가 경로를 읽는 방법입니다. 거기서는 인자가 정말로 경로이므로 위
  규칙이 도와주지 못하고, **메서드 이름**이 그것을 가릅니다. 목록은 `startsWith`,
  `endsWith`, `includes`, `indexOf`, `lastIndexOf`, `match`, `test`, `replace`,
  `replaceAll`, `split`, `localeCompare`, `padStart`, `padEnd`, `concat` 이며,
  어떤 선언 팩이 이름 대는 클라이언트 동사도 여기에 없습니다(테스트가 두 목록을
  떼어 놓습니다). `calls.stringMethod` 로 셉니다. 클라이언트에 **닿은** 호출은
  건드리지 않습니다. 거기서는 싱크가 라이브러리이고, 이 규칙은 싱크가 아예 없는
  호출만 다룹니다.
- **보간뿐인** URL(`` `/${a}/${b}` `` → `/{*}/{*}`)은 어떤 라우트도 이름 대지
  않습니다. 그 길이의 모든 라우트와 맞기 때문입니다. `unresolved.byReason.allHoles`
  로 세고, 다른 실패와 똑같이 `unmatchedUrls` 에 나열합니다. 상수는 먼저
  채우므로(위 참조) 이것은 그러고도 남은 것입니다.

### 호출을 라우트에 대조하기

라우트 경로는 템플릿입니다(`{id}`, `{key:.+}`, `*` 는 각각 세그먼트 하나를,
`**` 는 나머지 전부를 받습니다). 호출의 `{*}` 는 세그먼트가 그것뿐이면 세그먼트
하나를, 아니면 세그먼트의 일부를 받습니다. 정확한 문자열 일치를 먼저 보고
(`match: "exact"`), 그다음 템플릿 대조를 봅니다(`match: "template"`). 메서드가
일치해야 하며, 라우트가 `ANY` 면 예외입니다. 메서드가 아예 없는 호출은 경로로만
대조되고 그 때문에 HEURISTIC 입니다.

여러 라우트와 맞는 호출은 각각에 엣지를 얻고, 모든 엣지가 몇 개였는지를
`evidence.candidates` 로 싣습니다.

## lane 줄

```
Web lane: 120 file(s) (65 .vue, 0 .ts/.tsx, 55 .js/.jsx), 0 parse error(s); 132 call site(s) carry a URL
  (128 literal, 2 template, 1 constant, 1 unresolved), 57 route declaration(s), 2 alias(es), 1 proxy rule(s)
Web lane: 127 call site(s), 121 resolved (121 sound, 0 heuristic), 6 unresolved (noMatch 5, expression 1),
  4 outside-pack; prefix front: /admin (derived)
Web lane: 1 client instance(s), 0 wrapper(s) (deepest 0), 121 exact and 0 template match(es),
  0 call(s) through an assumed alias; bridge 6 ms
```

첫 줄은 워커의 것이고 나머지 둘은 브리지의 것입니다. 같은 숫자가
`pack.meta.laneStats.web` 으로도 들어가므로, 출력된 것과 기록된 것이 어긋날 수
없습니다.

## 증분: 무엇이 캐시되고 무엇은 절대 안 되는가

이 레인의 사실은 Java 레인과 똑같이 **파일마다 내용 주소로** 캐시됩니다. shard
하나가 프런트엔드 소스 파일 하나의 기록이고, 이름은
`sha256(파일 바이트) + webfacts 워커 버전 + 파일의 루트 상대 경로` 입니다. 그래서
"이게 아직 유효한가?" 는 판단이 아니라 이름 조회입니다. `.vue` 하나를 고치면
다음 실행은 그 파일 하나만 다시 읽고 나머지는 캐시에서 다시 조립합니다.

Java 쪽과 같은 이유로 안전합니다. 워커는 **파일을 넘나드는 해석을 전혀 하지
않습니다.** 한 파일이 무엇을 import 하고 export 하고 묶고 부르는지만 기록합니다.
파일을 넘나드는 모든 단계 — 별칭으로 푼 import, 클라이언트 라이브러리까지 추적한
래퍼, 라우트에 대조한 URL — 는 그 뒤에 브리지에서, 조립된 전체 위에서 일어나고,
모든 실행이 그것을 통째로 다시 만듭니다.

**절대 캐시되지 않는 것**은 패키지 설정입니다. `.env*` 값, 개발 서버 프록시 규칙,
경로 별칭입니다. 그것들은 자기가 쓰인 파일이 아니라 **패키지**를 서술하므로,
어떤 파일의 shard 도 그것을 정직하게 담을 수 없습니다. 그래서 모든 실행이
프런트엔드가 보내는 모든 URL 을 다시 빚습니다. 낡은 사본으로 답하는 것이 이
레인이 저지를 수 없는 유일한 실수이기 때문입니다. 모든 실행이
`node adapters/web/webfacts.mjs --configs-only …` 로 그것들을 다시 읽습니다.
소스 파일은 하나도 걷지 않고 프로세스 하나 띄우는 비용만 듭니다.

**무엇이 콜드 실행을 강제하는가:**

| 무엇이 움직였나 | 왜 모든 shard 를 버리는가 |
|---|---|
| webfacts 워커 버전 | 워커 두 세대의 shard 는 뜻이 다릅니다 |
| 엔진의 조립 버전(`cascade-incremental/N`) | shard 배치나 조립 순서가 바뀌었습니다 |
| 레인 선택(웹 루트가 추가·제거·이동됨) | 콜드와 증분이 같은 입력을 분석해야 합니다 |
| `--cold` | 여러분이 그렇게 시켰습니다 |

이렇게 해서 지키는 불변식이 I-9 입니다. **같은 트리에서 증분 실행의 pack 다이제스트는
콜드 실행의 것과 같습니다.** `test/incremental.test.mjs` 가 합성 프로젝트의
무작위 부분집합을 — 프런트엔드 파일을 포함해 — 바꿔 가며 매 라운드 두 pack 을
비교해 증명합니다.

## 작업 트리 오버레이

`changed_impact`(그리고 `cascade impact`)는 마지막 분석이 아니라 디스크 위의
바이트로 답하며, 거기에는 프런트엔드도 들어갑니다.

**프런트엔드 파일을 고친 경우.** 오버레이는 그 파일만 다시 읽고, 패키지 설정을
다시 읽고, 결과를 캐시된 shard 위에 얹어 그래프를 다시 만듭니다. 답은 **아래로**
내려갑니다.

- `touched.webSymbols`: 여러분이 고친 파일 안의 프런트엔드 함수들입니다. 그 아래에
  있는 것이 라우트이므로 Java 심벌과 따로 둡니다.
- `calledEndpoints`: 그 함수들이 부르는 라우트입니다.
- `downstreamColumns`: 그 라우트들이 핸들러를 통해 닿는 컬럼입니다.

인증된 실행이 본 적 없는 함수는 등급 옆에 `provisional: true` 가 붙습니다. 그것은
**표시**이지 등급이 아닙니다. 격자는 손대지 않습니다.

**백엔드 파일을 고친 경우.** `upstreamEndpoints` 의 영향받은 라우트마다
`frontendCalls` 가 붙습니다. 프런트엔드 함수 몇 개가 그것을 부르는지입니다. 그것이
편집 아래쪽이 아닌 폭발 반경의 나머지 절반입니다.

통합 픽스처에서 측정: `.vue` 하나를 고쳤을 때 레인 전체 **67 ms**(web 63, sql 1,
graph 3), 기준선은 1 초입니다.

## OpenAPI 문서

문서는 소스 위의 레인이 아니라 **증거 계층**입니다. 프로젝트가 자기가 무엇을
서빙하는지 말하려고 쓴 것이고, 이 엔진은 그것을 선언으로 읽습니다.

**무엇을 읽는가.** 2 MB 이하의 `.json`, `.yaml`, `.yml` 파일 중 첫 4 KB 에
최상위 `openapi:` / `"openapi"` 또는 `swagger:` / `"swagger"` 키가 있는 것입니다.
Swagger 2 는 `basePath` 에서, OpenAPI 3 은 `servers[0].url` 의 경로 부분에서
접두사를 가져옵니다(경로 안의 `{variable}` 은 쓰인 그대로 둡니다. 기본값을 넣으면
문서가 진술하지 않은 base path 를 지어내게 되기 때문입니다). `(method, path)`
마다 엔드포인트 하나가 되고, 동사가 하나도 없는 path item 도 메서드 `ANY` 로
경로를 선언합니다.

**YAML 부분집합.** 이 엔진에는 런타임 의존성이 없으므로 YAML 리더를 여기서
씁니다(`src/adapters/openapi_bridge.mjs`). 의도적으로 작습니다.

| 받아들이는 것 | 이름을 대며 거부하는 것 |
|---|---|
| 들여쓰기로 된 블록 매핑과 시퀀스 | 앵커(`&x`)와 별칭(`*x`) |
| 평범한, 홑따옴표, 겹따옴표 스칼라 | 명시적 태그(`!!str`, `!Ref`) |
| `#` 주석, 줄 전체와 줄 끝 | 한 파일 안의 두 번째 문서(`---`) |
| 스칼라로 된 흐름 시퀀스 `[a, b]` 와 흐름 매핑 `{k: v}` | 들여쓰기 안의 탭 |
| `\|` 와 `>` 블록 스칼라. 텍스트로 유지 | 닫히지 않은 따옴표나 흐름 컬렉션 |

거부는 **줄과 구문**을 이름 대고, 그러면 그 문서 전체가 **읽히지 않습니다.**
절반도 그래프에 들어가지 않습니다. 조용히 잘못 파싱된 YAML 기능은 파일이 선언하지
않은 라우트를 pack 에 넣게 되고, 그것은 라우트를 하나도 읽지 않는 것보다
나쁩니다. 문서를 JSON 으로 바꾸거나, 그 구문 없이 라우트를 쓰세요.

**Java 레인이 있을 때.** 문서와 코드는 같은 라우트에 대한 서로 독립인 두
진술입니다. 둘 다 이름 대는 라우트는 서로 **뒷받침**합니다. 엔드포인트 노드가
`declaredBy`(그것을 선언하는 문서들, 정렬됨)와 문서가 들고 있으면 `operationId`
및 `summary` 를 얻고, 코드 레인이 준 등급은 그대로 유지합니다. 문서만 이름 대는
라우트는 **핸들러 엣지 없이** 추가됩니다. 드리프트 집계는
`meta.laneStats.openapi` 와 overview 의 `openapi-drift` 갭에 양방향으로 있습니다.

- **선언되었으나 서빙되지 않음**: 다른 저장소의 서비스이거나, 앞서 나간 계약입니다.
- **서빙되나 선언되지 않음**: 문서화되지 않은 API 입니다.

이 엔진은 둘 다 보고하고 어느 쪽도 판정하지 않습니다.

**Java 레인이 없을 때.** 이 계층이 정말로 필요한 자리가 여기입니다. 이 엔진에
레인이 없는 언어로 쓰인 백엔드 — Node, Go, Python, .NET — 도 문서는 펴내고,
그러면 프런트엔드의 호출이 허공이 아니라 진짜 엔드포인트 노드에 내려앉습니다.
pack 은 그것으로 어디까지 갈 수 있는지 말합니다. `code` 축이 `degraded` 이고
이유는 *"endpoints come from an OpenAPI document, not from source: the routes
exist, but nothing below them is walked, so a frontend call reaches an endpoint
and stops there"* 이며, 컬럼 질문은 "찾아봤다"로 읽힐 빈 목록 대신
`not-shipped` 로 답합니다.

## 화면

라우트 선언은 화면이 아닙니다. **화면**은 사용자가 실제로 있는 경로이고, 그
경로는 읽는 것이 아니라 합성하는 것입니다. 라우터는 중첩되므로
`{path: '/panel', children: [{path: 'rows'}]}` 는 `/panel/rows` 라는 화면
하나입니다. 합성 규칙 전체는 이렇습니다.

- `/` 로 시작하는 자식 경로는 **절대 경로**이고 위의 모든 것을 대체합니다.
- 경로가 `''` 인 부모는 아무것도 기여하지 않습니다.
- 나머지는 슬래시 하나로 이어 붙이고 결과를 정규화합니다. 앞 슬래시 하나,
  중복 슬래시 없음, 끝 슬래시 없음입니다.
- **컴포넌트도 자식도 없고 `redirect` 만 있는** 선언은 화면이 아닙니다. 아무것도
  마운트하지 않고 아무것도 보여 주지 않습니다.
- 두 선언이 같은 경로로 합성되면 하나의 노드이고, (파일, 줄) 순서로 첫 번째가
  대표가 되며 모든 선언이 `declaredAt` 에 나열됩니다.

노드 id 는 `screen:<합성된 경로>` 이며, `flow screen=` 과 `browse kind=screen`
이 그것으로 부릅니다.

### 컨트롤러가 그리는 페이지

또 하나의 화면 종류입니다. 라우터가 경로를 선언하고 컴포넌트를 마운트하는 자리에서,
`@Controller` 는 경로에 답하면서 **뷰**를 이름 대고, 뷰 리졸버가 자기 prefix 와
suffix 를 그 이름에 붙여 파일을 찾습니다. 핸들러가 이름 대는 모든 템플릿이
화면입니다.

    screen:view:<뷰 이름>          owners/findOwners, business/job.list

`view:` 접두사는 하이브리드 애플리케이션의 두 화면 종류를 갈라 둡니다. Vue
라우터와 Thymeleaf 관리자 화면을 함께 가진 애플리케이션은 둘 다 갖고, 두 id 는
서로 충돌할 수 없습니다.

| 필드 | 어디서 오는가 |
|---|---|
| `name` | 핸들러가 돌려준 뷰 이름 |
| `template` | 리졸버의 prefix 와 suffix 가 찾은 파일 |
| `engine` | thymeleaf / freemarker / jsp / velocity / plain-html |
| `paths` | 이 페이지를 그리는 핸들러가 속한 모든 라우트, 정렬됨 |
| `path` | 그중 첫 번째 |
| `label` / `group` / `code` | 라우터 화면과 같은 규칙을 뷰 이름에 적용 |
| `source` | `view` |

**어떤 핸들러도 이름 대지 않는** 템플릿은 화면이 아닙니다. 누군가 끌어다 쓰는
프래그먼트이거나 아무도 서빙하지 않는 페이지이고, 실행이 각각 몇 개인지
말합니다. 그 링크는 누구의 호출도 아니고 엣지를 그리지 않습니다.

`symbol --RENDERS_PAGE--> screen` 은 EXACT 입니다. 핸들러가 리터럴로 돌려준 것이
뷰 리졸버의 입력 그 자체이므로 이름이나 모양으로 대조한 것이 없습니다. 그리고
의도적으로 흐름 엣지가 **아닙니다.** 페이지 자신의 폼과 링크는 이번 요청이 아니라
다음 요청이고, 페이지를 그리는 라우트에서 그것을 따라가게 했더니 모든 라우트가
자기 페이지가 링크하는 모든 라우트의 도달 범위를 물려받았습니다. 코퍼스에서
측정했더니 엔드포인트 하나가 닿는 범위가 어떤 프로젝트에서 81% 부풀었는데 합집합
개수는 하나도 움직이지 않았습니다. 대신 이 관계는 그것을 묻는 두 자리에서 **한
걸음만** 갑니다. `screen_impact` 는 "이 메서드가 그 컬럼을 읽는다" 를 "이 페이지가
그것을 보여 준다" 로 바꾸고, 라우트에서 내려가는 `flow` 는 그 라우트가 보여 주는
페이지를 따라가지 않고 나열합니다.

`redirect:` 나 `forward:` 는 페이지가 아예 아닙니다. 같은 애플리케이션의 라우트를
이름 대므로 `symbol --CALLS_HTTP--> endpoint`(GET, 규칙 `view-redirect`)가 되고,
다른 호출과 똑같이 라우트 대조로 등급이 매겨집니다.

**라우트를 가져오는 페이지는 그 라우트를 자기 요청 안에서 실행합니다.**
`<c:import url="/sym/mms/EgovHeader.do"/>` 는 링크가 아닙니다. 컨테이너가 이 페이지를
그리는 도중에 그 라우트를 실행하고 결과를 그 자리에 씁니다. 템플릿이 아니라 라우트를
가리키는 `<jsp:include page>` 도 같습니다. 그래서 페이지를 그리는 핸들러에서 가져온
라우트마다 `symbol --CALLS_HTTP--> endpoint` 를 둡니다. 규칙은 `template-import`,
등급은 라우트 대조에 따른 SOUND_SET 이고, 페이지 자신이나 그 페이지가 include 하는
템플릿에 쓰인 가져오기를 모두 봅니다. 페이지의 링크는 다음 요청이라 걷기에서
빠지지만, 가져오기는 이번 요청이라 걷기에 들어갑니다. 전자정부 기업업무 템플릿에서
재 보니 페이지 70 개가 상단, 하단, 좌측 메뉴를 가져오고 가져오기 엣지는 모두 398
개입니다. 목록 화면들을 실제로 돌려 보니 처음 실행한 26 개 라우트 중 20 개가 메뉴
테이블을 읽었고, 이 규칙 전에는 pack 이 그중 하나도 닿지 못했습니다.

페이지의 RENDERS 엣지는 자기 코드와 자기가 끌어다 쓰는 것입니다.

- 페이지 인라인 스크립트의 모든 함수에 대해 **EXACT**, 규칙 `template-own`
  입니다. 폼과 링크가 매달리는 `#(module)` 도 포함합니다.
- 페이지가 인클루드하는 템플릿마다(프래그먼트가 코드를 들고 있든 아니든 인클루드
  하나에 행 하나) 그리고 그 프래그먼트 자신의 함수에 대해 **SOUND_SET**, 규칙
  `template-include` 입니다. 페이지의 어느 분기가 그 인클루드에 실제로 닿는지는
  런타임 질문이므로 후보입니다.

이번 실행이 자리를 찾아 주지 못한 뷰 이름 — 아무도 선언하지 않은 템플릿 루트,
설정된 것이 아닌 suffix, 런타임에 만들어지는 이름 — 은 이름을 달고
`VIEW_NAME_UNRESOLVED` 경고가 되고, Java 레인이 읽지 못한 핸들러 반환은 화면 축
이유에 세어집니다. 둘 다 숫자가 붙은 갭이지 침묵이 아닙니다.

이름을 **어떻게 읽었는지**는 엣지에 `evidence.from` 으로 실립니다. `literal`,
`model-and-view`, `set-view-name`, `constant`(핸들러가 속한 클래스의
`static final String`), `helper`(그 클래스의 private 메서드이고, 그 이름도 엣지에
실립니다)입니다. 다섯 다 EXACT 입니다. 다섯 다 파일 하나에서 아무것도 넘나들지
않고 읽은 것이기 때문입니다. 각각이 무엇을 읽어도 되는지는
[java 레인](java-lane.md) 을 보세요.

### 화면에 무엇이 실리는가

| 필드 | 어디서 오는가 |
|---|---|
| `path` | 합성된 경로 |
| `name` | 라우트 자신의 `name` |
| `title` | `screenAxis.nameSource` 가 `route-meta` 일 때만, 라우트의 `meta.title` |
| `label` | `screenAxis.pathRule` 이 `last-segment` 면 경로의 마지막 세그먼트, 아니면 경로 전체 |
| `code` | `screenAxis.codeRegex` 를 이름, 제목, 경로 순으로 대조한 첫 결과 |
| `group` | 코드와 `moduleAttribution.codeLength` 가 둘 다 있으면 코드의 앞 그만큼, 아니면 경로의 첫 세그먼트 |
| `component` | 라우트의 컴포넌트가 해석된 루트 상대 파일 |
| `file` / `line` / `pack` | 선언 그 자체와, 어느 라우터 팩이 그것을 알아봤는지 |
| `params` | 합성된 경로에 `:x` 나 `*` 가 있으면 true |
| `hidden` | 선언이 그렇게 말할 때만 실립니다 |
| `source` | `router`, 또는 기록만 찾아낸 페이지면 `har` |

### RENDERS: 화면이 실제로 실행하는 것

`screen --RENDERS--> symbol` 은 화면과 그것이 실행할 수 있는 프런트엔드 함수를
잇습니다. 이름으로 추측하는 부분은 하나도 없습니다.

- 라우트가 컴포넌트로 **선언한** 파일의 모든 함수에 대해 **EXACT** 입니다.
  라우트가 어느 파일인지 말했고, 함수는 그 파일 안에 있습니다.
- 그 컴포넌트가 **import** 하는 파일의 함수에 대해서는, 직접이든 다른 컴포넌트를
  거치든 4 단계까지, 순환은 끊고 **SOUND_SET** 입니다. 엣지는 거기에 도달한
  import 사슬을 `evidence.via` 로 들고 있습니다. import 된 컴포넌트의 어느 함수가
  화면에서 진짜 도는지는 런타임 질문이므로 후보입니다.
- 아무도 import 하지 않는 파일은 자식이 아니고, 컴포넌트를 이 레인이 읽은 파일로
  해석하지 못한 라우트는 RENDERS 엣지를 **전혀** 얻지 못합니다. 그런 경우는 실패한
  지정자와 함께 집계됩니다(`laneStats.web.screens.componentUnresolved`). 보통은
  별칭이나 빠진 소스 루트가 원인이기 때문입니다.

#### import 가 없을 때: 프레임워크 자신의 이름 등록부

모듈 이전에 쓰인 프런트엔드는 경로로 아무것도 해석하지 않습니다. AngularJS 는
**이름** 등록부를 두고, 하나가 다른 하나를 찾는 방법이 이름입니다.

```js
// 라우트가 어느 태그를 마운트하는지 말합니다
.state('owners', { url: '/owners', template: '<owner-list></owner-list>' })
// 그 태그는 이름으로 등록된 컴포넌트입니다
angular.module('ownerList').component('ownerList', { templateUrl: '…', controller: 'OwnerListController' })
// 그것이 컨트롤러를 이름 대고, 그 컨트롤러는 또 다른 파일에 등록되어 있습니다
angular.module('ownerList').controller('OwnerListController', ['$http', function ($http) { … }])
```

워커는 등록 하나하나를 사실로 기록하고(`kind: "registration"`, `what` 이
`component` / `controller` / `directive`, 이름, 그리고 그것이 가리키는 이름들),
등록이나 라우트가 가리키는 HTML 템플릿을 **커스텀 엘리먼트 태그만 보려고**
읽으며(`templateUrl`), 브리지가 그 이름들을 걷습니다.

| 규칙 | 무엇으로 닿았나 |
|---|---|
| `angular-component` | 라우트가 컴포넌트를 이름 댔습니다. `component: 'ownerList'` 또는 엘리먼트 하나뿐인 `template`(`<owner-list></owner-list>`, 케밥을 카멜로 읽습니다) |
| `angular-controller` | 컴포넌트 등록의 `controller` 키 |
| `angular-template-tag` | 등록이 가리키는 HTML 템플릿 안의 태그. 컴포넌트가 다른 컴포넌트를 마운트하는 방법입니다 |

등급은 깊이가 아니라 해석을 따릅니다. 사슬의 모든 이름이 정확히 등록 하나와
맞으면 **EXACT** 입니다. 프레임워크 자신이 그 정확한 문자열로 해석하고, 그것은
import 가 파일을 이름 대는 것과 같기 때문입니다. 이름이 두 번 이상 등록되어
있으면 **HEURISTIC** 입니다. 어느 모듈이 마지막에 적재되는지는 소스에 없고 그것을
등록하는 모든 파일이 후보이기 때문입니다. 이름의 사슬은 엣지에 `evidence.names`
로 실립니다. 템플릿을 통해 태그를 따라가는 것도 import 걷기와 같은 깊이 제한을
따릅니다.

**아무것도 등록하지 않는** 이름은 엣지를 얻지 못하고, 이름과 함께
`laneStats.web.screens.unresolvedNames` 에 세어지며
`SCREEN_COMPONENT_UNREGISTERED` 로 출력됩니다. petclinic 게이트웨이에 정확히
하나 있습니다. 레이아웃 컴포넌트를 계산된 이름 위의 반복문으로 등록하므로, 어떤
소스 줄도 그것을 진술하지 않습니다.

`directive` 는 정의 객체가 컨트롤러를 이름 댈 때만 마운트 지점으로 셉니다. 다른
모든 디렉티브는 엘리먼트 위의 동작입니다. 컴포넌트 등록부 다음에 찾습니다. 요즘
파일이 등록하는 곳이 그쪽이기 때문입니다.

**갭 하나를 적어 둡니다.** HTML 템플릿은 이 레인이 소스로 나열하는 파일이 아니므로,
템플릿만 바뀐 **증분** 실행은 그것을 가리키는 파일을 다시 읽지 않습니다. 콜드
실행(`cascade analyze --cold`)은 봅니다.

### 프런트엔드 자신의 호출

컴포넌트의 함수와 그것이 때리는 라우트 사이에는 보통 홉이 하나 더 있습니다. api
모듈입니다. `symbol --CALLS--> symbol` 이 그 홉이고, 등급은 그 이름을 어떻게
따라갔는지를 말합니다.

| 등급 | 언제 |
|---|---|
| `EXACT` | named 나 default 지정자를 쓴 정적 import 를 상대 경로나 **선언된** 별칭을 통해 이 레인이 읽은 함수까지 따라간 경우, 또는 한 파일 안에서 이름으로 부른 경우(`getList()`, `this.getList()`) |
| `SOUND_SET` | 같은 경우이되 이름이 `export *` 배럴이나 재export 사슬을 거쳐 왔고, 그래서 어느 파일에서 왔는지가 선택이었던 경우 |
| `SOUND_SET` | 여기서는 아예 호출되지 않았고, 다른 호출에 **값으로 넘겨진** 경우. 받은 쪽이 그것을 부를 수 있습니다 |
| `HEURISTIC` | 경로 위에 **가정된** 별칭이 있었던 경우 |

함수가 **아닌** import 된 이름(상수, 컴포넌트) 위의 호출은 엣지를 만들지 않고
`calls.notAFunction` 으로 세어집니다.

**import 된 객체의 멤버.** 대부분의 TypeScript 프런트엔드는 API 호출을 흩어진
export 가 아니라 이름 있는 객체에 담아 둡니다.

```ts
export const contentService = {
  get: async (no: number) => axios.get(`${CONTENT_URL}/${no}`),
}
```

그리고 페이지는 `contentService.get(id)` 라고 씁니다. 그것도 같은 한 홉이고, 하나로
읽습니다. 키만으로는(`get`) 어느 객체의 것인지 말할 수 없으므로 — 한 파일의 두
객체가 둘 다 `get` 을 가질 수 있습니다 — 워커가 이름 옆에 주인을 기록하고
(`member: "contentService.get"`) 브리지가 그것으로 멤버를 찾습니다. `.ts` 와
`.js` 가 여기서 같고, 두 파일 사이의 `export *` 배럴은 맨 호출과 마찬가지로 엣지를
SOUND_SET 으로 만들며, 엣지는 `evidence.member` 를 싣습니다. 이름 있는 객체의
**직속** 멤버만 따라갑니다. 한 단계 더 깊으면(`a: { b() {} }`) 호출자가 쓸 이름이
없고, 다른 것에 내려앉는 멤버 호출 — 클라이언트 인스턴스, 라이브러리 객체 — 은
HTTP 패스가 이미 설명한 싱크이므로 엣지도 실패도 아닙니다.

**값으로 넘겨진 함수.** 뷰에서 api 함수를 아예 부르지 않는 프런트엔드가 많습니다.
훅에 넘깁니다.

```js
const { rows, reload } = usePagedList({ api: listRows })
useSubmit(saveRow, { immediate: false })
```

`listRows` 를 이름으로 부르는 호출 지점이 없으므로, 호출만 따라가는 규칙은 뷰에서
멈춥니다. 워커는 무엇이 넘겨졌는지를 기록합니다(호출 기록의 `fnRefs`). 인자 위치의
식별자, 또는 객체 인자의 프로퍼티 값을 한 단계 깊이까지 어떤 키 아래에서든
기록하되, 그 파일이 그 식별자를 import 나 자기가 선언한 함수에 묶은 경우에만
기록합니다. 네임스페이스 import 의 멤버(`api.list`)는 뿌리와 경로를 유지합니다.
문자열은 참조가 아니고, 호출은 이미 호출이며, 인라인 화살표 함수의 본문은 이미
그것을 둘러싼 함수에 귀속되어 있습니다.

브리지는 그 이름을 피호출자와 똑같이 해석해 `symbol --CALLS--> symbol` 을 놓고,
`evidence.rule: "passed-as-value"` 와 `via`(`argument` 또는 `property`), 키가
있었다면 `key`, 지정자와 출처를 함께 기록합니다. 등급은 **SOUND_SET 이며 절대
EXACT 가 아닙니다.** `usePagedList` 가 자기 `api` 를 실제로 부르는지 여기서
들여다본 적이 없기 때문입니다. 그것을 보려면 값을 다른 모듈의 본문 속까지
따라가야 합니다. 경로 위에 가정된 별칭이 있으면 HEURISTIC 으로 내려가고, 호출도
되고 넘겨지기도 한 쌍은 호출 쪽의 EXACT 를 유지합니다. 대상은 호출된 함수와 같은
고정점에 들어가므로 화면이 그것에 닿을 수 있습니다.
`laneStats.web.calls.passedAsValue` 가 해석된 참조를 세고,
`laneStats.web.callsByRule` 이 엣지를 찾아낸 규칙별로 나눕니다. 따라간 호출과
넘겨진 함수를 등급만으로는 구분할 수 없기 때문입니다.

**HTTP 에 닿는 함수만 노드를 얻습니다.** 요청을 보내거나 이 엣지들을 통해 요청에
닿는 함수는 그래프에 들어가고, 포매터나 날짜 헬퍼는 집계만 되고
(`laneStats.web.functions`) 빠집니다. 그러지 않으면 아무 질문도 하지 않을 코드
때문에 pack 이 두 배가 되기 때문입니다. 컴포넌트 파일(`.vue`, `.tsx`, `.jsx`)
안의 함수는 `component: true` 를 달고 있어서, 도구가 화면 안의 함수와 api 함수를
구분할 수 있습니다. JSX 를 반환하는 함수를 export 하는 `.ts` 나 `.js` 모듈도
컴포넌트이지만 이 버전은 그것을 잡지 **않습니다.** 사실 스트림에 JSX 표시가 없으
므로 규칙은 파일 확장자뿐입니다.

### 라우터를 서버가 채워 줄 때

앱이 시작할 때 백엔드에서 메뉴를 받아 오는 관리자 제품이 많습니다. 그러면 이
레인이 볼 수 있는 화면은 그 앱의 일부일 뿐입니다. 축은 소스 안의 것들만으로
제품 전체인 척 굴지 않고, 사실대로 그렇다고 말합니다.

**규칙은 호출입니다.** 프런트엔드 자신의 호출 중 하나가 이 pack 이 서빙하는
라우트로 해석되었고 그 경로가 `/getRouters`, `/menu`, `/menus`, `/routes`,
`/nav` 로 끝나는 경우입니다. 그 밖에는 아무것도 요구하지 않습니다. 집계는
`serverDriven: {detected, detectedBy: "menu-call", routes, ceiling,
menuEndpoints}` 로 기록되므로, 독자가 규칙을 그대로 받아들이는 대신 확인할 수
있습니다.

라우트 개수는 결정하지 않고 문장만 고릅니다. **30** 개 상한 아래에서는 *대부분의
화면이 앱이 돌 때 도착한다*고 말하고, 그 위에서는 *선언된 N 개를 넘는 화면이 앱이
돌 때 도착한다*고 말합니다.

**이것으로도 잡히지 않는 경우**는 측정해 두고 그대로 두었습니다. 메뉴를 메뉴처럼
생기지 않은 엔드포인트에 실어 나르는 제품입니다. 측정한 가장 큰 프런트엔드는
라우트 173 개를 선언하는데 그중 87 개가 프레임워크 자체의 데모 페이지이고, 모든
업무 화면은 메뉴가 아니라 **권한**을 따라 이름 지은 라우트에서 런타임에 가져
옵니다. 위의 어떤 접미사도 그것과 맞지 않으므로 그 프로젝트의 `screen` 축은
`shipped` 로 읽히고, "화면 166 개 중 19 개가 테이블에 닿는다"는 설명이 아니라
부족으로 읽힙니다. 그 프로젝트의 철자를 여기 넣는 것은 그 프로젝트에서만 통하는
규칙이 되므로, 철자 표는 일반적인 채로 두고 대신 이렇게 적어 둡니다.

발동하면 `screen` 축은 그 문장과 근거 숫자를 달고 `degraded` 가 되고, `overview`
에 `screens-from-server` 갭이 실립니다. 이 갭은 무엇이 **빠졌는지**를 말할
뿐이지, 화면 축을 만들지 말지를 말하는 것이 아닙니다. `screenAxis.enabled: true`
인 프로파일은 여전히 선언된 화면을 전부 만듭니다. 부분적인 화면 축보다 아예
없는 편이 낫다면 `screenAxis.enabled: false` 로 두세요.

### 프로파일 키

```json
{
  "templateRoots": [
    { "root": "../src/main/resources/templates", "engine": "thymeleaf", "suffix": ".html", "from": "default" }
  ],
  "screenAxis": {
    "enabled": true,
    "nameSource": "route-meta",
    "pathRule": "last-segment",
    "codeRegex": "([A-Z]{2}\\d{4})"
  },
  "moduleAttribution": { "codeLength": 2 }
}
```

- `templateRoots` 는 뷰 이름이 페이지가 되는 자리입니다. 각 항목은
  `{root, engine, suffix, from}` 이고, `root` 는 매니페스트 기준 상대 경로,
  `from` 은 `config`(`spring.thymeleaf`/`freemarker`/`mvc.view` 접두사가
  디렉터리를 이름 댐)이거나 `default`(엔진의 문서화된 기본값을 파일이 실제로 놓인
  자리에 적용)입니다. `cascade init` 은 발견한 것을 쓰고, 이미 있는 목록은
  여러분의 것이라 그대로 두며, 빈 목록은 프로젝트가 "템플릿을 읽지 마라" 고 말하는
  방법입니다. 실행은 어떤 레인이 돌기 전에 읽을 루트를 출력합니다.

  ```
  template roots 1 (profile): src/main/resources/templates thymeleaf .html
  ```

- `screenAxis.enabled` 가 **게이트**이며 **상태가 셋**입니다.

  | 값 | 뜻 |
  |---|---|
  | `true` | 이 실행이 무엇을 읽든 화면을 만듭니다. `cascade init` 은 분석 대상 트리에서 라우터 패키지를 찾으면 이것을 씁니다 |
  | `false` | 이 실행이 무엇을 읽든 만들지 않습니다. 여러분의 말이고 엔진은 따집니다 |
  | `null` 또는 키 없음 | 실행이 **읽는** 것을 보고 결정합니다. `frameworkPacks` 가 라우터 팩을 대거나, 이 실행이 실제로 읽는 프런트엔드 패키지가 `vue-router`, `react-router`, AngularJS 라우터에 의존하거나, 이 실행이 템플릿 루트를 하나라도 읽으면 켜고, 아니면 끕니다. 기본값입니다 |

  세 번째 상태는 `--web-src ../front/src` 같은 배치를 위해 있습니다. `cascade
  init` 은 **분석 대상 트리**를 발견하므로, 프런트엔드가 옆에 체크아웃된 백엔드에는
  `init` 이 찾을 라우터 패키지가 없습니다. 세 번째 상태가 있기 전에는, 그
  프런트엔드 전체를 읽고 호출을 진짜 라우트로 해석한 실행조차도 코드와 아무 상관
  없는 이유로 화면을 하나도 만들지 못했습니다. 실행은 셋 중 어느 규칙이
  결정했는지를 출력합니다.

  ```
  screen axis ON (read-router): screenAxis.enabled is undeclared and a frontend
  package this run reads depends on vue-router
  screen axis ON (server-views): screenAxis.enabled is undeclared and this run
  reads 1 template root(s) (thymeleaf), whose pages a controller names
  ```
- `screenAxis.nameSource` 는 `route-meta`, `none`, `jsdoc-comment` 입니다. 마지막
  것은 진단과 함께 **거부**됩니다. 여기의 어떤 레인도 컴포넌트 위의 주석을 읽지
  않으므로 모든 제목이 null 이 될 것이고, 그것을 요청한 것만으로 축은 degraded
  입니다.
- `screenAxis.pathRule` 은 짧은 `label` 만 바꾸고 경로는 절대 바꾸지 않습니다.
- `screenAxis.codeRegex` 와 `moduleAttribution.codeLength` 는 화면이 자기 코드를
  갖는 프로젝트(`AB1234`)를 위한 것으로, 코드의 앞 몇 글자가 모듈 이름인
  경우입니다. `codeRegex` 가 없으면 어떤 화면도 코드를 갖지 않고, 모든 화면은
  경로의 첫 세그먼트로 묶입니다.

### 축이 shipped 가 되는 조건

`shipped` 에는 셋이 다 필요합니다. 게이트가 켜져 있고, 최소 하나의 화면이
RENDERS 엣지를 갖고, 읽는 과정에서 추측한 것이 하나도 없어야 합니다. 앱이 서버에서
메뉴를 받아 올 때, 선언된 라우트의 5분의 1 이상이 이 레인이 해석하지 못한
컴포넌트를 지목할 때, `nameSource` 가 제공하지 않는 것을 요구할 때, 화면은
만들어졌는데 그중 어느 것도 함수에 닿지 않을 때 `degraded` 입니다. 게이트가 꺼져
있거나 라우트를 하나도 읽지 못한 경우에만 `not-shipped` 입니다. 꺼져 있을 때는 축
이유가 위의 세 규칙 중 무엇이 껐는지를 밝힙니다.

## 기록(HAR)

**HAR** 파일은 브라우저가 본 것입니다. 어느 페이지가 열려 있었는지와 그것이 보낸
모든 요청입니다. `cascade analyze --har <file>`(반복 가능)이 하나를 읽고,
프로파일의 `runtimeEvidence.har` 가 플래그 없는 실행을 위해 이름을 댑니다.
**발견은 하지 않습니다.** 기록은 일부러 만드는 것이고, 트리에 우연히 있다는
이유로 주워 오면 무관한 캡처가 이 pack 이 무엇을 관측했다고 주장할지를 정하게
되기 때문입니다.

### 만드는 법

Chrome 에서 앱을 열고 F12 를 누른 뒤 **Network** 로 가서 *Preserve log* 를 켜고,
보고 싶은 화면들을 지나간 다음, 요청 목록에서 오른쪽 버튼을 눌러 **Save all as
HAR with content** 를 고릅니다(내용 자체는 여기서 읽지 않고 URL 과 각 요청이 속한
페이지만 읽습니다). Firefox 와 Edge 도 같은 형식을 씁니다.

### 무엇이 매칭되는가

- 모든 항목의 URL 을 경로까지 읽습니다. 요청 경로는 **프런트엔드** 접두사를
  달고 있고(`/dev-api/system/user/list`) 그래프의 라우트는 백엔드 경로를 달고
  있으므로, 앞 접두사를 떼고 뒤 접두사를 붙입니다. 이때 웹 브리지가 그 패키지에
  대해 이미 내린 접두사 결정을 그대로 씁니다. declared, derived, auto 순서입니다.
- **페이지** URL 도 라우트까지 읽습니다. 해시 모드의 단일 페이지 앱은 라우트를
  프래그먼트에 넣으므로(`https://app.example.com/#/things/list`) 거기서는 그
  프래그먼트가 화면 경로입니다. 히스토리 모드에서는 경로가 그렇습니다.
- 정적 자산(`.js .css .png .woff2 .map .ico .svg`)은 건너뛰고 따로 셉니다. 그 밖에
  어떤 라우트와도 맞지 않는 것은 버리지 않고 **경로별로 셉니다.** 아무 데도 닿지
  않는 기록은 대개 아무도 선언하지 않은 접두사가 원인입니다.
- 소스가 선언한 어떤 화면과도 맞지 않는 페이지는 그 자체로 화면이 되며,
  `source: "har"`, `observed: true` 이고 RENDERS 엣지는 없습니다. 어느 컴포넌트를
  마운트하는지 말해 주는 소스 줄이 없기 때문입니다. 컨트롤러가 그리는 페이지는
  그 페이지를 그리는 **모든** 라우트로 찾습니다(화면 노드의 `paths`). 서버가 그리는
  앱의 수정 화면은 `/addView.do` 로 열든 `/editView.do` 로 열든 한 화면입니다.
- 경로 파라미터는 라우트가 아닙니다. 쿠키를 못 쓰는 컨테이너는 세션을 주소에
  적는데(`/list.do;jsessionid=…`), 이것은 `/list.do` 로 읽습니다.
- **어느 화면이 요청을 보냈는가.** 페이지 안에서 한 요청(`fetch`, XHR)은 그 요청을
  한 페이지의 것이고, HAR 의 `pageref` 가 그 페이지를 말합니다. 페이지를 **여는**
  요청(HTML 응답이나 리다이렉트)은 다릅니다. HAR 은 그 요청을 새로 열린 페이지 밑에
  두고, 요청을 보낸 페이지는 **Referer** 가 말합니다. 서버가 그리는 앱은 거의 모든
  요청을 링크나 폼 제출로 보내니, 거기서는 보낸 화면이 Referer 에만 적혀 있습니다.
  리다이렉트가 보낸 요청(`302` 다음 `redirectURL`)과 Referer 없이 연 페이지(주소창,
  북마크)는 어느 화면에도 붙이지 않고 `followedRedirects`, `openedByAddress` 로
  셉니다. 전자정부 웹 샘플을 브라우저로 두 화면 모두 눌러 보니, 관측된 화면-라우트
  쌍 7 개가 모두 정적 분석이 이미 가진 `form-submit` 엣지였습니다.

### RUNTIME_ONLY 의 뜻

매칭된 (화면, 라우트) 쌍마다 `screen --CALLS_HTTP--> endpoint` 엣지 **하나**가
생기고 등급은 **RUNTIME_ONLY**, 증거는 `{rule: 'har', file, count, firstSeen,
lastSeen, methods}` 입니다. 그 등급은 **모든** 질의 모드의 하한 아래이므로,

- **보여 주기만 하고 절대 걷지 않습니다.** 어떤 체인, 영향, 집계 걷기도 그것을
  따라가지 않습니다. 기록은 요청이 한 번 일어났음을 증명할 뿐, 코드가 무엇을 할
  수 있는지는 전혀 증명하지 않습니다.
- **등급을 절대 올리지 않습니다.** 정적 분석이 이미 같은 화면이 같은 라우트를
  부르는 것을 찾아냈다면 그 엣지는 그대로 두고, 도구가 그 옆에 `observed: true`
  라고 말합니다.

`observed: true` 는 화면 노드와 엔드포인트 노드, 그리고 그것들을 이름으로 부르는
`flow`, `browse kind=screen`, `screen_impact` 의 행에 붙습니다. 집계는
`meta.laneStats.har` 에 있습니다.

## 범용성 게이트가 측정하는 것

[`scripts/generality-gate.mjs`](../../../scripts/generality-gate.mjs) 는 이
엔진을, 고치지 않고 아무 설정도 하지 않은 채, 고정된 실제 저장소 코퍼스 위에서
돌리고, 거기서 닿은 숫자를 테스트 스위트가 바닥으로 지킵니다. 그중 넷은 백엔드와
프런트엔드를 함께 가진 항목입니다. 백엔드만으로는 화면이 컬럼에 닿는지에 대해
아무 말도 할 수 없기 때문입니다. 넷 중 둘은 프런트엔드를 백엔드 저장소 안에 갖고
있어서 설정 없는 `cascade init` 이 `web` 팩을 선언하고 실행이 플래그 없이 그것을
읽습니다. 나머지 둘은 프런트엔드가 자기 저장소에 있고, 코퍼스가 백엔드와 똑같이
그것을 고정하며(`front: {url, sha, dir}`) 러너가 옆에 클론해서 `--web-src` 하나를
넘깁니다. 그 밖에는 아무것도 주지 않습니다. 프로파일 편집도, `gatewayRoutes` 도,
문서도, 기록도 없습니다.

지켜지는 숫자 중 둘이 이 레인의 것입니다. `webCallsResolved`(URL 을 든 호출 지점
중 이 pack 이 서빙하는 라우트에 닿은 것)와 `screensReachingATable` 입니다. 넷 다
진짜 숫자이며, 프런트엔드가 자기 저장소에 있는 둘도 그렇습니다. 화면 축은 실행이
읽는 것으로 결정되므로(위의 세 상태), 백엔드에 `--web-src` 를 더한 설정 없는
실행도 아무도 프로파일을 고치지 않고 화면을 만듭니다.

## 이 버전이 하지 않는 것

- **APM 이나 서버 로그 입력은 없습니다.** 이 버전이 읽는 런타임 출처는 HAR 기록
  하나뿐이고, APM 에이전트의 트레이스나 액세스 로그는 아닙니다.
- **파일 확장자 밖의 JSX 감지는 없습니다.** JSX 를 반환하는 함수를 export 하는
  `.ts` 나 `.js` 모듈도 컴포넌트이지만, 이 버전은 `.vue`, `.tsx`, `.jsx` 만
  컴포넌트로 봅니다.
- **라우트가 선언하지 않은 화면은 없습니다.** 기록이 그 페이지를 찾은 경우만
  예외입니다. 서버가 채워 주는 라우터는 소스 안의 라우트만 기여하고, 축이 그렇다고
  말합니다.
- **문서 안의 `$ref` 해석은 없습니다.** 라우트와 그 `operationId` 및 `summary`
  는 읽지만, 공유 파라미터나 스키마를 가리키는 `$ref` 는 그대로 둡니다. 여기의
  무엇도 그것이 가리키는 것을 필요로 하지 않기 때문입니다.
