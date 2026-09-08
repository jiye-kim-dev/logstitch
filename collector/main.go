// logstitch — 여러 노드에 흩어진 로그를 특정 필드값으로 긁어와 NDJSON 으로 흘린다.
//
// 이 프로그램은 로그의 내용을 해석하지 않는다. 타임스탬프 파싱, 필드 별칭
// 해석, 매칭 종류 판정, 반복 접기, 정렬은 모두 파서(parser/, TypeScript)의
// 일이다. 여기서 하는 일은 딱 넷이다.
//
//  1. 인벤토리를 읽어 (영역 × 호스트 × 소스) 타깃으로 펼친다  → inventory/
//  2. 원격 bash 스크립트를 만들어 ssh 로 병렬 실행한다         → remote/, collect/
//  3. 원격 awk 가 붙인 "소스\t파일\t줄" 을 NDJSON 으로 분해한다 → collect/
//  4. 호스트별 성공/실패 상태를 남긴다                         → collect/
//
// 이 파일에는 CLI 관심사(인자 파싱, 검증, 종료코드)만 둔다. 전송 계층은
// 별도 패키지(apps, inventory, remote, collect)에 있고 그 경계는 컴파일러가
// 강제한다. 2차에서 stdin JSON 진입점을 붙일 때도 이 파일만 건드리면 된다.
//
// 설정은 두 갈래다.
//
//	apps.json                        앱별 필수 필드 (환경 무관, 커밋함)
//	<기본이름>.<앱>.<환경>.json        호스트와 로그 경로 (환경별, 커밋 안 함)
//
// 앱과 환경은 파일 이름에만 있다. --app 과 --env 로 파일을 고른다.
//
// 사용:
//
//	logstitch --app ai-stt --env prod --rid abc123 | logstitch-parse
//	  → inventory.ai-stt.prod.json
//
//	logstitch --app forwarder --env prod \
//	  --field stream_key=abc --field session_id=s1 --field node_id=n7
//
// 접속 대상은 인벤토리에 적힌 호스트뿐이다. 명령줄로 호스트를 넘기는 방법은
// 없다 — 어디에 붙는지가 파일 하나에만 적혀 있어야 검토가 가능하다.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jiye-kim-dev/logstitch/collector/apps"
	"github.com/jiye-kim-dev/logstitch/collector/collect"
	"github.com/jiye-kim-dev/logstitch/collector/inventory"
	"github.com/jiye-kim-dev/logstitch/collector/remote"
)

// request 는 이 실행이 무엇을 해야 하는지를 담는다.
//
// 플래그를 곧장 쓰지 않고 한 번 구조체로 모으는 이유는, 2차에서 웹 백엔드가
// 이 바이너리를 spawn 하고 stdin 으로 JSON 요청을 넘기게 될 때 진입점만
// 하나 더 붙이면 되게 하기 위해서다.
type request struct {
	AppsPath string
	// InventoryBase 는 확장자·앱·환경을 뺀 기본 이름이다.
	// 실제 경로는 inventory.Resolve 가 --app/--env 와 합쳐서 만든다.
	InventoryBase string
	App           string
	Env           string
	// Criteria 는 검색 조건이다. 앱의 required 순서가 앞에 오고,
	// 추가로 준 필드가 뒤에 붙는다.
	Criteria   []collect.Criterion
	Areas      []string
	After      int
	TimeoutSec int
	Workers    int
	MaxLines   int
	DryRun     bool
}

type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "[오류]", err)
		os.Exit(2)
	}
}

