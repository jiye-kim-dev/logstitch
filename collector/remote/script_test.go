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
	script := BuildScript(sources, Query{Values: []string{"rid-7f3a91"}})

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

	withCtx := BuildScript(sources[:1], Query{Values: []string{"x"}, After: 20})
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
	script := BuildScript(sources, Query{Values: []string{"abc", "s1", "n7"}})

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
	quoted := BuildScript(sources, Query{Values: []string{"a", "it's b"}})
	if !strings.Contains(quoted, `| grep -F -a -e 'it'\''s b'`) {
		t.Errorf("이어붙인 값이 인용되지 않았다:\n%s", quoted)
	}

	// 값도 시간 범위도 없으면 아무것도 하지 않는다.
	if BuildScript(sources, Query{}) != "exit 0\n" {
		t.Error("값도 범위도 없는데 스크립트가 생성됐다")
	}
}

// TestBuildScriptNoValues 는 값 없이 시간 범위만으로 거르는 스크립트를
// 고정한다 (--no-required + --from/--to 조회).
func TestBuildScriptNoValues(t *testing.T) {
	sources := []inventory.Source{
		{Name: "app", Paths: []string{"/var/log/app.log*"}},
	}
	script := BuildScript(sources, Query{
		TimeFrom: "2026-09-04T00:00",
		TimeTo:   "2026-09-04",
	})

	if strings.Contains(script, "grep") {
		t.Errorf("값이 없는데 grep 이 들어갔다:\n%s", script)
	}
	if !strings.Contains(script,
		`cat -- "$f" 2>/dev/null | awk -v from=2026-09-04T00:00 -v to=2026-09-04`) {
		t.Errorf("일반 파일 분기가 cat | 시각 필터가 아니다:\n%s", script)
	}
	if !strings.Contains(script, `gzip -cd -- "$f" 2>/dev/null | awk -v from=`) {
		t.Errorf(".gz 분기가 gzip | 시각 필터가 아니다:\n%s", script)
	}
	if !strings.HasSuffix(script, "exit 0\n") {
		t.Error("스크립트가 exit 0 으로 끝나지 않는다")
	}
}

// TestBuildScriptTimeRange 는 시각 범위가 스크립트에 반영되는 형태를 고정한다.
func TestBuildScriptTimeRange(t *testing.T) {
	sources := []inventory.Source{
		{Name: "app", Paths: []string{"/var/log/app.log*"}},
	}

	// 범위가 없으면 스크립트는 기존과 완전히 같아야 한다 (awk 필터 없음).
	plain := BuildScript(sources, Query{Values: []string{"abc"}})
	if strings.Contains(plain, "-v from=") {
		t.Error("범위가 없는데 시각 필터가 들어갔다")
	}

	ranged := BuildScript(sources, Query{
		Values:   []string{"abc"},
		TimeFrom: "2026-09-04T02:19",
		TimeTo:   "2026-09-04T02:20",
	})
	// grep 체인 "뒤"에 붙어야 한다 — grep 이 먼저 줄여야 awk 가 훑을 양이 준다.
	if !strings.Contains(ranged, "grep -F -a -h -e abc -- \"$f\" 2>/dev/null | awk -v from=2026-09-04T02:19 -v to=2026-09-04T02:20") {
		t.Errorf("시각 필터가 grep 뒤에 붙지 않았다:\n%s", ranged)
	}
	// .gz 분기에도 같은 필터가 있어야 한다.
	if got := strings.Count(ranged, "-v from=2026-09-04T02:19"); got != 2 {
		t.Errorf("시각 필터가 %d군데다 (기대: 일반/.gz 두 분기)", got)
	}

	// 한쪽 경계만 줘도 필터가 붙는다. 빈 쪽은 '' 로 넘어간다.
	fromOnly := BuildScript(sources, Query{Values: []string{"abc"}, TimeFrom: "2026-09-04"})
	if !strings.Contains(fromOnly, "-v from=2026-09-04 -v to=''") {
		t.Errorf("from 만 준 경우가 처리되지 않았다:\n%s", fromOnly)
	}
}

