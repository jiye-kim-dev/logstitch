// Package collect 는 여러 호스트에 ssh 로 붙어 원격 스크립트를 돌리고,
// 나온 줄을 NDJSON 으로 흘린다.
//
// 접속은 시스템 ssh 바이너리를 exec 한다. golang.org/x/crypto/ssh 를 쓰지
// 않는 이유는 인벤토리의 hosts 가 ~/.ssh/config 의 별칭이기 때문이다.
// x/crypto/ssh 는 ssh_config 을 읽지 않으므로 ProxyJump, ssh-agent,
// known_hosts, ControlMaster 를 전부 직접 구현해야 한다. exec 하면 OS 가
// 그걸 다 처리하고, 이 코드는 IP 도 패스워드도 알지 못한다.
package collect

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/jiye-kim-dev/logstitch/collector/inventory"
	"github.com/jiye-kim-dev/logstitch/collector/remote"
)

// Target 은 "이 호스트에서 이 소스들을 긁는다" 한 건이다.
type Target struct {
	Area    string
	Host    string
	Sources []inventory.Source
}

// Criterion : and 조건으로 필터링 주고 싶을때
type Criterion struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

func values(criteria []Criterion) []string {
	out := make([]string, 0, len(criteria))
	for _, c := range criteria {
		out = append(out, c.Value)
	}
	return out
}

// 호스트 실행 결과 상태.
const (
	StatusOK          = "ok"
	StatusTimeout     = "timeout"
	StatusSSHError    = "ssh_error"
	StatusNoSSHBinary = "no_ssh_binary"
)

// MetaEvent 는 스트림 맨 앞에 한 번 나온다. 파서가 무엇을 찾는 스트림인지
// 알아야 매칭 종류를 판정할 수 있다.
type MetaEvent struct {
	Type        string      `json:"type"` // "meta"
	App         string      `json:"app"`
	Environment string      `json:"environment"`
	Fields      []Criterion `json:"fields"`
	StartedAt   string      `json:"startedAt"`
	Targets     int         `json:"targets"`
	Areas       []string    `json:"areas"`
}

// LineEvent 는 원격에서 grep 에 걸린 로그 한 줄이다.
// Line 은 불투명한 문자열로, 수집기는 그 내용을 해석하지 않는다.
type LineEvent struct {
	Type   string `json:"type"` // "line"
	Area   string `json:"area"`
	Host   string `json:"host"`
	Source string `json:"source"`
	File   string `json:"file"`
	Line   string `json:"line"`
}

// HostEvent 는 한 호스트의 실행이 끝날 때마다 나온다.
// 한 대가 죽어도 전체를 실패시키지 않는다 — 오히려 그 죽은 노드가
// 장애 원인일 때가 많으므로 결과에 남긴다.
type HostEvent struct {
	Type      string `json:"type"` // "host"
	Area      string `json:"area"`
	Host      string `json:"host"`
	Status    string `json:"status"`
	LineCount int    `json:"lineCount"`
	Truncated bool   `json:"truncated"`
	Error     string `json:"error,omitempty"`
	ElapsedMs int64  `json:"elapsedMs"`
}

type Options struct {
	App         string // 대상 애플리케이션. meta 이벤트로 파서에 넘긴다.
	Environment string // 대상 환경. meta 이벤트로 파서에 넘긴다.
	SSHOpts     []string
	Timeout     time.Duration
	Workers     int
	After       int
	MaxLines    int      // 호스트당 상한. 0 이면 무제한.
	Areas       []string // 인벤토리 정의 순서. meta 이벤트로 파서에 넘긴다.
}

// Stats 는 종료 코드 결정에 쓸 최소한의 집계다.
// 사람이 읽는 요약은 파서가 만든다.
type Stats struct {
	Lines       int
	HostsFailed int
	HostsOK     int
}

// Run 은 모든 타깃을 병렬로 실행하고 NDJSON 을 out 에 쓴다.
func Run(
	ctx context.Context,
	targets []Target,
	criteria []Criterion,
	opt Options,
	out io.Writer,
) Stats {
	buffered := bufio.NewWriterSize(out, 64*1024)
	defer buffered.Flush()

	enc := json.NewEncoder(buffered)
	// 로그 줄에 <, >, & 가 흔한데 기본 설정은 그걸 < 로 이스케이프한다.
	// 파이썬 json.dumps(ensure_ascii=False) 와 출력을 맞추기 위해 끈다.
	enc.SetEscapeHTML(false)

	events := make(chan any, 512)
	var stats Stats
	var emitDone sync.WaitGroup

	emitDone.Add(1)
	go func() {
		defer emitDone.Done()
		for ev := range events {
			switch e := ev.(type) {
			case LineEvent:
				stats.Lines++
			case HostEvent:
				if e.Status == StatusOK {
					stats.HostsOK++
				} else {
					stats.HostsFailed++
				}
			}
			if err := enc.Encode(ev); err != nil {
				// stdout 이 끊긴 경우(파이프 종료 등). 더 쓸 수 없으니 조용히 멈춘다.
				return
			}
		}
	}()

	events <- MetaEvent{
		Type:        "meta",
		App:         opt.App,
		Environment: opt.Environment,
		Fields:      criteria,
		StartedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		Targets:     len(targets),
		Areas:       opt.Areas,
	}

	workers := opt.Workers
	if workers <= 0 {
		workers = min(16, max(4, len(targets)))
	}

	searchValues := values(criteria)

	jobs := make(chan Target)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range jobs {
				runOne(ctx, t, searchValues, opt, events)
			}
		}()
	}
	for _, t := range targets {
		jobs <- t
	}
	close(jobs)
	wg.Wait()

	close(events)
	emitDone.Wait()
	return stats
}

