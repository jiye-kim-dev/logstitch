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
	"regexp"
	"sort"
	"strings"
)

// App 은 한 애플리케이션의 검색 규칙이다.
type App struct {
	// Required 는 이 앱을 조회할 때 반드시 넘겨야 하는 필드다.
	// 순서가 의미를 가진다. 원격에서 grep 을 이 순서로 이어붙이므로
	// 가장 선택적인(결과가 적게 나오는) 필드를 앞에 두면 전송량이 줄어든다.
	Required []string `json:"required"`

	// View 는 파서를 위한 표현 힌트다. 수집기는 내용을 해석하지 않고
	// meta 이벤트에 그대로 실어 보낸다 — 로그를 어떻게 보여줄지는
	// 파서의 일이고, 여기서 파싱하면 그 경계가 무너진다.
	View json.RawMessage `json:"view,omitempty"`

	// Parser 는 파서를 위한 필드 별칭 힌트다 (tsKeys, msgKeys 등 —
	// 표준 키를 안 쓰는 앱을 코드 수정 없이 흡수한다). View 와 같은
	// 통과 채널이다: 해석 없이 meta 이벤트에 그대로 실어 보낸다.
	Parser json.RawMessage `json:"parser,omitempty"`

	// Areas 는 특정 영역에만 다르게 적용할 규칙이다. 키는 인벤토리의 영역 이름.
	Areas map[string]AreaRule `json:"areas,omitempty"`

	// Redact 는 파서로 내보내기 전에 가릴 민감 값 규칙이다. 모든 영역에 적용된다.
	Redact Redact `json:"redact,omitempty"`

	// Note 는 사람을 위한 메모다. 코드는 쓰지 않는다.
	Note string `json:"note,omitempty"`
}

// AreaRule 은 한 영역에만 적용할 검색 규칙이다.
//
// 같은 앱 안에서도 영역마다 로그 형태가 달라 공통 앵커가 안 통할 때가 있다
// 또는 같은 앱 안에서
// (JSON 로그에는 user_key 가 있지만 lal 계열 plain 로그에는 없다). 영역별로
// 앵커를 갈라두면 앱을 쪼개지 않고 — view/parser 힌트를 그대로 상속한 채 —
// 한 번의 조회에 함께 담을 수 있다.
type AreaRule struct {
	// Required 는 이 영역에서 쓸 검색 필드다. 앱 레벨 required 를 **대체**한다.
	// (area 영역만의 required 필드 지정이라 이해해주면 됨)
	//
	// 마찬가지로 값을 안 주면 이 영역은 시간 범위로만 검색할거고, 최대 24H 이다.
	// 빈 배열은 "이 영역은 늘 시간 범위로만" 이라는 뜻으로 유효하다.
	Required []string `json:"required"`
}

// Redact 는 민감 값 가림 규칙이다. 가린 값은 collect.Removed 로 바뀐다.
type Redact struct {
	// Fields 는 JSON 줄에서 값을 가릴 키 이름이다. 깊이와 무관하게 일치하는
	// 키를 모두 가린다 (문자열로 박힌 JSON 안까지).
	Fields []string `json:"fields,omitempty"`

	// Patterns 는 줄 전체(JSON·plain 공통)에 적용할 정규식이다.
	// Go RE2 문법이라 lookbehind·backreference 는 쓸 수 없다.
	Patterns []string `json:"patterns,omitempty"`
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
		if err := validateFields(app.Required, path, fmt.Sprintf("앱 %q 의 required", name)); err != nil {
			return nil, err
		}

		for area, rule := range app.Areas {
			if strings.TrimSpace(area) == "" {
				return nil, fmt.Errorf(
					"[앱 설정 오류] %s: 앱 %q 의 areas 에 빈 영역 이름이 있습니다", path, name)
			}
			if err := validateFields(
				rule.Required, path, fmt.Sprintf("앱 %q 의 영역 %q 의 required", name, area),
			); err != nil {
				return nil, err
			}
		}

		if err := validateRedact(app, path, name); err != nil {
			return nil, err
		}
	}
	return &cfg, nil
}

