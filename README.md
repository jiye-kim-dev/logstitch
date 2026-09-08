# logstitch

여러 노드에 흩어진 JSON 로그를 특정 필드값(rid 등)으로 긁어와 UTC 시간순으로 병합한다.

`python-practice/ssh-logtrace` 의 파이썬 구현을 **Go 수집기 + TypeScript 파서**로
이식한 것이다. 두 조각으로 나눈 이유는 하나다.

**파싱은 이 시스템에서 가장 자주 바뀌는 코드다.** 로그 포맷이 슬쩍 바뀌고, 필드가
추가되고, 모듈이 하나 늘어난다. 반대로 SSH 전송(커넥션, 타임아웃, 팬아웃, 재시도)은
한 번 제대로 만들면 거의 안 건드린다. 그래서 **잘 안 바뀌는 걸 Go 에, 자주 바뀌는 걸
TS 에** 두었다. 로그 포맷 하나 바뀔 때마다 수집기 바이너리를 다시 배포하지 않아도 된다.

```
logstitch --app ai-stt --env prod --rid abc123 | logstitch-parse
```

- **자격증명을 다루지 않는다** — 시스템 `ssh` 를 그대로 exec 하므로 `~/.ssh/config`,
  ssh-agent, ProxyJump, known_hosts 를 OS 가 처리한다. IP 도 패스워드도 코드에 없다.
- **의존성이 거의 없다** — 수집기는 Go 표준 라이브러리만, 파서는 Node 22 의 내장
  타입 스트리핑으로 빌드 단계 없이 돈다 (개발 시 `typescript` 만 필요).

## 구성

```
apps.json                  앱별 필수 필드 (환경 무관, 커밋함)
inventory.<앱>.<환경>.json    호스트와 로그 경로 (환경별, 커밋 안 함)

collector/                 Go — 로그 내용을 모른다
  main.go                  CLI, 인자 검증, 타깃 전개, 종료코드
  apps/                    앱 설정 로딩·검증
  inventory/               인벤토리 경로 해석, 로딩·검증
  remote/                  원격 bash 스크립트 생성, 셸 인용
  collect/                 ssh 팬아웃, NDJSON 스트리밍

parser/                    TypeScript — 로그 내용을 안다
  src/fields.ts            필드 별칭, 타임스탬프 파싱, 임베디드 JSON 풀기
  src/records.ts           정규화, 매칭 판정, 지문, 반복 접기
  src/render.ts            터미널 / JSONL 출력, 요약
  src/cli.ts               stdin NDJSON 소비, 필터·정렬
  src/index.ts             라이브러리 진입점 (2차 웹 계층이 import)

test/                      가짜 ssh + 픽스처 + 파이썬 대조
```

`main.go` 는 CLI 관심사(인자 파싱, 검증, 종료코드)만 두고 전송 계층은 별도
패키지(`apps`, `inventory`, `remote`, `collect`)에 둔다. 그 경계는 컴파일러가 강제한다.
2차에서 stdin JSON 진입점을 붙일 때도 `main.go` 만 건드리면 된다.

경계선이 정확히 어디인지가 이 저장소를 읽는 열쇠다.

| | Go 수집기 | TS 파서 |
|---|---|---|
| 인벤토리 읽기, 타깃 전개 | ✅ | |
| 원격 스크립트 생성, ssh 실행 | ✅ | |
| `소스\t파일\t줄` → NDJSON 분해 | ✅ | |
| 호스트별 성공/실패 상태 | ✅ | |
| JSON 파싱, 필드 별칭 해석 | | ✅ |
| 타임스탬프 파싱 (ISO / epoch / 나노초) | | ✅ |
| 임베디드 JSON 풀기 | | ✅ |
| 매칭 종류 판정, 지문, 반복 접기 | | ✅ |
| 정렬, 병합, 출력 | | ✅ |

수집기에게 로그 한 줄은 **불투명한 문자열**이다.

## 준비

`~/.ssh/config` 별칭 등록 → 키 생성 → 공개키 배포 순서로 한 번만 하면 된다.
순서가 중요하다.

**1. `~/.ssh/config` 에 별칭 등록** (IP는 여기에만 산다)