func runOne(ctx context.Context, t Target, searchValues []string, opt Options, events chan<- any) {
	script := remote.BuildScript(t.Sources, searchValues, opt.After)

	cctx, cancel := context.WithTimeout(ctx, opt.Timeout)
	defer cancel()

	args := make([]string, 0, len(opt.SSHOpts)+2)
	args = append(args, opt.SSHOpts...)
	args = append(args, t.Host, "bash -s")

	cmd := exec.CommandContext(cctx, "ssh", args...)
	cmd.Stdin = strings.NewReader(script)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		emitHost(events, t, StatusSSHError, 0, false, err.Error(), 0)
		return
	}

	started := time.Now()
	if err := cmd.Start(); err != nil {
		status := StatusSSHError
		if errors.Is(err, exec.ErrNotFound) {
			status = StatusNoSSHBinary
		}
		emitHost(events, t, status, 0, false, err.Error(), time.Since(started).Milliseconds())
		return
	}

	// bufio.Scanner 를 쓰지 않는다. Scanner 는 기본 64KB 에서 줄이 잘리고
	// 에러를 내는데, 스택트레이스가 박힌 JSON 로그 한 줄은 그걸 넘길 수 있다.
	// Reader.ReadString 은 필요한 만큼 늘어난다.
	reader := bufio.NewReaderSize(stdout, 64*1024)
	emitted, truncated := 0, false

	for {
		line, readErr := reader.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		// 빈 줄은 버린다 (파이썬 normalize 와 같은 규약). 원격 awk 가 항상
		// 소스와 파일을 앞에 붙이므로 정상 결과에는 빈 줄이 나오지 않는다.
		if strings.TrimSpace(line) != "" {
			if opt.MaxLines > 0 && emitted >= opt.MaxLines {
				// 더 읽어도 버릴 뿐이라 원격 파이프를 끊는다.
				truncated = true
				cancel()
			} else {
				source, file, raw := splitThree(line)
				events <- LineEvent{
					Type:   "line",
					Area:   t.Area,
					Host:   t.Host,
					Source: source,
					File:   file,
					Line:   raw,
				}
				emitted++
			}
		}
		if readErr != nil {
			break
		}
	}

	waitErr := cmd.Wait()
	elapsed := time.Since(started).Milliseconds()
	status, message := classify(cctx, waitErr, stderr.String(), truncated)
	emitHost(events, t, status, emitted, truncated, message, elapsed)
}

// classify 는 ssh 종료 상태를 사람이 읽을 상태값으로 바꾼다.
//
// 파이썬 run_ssh 와 같은 판정을 한다. 종료코드가 0 이어도 stderr 에 뭐가
// 있으면 그 내용을 남긴다 — 부분적으로만 읽힌 경우를 놓치지 않기 위해서다.
func classify(ctx context.Context, waitErr error, stderr string, truncated bool) (string, string) {
	stderr = strings.TrimSpace(stderr)

	if errors.Is(ctx.Err(), context.DeadlineExceeded) && !truncated {
		return StatusTimeout, "타임아웃"
	}
	if waitErr != nil {
		// max-lines 상한으로 우리가 직접 끊은 경우는 실패가 아니다.
		if truncated {
			return StatusOK, stderr
		}
		if stderr != "" {
			return StatusSSHError, stderr
		}
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			return StatusSSHError, fmt.Sprintf("ssh 종료코드 %d", exitErr.ExitCode())
		}
		return StatusSSHError, waitErr.Error()
	}
	return StatusOK, stderr
}

func emitHost(
	events chan<- any,
	t Target,
	status string,
	lines int,
	truncated bool,
	msg string,
	elapsedMs int64,
) {
	events <- HostEvent{
		Type:      "host",
		Area:      t.Area,
		Host:      t.Host,
		Status:    status,
		LineCount: lines,
		Truncated: truncated,
		Error:     msg,
		ElapsedMs: elapsedMs,
	}
}

// splitThree 는 원격 awk 가 붙인 "소스\t파일\t줄" 을 되돌린다.
// 로그 줄 자체에 탭이 있어도 되도록 앞 두 개만 자른다.
// 3칼럼이 아니면 파이썬과 같이 "?" 로 두고 줄 전체를 살린다.
func splitThree(line string) (source, file, raw string) {
	parts := strings.SplitN(line, "\t", 3)
	if len(parts) < 3 {
		return "?", "?", line
	}
	return parts[0], parts[1], parts[2]
}