// validateRedact 는 정규식을 미리 컴파일해 보고, 가릴 필드가 검색·표현에
// 쓰이는 필드와 겹치지 않는지 본다.
//
// 겹치면 조용히 망가진다. 파서는 매칭 종류를 판정할 때 줄 안에서 검색값을
// 다시 찾고 (records.ts classifyMatch), contention 뷰는 lane/session 값으로
// 레인을 나눈다. 그 값이 **removed** 가 되면 판정이 전부 substring 이 되거나
// 레인이 하나로 뭉친다 — 에러 없이. 그래서 기동 시점에 거부한다.
func validateRedact(app App, path, name string) error {
	if err := validateFields(app.Redact.Fields, path, fmt.Sprintf("앱 %q 의 redact.fields", name)); err != nil {
		return err
	}
	for _, p := range app.Redact.Patterns {
		if _, err := regexp.Compile(p); err != nil {
			return fmt.Errorf(
				"[앱 설정 오류] %s: 앱 %q 의 redact.patterns 정규식 %q 오류: %w\n"+
					"       Go RE2 문법입니다 (lookbehind·backreference 불가)",
				path, name, p, err)
		}
	}

	used := make(map[string]string)
	for _, f := range app.Required {
		used[f] = "required"
	}
	for area, rule := range app.Areas {
		for _, f := range rule.Required {
			used[f] = fmt.Sprintf("areas.%s.required", area)
		}
	}
	// view 는 통과 채널이라 다른 곳에서는 해석하지 않는다. 여기서도 겹침
	// 판정에 필요한 두 키만 읽고, 형태가 틀려도 그건 파서가 판단할 일이다.
	var view struct {
		Lane    string `json:"lane"`
		Session string `json:"session"`
	}
	_ = json.Unmarshal(app.View, &view)
	if view.Lane != "" {
		used[view.Lane] = "view.lane"
	}
	if view.Session != "" {
		used[view.Session] = "view.session"
	}

	for _, f := range app.Redact.Fields {
		if where, ok := used[f]; ok {
			return fmt.Errorf(
				"[앱 설정 오류] %s: 앱 %q 의 redact.fields 에 %q 가 있는데 %s 에서도 씁니다\n"+
					"       가리면 파서가 매칭 판정·레인 구분을 못 합니다. 둘 중 하나를 빼세요",
				path, name, f, where)
		}
	}
	return nil
}

// validateFields 는 필드 목록(required, redact.fields)에 빈 이름이나 중복이 없는지 본다.
// where 는 에러 메시지에 들어갈 위치 설명이다 (앱 레벨과 영역 레벨이 공유).
func validateFields(fields []string, path, where string) error {
	seen := make(map[string]bool, len(fields))
	for _, field := range fields {
		if strings.TrimSpace(field) == "" {
			return fmt.Errorf(
				"[앱 설정 오류] %s: %s 에 빈 필드 이름이 있습니다", path, where)
		}
		if seen[field] {
			return fmt.Errorf(
				"[앱 설정 오류] %s: %s 에 %q 가 두 번 있습니다", path, where, field)
		}
		seen[field] = true
	}
	return nil
}

// AreaFields 는 이 앱의 영역 규칙에 선언된 필드 전체를 모은다.
//
// 영역 전용 필드를 다른 영역의 추가 조건으로 붙이면 안 되기 때문에 필요하다
// (main.orderCriteria 참고). 붙이면 --field sess=... 를 주는 순간 그 필드가
// 없는 영역이 통째로 0줄이 된다 — 에러도 없이.
func (a App) AreaFields() map[string]bool {
	owned := make(map[string]bool)
	for _, rule := range a.Areas {
		for _, field := range rule.Required {
			owned[field] = true
		}
	}
	return owned
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
