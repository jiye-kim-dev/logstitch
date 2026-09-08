// Package inventory 는 조회 대상 정의(인벤토리 JSON)를 읽고 검증한다.
//
// 기존 파이썬 구현(ltrace/inventory.py)의 스키마를 그대로 유지한다.
// 알 수 없는 필드는 encoding/json 이 자동으로 무시하므로 _comment 나
// followup(라운드2 설정)이 들어있는 기존 인벤토리 파일도 그대로 로드된다.
// followup 은 1차 범위에서 제외되었으므로 구조체에 두지 않는다.
package inventory

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Source 는 한 영역 안에서 긁을 로그 묶음이다.
// Paths 는 원격 셸이 확장하는 glob 이며, 로테이션된 .gz 도 잡히도록
// 보통 뒤에 * 를 붙여 쓴다.
type Source struct {
	Name  string   `json:"name"`
	Paths []string `json:"paths"`
}

// hostPattern 은 ssh 별칭으로 허용할 형태다.
//
// 첫 글자를 영숫자로 강제하는 것이 핵심이다. 호스트 문자열은 ssh 의 argv 로
// 들어가므로 "-" 로 시작하면 ssh 가 그걸 옵션으로 파싱한다. 예컨대
// -oProxyCommand=... 이 인벤토리에 들어가면 수집기가 도는 머신에서 임의
// 명령이 실행된다.
//
// 인벤토리는 사람이 쓰는 파일이라 외부 입력은 아니다. 그래도 실패가 조용하고
// 심각해서 로딩 때 걸러낸다 — 나중에 스크립트로 인벤토리를 생성하게 되면
// 이게 마지막 방어선이 된다.
var hostPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// Area 는 모듈 단위의 조회 대상이다.
// Hosts 는 IP 가 아니라 ~/.ssh/config 의 별칭이다. 그래서 이 프로그램은
// IP 도 패스워드도 알지 못한다.
type Area struct {
	Name    string   `json:"name"`
	Hosts   []string `json:"hosts"`
	Sources []Source `json:"sources"`
}

// Inventory 는 인벤토리 파일 하나의 내용이다.
//
// 환경(dev/stage/prod ...)은 이 안에 없다. 파일 이름이 환경을 나타내고
// (`<기본이름>.<환경>.json`), 실행할 때 --env 로 파일을 고른다.
// 파일 안에도 환경을 적어두면 이름과 어긋날 수 있고, 같은 값을 두 번
// 넘겨야 해서 방어가 아니라 중복이 된다.
type Inventory struct {
	SSHOpts []string `json:"ssh_opts"`
	Areas   []Area   `json:"areas"`
}

// DefaultSSHOpts 는 인벤토리에 ssh_opts 가 없을 때 쓰는 값이다.
//
// BatchMode=yes 는 패스워드 프롬프트에 매달리지 말고 즉시 실패하라는 뜻이다.
// 이 옵션은 ~/.ssh/config 에 넣으면 ssh-copy-id 가 깨지므로 실행 시 넘긴다.
var DefaultSSHOpts = []string{
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-o", "LogLevel=ERROR",
}

// Resolve 는 기본 이름과 환경으로 인벤토리 파일 경로를 만든다.
//
//	Resolve("inventory.ai-stt", "prod")  →  "inventory.ai-stt.prod.json"
//
// 환경은 파일 이름에만 산다. 파일이 없으면 같은 기본 이름으로 실제 존재하는
// 환경들을 함께 알려준다 — 오타인지 아직 안 만든 환경인지 바로 보인다.
//
// base 에 .json 이 붙어 있으면 떼고 쓴다. 그게 없으면
// inventory.ai-stt.json.prod.json 같은 경로가 나온다.
func Resolve(base, env string) (string, error) {
	base = strings.TrimSuffix(base, ".json")
	path := fmt.Sprintf("%s.%s.json", base, env)

	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return path, nil
	}

	available := Environments(base)
	if len(available) == 0 {
		return "", fmt.Errorf(
			"인벤토리 파일이 없습니다: %s\n"+
				"       (-i %s, --env %s)\n"+
				"       %s.<환경>.json 형태의 파일이 하나도 없습니다",
			path, base, env, base)
	}
	return "", fmt.Errorf(
		"인벤토리 파일이 없습니다: %s\n"+
			"       (-i %s, --env %s)\n"+
			"       쓸 수 있는 환경: %s",
		path, base, env, strings.Join(available, ", "))
}