```
Host req-01
  HostName 192.0.2.11
  User myuser
  IdentityFile ~/.ssh/id_logstitch
```

> `BatchMode yes` 를 **config 에 넣지 말 것.** 넣으면 다음 단계의 `ssh-copy-id` 가
> 패스워드를 물어보지 못해서 실패한다. logstitch 는 그 옵션을 실행 시 명령줄로 넘긴다.

**2. 키 생성** — 노트북에서 한 번만

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_logstitch -C logstitch
ssh-add --apple-use-keychain ~/.ssh/id_logstitch   # macOS: 패스프레이즈 한 번만
```

**3. 공개키 배포** — 반드시 **별칭으로** 한다

```sh
ssh-copy-id -i ~/.ssh/id_logstitch.pub req-01
```

별칭으로 하는 이유가 두 가지다. `ssh-copy-id` 는 내부적으로 `ssh` 를 쓰므로 config 가
제대로 써졌는지 그 자리에서 검증되고, 처음 접속하는 서버의 host key 확인(`yes`)을
미리 대화형으로 넘겨 `known_hosts` 에 등록해둘 수 있다. **이걸 안 해두면
`BatchMode=yes` 로 도는 logstitch 가 `Host key verification failed` 로 실패한다.**

**4. 전체 확인**

```sh
for h in req-01 req-02 sch-01; do
  printf '%-8s ' "$h"
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$h" 'echo ok' 2>&1 | head -1
done
```

키 인증이 서버 정책으로 막혀 있다면 차선책으로 연결 재사용을 쓴다:

```
Host req-* sch-* rcv-*
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

**5. 앱 설정 작성** (`apps.json`)

애플리케이션별로 **반드시 받아야 하는 필드**를 적는다. 하나라도 빠지면
스크립트가 돌지 않는다.

```json
{
  "apps": {
    "app-01":    { "required": ["rid"] },
    "app-02": { "required": ["node_id"] }
  }
}
```

필수 필드는 앱의 **로그 스키마 속성이라 환경과 무관하다.** 그래서 인벤토리가
아니라 이 파일 하나에 모은다 — prod 에 필드를 추가하고 stage 에 빠뜨리는
드리프트가 원리적으로 생기지 않는다. 호스트도 경로도 없으니 커밋해도 된다.

**`required` 는 순서가 의미를 가진다.** 원격에서 grep 을 이 순서로 이어붙이므로,
가장 선택적인(결과가 적게 나오는) 필드를 앞에 두면 뒤쪽 grep 이 훑을 양이 줄어든다.

**6. 인벤토리 작성**

인벤토리는 **앱과 환경별로 파일을 나눈다.** 파일 이름이 그 둘을 나타낸다.

```
<기본이름>.<앱>.<환경>.json

inventory.ai-stt.prod.json
inventory.ai-stt.stage.json
inventory.forwarder.prod.json
```

```sh
cp inventory.example.json inventory.ai-stt.prod.json
```

`-i` 는 확장자·앱·환경을 뺀 **기본 이름**이고(기본값 `inventory`), `--app` 과
`--env` 가 나머지를 채운다.

```sh
logstitch --app ai-stt --env prod --rid abc123
  → inventory.ai-stt.prod.json
```

`hosts` 는 위에서 만든 ssh 별칭, `paths` 는 원격 셸이 확장하는 glob 이다.
로테이션된 `.gz` 도 잡히도록 `*` 를 넉넉히 준다.

파일 안에는 앱도 환경도 적지 않는다. 두 곳에 적으면 서로 어긋날 수 있고,
실행할 때 같은 값을 두 번 넘겨야 해서 방어가 아니라 중복이 된다.

**앱과 환경 이름은 코드가 정하지 않는다.** `apps.json` 에 항목을 만들고
그 이름으로 인벤토리 파일을 만들면 그게 앱·환경이다.

### 없으면 아무것도 돌지 않는다

`--app`, `--env`, 그리고 앱의 필수 필드 — 하나라도 없으면 ssh 에 붙지 않고
거부한다. 에러는 **실제로 뭘 쓸 수 있는지** 알려준다.

