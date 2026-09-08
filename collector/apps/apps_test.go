package apps

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "apps.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("픽스처 작성 실패: %v", err)
	}
	return path
}

const validBody = `{
  "apps": {
    "ai-stt":    { "required": ["rid"] },
    "forwarder": { "required": ["stream_key", "session_id", "node_id"],
                   "note": "세 값이 같은 줄에 있어야 걸린다" }
  }
}`

func TestLoadValid(t *testing.T) {
	cfg, err := Load(write(t, validBody))
	if err != nil {
		t.Fatalf("예상치 못한 오류: %v", err)
	}

	stt, ok := cfg.Find("ai-stt")
	if !ok {
		t.Fatal("ai-stt 를 못 찾았다")
	}
	if len(stt.Required) != 1 || stt.Required[0] != "rid" {
		t.Errorf("ai-stt 의 required 가 [rid] 가 아니다: %v", stt.Required)
	}

	fwd, _ := cfg.Find("forwarder")
	// required 는 순서가 의미를 가진다 — 원격에서 grep 을 이 순서로 이어붙인다.
	want := []string{"stream_key", "session_id", "node_id"}
	if len(fwd.Required) != len(want) {
		t.Fatalf("forwarder 의 required 개수가 %d (기대 %d)", len(fwd.Required), len(want))
	}
	for i := range want {
		if fwd.Required[i] != want[i] {
			t.Errorf("required 순서가 %v (기대 %v)", fwd.Required, want)
			break
		}
	}

	if _, ok := cfg.Find("없는앱"); ok {
		t.Error("없는 앱이 찾아졌다")
	}

	names := cfg.Names()
	if len(names) != 2 || names[0] != "ai-stt" || names[1] != "forwarder" {
		t.Errorf("Names 가 정렬되지 않았다: %v", names)
	}
}

func TestLoadRejectsBadShapes(t *testing.T) {
	cases := map[string]string{
		"apps 가 빔":         `{"apps":{}}`,
		"apps 가 아예 없음":     `{}`,
		"required 가 빔":     `{"apps":{"x":{"required":[]}}}`,
		"required 가 아예 없음": `{"apps":{"x":{}}}`,
		"required 에 빈 이름":  `{"apps":{"x":{"required":["a","  "]}}}`,
		"required 에 중복":    `{"apps":{"x":{"required":["a","b","a"]}}}`,
		"JSON 이 아님":        `not json`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(write(t, body)); err == nil {
				t.Error("거부되어야 하는 설정이 통과했다")
			}
		})
	}
}

// TestLoadMissingFileExplains 는 파일이 없을 때 무엇을 만들어야 하는지
// 에러가 알려주는지 본다. 처음 쓰는 사람이 제일 먼저 만나는 에러다.
func TestLoadMissingFileExplains(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "없는파일.json"))
	if err == nil {
		t.Fatal("없는 파일이 통과했다")
	}
	if !strings.Contains(err.Error(), "required") {
		t.Errorf("에러가 파일 형태를 알려주지 않는다: %v", err)
	}
}
