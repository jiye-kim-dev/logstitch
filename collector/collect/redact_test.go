package collect

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRedactorApply(t *testing.T) {
	r, err := NewRedactor(
		[]string{"password", "token"},
		[]string{`0?1[0-9]-?\d{3,4}-?\d{4}`},
	)
	if err != nil {
		t.Fatalf("생성 실패: %v", err)
	}

	cases := []struct {
		name, in, want string
	}{
		{
			"중첩된 키도 가린다",
			`{"msg":"login","user":{"id":"u1","password":"p@ss"},"list":[{"token":"t1"}]}`,
			`{"list":[{"token":"**removed**"}],"msg":"login","user":{"id":"u1","password":"**removed**"}}`,
		},
		{
			"문자열로 박힌 JSON 안까지 가린다",
			`{"body":"{\"password\":\"p\",\"n\":1}"}`,
			`{"body":"{\"n\":1,\"password\":\"**removed**\"}"}`,
		},
		{
			"큰 정수가 float 로 바뀌지 않는다",
			`{"id":77777777777777777777,"token":"t"}`,
			`{"id":77777777777777777777,"token":"**removed**"}`,
		},
		{
			"정규식에 걸린 숫자 값은 문자열로 가려 JSON 을 지킨다",
			`{"tel":1012345678,"msg":"x"}`,
			`{"msg":"x","tel":"**removed**"}`,
		},
		{
			"유니코드 이스케이프로 감춰진 값도 가린다",
			`{"msg":"tel 010\u002d1234\u002d5678","z":1}`,
			`{"msg":"tel **removed**","z":1}`,
		},
		{
			"가릴 게 없으면 원본 바이트 그대로 (키 순서 유지)",
			`{"z":1, "a":"<b>"}`,
			`{"z":1, "a":"<b>"}`,
		},
		{
			"키 이름이 값에만 있으면 바꾸지 않는다",
			`{"z":1,"msg":"password reset"}`,
			`{"z":1,"msg":"password reset"}`,
		},
		{
			"plain 줄은 정규식으로 가린다",
			`2026-10-15 10:00:00 INFO call from 010-1234-5678 ok`,
			`2026-10-15 10:00:00 INFO call from **removed** ok`,
		},
		{
			"JSON 줄에도 정규식을 적용한다",
			`{"msg":"tel 01012345678"}`,
			`{"msg":"tel **removed**"}`,
		},
		{
			"JSON 뒤에 꼬리가 붙은 줄은 plain 으로 다룬다",
			`{"password":"p"} trailing`,
			`{"password":"p"} trailing`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := r.Apply(c.in)
			if got != c.want {
				t.Errorf("\n입력 %s\n결과 %s\n기대 %s", c.in, got, c.want)
			}
			if strings.HasPrefix(c.want, "{") && !strings.Contains(c.want, "trailing") && !json.Valid([]byte(got)) {
				t.Errorf("JSON 이 깨졌다: %s", got)
			}
		})
	}
}

func TestNilRedactorPassesThrough(t *testing.T) {
	r, err := NewRedactor(nil, nil)
	if err != nil || r != nil {
		t.Fatalf("설정이 없으면 nil 이어야 한다: %v %v", r, err)
	}
	if got := r.Apply(`{"password":"p"}`); got != `{"password":"p"}` {
		t.Errorf("nil Redactor 가 줄을 바꿨다: %s", got)
	}
}

func TestNewRedactorRejectsBadPattern(t *testing.T) {
	if _, err := NewRedactor(nil, []string{`(?<=x)y`}); err == nil {
		t.Error("RE2 가 지원하지 않는 lookbehind 가 통과했다")
	}
}
