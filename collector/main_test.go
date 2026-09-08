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
	app    string
	env    string
	rid    string
	fields stringList
	after  int
}

func build(t *testing.T, a args) (request, error) {
	t.Helper()
	timeout := 90
	return buildRequest(testApps, "apps.json", "inventory",
		a.app, a.env, a.rid, a.fields, nil, a.after, timeout, 0, 0, false)
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
