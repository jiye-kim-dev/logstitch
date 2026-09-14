package main

import (
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// POST /collect 가 CLI 와 같은 검증을 태우고, dry_run 으로 원격 스크립트를
// 응답 본문에 돌려주는지 끝까지 확인한다. ssh 접속은 없다.
func TestHandleCollect(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	appsJSON := `{"apps":{"ai-stt":{"required":["rid"]}}}`
	invJSON := `{
		"areas": [{
			"name": "requester",
			"hosts": ["dev-01"],
			"sources": [{"name": "app", "paths": ["/var/log/app/debug.log"]}]
		}]
	}`
	if err := os.WriteFile("apps.json", []byte(appsJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("inventory.ai-stt.dev.json", []byte(invJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	post := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("POST", "/collect", strings.NewReader(body))
		rec := httptest.NewRecorder()
		handleCollect(rec, req, "apps.json", "inventory")
		return rec
	}

	t.Run("dry_run 은 원격 스크립트를 돌려준다", func(t *testing.T) {
		rec := post(`{"app":"ai-stt","env":"dev","fields":{"rid":"abc123"},"dry_run":true}`)
		if rec.Code != 200 {
			t.Fatalf("코드 = %d, 본문 = %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "abc123") {
			t.Errorf("검색값이 스크립트에 없음: %s", rec.Body.String())
		}
	})

	t.Run("필수 필드 누락은 400", func(t *testing.T) {
		rec := post(`{"app":"ai-stt","env":"dev"}`)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), "rid") {
			t.Errorf("코드 = %d, 본문 = %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("모르는 필드는 400", func(t *testing.T) {
		rec := post(`{"app":"ai-stt","env":"dev","max_line":10}`)
		if rec.Code != 400 {
			t.Errorf("코드 = %d, 본문 = %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("없는 인벤토리는 400", func(t *testing.T) {
		rec := post(`{"app":"ai-stt","env":"prod","fields":{"rid":"x"}}`)
		if rec.Code != 400 {
			t.Errorf("코드 = %d, 본문 = %s", rec.Code, rec.Body.String())
		}
	})
}
