package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jiye-kim-dev/logstitch/collector/apps"
	"github.com/jiye-kim-dev/logstitch/collector/collect"
	"github.com/jiye-kim-dev/logstitch/collector/inventory"
)

// testApps 는 두 종류의 앱을 흉내낸다 — 필수 필드 하나, 그리고 셋.
var testApps = &apps.Config{
	Apps: map[string]apps.App{
		"ai-stt":    {Required: []string{"rid"}},
		"forwarder": {Required: []string{"stream_key", "session_id", "node_id"}},
		// 영역마다 앵커가 갈리는 앱 — JSON 로그는 rid, lal 영역은 plain 이라 sess.
		"mixed": {
			Required: []string{"rid"},
			Areas:    map[string]apps.AreaRule{"lal": {Required: []string{"sess"}}},
		},
	},
}

// mixedInventory 는 앵커가 갈리는 앱의 인벤토리다 (영역 둘, 호스트 하나씩).
func mixedInventory() *inventory.Inventory {
	src := func(name string) []inventory.Source {
		return []inventory.Source{{Name: name, Paths: []string{"/var/log/" + name + "/*.log"}}}
	}
	return &inventory.Inventory{Areas: []inventory.Area{
		{Name: "api", Hosts: []string{"h1"}, Sources: src("api")},
		{Name: "lal", Hosts: []string{"h1"}, Sources: src("lal")},
	}}
}

// valuesByArea 는 타깃을 영역별 검색값으로 접는다 (같은 영역은 값이 같다).
func valuesByArea(targets []collect.Target) map[string]string {
	out := make(map[string]string, len(targets))
	for _, t := range targets {
		out[t.Area] = strings.Join(t.Values, "|")
	}
	return out
}

type args struct {
	app        string
	env        string
	rid        string
	from       string
	to         string
	fields     stringList
	areas      stringList
	after      int
	noRequired bool
}

func build(t *testing.T, a args) (request, error) {
	t.Helper()
	timeout := 90
	return buildRequest(testApps, "apps.json", "inventory",
		a.app, a.env, a.rid, a.from, a.to, a.fields, a.areas, a.after, timeout, 0, 0,
		a.noRequired, false)
}

// buildAll 은 요청 조립부터 타깃 확정까지 돈다.
//
// 앵커 없는 조회의 시간 범위 검사는 buildTargets 에서 일어난다 — 실제 조회
// 대상 영역이 거기서야 정해지기 때문이다 (--area 로 좁히면 앵커 있는 영역만
// 남을 수 있다). 그 규약을 보는 테스트는 여기까지 돌려야 한다.
func buildAll(t *testing.T, a args) (request, error) {
	t.Helper()
	req, err := build(t, a)
	if err != nil {
		return req, err
	}
	_, _, err = buildTargets(mixedInventory(), req)
	return req, err
}

func criteriaOf(req request) []string {
	out := make([]string, 0, len(req.Criteria))
	for _, c := range req.Criteria {
		out = append(out, c.Field+"="+c.Value)
	}
	return out
}

