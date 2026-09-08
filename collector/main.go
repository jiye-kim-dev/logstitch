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
// 별도 패키지(inventory, remote, collect)에 있고 그 경계는 컴파일러가 강제한다.
// 2차에서 stdin JSON 진입점을 붙일 때도 이 파일만 건드리면 된다.
//
// 인벤토리는 환경(dev/stage/prod ...)별로 파일을 나눈다. -i 는 확장자 없는
// 기본 이름을, --env 는 환경을 받고, 둘을 합쳐 <기본이름>.<환경>.json 을 읽는다.
// 환경은 파일 이름에만 있으므로 같은 값을 두 번 적을 일이 없다.
//
// 사용:
//
//	logstitch --env prod --rid abc123 -i inventory.ai-stt | logstitch-parse
//	  → inventory.ai-stt.prod.json
//
//	logstitch --env dev --field content_id=555 --area scheduler -i inventory.ai-stt --dry-run
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
	// InventoryBase 는 확장자와 환경을 뺀 기본 이름이다.
	// 실제 경로는 inventory.Resolve 가 --env 와 합쳐서 만든다.
	InventoryBase string
	Env           string
	Field         string
	Value         string
	Areas         []string
	After         int
	TimeoutSec    int
	Workers       int
	MaxLines      int
	DryRun        bool
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
		inventoryBase = flag.String("i", "inventory",
			"인벤토리 기본 이름. --env 와 합쳐 <기본이름>.<환경>.json 을 읽는다 (.json 은 붙여도 됨)")
		env      = flag.String("env", "", "대상 환경 (필수). 예: prod, stage, dev")
		rid      = flag.String("rid", "", "--field rid=<값> 의 축약형")
		field    = flag.String("field", "", "검색 기준. 형식: key=value")
		areas    stringList
		after    = flag.Int("after", 0, "grep 컨텍스트 줄 수 (스택트레이스용)")
		timeout  = flag.Int("timeout", 90, "호스트당 타임아웃(초)")
		workers  = flag.Int("workers", 0, "동시 실행 수. 0 이면 자동")
		maxLines = flag.Int("max-lines", 50000, "호스트당 줄 수 상한. 0 이면 무제한")
		dryRun   = flag.Bool("dry-run", false, "접속 없이 원격 명령만 출력")
	)
	flag.Var(&areas, "area", "특정 영역만 조회 (반복 가능)")
	flag.StringVar(inventoryBase, "inventory", *inventoryBase, "-i 의 긴 이름")
	flag.Parse()

	req, err := buildRequest(*inventoryBase, *env, *rid, *field, areas,
		*after, *timeout, *workers, *maxLines, *dryRun)
	if err != nil {
		return err
	}

	path, err := inventory.Resolve(req.InventoryBase, req.Env)
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

	stats := collect.Run(ctx, targets, req.Field, req.Value, collect.Options{
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

func buildRequest(inventoryBase, env, rid, field string, areas stringList,
	after, timeout, workers, maxLines int, dryRun bool) (request, error) {

	if env == "" {
		available := inventory.Environments(inventoryBase)
		if len(available) > 0 {
			return request{}, fmt.Errorf(
				"--env 가 필요합니다 (쓸 수 있는 환경: %s)",
				strings.Join(available, ", "))
		}
		return request{}, fmt.Errorf("--env 가 필요합니다. 예: --env prod")
	}
	if rid != "" {
		field = "rid=" + rid
	}
	if field == "" {
		return request{}, fmt.Errorf("--rid 또는 --field key=value 중 하나는 필요합니다")
	}
	key, value, ok := strings.Cut(field, "=")
	if !ok || key == "" {
		return request{}, fmt.Errorf("--field 형식은 key=value 입니다: %q", field)
	}
	if value == "" {
		return request{}, fmt.Errorf("검색값이 비어 있습니다: %q", field)
	}
	if timeout <= 0 {
		return request{}, fmt.Errorf("--timeout 은 양수여야 합니다")
	}
	if after < 0 {
		return request{}, fmt.Errorf("--after 는 0 이상이어야 합니다")
	}

	return request{
		InventoryBase: inventoryBase,
		Env:           env,
		Field:         key,
		Value:         value,
		Areas:         areas,
		After:         after,
		TimeoutSec:    timeout,
		Workers:       workers,
		MaxLines:      maxLines,
		DryRun:        dryRun,
	}, nil
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

		fmt.Printf("\n===== %s / %v (%s=%s) — 예: ssh %s 'bash -s' =====\n",
			t.Area, names, req.Field, req.Value, t.Host)
		fmt.Print(remote.BuildScript(t.Sources, req.Value, req.After))
	}
}
