package main

import "testing"

// TestBuildRequest 는 CLI 인자 검증을 고정한다.
//
// 접속 대상은 인벤토리에서만 온다. 명령줄로 호스트를 넘기는 경로가 없으므로
// 여기서 검증할 것은 검색 기준과 환경, 숫자 옵션뿐이다.
// 호스트 형태 검증은 인벤토리 로딩 쪽에 있다 (inventory 패키지).
func TestBuildRequest(t *testing.T) {
	t.Run("rid 는 field 축약형으로 풀린다", func(t *testing.T) {
		req, err := buildRequest("inventory", "prod", "abc123", "", nil, 0, 90, 0, 0, false)
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		if req.Field != "rid" || req.Value != "abc123" {
			t.Errorf("field/value 가 rid/abc123 이 아니다: %q/%q", req.Field, req.Value)
		}
		if req.Env != "prod" {
			t.Errorf("env 가 전달되지 않았다: %q", req.Env)
		}
	})

	t.Run("field 는 그대로 쓰인다", func(t *testing.T) {
		req, err := buildRequest("inventory", "prod", "", "content_id=555", nil, 0, 90, 0, 0, false)
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		if req.Field != "content_id" || req.Value != "555" {
			t.Errorf("field/value 가 content_id/555 가 아니다: %q/%q", req.Field, req.Value)
		}
	})

	t.Run("검색값에 = 가 들어가도 첫 = 에서만 자른다", func(t *testing.T) {
		req, err := buildRequest("inventory", "prod", "", "key=a=b", nil, 0, 90, 0, 0, false)
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		if req.Value != "a=b" {
			t.Errorf("value 가 a=b 가 아니다: %q", req.Value)
		}
	})

	t.Run("env 가 없으면 거부", func(t *testing.T) {
		// 프로덕션 로그를 뒤지는 도구라 어느 환경인지 항상 명시하게 한다.
		_, err := buildRequest("inventory", "", "abc123", "", nil, 0, 90, 0, 0, false)
		if err == nil {
			t.Error("--env 없이 통과했다")
		}
	})

	bad := []struct {
		name    string
		field   string
		after   int
		timeout int
	}{
		{name: "검색 기준이 없음", timeout: 90},
		{name: "field 에 = 가 없음", field: "rid", timeout: 90},
		{name: "field 키가 빔", field: "=abc", timeout: 90},
		{name: "검색값이 빔", field: "rid=", timeout: 90},
		{name: "timeout 이 0", field: "rid=x", timeout: 0},
		{name: "timeout 이 음수", field: "rid=x", timeout: -1},
		{name: "after 가 음수", field: "rid=x", after: -1, timeout: 90},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			_, err := buildRequest("inventory", "prod", "", tc.field, nil,
				tc.after, tc.timeout, 0, 0, false)
			if err == nil {
				t.Errorf("거부되어야 하는 입력이 통과했다: %+v", tc)
			}
		})
	}
}