func TestConfigDefaults(t *testing.T) {
	t.Run("명시한 플래그는 그대로 둔다", func(t *testing.T) {
		gotApps, gotInv := configDefaults("a.json", "inv")
		if gotApps != "a.json" || gotInv != "inv" {
			t.Errorf("명시 플래그가 바뀌었다: %q, %q", gotApps, gotInv)
		}
	})

	t.Run("CWD 에 apps.json 이 있으면 CWD 를 쓴다", func(t *testing.T) {
		t.Chdir(t.TempDir())
		if err := os.WriteFile("apps.json", []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		gotApps, gotInv := configDefaults("", "")
		if gotApps != "apps.json" || gotInv != "inventory" {
			t.Errorf("CWD 우선이 아니다: %q, %q", gotApps, gotInv)
		}
	})

	t.Run("CWD 에 없으면 XDG_CONFIG_HOME/logstitch 를 쓴다", func(t *testing.T) {
		t.Chdir(t.TempDir())
		t.Setenv("XDG_CONFIG_HOME", "/cfg")
		gotApps, gotInv := configDefaults("", "")
		if gotApps != filepath.Join("/cfg", "logstitch", "apps.json") ||
			gotInv != filepath.Join("/cfg", "logstitch", "inventory") {
			t.Errorf("XDG 폴백이 아니다: %q, %q", gotApps, gotInv)
		}
		// 한쪽만 명시하면 나머지만 폴백된다.
		gotApps, gotInv = configDefaults("given.json", "")
		if gotApps != "given.json" || gotInv != filepath.Join("/cfg", "logstitch", "inventory") {
			t.Errorf("부분 폴백이 아니다: %q, %q", gotApps, gotInv)
		}
	})

	t.Run("XDG_CONFIG_HOME 이 없으면 ~/.config/logstitch", func(t *testing.T) {
		t.Chdir(t.TempDir())
		t.Setenv("XDG_CONFIG_HOME", "")
		t.Setenv("HOME", "/home/u")
		gotApps, _ := configDefaults("", "")
		if gotApps != filepath.Join("/home/u", ".config", "logstitch", "apps.json") {
			t.Errorf("HOME 폴백이 아니다: %q", gotApps)
		}
	})
}

func TestBuildRequestHappyPath(t *testing.T) {
	t.Run("rid 는 field 축약형으로 풀린다", func(t *testing.T) {
		req, err := build(t, args{app: "ai-stt", env: "prod", rid: "abc123"})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		if got := criteriaOf(req); len(got) != 1 || got[0] != "rid=abc123" {
			t.Errorf("조건이 [rid=abc123] 이 아니다: %v", got)
		}
		if req.App != "ai-stt" || req.Env != "prod" {
			t.Errorf("app/env 가 전달되지 않았다: %q/%q", req.App, req.Env)
		}
	})

	t.Run("필수 필드 순서는 앱 설정을 따른다", func(t *testing.T) {
		// 원격에서 grep 을 이 순서로 이어붙이므로 순서가 중요하다.
		// 명령줄에서 뒤죽박죽 줘도 required 순서로 정렬되어야 한다.
		req, err := build(t, args{
			app: "forwarder", env: "prod",
			fields: stringList{"node_id=n7", "stream_key=abc", "session_id=s1"},
		})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		want := []string{"stream_key=abc", "session_id=s1", "node_id=n7"}
		got := criteriaOf(req)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("조건 순서가 %v (기대 %v)", got, want)
		}
	})

	t.Run("required 밖의 필드는 뒤에 붙는다", func(t *testing.T) {
		req, err := build(t, args{
			app: "ai-stt", env: "prod", rid: "abc",
			fields: stringList{"cpk=tenant-a"},
		})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		want := []string{"rid=abc", "cpk=tenant-a"}
		if got := criteriaOf(req); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("조건이 %v (기대 %v)", got, want)
		}
	})
}

// TestBuildRequestRequiresAppAndEnv 는 앱이나 환경 없이는 아무것도 안 돌아야
// 함을 고정한다.
func TestBuildRequestRequiresAppAndEnv(t *testing.T) {
	t.Run("app 이 없으면 쓸 수 있는 앱을 알려준다", func(t *testing.T) {
		_, err := build(t, args{env: "prod", rid: "abc"})
		if err == nil {
			t.Fatal("--app 없이 통과했다")
		}
		for _, want := range []string{"ai-stt", "forwarder"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("에러에 %q 가 없다: %v", want, err)
			}
		}
	})

	t.Run("모르는 app 은 거부", func(t *testing.T) {
		if _, err := build(t, args{app: "없는앱", env: "prod", rid: "abc"}); err == nil {
			t.Error("정의되지 않은 앱이 통과했다")
		}
	})

	t.Run("env 가 없으면 거부", func(t *testing.T) {
		if _, err := build(t, args{app: "ai-stt", rid: "abc"}); err == nil {
			t.Error("--env 없이 통과했다")
		}
	})
}