func run() error {
	var (
		appsPath      = flag.String("apps", apps.DefaultPath, "앱 설정 JSON 경로")
		inventoryBase = flag.String("i", "inventory",
			"인벤토리 기본 이름. --app/--env 와 합쳐 <기본이름>.<앱>.<환경>.json 을 읽는다")
		app      = flag.String("app", "", "대상 애플리케이션 (필수). 예: ai-stt")
		env      = flag.String("env", "", "대상 환경 (필수). 예: prod, stage, dev")
		rid      = flag.String("rid", "", "--field rid=<값> 의 축약형")
		fields   stringList
		areas    stringList
		after    = flag.Int("after", 0, "grep 컨텍스트 줄 수 (스택트레이스용). 필드가 하나일 때만")
		timeout  = flag.Int("timeout", 90, "호스트당 타임아웃(초)")
		workers  = flag.Int("workers", 0, "동시 실행 수. 0 이면 자동")
		maxLines = flag.Int("max-lines", 50000, "호스트당 줄 수 상한. 0 이면 무제한")
		dryRun   = flag.Bool("dry-run", false, "접속 없이 원격 명령만 출력")
	)
	flag.Var(&fields, "field", "검색 조건 (반복 가능). 형식: key=value")
	flag.Var(&areas, "area", "특정 영역만 조회 (반복 가능)")
	flag.StringVar(inventoryBase, "inventory", *inventoryBase, "-i 의 긴 이름")
	flag.Parse()

	// 앱 설정을 먼저 읽는다. 뭘 물어봐야 하는지가 여기서 나오므로,
	// --app 이 없을 때 쓸 수 있는 앱 목록을 에러에 실을 수 있다.
	appCfg, err := apps.Load(*appsPath)
	if err != nil {
		return err
	}

	req, err := buildRequest(appCfg, *appsPath, *inventoryBase, *app, *env, *rid, fields,
		areas, *after, *timeout, *workers, *maxLines, *dryRun)
	if err != nil {
		return err
	}

	path, err := inventory.Resolve(req.InventoryBase, req.App, req.Env)
	if err != nil {
		return err
	}

	inv, err := inventory.Load(path)
	if err != nil {
		return err
	}

	targets, areaOrder, err := buildTargets(inv, req)
	if err != nil {
		return err
	}
	if len(targets) == 0 {
		return fmt.Errorf("조회할 타깃이 없습니다")
	}

	if req.DryRun {
		printDryRun(targets, req)
		return nil
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	stats := collect.Run(ctx, targets, req.Criteria, collect.Options{
		App:         req.App,
		Environment: req.Env,
		SSHOpts:     inv.SSHOpts,
		Timeout:     time.Duration(req.TimeoutSec) * time.Second,
		Workers:     req.Workers,
		After:       req.After,
		MaxLines:    req.MaxLines,
		Areas:       areaOrder,
	}, os.Stdout)

	fmt.Fprintf(os.Stderr, "수집 완료: %d줄, 성공 %d대, 실패 %d대\n",
		stats.Lines, stats.HostsOK, stats.HostsFailed)

	// 결과가 없으면 1. 파이썬 구현과 같은 규약이다.
	if stats.Lines == 0 {
		os.Exit(1)
	}
	return nil
}

func buildRequest(
	appCfg *apps.Config,
	appsPath, inventoryBase, app, env, rid string,
	fields, areas stringList,
	after, timeout, workers, maxLines int,
	dryRun bool,
) (request, error) {

	if app == "" {
		return request{}, fmt.Errorf(
			"--app 이 필요합니다 (%s 에 정의된 앱: %s)",
			appsPath, strings.Join(appCfg.Names(), ", "))
	}
	appDef, ok := appCfg.Find(app)
	if !ok {
		return request{}, fmt.Errorf(
			"%s 에 앱 %q 가 없습니다 (정의된 앱: %s)",
			appsPath, app, strings.Join(appCfg.Names(), ", "))
	}

	if env == "" {
		available := inventory.Environments(inventoryBase, app)
		if len(available) > 0 {
			return request{}, fmt.Errorf(
				"--env 가 필요합니다 (%s 앱에 쓸 수 있는 환경: %s)",
				app, strings.Join(available, ", "))
		}
		return request{}, fmt.Errorf("--env 가 필요합니다. 예: --env prod")
	}

	// --rid 는 --field rid=<값> 의 축약형이다.
	if rid != "" {
		fields = append(fields, "rid="+rid)
	}

	given, err := parseFields(fields)
	if err != nil {
		return request{}, err
	}

	criteria, err := orderCriteria(app, appDef, given)
	if err != nil {
		return request{}, err
	}

	if after < 0 {
		return request{}, fmt.Errorf("--after 는 0 이상이어야 합니다")
	}
	if after > 0 && len(criteria) > 1 {
		// 이어붙인 grep 에서는 앞 grep 이 붙인 컨텍스트 줄이 뒤 grep 에
		// 걸리지 않아 그대로 사라진다. 조용히 무효가 되는 대신 거부한다.
		return request{}, fmt.Errorf(
			"--after 는 검색 조건이 하나일 때만 쓸 수 있습니다 (지금 %d개)\n"+
				"       조건을 이어붙여 교집합을 내는 구조라 컨텍스트 줄이 걸러집니다",
			len(criteria))
	}
	if timeout <= 0 {
		return request{}, fmt.Errorf("--timeout 은 양수여야 합니다")
	}

	return request{
		AppsPath:      appsPath,
		InventoryBase: inventoryBase,
		App:           app,
		Env:           env,
		Criteria:      criteria,
		Areas:         areas,
		After:         after,
		TimeoutSec:    timeout,
		Workers:       workers,
		MaxLines:      maxLines,
		DryRun:        dryRun,
	}, nil
}

// parseFields 는 key=value 목록을 파싱한다. 같은 키를 두 번 주면 거부한다.
func parseFields(fields stringList) (map[string]string, error) {
	given := make(map[string]string, len(fields))
	for _, spec := range fields {
		key, value, ok := strings.Cut(spec, "=")
		if !ok || key == "" {
			return nil, fmt.Errorf("--field 형식은 key=value 입니다: %q", spec)
		}
		if value == "" {
			return nil, fmt.Errorf("검색값이 비어 있습니다: %q", spec)
		}
		if _, dup := given[key]; dup {
			return nil, fmt.Errorf("--field %s 가 두 번 주어졌습니다", key)
		}
		given[key] = value
	}
	return given, nil
}

// orderCriteria 는 앱의 required 를 모두 받았는지 확인하고 순서를 정한다.
//
// required 순서를 앞에 두는 이유는 원격에서 grep 을 그 순서로 이어붙이기
// 때문이다 — 선택적인 필드를 앞에 적어두면 뒤쪽 grep 이 훑을 양이 줄어든다.
// required 밖의 필드는 추가 교집합 조건으로 뒤에 붙는다 (임시 조회용).
func orderCriteria(
	app string,
	def apps.App,
	given map[string]string,
) ([]collect.Criterion, error) {

	var missing []string
	criteria := make([]collect.Criterion, 0, len(given))

	for _, field := range def.Required {
		value, ok := given[field]
		if !ok {
			missing = append(missing, field)
			continue
		}
		criteria = append(criteria, collect.Criterion{Field: field, Value: value})
	}

	if len(missing) > 0 {
		return nil, fmt.Errorf(
			"앱 %q 의 필수 필드가 빠졌습니다: %s\n"+
				"       필요한 필드 전체: %s\n"+
				"       예: %s",
			app, strings.Join(missing, ", "),
			strings.Join(def.Required, ", "),
			exampleUsage(app, def.Required))
	}

	// required 에 없는 필드는 선언 순서를 알 수 없으므로 준 순서대로 뒤에 붙인다.
	required := make(map[string]bool, len(def.Required))
	for _, field := range def.Required {
		required[field] = true
	}
	extra := make([]string, 0, len(given))
	for field := range given {
		if !required[field] {
			extra = append(extra, field)
		}
	}
	sortStrings(extra)
	for _, field := range extra {
		criteria = append(criteria, collect.Criterion{Field: field, Value: given[field]})
	}

	return criteria, nil
}

func exampleUsage(app string, required []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "logstitch --app %s --env prod", app)
	for _, field := range required {
		fmt.Fprintf(&b, " --field %s=<값>", field)
	}
	return b.String()
}