```sh
$ logstitch --env test --rid abc
[오류] --app 이 필요합니다 (apps.json 에 정의된 앱: ai-stt, forwarder)

$ logstitch --app ai-stt --rid abc
[오류] --env 가 필요합니다 (ai-stt 앱에 쓸 수 있는 환경: prod, stage)

$ logstitch --app forwarder --env prod --field stream_key=abc
[오류] 앱 "forwarder" 의 필수 필드가 빠졌습니다: session_id, node_id
       필요한 필드 전체: stream_key, session_id, node_id
       예: logstitch --app forwarder --env prod --field stream_key=<값> \
             --field session_id=<값> --field node_id=<값>
```

## 빌드

```sh
# 수집기. -o 는 -C 로 이동한 디렉토리 기준이라 ../ 가 필요하다.
# (collector 는 자기 go.mod 를 가진 별도 모듈이라 루트에서 ./collector 로는 못 짓는다)
go build -C collector -o ../.bin/logstitch .

# 파서는 빌드 단계가 없다. Node 22.18+ 의 타입 스트리핑으로 .ts 를 바로 실행한다.
# 의존성은 타입체크·테스트용으로만 필요하다.
(cd parser && npm install)

# 파서를 이름으로 부르고 싶으면
chmod +x parser/src/cli.ts
ln -s "$PWD/parser/src/cli.ts" .bin/logstitch-parse

export PATH="$PWD/.bin:$PATH"
```

`.bin/` 은 `.gitignore` 대상이라 새로 clone 하면 비어 있다. `./test/e2e.sh` 도
첫 단계에서 수집기를 빌드하므로, 그것만 한 번 돌려도 `.bin/logstitch` 가 생긴다.

## 사용

`--app` 과 `--env` 는 매번 붙어다니므로 셸 변수로 묶어두면 편하다.

```sh
LS="logstitch --app ai-stt --env prod"

$LS --rid abc123 | logstitch-parse                  # 기본
$LS --rid abc123 --dry-run                          # 접속 없이 원격 명령만 확인
$LS --rid abc123 --area scheduler | logstitch-parse  # 특정 영역만
$LS --rid abc123 --after 20 | logstitch-parse        # 스택트레이스 뒤 20줄까지
$LS --field content_id=555 | logstitch-parse         # 임의 필드로 검색

$LS --rid abc123 | logstitch-parse --strict          # 필드 정확일치만
$LS --rid abc123 | logstitch-parse --value-cap 0     # 긴 값(ffmpeg 명령줄 등) 통째로
$LS --rid abc123 | logstitch-parse --json > t.jsonl  # 나중에 시각화용
```

필수 필드가 여러 개인 앱은 전부 줘야 한다.

```sh
logstitch --app forwarder --env prod \
  --field stream_key=abc --field session_id=s1 --field node_id=n7 | logstitch-parse
```

`required` 밖의 필드를 더 주면 **추가 교집합 조건**으로 붙는다 (임시 조회용).

```sh
$LS --rid abc123 --field cpk=tenant-a | logstitch-parse
```

처음 돌릴 땐 `--dry-run` 으로 원격 명령을 눈으로 확인하고 시작하는 걸 권한다.

`--area` 를 빼고 전 영역을 긁으면 요약에 **구간 갭**이 나온다. 어느 구간에서
시간이 비었는지가 이 도구의 목적이고, 갭이 5초를 넘으면 빨간색으로 찍힌다.

## 동작

```
전 호스트 병렬   ssh <host> 'bash -s'  ←  for f in <glob>; do grep -F -a -e <값> ; done
                                          (각 줄 앞에 소스명·파일 경로를 탭으로 붙임)
        ↓ NDJSON
파서             JSON 파싱 → 별칭 해석 → 타임스탬프 → 매칭 판정 → 정렬 → 반복 접기
```

### 조건이 여러 개면 원격에서 교집합

`required` 가 여러 개인 앱은 grep 을 **파이프로 이어붙여** 원격에서 교집합을
계산한다. 모든 값이 같은 줄에 있어야 남는다.

```sh
grep -F -e abc | grep -F -e s1 | grep -F -e n7
```