// TestBuildRequestRequiresFields 는 앱별 필수 필드가 다 없으면 스크립트가
// 돌지 않아야 함을 고정한다.
func TestBuildRequestRequiresFields(t *testing.T) {
	t.Run("검색 조건이 아예 없으면 거부", func(t *testing.T) {
		_, err := build(t, args{app: "ai-stt", env: "prod"})
		if err == nil {
			t.Fatal("조건 없이 통과했다")
		}
		if !strings.Contains(err.Error(), "rid") {
			t.Errorf("에러가 빠진 필드를 알려주지 않는다: %v", err)
		}
	})

	t.Run("일부만 주면 빠진 것을 알려준다", func(t *testing.T) {
		_, err := build(t, args{
			app: "forwarder", env: "prod",
			fields: stringList{"stream_key=abc"},
		})
		if err == nil {
			t.Fatal("필수 필드가 빠졌는데 통과했다")
		}
		msg := err.Error()
		for _, want := range []string{"session_id", "node_id"} {
			if !strings.Contains(msg, want) {
				t.Errorf("에러에 빠진 필드 %q 가 없다: %v", want, msg)
			}
		}
		if strings.Contains(strings.SplitN(msg, "\n", 2)[0], "stream_key") {
			t.Errorf("이미 준 필드가 빠진 것으로 표시됐다: %v", msg)
		}
		// 어떻게 고치는지 예시가 있어야 한다.
		if !strings.Contains(msg, "--field stream_key=") {
			t.Errorf("에러에 사용 예시가 없다: %v", msg)
		}
	})

	t.Run("다른 앱의 필드를 줘도 required 는 못 채운다", func(t *testing.T) {
		_, err := build(t, args{
			app: "ai-stt", env: "prod",
			fields: stringList{"stream_key=abc"},
		})
		if err == nil {
			t.Error("rid 없이 통과했다")
		}
	})
}

// TestNoRequired 는 --no-required 가 필수 필드 검사만 끄고, "조건 없는 수집
// 금지" 와 "required 우선 정렬" 은 유지함을 고정한다.
func TestNoRequired(t *testing.T) {
	t.Run("필수 필드 없이 임의 필드로 검색할 수 있다", func(t *testing.T) {
		req, err := build(t, args{
			app: "forwarder", env: "prod", noRequired: true,
			fields: stringList{"source.function=OnRtmpConnect"},
		})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		want := []string{"source.function=OnRtmpConnect"}
		if got := criteriaOf(req); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("조건이 %v (기대 %v)", got, want)
		}
	})

	t.Run("조건도 시간 범위도 없으면 여전히 거부", func(t *testing.T) {
		_, err := buildAll(t, args{app: "ai-stt", env: "prod", noRequired: true})
		if err == nil {
			t.Fatal("--no-required 로 조건 없이 통과했다 — 로그 전체를 긁게 된다")
		}
		if !strings.Contains(err.Error(), "--from") {
			t.Errorf("에러가 --from 이 필요함을 알려주지 않는다: %v", err)
		}
	})

	t.Run("준 required 는 여전히 앞에 정렬된다", func(t *testing.T) {
		req, err := build(t, args{
			app: "forwarder", env: "prod", noRequired: true,
			fields: stringList{"fn=OnRtmpConnect", "stream_key=abc"},
		})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		want := []string{"stream_key=abc", "fn=OnRtmpConnect"}
		if got := criteriaOf(req); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("조건 순서가 %v (기대 %v)", got, want)
		}
	})
}

