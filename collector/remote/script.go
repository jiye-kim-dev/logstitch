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

// BuildScript 는 원격 bash 로 넘길 스크립트를 만든다.
//
// 파이썬 remote.build_remote_script 의 이식이며 아래 성질을 그대로 유지한다.
//
//   - glob 은 원격 셸이 확장해야 하므로 경로를 인용하지 않는다.
//     (그래서 경로에 $VAR 를 쓰면 원격에서 확장된다 — 의도된 동작이다.)
//   - .gz 는 gzip -cd 로 풀어서 grep 한다. zgrep/zcat 은 배포판마다 없을 수 있다.
//   - 각 줄 앞에 소스명과 파일 경로를 붙여 어느 파일에서 나왔는지 잃지 않는다.
//   - grep 이 못 찾으면 exit 1 이라 스크립트 전체가 실패로 보이므로 마지막에 exit 0.
func BuildScript(sources []inventory.Source, pattern string, after int) string {
	quoted := ShQuote(pattern)

	ctx := ""
	if after > 0 {
		ctx = fmt.Sprintf("-A %d ", after)
	}

	var b strings.Builder
	for _, src := range sources {
		qsrc := ShQuote(src.Name)
		for _, path := range src.Paths {
			fmt.Fprintf(&b, "for f in %s; do\n", path)
			b.WriteString("  [ -r \"$f\" ] || continue\n")
			b.WriteString("  case \"$f\" in\n")
			fmt.Fprintf(&b,
				"    *.gz) gzip -cd -- \"$f\" 2>/dev/null | grep -F -a %s-e %s ;;\n",
				ctx, quoted)
			fmt.Fprintf(&b,
				"    *)    grep -F -a -h %s-e %s -- \"$f\" 2>/dev/null ;;\n",
				ctx, quoted)
			b.WriteString("  esac | awk -v f=\"$f\" -v s=" + qsrc + " " + awkPrefix + "\n")
			b.WriteString("done\n")
		}
	}

	b.WriteString("exit 0\n")
	return b.String()
}