// sortStrings 는 sort 패키지를 끌어오지 않기 위한 작은 삽입 정렬이다.
// 추가 필드는 많아도 몇 개다.
func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// buildTargets 는 인벤토리를 (영역 × 호스트) 로 펼친다.
//
// 접속 대상은 여기서만 정해진다. 명령줄로 호스트를 추가하는 경로는 없고,
// --area 는 인벤토리에 있는 것을 줄이기만 한다.
//
// 두 번째 반환값은 인벤토리에 정의된 순서대로 정리한 영역 이름이다.
// 출력 정렬과 요약의 구간 순서가 이 순서를 따른다.
func buildTargets(inv *inventory.Inventory, req request) ([]collect.Target, []string, error) {
	selected := inv.Areas
	if len(req.Areas) > 0 {
		wanted := make(map[string]bool, len(req.Areas))
		for _, name := range req.Areas {
			wanted[name] = true
		}
		selected = nil
		for _, area := range inv.Areas {
			if wanted[area.Name] {
				selected = append(selected, area)
			}
		}
		if len(selected) == 0 {
			return nil, nil, fmt.Errorf("해당 영역이 인벤토리에 없습니다: %v (있는 영역: %v)",
				req.Areas, inv.Names())
		}
	}

	var targets []collect.Target
	order := make([]string, 0, len(selected))

	for _, area := range selected {
		order = append(order, area.Name)
		for _, host := range area.Hosts {
			targets = append(targets, collect.Target{
				Area:    area.Name,
				Host:    host,
				Sources: area.Sources,
			})
		}
	}

	return targets, order, nil
}

// printDryRun 은 접속 없이 원격에 넘길 스크립트를 보여준다.
// 같은 (영역, 소스) 조합은 호스트마다 스크립트가 동일하므로 한 번만 찍는다.
func printDryRun(targets []collect.Target, req request) {
	criteria := make([]string, 0, len(req.Criteria))
	searchValues := make([]string, 0, len(req.Criteria))
	for _, c := range req.Criteria {
		criteria = append(criteria, c.Field+"="+c.Value)
		searchValues = append(searchValues, c.Value)
	}

	shown := make(map[string]bool)
	for _, t := range targets {
		names := make([]string, 0, len(t.Sources))
		for _, s := range t.Sources {
			names = append(names, s.Name)
		}
		key := t.Area + "\x00" + strings.Join(names, ",")
		if shown[key] {
			continue
		}
		shown[key] = true

		fmt.Printf("\n===== %s/%s %s / %v (%s) — 예: ssh %s 'bash -s' =====\n",
			req.App, req.Env, t.Area, names, strings.Join(criteria, " "), t.Host)
		fmt.Print(remote.BuildScript(t.Sources, searchValues, req.After))
	}
}