// runAwkTimeRange 는 awkTimeRange 프로그램을 실제 awk 로 돌려 결과 줄을 돌려준다.
// ShQuote 라운드트립처럼 텍스트가 아니라 동작을 검증한다 — 여기서 잘못
// 버려진 줄은 파서가 볼 기회가 없으므로, 이 프로그램의 관대함이 핵심이다.
func runAwkTimeRange(t *testing.T, from, to string, lines []string) []string {
	t.Helper()
	cmd := exec.Command("sh", "-c",
		"awk -v from="+ShQuote(from)+" -v to="+ShQuote(to)+" "+awkTimeRange)
	cmd.Stdin = strings.NewReader(strings.Join(lines, "\n") + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("awk 실행 실패: %v", err)
	}
	got := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(got) == 1 && got[0] == "" {
		return nil
	}
	return got
}

func TestAwkTimeRangeBehavior(t *testing.T) {
	in := `{"time":"2026-09-04T02:19:24.568353422Z","msg":"in-range iso"}`
	before := `{"time":"2026-09-04T02:18:59.999999999Z","msg":"before"}`
	after := `{"time":"2026-09-04T02:21:00.000000000Z","msg":"after"}`
	spaceOffset := `{"ts":"2026-09-04 02:19:26.000000 +00:00","msg":"in-range space+offset"}`

	t.Run("범위 안은 남고 밖은 떨어진다", func(t *testing.T) {
		got := runAwkTimeRange(t, "2026-09-04T02:19", "2026-09-04T02:20",
			[]string{before, in, spaceOffset, after})
		if len(got) != 2 || !strings.Contains(got[0], "in-range iso") ||
			!strings.Contains(got[1], "space+offset") {
			t.Errorf("범위 판정이 틀렸다: %v", got)
		}
	})

	t.Run("to 는 준 정밀도 구간 끝까지 포함한다", func(t *testing.T) {
		// to=...:24 는 24초 구간 전체(24.568 포함)를 포함하고 25초는 뺀다.
		sec25 := `{"time":"2026-09-04T02:19:25.000000000Z","msg":"sec25"}`
		got := runAwkTimeRange(t, "", "2026-09-04T02:19:24", []string{in, sec25})
		if len(got) != 1 || !strings.Contains(got[0], "in-range iso") {
			t.Errorf("to 프리픽스 포함 판정이 틀렸다: %v", got)
		}
	})

	t.Run("from 은 경계 시각 자체를 포함한다", func(t *testing.T) {
		exact := `{"time":"2026-09-04T02:19:24.000000000Z","msg":"exact"}`
		got := runAwkTimeRange(t, "2026-09-04T02:19:24", "", []string{before, exact})
		if len(got) != 1 || !strings.Contains(got[0], "exact") {
			t.Errorf("from 경계 판정이 틀렸다: %v", got)
		}
	})

	t.Run("확신 없는 줄은 통과한다", func(t *testing.T) {
		// 잘못 버린 줄은 파서가 볼 기회가 없다. 시각을 못 읽으면 남긴다.
		lenient := []string{
			`panic: runtime error: invalid memory address`,     // 비 JSON
			`{"timestamp":1788488369123,"msg":"epoch"}`,        // epoch 숫자 — 사전순 비교 불가
			`{"time":"2026-09-04T11:19:24+09:00","msg":"kst"}`, // UTC 아닌 오프셋
			`--`, // grep -A 구분선 (뒤 awk 가 버린다)
		}
		got := runAwkTimeRange(t, "2026-09-04T02:19", "2026-09-04T02:20", lenient)
		if len(got) != len(lenient) {
			t.Errorf("확신 없는 줄이 버려졌다 (기대 %d줄, 실제 %d줄): %v",
				len(lenient), len(got), got)
		}
	})
}
