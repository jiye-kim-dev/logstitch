package collect

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Removed 는 가려진 값 자리에 들어가는 표식이다. 따옴표·역슬래시가 없어서
// JSON 줄에 정규식으로 끼워 넣어도 문법이 깨지지 않는다.
const Removed = "**removed**"

// embedMaxDepth 는 문자열에 든 JSON 을 몇 겹까지 풀지다. 파서의
// parseEmbeddedJson 과 같은 대상(문자열로 박힌 JSON)을 같은 깊이까지 본다 —
// 파서가 풀어서 보여주는데 여기서 못 풀면 그 안의 값이 그대로 새어 나간다.
const embedMaxDepth = 5

// Redactor 는 원격에서 받은 줄이 파서로 나가기 전에 민감 값을 가린다.
//
// 수집기 stdout 이 신뢰 경계다. 파서는 해석 전에 받은 줄을 raw.ndjson 으로
// 그대로 저장하므로, 파서 쪽에서 가리면 원본 파일에 값이 남는다.
//
// nil 이면 아무것도 하지 않는다 (redact 설정이 없는 앱).
type Redactor struct {
	fields   map[string]bool
	patterns []*regexp.Regexp
}

// NewRedactor 는 apps.json 의 redact 설정으로 Redactor 를 만든다.
// 둘 다 비면 nil 을 돌려준다 — 줄마다 아무 일도 하지 않게.
func NewRedactor(fields, patterns []string) (*Redactor, error) {
	if len(fields) == 0 && len(patterns) == 0 {
		return nil, nil
	}
	r := &Redactor{fields: make(map[string]bool, len(fields))}
	for _, f := range fields {
		r.fields[f] = true
	}
	for _, p := range patterns {
		re, err := regexp.Compile(p)
		if err != nil {
			return nil, fmt.Errorf("redact 패턴 %q 컴파일 실패: %w", p, err)
		}
		r.patterns = append(r.patterns, re)
	}
	return r, nil
}

// Apply 는 한 줄을 가린다.
//
//   - JSON 객체 줄: fields 에 든 키의 값을 깊이와 무관하게 Removed 로 바꾸고,
//     patterns 는 문자열·숫자 값에만 적용한다. 원문 텍스트에 정규식을 걸면
//     숫자 값에 따옴표 없는 Removed 가 들어가 JSON 이 깨진다.
//     키는 지우지 않는다 — 필드가 있었다는 사실과 파서 별칭 해석을 지킨다.
//   - 그 밖의 줄(plain): patterns 를 줄 전체에 적용한다.
func (r *Redactor) Apply(line string) string {
	if r == nil {
		return line
	}
	if strings.HasPrefix(strings.TrimSpace(line), "{") {
		if out, isJSON := r.redactJSON(line); isJSON {
			return out
		}
	}
	return r.replacePatterns(line)
}

func (r *Redactor) replacePatterns(s string) string {
	for _, re := range r.patterns {
		s = re.ReplaceAllString(s, Removed)
	}
	return s
}

// redactJSON 은 JSON 객체 줄이면 가린 결과와 true 를 돌려준다.
// 가린 게 없으면 원본 바이트 그대로다 — 재직렬화는 키 순서를 바꾸므로
// 필요할 때만 한다.
func (r *Redactor) redactJSON(line string) (string, bool) {
	// 대부분의 줄에는 가릴 게 없다. 파싱 전에 문자열 검사로 거른다.
	// 키 이름만 보므로 문자열에 박힌 JSON(\"password\")도 통과시킨다.
	// 원문에 아무것도 안 걸리면 값에도 안 걸린다 — JSON 으로 판정할 필요도 없다.
	// 단 \uXXXX 이스케이프가 있으면 디코드해야 보이는 값이 있으므로 거르지 않는다.
	if !r.mentionsAny(line) && !strings.Contains(line, `\u`) {
		return line, true
	}
	doc, ok := decodeJSON(line)
	if !ok {
		return "", false
	}
	if _, isObject := doc.(map[string]any); !isObject {
		return "", false
	}
	doc, changed := r.walk(doc, 0)
	if !changed {
		return line, true
	}
	out, err := encodeJSON(doc)
	if err != nil {
		// 방금 디코드한 값이라 실패할 일이 없지만, 실패하면 원문을 흘리지 않는다.
		return Removed, true
	}
	return out, true
}

func (r *Redactor) mentionsAny(line string) bool {
	for f := range r.fields {
		if strings.Contains(line, f) {
			return true
		}
	}
	for _, re := range r.patterns {
		if re.MatchString(line) {
			return true
		}
	}
	return false
}

// walk 는 가린 노드와 바뀌었는지를 돌려준다.
func (r *Redactor) walk(node any, depth int) (any, bool) {
	changed := false
	switch v := node.(type) {
	case map[string]any:
		for key, child := range v {
			if r.fields[key] {
				v[key] = Removed
				changed = true
				continue
			}
			if next, c := r.walk(child, depth); c {
				v[key] = next
				changed = true
			}
		}
	case []any:
		for i, child := range v {
			if next, c := r.walk(child, depth); c {
				v[i] = next
				changed = true
			}
		}
	case string:
		if next, c := r.walkEmbedded(v, depth); c {
			return next, true
		}
		if next := r.replacePatterns(v); next != v {
			return next, true
		}
	case json.Number:
		// 패턴에 걸린 숫자는 문자열로 바꿔 가린다 (숫자 자리에 Removed 를 못 넣는다).
		if next := r.replacePatterns(v.String()); next != v.String() {
			return next, true
		}
	}
	return node, changed
}

// walkEmbedded 는 문자열로 박힌 JSON(body 등)을 풀어 가린 뒤 다시 문자열로 넣는다.
// 판정 조건은 파서의 parseEmbeddedJson 과 같다.
func (r *Redactor) walkEmbedded(s string, depth int) (any, bool) {
	text := strings.TrimSpace(s)
	if depth >= embedMaxDepth || len(text) < 2 ||
		!strings.ContainsAny(text[:1], "{[") || !strings.ContainsAny(text[len(text)-1:], "}]") {
		return s, false
	}
	inner, ok := decodeJSON(text)
	if !ok {
		return s, false
	}
	inner, changed := r.walk(inner, depth+1)
	if !changed {
		return s, false
	}
	out, err := encodeJSON(inner)
	if err != nil {
		return s, false
	}
	return out, true
}

// decodeJSON 은 값 하나로만 이뤄진 JSON 을 읽는다. 뒤에 다른 게 붙어 있으면
// 파서의 JSON.parse 도 실패해 plain 으로 다루므로 여기서도 JSON 으로 보지 않는다.
// UseNumber: 큰 정수 ID 가 float64 를 거치며 바뀌는 걸 막는다.
func decodeJSON(s string) (any, bool) {
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return nil, false
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, false
	}
	return doc, true
}

// encodeJSON 은 수집기 출력과 같은 규약(SetEscapeHTML(false))으로 직렬화한다.
func encodeJSON(doc any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}
