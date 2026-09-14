// HTTP 진입점 (--serve). CLI 와 같은 수집을 POST /collect 로 실행한다.
//
// 검증(buildRequest)과 실행(execute)은 main.go 와 공유한다. 여기서 하는 일은
// JSON 본문을 CLI 플래그와 같은 형태로 옮기고, NDJSON 스트림을 응답 본문으로
// 흘리는 것뿐이다. 접속 대상이 인벤토리 파일에만 있다는 원칙도 그대로다 —
// 요청 본문으로 호스트를 넘기는 방법은 없다.
//
// 사용:
//
//	logstitch --serve :8080
//	curl -s localhost:8080/collect -d '{"app":"ai-stt","env":"prod","fields":{"rid":"abc123"}}'
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/jiye-kim-dev/logstitch/collector/apps"
)

// apiRequest 는 POST /collect 의 JSON 본문이다. 외부 계약이므로 snake_case.
// 의미와 기본값은 같은 이름의 CLI 플래그와 동일하다.
type apiRequest struct {
	App    string            `json:"app"`
	Env    string            `json:"env"`
	Fields map[string]string `json:"fields"`
	From   string            `json:"from"`
	To     string            `json:"to"`
	Areas  []string          `json:"areas"`
	After  int               `json:"after"`
	// Timeout 0 은 CLI 기본값(90초)을 쓴다. MaxLines 는 명시적 0(무제한)과
	// 미지정(기본 50000)을 구분해야 해서 포인터다.
	Timeout  int  `json:"timeout"`
	Workers  int  `json:"workers"`
	MaxLines *int `json:"max_lines"`
	DryRun   bool `json:"dry_run"`
}

func serveHTTP(addr, appsPath, inventoryBase string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /collect", func(w http.ResponseWriter, r *http.Request) {
		handleCollect(w, r, appsPath, inventoryBase)
	})

	fmt.Fprintf(os.Stderr, "listening on %s — POST /collect\n", addr)
	return http.ListenAndServe(addr, mux)
}

func handleCollect(w http.ResponseWriter, r *http.Request, appsPath, inventoryBase string) {
	dec := json.NewDecoder(r.Body)
	// 오타 필드(max_line 등)가 조용히 기본값으로 처리되는 것을 막는다.
	dec.DisallowUnknownFields()

	var body apiRequest
	if err := dec.Decode(&body); err != nil {
		http.Error(w, "잘못된 JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	req, err := buildAPIRequest(body, appsPath, inventoryBase)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")

	// execute 의 에러는 모두 첫 이벤트를 쓰기 전에 난다(인벤토리 없음, 타깃
	// 없음). 그래서 여기서 http.Error 로 상태코드를 바꿔도 안전하다.
	stats, err := execute(r.Context(), req, w)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !req.DryRun {
		fmt.Fprintf(os.Stderr, "[%s/%s] 수집 완료: %d줄, 성공 %d대, 실패 %d대\n",
			req.App, req.Env, stats.Lines, stats.HostsOK, stats.HostsFailed)
	}
}

// buildAPIRequest 는 JSON 본문을 CLI 플래그 형태로 옮겨 buildRequest 의
// 검증을 그대로 태운다. 검증 규칙이 두 벌이 되지 않게 하기 위해서다.
func buildAPIRequest(body apiRequest, appsPath, inventoryBase string) (request, error) {
	// 설정은 요청마다 새로 읽는다. 파일이 작고, 서버 재시작 없이 수정이 반영된다.
	appCfg, err := apps.Load(appsPath)
	if err != nil {
		return request{}, err
	}

	fields := make(stringList, 0, len(body.Fields))
	for key, value := range body.Fields {
		fields = append(fields, key+"="+value)
	}

	timeout := body.Timeout
	if timeout == 0 {
		timeout = 90
	}
	maxLines := 50000
	if body.MaxLines != nil {
		maxLines = *body.MaxLines
	}

	return buildRequest(appCfg, appsPath, inventoryBase,
		body.App, body.Env, "", body.From, body.To,
		fields, body.Areas, body.After, timeout, body.Workers, maxLines, body.DryRun)
}