값마다 별도 스크립트를 돌려 로컬에서 교집합을 내도 결과는 같지만, ssh 왕복이
값 개수만큼 늘고 **걸러지기 전 줄이 전부 전송된다.** 이어붙이면 왕복 1회에
원격에서 이미 줄어든 것만 넘어온다.

그래서 `--after` 는 조건이 하나일 때만 쓸 수 있다. 이어붙인 grep 에서는 앞
grep 이 붙인 컨텍스트 줄이 뒤 grep 에 걸리지 않아 그대로 사라지므로, 조용히
무효가 되는 대신 거부한다.

**왜 원격에서 정확히 필터하지 않는가** — `grep -F '"rid":"abc"'` 는 직렬화 형태
(콜론 뒤 공백, 키 순서, 숫자/문자열)에 의존해서 모듈 언어가 다르면 조용히 안 걸린다.
`jq` 는 노드에 있다는 보장이 없다. 그래서 원격은 값으로 관대하게 긁고, 정확한 필드
일치 판정은 파서가 `JSON.parse` 후에 한다.

파서는 레코드를 중첩 구조까지 훑어서 값이 **어디서** 걸렸는지 분류한다.

| 분류 | 뜻 | `--strict` |
|---|---|---|
| `field` | 찾던 필드에 정확히 그 값 | 남음 |
| `nested` | 중첩 구조 안에 값이 그대로 (`form_data.source_file_name[0]`) | 남음 |
| `partial` | 그 경로의 값 "안에" 포함 (`"<rid>.mp3"`, ffmpeg 명령줄의 경로) | 남음 |
| `other` | 다른 최상위 필드에 같은 값 (`parent_rid`) — 다른 요청일 수 있음 | 제외 |
| `substring` | 값이 든 위치를 특정 못 함 | 제외 |
| `raw` | JSON 이 아닌 줄 (panic 등) | 남음 |

**`--strict` 를 기본으로 쓰지 말 것.** receiver 모듈은 `rid` 필드에 핸들러 이름
(`"HandleSubtitle"`)을 넣고 진짜 rid 는 `form_data` 안에 넣는데, 그게 요청을 처음 받은
시점의 원본 파라미터 로그다. 정확일치만 남기면 그 줄이 통째로 사라진다.

### 반복되는 줄 접기

폴링 로그는 같은 내용이 수십 번 반복돼서 타임라인을 덮는다. 기본으로 접는다.

```
 12:37:43.012  scheduler/scheduler  kw47  DEBUG  worker checking task  (scheduler.go:802)
      ⟲ 같은 내용 9회 반복 — 12:37:43 → 12:37:58 (15s)
```

한 줄만 남기는 게 아니라 **횟수와 지속 시간**을 같이 남긴다. 폴링에서는 그 지속
시간 자체가 진단 정보다 ("STARTED 로 17분 묶여 있었다").

판정 기준은 **시각을 뺀 레코드 전체의 지문**이다. `msg` 만 보고 접으면 상태
전이(`STARTED` → `SUCCESS`)까지 뭉개지는데, 그게 정작 제일 보고 싶은 줄이다.
접기는 같은 (영역·소스·호스트) 안에서 **연달아** 나온 줄에만 적용된다.

`--no-collapse` 로 전부 볼 수 있다.

## 실제 환경에 맞추기

로그 필드 이름이 다르면 `parser/src/fields.ts` 상단의 별칭 목록만 고치면 된다.
모듈별 파서를 만들 필요 없다.

```ts
export const TS_KEYS    = ['ts', 'time', 'timestamp', '@timestamp', ...]
export const LEVEL_KEYS = ['level', 'lvl', 'severity', ...]
export const MSG_KEYS   = ['msg', 'message', 'log', 'event', ...]
export const CALLER_KEYS = ['source', 'caller', ...]
```

`CALLER_KEYS` 는 호출 위치다. Go slog 의
`"source":{"function":..,"file":..,"line":..}` 객체와 zap 의
`"caller":"consumer/rabbitmq.go:300"` 문자열을 둘 다 받아서 `(rabbitmq.go:300)` 으로
짧게 찍는다. function 경로는 너무 길어서 버린다.

