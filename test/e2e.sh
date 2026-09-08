#!/usr/bin/env bash
# 실제 노드 없이 전체 파이프라인을 검증한다.
#
#   ./test/e2e.sh              수집기 빌드 → 픽스처 → 수집 → 파싱 → 단위 테스트
#   PYTHON_REF=../python-practice/ssh-logtrace ./test/e2e.sh
#                              위에 더해 기존 파이썬 구현과 출력을 대조한다
#
# 가짜 ssh(test/fakebin/ssh)가 로컬 bash 로 원격 스크립트를 실행하므로
# 코드 경로는 실제와 동일하다.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BIN="$ROOT/.bin/logstitch"
INV_BASE="$ROOT/test/inventory"          # Go 수집기는 기본 이름 + --env
INV="$ROOT/test/inventory.test.json"     # 파이썬 원본은 전체 경로
RID="rid-7f3a91"

pass=0
fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── 1. 수집기 빌드 ──────────────────────────────────────────────────────────
step "1. Go 수집기"
mkdir -p "$ROOT/.bin"
if go build -C collector -o "$BIN" .; then ok "빌드"; else bad "빌드"; exit 1; fi
if go vet -C collector ./... 2>/dev/null; then ok "go vet"; else bad "go vet"; fi
if go test -C collector ./... >/dev/null 2>&1; then ok "go test"; else bad "go test"; fi
if [ -z "$(gofmt -l collector)" ]; then ok "gofmt"; else bad "gofmt: $(gofmt -l collector)"; fi

# ── 2. 파서 ─────────────────────────────────────────────────────────────────
step "2. TS 파서"
if [ ! -d parser/node_modules ]; then
  printf '  node_modules 가 없습니다 — npm install 을 먼저 실행하세요\n'
else
  if (cd parser && npx tsc --noEmit); then ok "타입체크"; else bad "타입체크"; fi
fi
if (cd parser && node --test "test/*.test.ts" >/dev/null 2>&1); then
  ok "단위 테스트"
else
  bad "단위 테스트 (자세히 보려면: cd parser && node --test 'test/*.test.ts')"
fi

# ── 3. 픽스처 + 파이프라인 ──────────────────────────────────────────────────
step "3. 파이프라인 (가짜 ssh)"
./test/make_fixtures.sh >/dev/null

export PATH="$ROOT/test/fakebin:$PATH"
export LOGSTITCH_FIXTURES="$ROOT/test/fixtures"

RAW="$(mktemp)"
OUT="$(mktemp)"
trap 'rm -f "$RAW" "$OUT" "$RAW.py" "$RAW.ts"' EXIT

"$BIN" --env test -i "$INV_BASE" --rid "$RID" --max-lines 0 > "$RAW" 2>/dev/null
lines=$(grep -c '"type":"line"' "$RAW")
[ "$lines" -eq 15 ] && ok "수집 15줄" || bad "수집 줄 수가 $lines (기대 15)"

grep -q '"status":"ssh_error"' "$RAW" \
  && ok "접속 실패 호스트를 결과에 남김" \
  || bad "dead-01 실패가 기록되지 않음"

grep -q '"environment":"test"' "$RAW" \
  && ok "환경이 meta 이벤트에 실림" \
  || bad "meta 에 environment 가 없음"

# 환경 인자 — 없거나 해당 파일이 없으면 거부되어야 한다
"$BIN" -i "$INV_BASE" --rid "$RID" >/dev/null 2>&1 \
  && bad "--env 없이 실행됐다" \
  || ok "--env 없으면 거부"

# 출력을 먼저 받아둔다. 파이프로 바로 넘기면 set -o pipefail 이 logstitch 의
# 종료코드 2(의도된 실패)를 파이프라인 전체의 실패로 잡아서, grep 이 찾았는지
# 여부와 무관하게 판정이 뒤집힌다.
env_err=$("$BIN" --env prod -i "$INV_BASE" --rid "$RID" 2>&1 >/dev/null || true)
case "$env_err" in
  *"쓸 수 있는 환경: test"*)
    ok "없는 환경이면 쓸 수 있는 환경을 알려줌" ;;
  *)
    bad "없는 환경 에러가 환경 목록을 안 알려줌: $env_err" ;;
esac

node parser/src/cli.ts --no-color < "$RAW" > "$OUT" 2>/dev/null
grep -q '⟲ 같은 내용 4회 반복' "$OUT" \
  && ok "반복 폴링 줄 접기" \
  || bad "반복 접기가 동작하지 않음 (canonical stringify 확인)"

grep -q 'body.info.storage_key' "$OUT" \
  && ok "임베디드 JSON 안의 값 탐지" \
  || bad "body 안의 값을 못 찾음"

grep -q 'form_data.source_file_name\[0\]' "$OUT" \
  && ok "중첩 배열 안의 부분 일치" \
  || bad "form_data 안의 값을 못 찾음"

grep -q "parent_rid" "$OUT" \
  && ok "다른 필드 매칭 경고" \
  || bad "parent_rid 매칭을 표시하지 않음"

grep -q 'rotated file hit' "$OUT" \
  && ok "로테이션된 .gz 파일" \
  || bad ".gz 파일을 읽지 못함"

grep -q '^~' "$OUT" \
  && ok "시각 없는 연속 줄이 직전 시각을 물려받음" \
  || bad "시각 물려받기가 동작하지 않음"

# ── 4. 파이썬 구현과 대조 (선택) ────────────────────────────────────────────
if [ -n "${PYTHON_REF:-}" ]; then
  step "4. 기존 파이썬 구현과 출력 대조"
  if [ ! -f "$PYTHON_REF/logtrace.py" ]; then
    bad "PYTHON_REF 에 logtrace.py 가 없습니다: $PYTHON_REF"
  else
    for flags in "" "--strict" "--no-collapse" "--no-embed"; do
      (cd "$PYTHON_REF" && python3 logtrace.py -i "$INV" --rid "$RID" --json $flags) \
        > "$RAW.py" 2>/dev/null
      "$BIN" --env test -i "$INV_BASE" --rid "$RID" --max-lines 0 2>/dev/null \
        | node "$ROOT/parser/src/cli.ts" --json $flags > "$RAW.ts" 2>/dev/null

      if python3 test/compare_with_python.py "$RAW.py" "$RAW.ts" >/dev/null; then
        ok "일치 ${flags:-(기본)}"
      else
        bad "불일치 ${flags:-(기본)} — python3 test/compare_with_python.py 로 확인"
      fi
    done
  fi
fi

step "결과"
printf '  통과 %d / 실패 %d\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
