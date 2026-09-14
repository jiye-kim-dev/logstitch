// Package remote 는 원격에서 실행할 bash 스크립트를 만든다.
//
// 원격에서는 grep -F 로 "싸고 관대한" 프리필터만 한다. jq 에 의존하지 않는다.
// 정확한 필드 일치 판정은 파서(TypeScript)가 json 파싱 후에 한다.
// 직렬화 형태(콜론 뒤 공백, 키 순서, 숫자/문자열)에 의존하는 정확 매칭을
// 원격에서 하면 모듈 언어가 다를 때 조용히 안 걸리기 때문이다.
package remote

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/jiye-kim-dev/logstitch/collector/inventory"
)

// shSafe 는 따옴표 없이 셸에 넘겨도 안전한 문자만으로 이루어졌는지 본다.
// 파이썬 shlex.quote 가 쓰는 집합과 같다.
var shSafe = regexp.MustCompile(`^[A-Za-z0-9@%+=:,./_-]+$`)

// ShQuote 는 문자열을 POSIX 셸에 안전하게 넘길 수 있도록 인용한다.
//
// Go 표준 라이브러리에는 파이썬 shlex.quote 에 대응하는 함수가 없어서
// 직접 구현한다. 홑따옴표로 감싸고, 내부의 홑따옴표는 인용을 닫고
// 이스케이프한 뒤 다시 여는 방식으로 끊어 붙인다.
//
//	it's                 →  'it'\''s'
//	20260904-a@subtitle  →  20260904-a@subtitle   (안전한 문자만이면 그대로)
//
// content_id 에 들어가는 @ 같은 문자가 이걸로 안전하게 통과한다.
//
// 여기가 틀리면 검색값이 원격 셸에서 명령으로 해석될 수 있다.
// script_test.go 가 실제 셸에 넘겨 라운드트립을 검증한다.
func ShQuote(s string) string {
	if s == "" {
		return "''"
	}
	if shSafe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// awkPrefix 는 각 줄 앞에 소스명(s)과 파일 경로(f)를 탭으로 붙인다.
// grep -A 가 끼워 넣는 "--" 구분선은 버린다.
//
// raw 문자열이어야 한다. Go 이스케이프로 해석되면 awk 에게 실제 탭 문자가
// 넘어가서 프로그램 텍스트가 깨진다.
const awkPrefix = `'$0=="--"{next} {print s "\t" f "\t" $0}'`

// awkTimeRange 는 시각 범위 밖의 줄을 원격에서 걸러내는 awk 프로그램이다.
// -v from=, -v to= 로 정규화된 UTC 시각 문자열을 받는다 (빈 값 = 경계 없음).
//
// grep -F 는 비교를 못 하므로 범위는 awk 가 맡는다. ISO-8601 UTC 문자열은
// 자릿수가 고정이라 사전순 비교가 곧 시간순 비교다. 이것도 "싸고 관대한"
// 프리필터일 뿐이다 — 정확한 판정은 파서가 나노초로 다시 한다.
//
// 관대함이 핵심 성질이다. 잘못 버린 줄은 파서가 볼 기회가 없으므로,
// 확신이 없으면 통과시킨다:
//
//   - 타임스탬프 키를 못 찾은 줄 (비 JSON panic 줄, grep -A 컨텍스트 줄)
//   - epoch 숫자 타임스탬프 (사전순 비교 불가 — 파서가 거른다)
//   - UTC 가 아닌 오프셋 (+09:00 등 — 사전순 비교가 시간순이 아니게 된다)
//
// to 는 substr 프리픽스 비교라 준 정밀도의 구간 끝까지 포함한다
// (to=2026-09-04 면 그날 전체). 파서의 정확 필터와 같은 의미다.
//
// POSIX awk 만 쓴다 (gawk 확장, {n} 반복 수량자 금지 — mawk/busybox 호환).
const awkTimeRange = `'{
  if (match($0, /"(ts|time|timestamp|@timestamp|eventTime|datetime|date)"[ \t]*:[ \t]*"[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9](:[0-9][0-9]([.,][0-9]+)?)? ?(Z|z|[+-][0-9][0-9]:?[0-9][0-9])?"/)) {
    v = substr($0, RSTART, RLENGTH)
    sub(/^"[^"]*"[ \t]*:[ \t]*"/, "", v)
    sub(/"$/, "", v)
    z = ""
    if (match(v, / ?(Z|z|[+-][0-9][0-9]:?[0-9][0-9])$/)) {
      z = substr(v, RSTART, RLENGTH)
      v = substr(v, 1, RSTART - 1)
      sub(/^ /, "", z)
    }
    if (z == "" || z == "Z" || z == "z" || z == "+00:00" || z == "+0000" || z == "-00:00" || z == "-0000") {
      gsub(/ /, "T", v)
      sub(/,/, ".", v)
      if (from != "" && v < from) next
      if (to != "" && substr(v, 1, length(to)) > to) next
    }
  }
  print
}'`

// Query 는 원격에서 로그를 거를 조건 묶음이다.
type Query struct {
	// Values 는 grep -F 교집합 검색값이다. 순서가 의미를 가진다 —
	// 선택적인(결과가 적은) 값을 앞에 두면 뒤쪽 grep 이 훑을 양이 줄어든다.
	Values []string

	// After 는 grep -A 컨텍스트 줄 수다. Values 가 하나일 때만 쓸 수 있다.
	// 이어붙인 grep 에서는 앞 grep 이 붙인 컨텍스트 줄이 뒤 grep 에 걸리지
	// 않아 그대로 사라지기 때문이다 (호출부에서 막는다).
	After int

	// TimeFrom / TimeTo 는 정규화된 UTC 시각 문자열이다
	// ("2026-09-04T02:19:24.5" 형태 — T 구분자, 존 표기 없음).
	// 비어 있으면 그쪽 경계가 없다. 정규화는 호출부(main)의 몫이다 —
	// 여기서 받은 그대로 awk 의 사전순 비교에 들어간다.
	TimeFrom string
	TimeTo   string
}

// BuildScript 는 원격 bash 로 넘길 스크립트를 만든다.
//
// 파이썬 remote.build_remote_script 의 이식이며 아래 성질을 그대로 유지한다.
//
//   - glob 은 원격 셸이 확장해야 하므로 경로를 인용하지 않는다.
//     (그래서 경로에 $VAR 를 쓰면 원격에서 확장된다 — 의도된 동작이다.)
//   - .gz 는 gzip -cd 로 풀어서 grep 한다. zgrep/zcat 은 배포판마다 없을 수 있다.
//   - 각 줄 앞에 소스명과 파일 경로를 붙여 어느 파일에서 나왔는지 잃지 않는다.
//   - grep 이 못 찾으면 exit 1 이라 스크립트 전체가 실패로 보이므로 마지막에 exit 0.
//
// 값이 여러 개면 grep 을 파이프로 이어붙여 **교집합**을 원격에서 계산한다.
//
//	grep -F -e v1 | grep -F -e v2 | grep -F -e v3
//
// 값마다 별도 스크립트를 돌려 로컬에서 교집합을 내도 결과는 같지만, ssh
// 왕복이 값 개수만큼 늘고 걸러지기 전 줄이 전부 전송된다. 이어붙이면 왕복
// 1회에 원격에서 이미 줄어든 것만 넘어온다.
//
// 시각 범위(TimeFrom/TimeTo)가 있으면 grep 체인 뒤에 awkTimeRange 를 한 단
// 더 붙인다. grep 다음인 이유: grep -F 가 awk 보다 훨씬 싸므로 먼저 줄여야
// awk 가 훑을 양이 준다. 범위가 없으면 스크립트는 기존과 바이트 단위로 같다.
func BuildScript(sources []inventory.Source, q Query) string {
	if len(q.Values) == 0 {
		return "exit 0\n"
	}

	first := ShQuote(q.Values[0])

	ctx := ""
	if q.After > 0 {
		ctx = fmt.Sprintf("-A %d ", q.After)
	}

	// 두 번째 값부터는 파이프로 이어붙인다.
	var chain strings.Builder
	for _, value := range q.Values[1:] {
		fmt.Fprintf(&chain, " | grep -F -a -e %s", ShQuote(value))
	}
	rest := chain.String()

	timeFilter := ""
	if q.TimeFrom != "" || q.TimeTo != "" {
		timeFilter = fmt.Sprintf(" | awk -v from=%s -v to=%s %s",
			ShQuote(q.TimeFrom), ShQuote(q.TimeTo), awkTimeRange)
	}

	var b strings.Builder
	for _, src := range sources {
		qsrc := ShQuote(src.Name)
		for _, path := range src.Paths {
			fmt.Fprintf(&b, "for f in %s; do\n", path)
			b.WriteString("  [ -r \"$f\" ] || continue\n")
			b.WriteString("  case \"$f\" in\n")
			fmt.Fprintf(&b,
				"    *.gz) gzip -cd -- \"$f\" 2>/dev/null | grep -F -a %s-e %s%s%s ;;\n",
				ctx, first, rest, timeFilter)
			fmt.Fprintf(&b,
				"    *)    grep -F -a -h %s-e %s -- \"$f\" 2>/dev/null%s%s ;;\n",
				ctx, first, rest, timeFilter)
			b.WriteString("  esac | awk -v f=\"$f\" -v s=" + qsrc + " " + awkPrefix + "\n")
			b.WriteString("done\n")
		}
	}

	b.WriteString("exit 0\n")
	return b.String()
}