타임스탬프는 ISO8601(`Z`/오프셋/공백 구분), epoch 초·밀리·마이크로·나노를 자동
판별한다. `⚠ 타임스탬프를 못 읽은 줄` 경고가 뜨면 `TS_KEYS` 에 키를 추가한다.

## 파이썬 구현에서 달라진 점

이식하면서 **개선한 것**:

- **나노초 정밀도를 지킨다.** 실제 로그가 `.568353422Z`(9자리)인데 파이썬 `datetime` 은
  마이크로초까지만 담는다. JS `Date` 는 밀리초까지라 더 나쁘다. 그래서 표시용 `Date` 와
  **정렬용 나노초(`bigint`)를 따로** 들고 다닌다. 같은 밀리초 안의 인과 순서를 잃지 않는다.
- **`--max-lines`** (기본 50000). 한 호스트가 거대한 결과를 뱉으면 상한에서 끊고
  요약에 잘렸다고 표시한다. 파이썬에는 상한이 없어서 메모리로 다 받았다.
- **앱과 환경이 1급 개념이 되었다.** 인벤토리를 `<기본이름>.<앱>.<환경>.json`
  으로 나누고 `--app`/`--env` 로 고른다. 없는 걸 주면 실제로 있는 것을
  알려준다. 수집한 앱·환경은 `meta` 이벤트로 파서에 전달되어 요약 머리글과
  JSONL 레코드에 남는다.
- **앱별 필수 필드** (`apps.json`). 앱마다 반드시 받아야 하는 필드가 다르고,
  하나라도 빠지면 ssh 에 붙지 않는다. 파이썬은 `--field` 하나만 받았고 그게
  뭐든 통과했다.
- **조건이 여러 개면 원격에서 교집합.** grep 을 파이프로 이어붙여 ssh 왕복
  1회에 처리한다.
- **`_match` 가 문자열이 아니라 union.** 파이썬은 `"nested:a.b[0]"` 문자열을 만들고
  렌더링 시점에 다시 파싱했다. 이제 `{ kind: 'nested', path: 'a.b[0]' }` 다.
- **줄 길이 제한이 없다.** 파이썬은 stdout 을 통째로 읽었고, Go 는 `bufio.Scanner` 대신
  `Reader.ReadString` 을 쓴다. Scanner 는 64KB 에서 줄을 자르는데 스택트레이스가 박힌
  JSON 로그 한 줄은 그걸 넘을 수 있다.

**빠진 것**:

- **라운드2(파생키 재조회)가 없다.** 1차 범위에서 제외했다. 인벤토리의 `followup`
  블록은 읽어도 무시하므로 기존 인벤토리 파일이 그대로 로드된다.
  (참고: `inventory.ai-stt.json` 에는 애초에 `followup` 이 없어서 파이썬에서도
  라운드2 가 돌지 않고 있었다. 예전 README 의 「동작」 설명과 설정이 드리프트한 상태였다.)

**남은 차이**:

- **셸 인용 스타일이 다르다.** 파이썬 `shlex.quote` 는 `'it'"'"'s'` 를, 이쪽은
  `'it'\''s'` 를 만든다. POSIX 셸에서 둘은 동등하고,
  `collector/internal/remote/script_test.go` 가 실제 셸에 넘겨 라운드트립을 검증한다.
- **소수점 숫자 검색은 결과가 갈릴 수 있다.** 파이썬 `str(1.0)` 은 `"1.0"` 인데 JS
  `String(1.0)` 은 `"1"` 이다. `JSON.parse` 는 `1` 과 `1.0` 을 구분하지 않으므로 복원할
  수 없다. 검색값이 rid / content_id 같은 문자열이면 영향이 없다.

## 보안상 지켜둔 것

- **검색값은 `ShQuote` 로 인용해 원격 셸에 넘긴다.** 여기가 틀리면 검색값이 원격에서
  명령으로 실행된다. `content_id` 에 들어가는 `@` 가 이걸로 통과한다.
- **경로는 인벤토리에만 있다.** 클라이언트가 임의 경로를 지정할 수 없다.
  2차에서 웹 백엔드를 붙일 때도 인벤토리 소유권은 수집기에 두어야 한다.