// Environments 는 <기본이름>.<환경>.json 파일들에서 환경 이름을 뽑아
// 정렬해 돌려준다.
func Environments(base string) []string {
	base = strings.TrimSuffix(base, ".json")

	matches, err := filepath.Glob(base + ".*.json")
	if err != nil {
		// base 에 glob 메타문자가 들어간 경우. 목록을 못 만들 뿐이다.
		return nil
	}

	envs := make([]string, 0, len(matches))
	for _, match := range matches {
		env := strings.TrimSuffix(strings.TrimPrefix(match, base+"."), ".json")
		if env != "" {
			envs = append(envs, env)
		}
	}
	sort.Strings(envs)
	return envs
}

// Load 는 인벤토리 파일을 읽고 검증한다.
func Load(path string) (*Inventory, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("인벤토리를 읽을 수 없습니다: %w", err)
	}

	var inv Inventory
	if err := json.Unmarshal(raw, &inv); err != nil {
		return nil, fmt.Errorf("인벤토리 JSON 파싱 실패 (%s): %w", path, err)
	}
	if err := inv.validate(path); err != nil {
		return nil, err
	}
	if len(inv.SSHOpts) == 0 {
		inv.SSHOpts = DefaultSSHOpts
	}
	return &inv, nil
}

func (inv *Inventory) validate(path string) error {
	if len(inv.Areas) == 0 {
		return fmt.Errorf("[인벤토리 오류] %s: 'areas' 배열이 비어 있습니다", path)
	}
	for i, area := range inv.Areas {
		switch {
		case area.Name == "":
			return fmt.Errorf("[인벤토리 오류] areas[%d] 에 'name' 이 없습니다", i)
		case len(area.Hosts) == 0:
			return fmt.Errorf("[인벤토리 오류] area %q 에 'hosts' 가 없습니다", area.Name)
		case len(area.Sources) == 0:
			return fmt.Errorf("[인벤토리 오류] area %q 에 'sources' 가 없습니다", area.Name)
		}
		seen := make(map[string]bool, len(area.Hosts))
		for _, host := range area.Hosts {
			if !hostPattern.MatchString(host) {
				return fmt.Errorf(
					"[인벤토리 오류] area %q 의 호스트 %q 는 쓸 수 없는 형태입니다\n"+
						"       (영숫자로 시작하고 영숫자 . _ - 만 허용 — ssh 가 옵션으로 해석하지 않게)",
					area.Name, host)
			}
			if seen[host] {
				return fmt.Errorf(
					"[인벤토리 오류] area %q 에 호스트 %q 가 두 번 있습니다 (같은 줄이 두 번 나온다)",
					area.Name, host)
			}
			seen[host] = true
		}

		for j, src := range area.Sources {
			if src.Name == "" || len(src.Paths) == 0 {
				return fmt.Errorf(
					"[인벤토리 오류] area %q 의 sources[%d] 에 name/paths 가 없습니다",
					area.Name, j)
			}
		}
	}
	return nil
}

// Find 는 이름으로 영역을 찾는다.
func (inv *Inventory) Find(name string) (*Area, bool) {
	for i := range inv.Areas {
		if inv.Areas[i].Name == name {
			return &inv.Areas[i], true
		}
	}
	return nil, false
}

// Names 는 인벤토리에 정의된 순서대로 영역 이름을 돌려준다.
// 출력 정렬과 요약의 구간 순서가 이 순서를 따른다.
func (inv *Inventory) Names() []string {
	names := make([]string, 0, len(inv.Areas))
	for _, a := range inv.Areas {
		names = append(names, a.Name)
	}
	return names
}