func TestBuildRequestRejectsBadInput(t *testing.T) {
	cases := map[string]args{
		"field 에 = 가 없음": {app: "ai-stt", env: "prod", fields: stringList{"rid"}},
		"field 키가 빔":     {app: "ai-stt", env: "prod", fields: stringList{"=abc"}},
		"검색값이 빔":         {app: "ai-stt", env: "prod", fields: stringList{"rid="}},
		"같은 field 두 번": {app: "ai-stt", env: "prod",
			fields: stringList{"rid=a", "rid=b"}},
		"after 가 음수": {app: "ai-stt", env: "prod", rid: "abc", after: -1},
	}
	for name, a := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := build(t, a); err == nil {
				t.Errorf("거부되어야 하는 입력이 통과했다: %+v", a)
			}
		})
	}
}

// TestTimeBoundNormalization 은 --from/--to 가 사전순 비교 가능한 형태
// (T 구분자, 점 소수, 존 표기 없음)로 정규화되는지 고정한다.
// 원격 awk 와 파서가 이 형태를 전제로 비교하므로, 여기가 흔들리면
// 범위 판정이 조용히 어긋난다.
func TestTimeBoundNormalization(t *testing.T) {
	cases := map[string]struct{ in, want string }{
		"날짜만":        {"2026-09-04", "2026-09-04"},
		"분까지":        {"2026-09-04T02:19", "2026-09-04T02:19"},
		"초까지":        {"2026-09-04T02:19:24", "2026-09-04T02:19:24"},
		"나노초 + Z":    {"2026-09-04T02:19:24.568353422Z", "2026-09-04T02:19:24.568353422"},
		"공백 구분자":     {"2026-09-04 02:19:24", "2026-09-04T02:19:24"},
		"쉼표 소수":      {"2026-09-04T02:19:24,5", "2026-09-04T02:19:24.5"},
		"+00:00 존":   {"2026-09-04T02:19:24+00:00", "2026-09-04T02:19:24"},
		"존 앞 공백":     {"2026-09-04 02:19:24.5 +00:00", "2026-09-04T02:19:24.5"},
		"빈 값은 경계 없음": {"", ""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := normalizeTimeBound("from", c.in)
			if err != nil {
				t.Fatalf("normalizeTimeBound(%q) 오류: %v", c.in, err)
			}
			if got != c.want {
				t.Errorf("normalizeTimeBound(%q) = %q (기대 %q)", c.in, got, c.want)
			}
		})
	}

	rejected := map[string]string{
		"UTC 아닌 오프셋": "2026-09-04T02:19:24+09:00",
		"시간만":        "02:19:24",
		"없는 달":       "2026-13-04",
		"없는 시각":      "2026-09-04T25:00",
		"자유 형식":      "어제",
		"epoch 숫자":   "1788488369123",
	}
	for name, in := range rejected {
		t.Run("거부: "+name, func(t *testing.T) {
			if _, err := normalizeTimeBound("from", in); err == nil {
				t.Errorf("거부되어야 하는 시각이 통과했다: %q", in)
			}
		})
	}
}

// TestTimeRangeValidation 은 뒤집힌 범위가 조용히 빈 결과가 되는 대신
// 거부되는지 본다. from 이 to 의 정밀도 구간 안이면 유효하다.
func TestTimeRangeValidation(t *testing.T) {
	t.Run("from 이 to 보다 뒤면 거부", func(t *testing.T) {
		_, err := build(t, args{app: "ai-stt", env: "prod", rid: "abc",
			from: "2026-09-05", to: "2026-09-04"})
		if err == nil {
			t.Fatal("뒤집힌 범위가 통과했다")
		}
	})

	t.Run("from 이 to 의 정밀도 구간 안이면 통과", func(t *testing.T) {
		// --to 2026-09-04 는 그날 전체를 포함하므로 02:19 부터는 유효한 범위다.
		req, err := build(t, args{app: "ai-stt", env: "prod", rid: "abc",
			from: "2026-09-04T02:19", to: "2026-09-04"})
		if err != nil {
			t.Fatalf("유효한 범위가 거부됐다: %v", err)
		}
		if req.TimeFrom != "2026-09-04T02:19" || req.TimeTo != "2026-09-04" {
			t.Errorf("범위가 전달되지 않았다: from=%q to=%q", req.TimeFrom, req.TimeTo)
		}
	})

	t.Run("한쪽 경계만 줘도 된다", func(t *testing.T) {
		req, err := build(t, args{app: "ai-stt", env: "prod", rid: "abc",
			from: "2026-09-04T02:19"})
		if err != nil {
			t.Fatalf("from 만 준 요청이 거부됐다: %v", err)
		}
		if req.TimeFrom == "" || req.TimeTo != "" {
			t.Errorf("경계가 잘못 전달됐다: from=%q to=%q", req.TimeFrom, req.TimeTo)
		}
	})
}