- **접속 대상은 인벤토리에만 있다.** 명령줄로 호스트를 넘기는 경로가 없다.
  `--area` 는 인벤토리에 있는 것을 줄이기만 한다. 어디에 붙는지가 파일 하나에만
  적혀 있어야 검토가 가능하다.
- **인벤토리의 호스트 이름은 영숫자로 시작해야 한다**
  (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, 로딩 때 검사). 호스트 문자열은 `ssh` 의 argv 로
  들어가므로 `-` 로 시작하면 ssh 가 옵션으로 파싱한다 —
  `-oProxyCommand=...` 하나로 수집기가 도는 머신에서 임의 명령이 실행된다.
  인벤토리는 사람이 쓰는 파일이라 외부 입력은 아니지만, 실패가 조용하고 심각해서
  걸러낸다. 같은 호스트가 두 번 적힌 것도 함께 거부한다 (줄이 두 번 수집된다).
- **`grep -F`** 로 고정 문자열 검색만 한다. 검색값이 정규식으로 해석되지 않는다.

## 설계상 지켜둔 것들

- **JSON 이 아닌 줄을 버리지 않는다.** panic, 스택트레이스, 기동 배너는 장애 시점에
  제일 보고 싶은 줄이다. 파싱 실패해도 `raw` 로 살리고, 직전 줄의 시각을 물려받아
  (`~` 표시) 순서가 안 깨지게 한다.
- **한 대가 죽어도 전체가 실패하지 않는다.** 실패한 호스트는 요약에 따로 찍힌다.
  그 죽은 노드가 장애 원인일 때가 많다.
- **구간 갭을 계산해서 보여준다.** 어느 구간에서 시간이 비었는지가 이 도구의 목적이다.
- **`seq` 로 원래 스트림 순서를 유지한다.** 같은 시각에 찍힌 줄들의 인과 순서가
  정렬 때문에 뒤집히지 않는다.
- **수집기는 stateless 하다.** 라운드 개념도, 캐시도, DB 도 없다.

## 테스트

실제 노드 없이 전체 파이프라인을 검증한다. `test/fakebin/ssh` 가 ssh 를 흉내내
로컬 bash 로 실행하므로 코드 경로는 실제와 동일하다.

```sh
./test/e2e.sh

# 기존 파이썬 구현과 출력까지 대조 (파이썬이 남아 있는 동안)
PYTHON_REF=../python-practice/ssh-logtrace ./test/e2e.sh
```

픽스처에는 로테이션된 `.gz`, 서로 다른 타임스탬프 키 3종(ISO `Z` 나노초 / 공백+오프셋 /
epoch ms), 다른 필드에 값이 든 줄, 중첩 배열 안의 값, `body` 에 JSON 문자열이 박힌 줄,
JSON 이 아닌 panic 줄과 시각 없는 연속 줄, 반복되는 폴링 줄, 접속 실패 노드,
그리고 존재하지 않는 로그 파일이 들어 있다.

**파이썬이 남아 있는 동안은 그게 가장 값싼 회귀 테스트다.** 두 구현을 같은 픽스처로
돌려 정규화된 JSONL 을 대조한다 (`test/compare_with_python.py`). 이식이 끝나면
그 스크립트와 `PYTHON_REF` 분기는 지운다.

개별 실행:

```sh
go test -C collector ./...
(cd parser && npx tsc --noEmit && node --test "test/*.test.ts")
```

## 다음 단계

`--json` 출력이 있으므로 시각화는 나중에 붙이면 된다. 먼저 터미널 출력으로
**rid 로 긁은 결과가 실제로 원하는 그림을 그리는지** 확인하는 게 순서다.

2차에 붙일 것:

- `web/` — Hono + React. `parser/src/index.ts` 를 그대로 import 한다.
- 수집기를 `spawn` 하고 **stdin 으로 JSON 요청**을 넘기는 진입점.
  플래그를 `request` 구조체로 한 번 모아둔 이유가 이것이다 (`cmd/logstitch/main.go`).
- TTL 캐시. DB 없이 시작하는 대가는 "화면 열 때마다 프로덕션에 ssh" 다.
  추이(시계열)가 필요해지면 그때 SQLite 파일 하나로 올린다.
