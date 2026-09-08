// Package apps 는 애플리케이션별 검색 규칙(apps.json)을 읽는다.
//
// 필수 필드는 애플리케이션의 로그 스키마 속성이므로 환경과 무관하다.
// 그래서 인벤토리(환경별 파일)가 아니라 이 파일 하나에 모아둔다 — prod 에
// 필드를 추가하고 stage 에 빠뜨리는 드리프트가 원리적으로 생기지 않는다.
//
// 호스트도 경로도 없으므로 이 파일은 저장소에 커밋해도 된다.
package apps

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

// App 은 한 애플리케이션의 검색 규칙이다.
type App struct {
	// Required 는 이 앱을 조회할 때 반드시 넘겨야 하는 필드다.
	//
	// 순서가 의미를 가진다. 원격에서 grep 을 이 순서로 이어붙이므로
	// 가장 선택적인(결과가 적게 나오는) 필드를 앞에 두면 전송량이 줄어든다.
	Required []string `json:"required"`

	// Note 는 사람을 위한 메모다. 코드는 쓰지 않는다.
	Note string `json:"note,omitempty"`
}

type Config struct {
	Apps map[string]App `json:"apps"`
}

// DefaultPath 는 --apps 를 안 줬을 때 찾는 경로다.
const DefaultPath = "apps.json"

func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf(
			"앱 설정을 읽을 수 없습니다 (%s): %w\n"+
				"       애플리케이션별 필수 필드를 여기에 적습니다:\n"+
				`         { "apps": { "ai-stt": { "required": ["rid"] } } }`,
			path, err)
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("앱 설정 JSON 파싱 실패 (%s): %w", path, err)
	}
	if len(cfg.Apps) == 0 {
		return nil, fmt.Errorf("[앱 설정 오류] %s: 'apps' 가 비어 있습니다", path)
	}

	for name, app := range cfg.Apps {
		if len(app.Required) == 0 {
			return nil, fmt.Errorf(
				"[앱 설정 오류] %s: 앱 %q 에 'required' 가 비어 있습니다\n"+
					"       필수 필드가 없으면 어떤 값으로 검색할지 정할 수 없습니다",
				path, name)
		}
		seen := make(map[string]bool, len(app.Required))
		for _, field := range app.Required {
			if strings.TrimSpace(field) == "" {
				return nil, fmt.Errorf(
					"[앱 설정 오류] %s: 앱 %q 의 required 에 빈 필드 이름이 있습니다", path, name)
			}
			if seen[field] {
				return nil, fmt.Errorf(
					"[앱 설정 오류] %s: 앱 %q 의 required 에 %q 가 두 번 있습니다",
					path, name, field)
			}
			seen[field] = true
		}
	}
	return &cfg, nil
}

// Find 는 이름으로 앱을 찾는다.
func (c *Config) Find(name string) (App, bool) {
	app, ok := c.Apps[name]
	return app, ok
}

// Names 는 정의된 앱 이름을 정렬해 돌려준다. 에러 메시지에 쓴다.
func (c *Config) Names() []string {
	names := make([]string, 0, len(c.Apps))
	for name := range c.Apps {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