// TestNoCriteriaTimeRange 는 조건 없는 조회(--no-required + --field 없음)가
// --from 을 요구하고 범위를 24시간으로 제한함을 고정한다. grep 앵커가 없으면
// 원격에서 파일 전 구간을 훑으므로 범위가 부하의 유일한 상한이다.
func TestNoCriteriaTimeRange(t *testing.T) {
	t.Run("24시간 이내 범위면 조건 없이 통과", func(t *testing.T) {
		// --to 2026-09-04 는 그날 전체 → 정확히 24시간이므로 허용 경계다.
		req, err := buildAll(t, args{app: "ai-stt", env: "prod", noRequired: true,
			from: "2026-09-04T00:00", to: "2026-09-04"})
		if err != nil {
			t.Fatalf("24시간 범위가 거부됐다: %v", err)
		}
		if len(req.Criteria) != 0 {
			t.Errorf("조건이 비어 있지 않다: %v", req.Criteria)
		}
	})

	t.Run("24시간 초과면 거부", func(t *testing.T) {
		_, err := buildAll(t, args{app: "ai-stt", env: "prod", noRequired: true,
			from: "2026-09-04", to: "2026-09-05"})
		if err == nil {
			t.Fatal("48시간 범위가 통과했다")
		}
		if !strings.Contains(err.Error(), "24시간") {
			t.Errorf("에러가 24시간 제한을 알려주지 않는다: %v", err)
		}
	})

	t.Run("to 를 생략하면 현재 시각까지로 계산한다", func(t *testing.T) {
		// 먼 과거의 from 은 현재까지 24시간을 넘으므로 거부된다.
		_, err := buildAll(t, args{app: "ai-stt", env: "prod", noRequired: true,
			from: "2026-09-04"})
		if err == nil {
			t.Fatal("과거 from + to 생략이 통과했다")
		}
	})

	t.Run("조건이 있으면 24시간 제한을 받지 않는다", func(t *testing.T) {
		// grep 앵커가 있으면 원격 전송량이 이미 좁혀지므로 제한 대상이 아니다.
		_, err := buildAll(t, args{app: "ai-stt", env: "prod", rid: "abc",
			from: "2026-09-01", to: "2026-09-10"})
		if err != nil {
			t.Errorf("조건 있는 넓은 범위가 거부됐다: %v", err)
		}
	})
}

// TestBoundRangeEnd 는 준 정밀도 구간 끝 계산을 고정한다 (파서 rangeEndNanos
// 와 같은 의미여야 24시간 판정이 사용자 기대와 일치한다).
func TestBoundRangeEnd(t *testing.T) {
	cases := map[string]struct{ in, want string }{
		"날짜만":  {"2026-09-04", "2026-09-05T00:00:00"},
		"분까지":  {"2026-09-04T02:19", "2026-09-04T02:20:00"},
		"초까지":  {"2026-09-04T02:19:24", "2026-09-04T02:19:25"},
		"소수 초": {"2026-09-04T02:19:24.5", "2026-09-04T02:19:24.6"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			got := boundRangeEnd(c.in).Format("2006-01-02T15:04:05.999999999")
			if got != c.want {
				t.Errorf("boundRangeEnd(%q) = %s (기대 %s)", c.in, got, c.want)
			}
		})
	}
}

