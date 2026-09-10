package remote

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/jiye-kim-dev/logstitch/collector/inventory"
)

// TestShQuoteRoundTrip 은 인용한 문자열을 실제 셸에 넘겨 원래 값이 그대로
// 나오는지 본다. 파이썬과 이쪽은 인용 텍스트가 다르지만 셸에서는 동등하다.
//
//	파이썬 shlex.quote:  'it'"'"'s'
//	이쪽 ShQuote:        'it'\''s'
//
// 그래서 텍스트를 맞추는 대신 동작을 검증한다.
//
// 여기가 틀리면 검색값이 원격 셸에서 명령으로 해석될 수 있으므로,
// 이 테스트는 이 저장소에서 가장 중요한 테스트다.
func TestShQuoteRoundTrip(t *testing.T) {
	cases := []string{
		"",
		"abc",
		"a b",
		"it's",
		`a"b`,
		"a'b'c",
		"'",
		"''",
		"$HOME",
		"a$(id)b",
		"`id`",
		"a;rm -rf /",
		"a|b",
		"a&b",
		"a\nb",
		"a\tb",
		"*",
		"?",
		"--flag",
		"-oProxyCommand=x",
		"~root",
		"한글 값",
		`back\slash`,
		"20260904-abc@subtitle@0f8e.mp3",
		"a1b2c3d4-5e6f-7890-abcd-ef1234567890",
	}

	for _, in := range cases {
		got, err := exec.Command("sh", "-c", "printf %s "+ShQuote(in)).Output()
		if err != nil {
			t.Errorf("ShQuote(%q) → 셸 실행 실패: %v", in, err)
			continue
		}
		if string(got) != in {
			t.Errorf("ShQuote(%q) 라운드트립 불일치: 셸이 %q 를 돌려줌 (인용 결과: %s)",
				in, string(got), ShQuote(in))
		}
	}
}

// TestBuildScriptInvariants 는 이식하면서 잃으면 안 되는 성질들을 고정한다.
func TestBuildScriptInvariants(t *testing.T) {
	sources := []inventory.Source{
		{Name: "app", Paths: []string{"/var/log/kollus/ai-stt/requester/requester.log*"}},
		{Name: "debug", Paths: []string{"/var/log/kollus/ai-stt-scheduler/debug.log*"}},
	}
	script := BuildScript(sources, []string{"rid-7f3a91"}, 0)

	// glob 은 원격 셸이 확장해야 하므로 인용되면 안 된다.
	if !strings.Contains(script, "for f in /var/log/kollus/ai-stt/requester/requester.log*; do") {
		t.Error("glob 경로가 인용되었거나 형태가 바뀌었다 — 원격에서 확장되지 않는다")
	}
	// .gz 는 zgrep 이 아니라 gzip -cd 로 풀어야 한다 (배포판마다 zgrep 이 없다).
	if !strings.Contains(script, `gzip -cd -- "$f"`) {
		t.Error(".gz 처리 분기가 없다")
	}
	if strings.Contains(script, "zgrep") || strings.Contains(script, "zcat") {
		t.Error("zgrep/zcat 에 의존하고 있다")
	}
	// 정규식이 아니라 고정 문자열 검색이어야 한다.
	if !strings.Contains(script, "grep -F") {
		t.Error("grep -F 가 아니다 — 검색값이 정규식으로 해석된다")
	}
	// grep 이 못 찾으면 exit 1 이므로 마지막에 exit 0 이 있어야 한다.
	if !strings.HasSuffix(script, "exit 0\n") {
		t.Error("스크립트가 exit 0 으로 끝나지 않는다 — 결과 없음이 실패로 보인다")
	}
	// 각 소스가 자기 이름으로 태깅되어야 한다.
	for _, name := range []string{"s=app", "s=debug"} {
		if !strings.Contains(script, name) {
			t.Errorf("%s 태깅이 없다 — 줄의 출처를 잃는다", name)
		}
	}

	withCtx := BuildScript(sources[:1], []string{"x"}, 20)
	if !strings.Contains(withCtx, "-A 20") {
		t.Error("--after 가 grep -A 로 전달되지 않았다")
	}
	if strings.Contains(script, "-A ") {
		t.Error("after=0 인데 -A 가 들어갔다")
	}
}

// TestBuildScriptIntersection 은 값이 여러 개일 때 원격에서 교집합이
// 계산되는지 본다.
//
// 값마다 별도 스크립트를 돌려 로컬에서 교집합을 내도 결과는 같지만, ssh
// 왕복이 값 개수만큼 늘고 걸러지기 전 줄이 전부 전송된다. grep 을 파이프로
// 이어붙이면 왕복 1회에 원격에서 이미 줄어든 것만 넘어온다.
func TestBuildScriptIntersection(t *testing.T) {
	sources := []inventory.Source{
		{Name: "app", Paths: []string{"/var/log/app.log*"}},
	}
	script := BuildScript(sources, []string{"abc", "s1", "n7"}, 0)

	// 일반 파일 분기: grep 하나 뒤에 두 개가 파이프로 붙어야 한다.
	if !strings.Contains(script, "grep -F -a -h -e abc -- \"$f\" 2>/dev/null | grep -F -a -e s1 | grep -F -a -e n7") {
		t.Errorf("일반 파일 분기에서 grep 이 이어붙지 않았다:\n%s", script)
	}
	// .gz 분기도 같아야 한다.
	if !strings.Contains(script, "| grep -F -a -e abc | grep -F -a -e s1 | grep -F -a -e n7") {
		t.Errorf(".gz 분기에서 grep 이 이어붙지 않았다:\n%s", script)
	}
	// 파일당 for 루프는 한 번뿐이어야 한다 (값마다 훑지 않는다).
	if got := strings.Count(script, "for f in "); got != 1 {
		t.Errorf("for 루프가 %d개다 — 값마다 파일을 다시 훑고 있다", got)
	}

	// 인용이 필요한 값도 이어붙는 자리에서 안전해야 한다.
	quoted := BuildScript(sources, []string{"a", "it's b"}, 0)
	if !strings.Contains(quoted, `| grep -F -a -e 'it'\''s b'`) {
		t.Errorf("이어붙인 값이 인용되지 않았다:\n%s", quoted)
	}

	// 값이 없으면 아무것도 하지 않는다.
	if BuildScript(sources, nil, 0) != "exit 0\n" {
		t.Error("값이 없는데 스크립트가 생성됐다")
	}
}
