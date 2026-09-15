package main

import (
	"strings"
	"testing"

	"github.com/jiye-kim-dev/logstitch/collector/apps"
)

// testApps 는 두 종류의 앱을 흉내낸다 — 필수 필드 하나, 그리고 셋.
var testApps = &apps.Config{
	Apps: map[string]apps.App{
		"ai-stt":    {Required: []string{"rid"}},
		"forwarder": {Required: []string{"stream_key", "session_id", "node_id"}},
	},
}

type args struct {
	app        string
	env        string
	rid        string
	from       string
	to         string
	fields     stringList
	after      int
	noRequired bool
}

func build(t *testing.T, a args) (request, error) {
	t.Helper()
	timeout := 90
	return buildRequest(testApps, "apps.json", "inventory",
		a.app, a.env, a.rid, a.from, a.to, a.fields, nil, a.after, timeout, 0, 0,
		a.noRequired, false)
}

func criteriaOf(req request) []string {
	out := make([]string, 0, len(req.Criteria))
	for _, c := range req.Criteria {
		out = append(out, c.Field+"="+c.Value)
	}
	return out
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

	t.Run("조건이 아예 없으면 여전히 거부", func(t *testing.T) {
		_, err := build(t, args{app: "ai-stt", env: "prod", noRequired: true})
		if err == nil {
			t.Fatal("--no-required 로 조건 없이 통과했다 — 로그 전체를 긁게 된다")
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