// TestAfterConflictsWithMultipleFields 는 --after 가 조용히 무효가 되는 대신
// 거부되는지 본다.
//
// 조건이 여러 개면 원격에서 grep 을 이어붙이는데, 앞 grep 이 붙인 컨텍스트
// 줄은 뒤 grep 에 걸리지 않아 그대로 사라진다.
func TestAfterConflictsWithMultipleFields(t *testing.T) {
	_, err := build(t, args{
		app: "forwarder", env: "prod", after: 20,
		fields: stringList{"stream_key=abc", "session_id=s1", "node_id=n7"},
	})
	if err == nil {
		t.Fatal("--after 와 다중 조건이 함께 통과했다")
	}
	if !strings.Contains(err.Error(), "--after") {
		t.Errorf("에러가 --after 를 지목하지 않는다: %v", err)
	}

	// 조건이 하나면 문제없다.
	if _, err := build(t, args{app: "ai-stt", env: "prod", rid: "abc", after: 20}); err != nil {
		t.Errorf("조건이 하나인데 --after 가 거부됐다: %v", err)
	}
}

// TestAreaRules 는 apps.json 의 areas 규칙이 영역별로 앵커를 가르는지 고정한다.
//
// 가장 중요한 것은 "영역 전용 필드가 다른 영역에 교집합으로 안 붙는다" 이다.
// 붙으면 그 필드가 없는 영역이 통째로 0줄이 되는데 에러도 안 난다.
func TestAreaRules(t *testing.T) {
	t.Run("영역 전용 필드는 다른 영역의 추가 조건이 되지 않는다", func(t *testing.T) {
		req, err := build(t, args{
			app: "mixed", env: "prod", rid: "abc",
			fields: stringList{"sess=RTMPPUSH246"},
		})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		// 앱 레벨에는 rid 만 — sess 가 여기 끼면 api 영역이 0줄이 된다.
		if got := criteriaOf(req); strings.Join(got, ",") != "rid=abc" {
			t.Errorf("앱 레벨 조건이 %v (기대 [rid=abc])", got)
		}
		lal := req.AreaCriteria["lal"]
		if len(lal) != 1 || lal[0].Field != "sess" || lal[0].Value != "RTMPPUSH246" {
			t.Errorf("lal 영역 조건이 %v", lal)
		}

		targets, _, err := buildTargets(mixedInventory(), req)
		if err != nil {
			t.Fatalf("buildTargets 실패: %v", err)
		}
		got := valuesByArea(targets)
		if got["api"] != "abc" || got["lal"] != "RTMPPUSH246" {
			t.Errorf("영역별 검색값이 %v (기대 api=abc, lal=RTMPPUSH246)", got)
		}
	})

	t.Run("값을 안 주면 그 영역은 시간 범위로만 긁는다", func(t *testing.T) {
		req, err := build(t, args{
			app: "mixed", env: "prod", rid: "abc",
			from: "2026-09-28T07:00", to: "2026-09-28T08:00",
		})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		targets, _, err := buildTargets(mixedInventory(), req)
		if err != nil {
			t.Fatalf("buildTargets 실패: %v", err)
		}
		if got := valuesByArea(targets); got["api"] != "abc" || got["lal"] != "" {
			t.Errorf("영역별 검색값이 %v (기대 api=abc, lal=앵커 없음)", got)
		}
	})

	t.Run("값도 범위도 없으면 무엇을 주면 되는지 알려준다", func(t *testing.T) {
		req, err := build(t, args{app: "mixed", env: "prod", rid: "abc"})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		_, _, err = buildTargets(mixedInventory(), req)
		if err == nil {
			t.Fatal("앵커도 범위도 없는 영역이 통과했다 — 원격에서 전 구간을 훑는다")
		}
		for _, want := range []string{"lal", "sess", "--from"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("에러에 %q 가 없다: %v", want, err)
			}
		}
	})

	t.Run("--area 로 앵커 있는 영역만 남으면 범위 없이도 통과한다", func(t *testing.T) {
		// 검사를 buildRequest 에서 하면 여기서 막힌다 — 거기서는 인벤토리를
		// 몰라 --area 로 무엇이 남는지 볼 수 없고, 앱 레벨 조건이 비었다는
		// 것만 보고 --from 을 요구하게 된다.
		req, err := build(t, args{
			app: "mixed", env: "prod", noRequired: true,
			areas: stringList{"lal"}, fields: stringList{"sess=RTMPPUSH246"},
		})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		targets, _, err := buildTargets(mixedInventory(), req)
		if err != nil {
			t.Fatalf("앵커(sess)가 있는데 거부됐다: %v", err)
		}
		if got := valuesByArea(targets); len(got) != 1 || got["lal"] != "RTMPPUSH246" {
			t.Errorf("타깃이 %v (기대 lal=RTMPPUSH246 하나)", got)
		}
	})

	t.Run("영역 규칙이 없는 앱은 동작이 그대로다", func(t *testing.T) {
		req, err := build(t, args{app: "ai-stt", env: "prod", rid: "abc"})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		targets, _, err := buildTargets(mixedInventory(), req)
		if err != nil {
			t.Fatalf("buildTargets 실패: %v", err)
		}
		if got := valuesByArea(targets); got["api"] != "abc" || got["lal"] != "abc" {
			t.Errorf("모든 영역이 앱 레벨 조건을 써야 한다: %v", got)
		}
	})
}

// TestWarnUnknownAreas 는 apps.json 의 영역 이름이 인벤토리와 어긋났을 때
// 소리를 내는지 고정한다. 조용히 넘어가면 그 영역이 앱 레벨 앵커로 조회되어
// 0줄이 나오는데, 에러가 없어서 "그 시간대에 로그가 없었다" 로 읽힌다.
func TestWarnUnknownAreas(t *testing.T) {
	req, err := build(t, args{
		app: "mixed", env: "prod", rid: "abc", fields: stringList{"sess=RTMPPUSH246"},
	})
	if err != nil {
		t.Fatalf("예상치 못한 오류: %v", err)
	}

	warn := func(inv *inventory.Inventory, r request) string {
		var buf bytes.Buffer
		warnUnknownAreas(&buf, inv, r)
		return buf.String()
	}

	t.Run("인벤토리에 없는 영역은 알린다", func(t *testing.T) {
		onlyAPI := &inventory.Inventory{Areas: []inventory.Area{{
			Name: "api", Hosts: []string{"h1"},
			Sources: []inventory.Source{{Name: "api", Paths: []string{"/var/log/api/*.log"}}},
		}}}
		got := warn(onlyAPI, req)
		if !strings.Contains(got, "lal") {
			t.Errorf("없는 영역(lal)을 알리지 않았다: %q", got)
		}
	})

	t.Run("이름이 맞으면 조용하다", func(t *testing.T) {
		if got := warn(mixedInventory(), req); got != "" {
			t.Errorf("정상인데 경고가 났다: %q", got)
		}
	})

	t.Run("--area 로 좁혀도 잘못 알리지 않는다", func(t *testing.T) {
		// 선택된 영역이 아니라 인벤토리 전체와 비교해야 한다. 안 그러면
		// --area api 로 돌릴 때마다 lal 이 없다고 알리게 된다.
		narrowed, err := build(t, args{
			app: "mixed", env: "prod", rid: "abc", areas: stringList{"api"},
		})
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		if got := warn(mixedInventory(), narrowed); got != "" {
			t.Errorf("--area 로 좁혔을 뿐인데 경고가 났다: %q", got)
		}
	})
}
