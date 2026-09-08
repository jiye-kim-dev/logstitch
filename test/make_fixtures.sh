#!/usr/bin/env bash
# 실제 노드 없이 파이프라인을 검증할 픽스처를 만든다.
#
#   ./test/make_fixtures.sh
#
# 픽스처에 일부러 넣어둔 까다로운 것들:
#
#   - 로테이션된 .gz 파일
#   - 서로 다른 타임스탬프 키 3종 (ISO Z 나노초 / 공백+오프셋 / epoch ms)
#   - JSON 이 아닌 panic 줄, 그리고 시각이 없어 직전 줄에서 물려받는 연속 줄
#   - 다른 최상위 필드(parent_rid)에 같은 값이 든 줄 → other 판정
#   - 중첩 배열 안에 값이 그대로 든 줄 → nested 판정
#   - 더 긴 값 안에 값이 든 줄 ("<rid>.mp3") → partial 판정
#   - body 에 JSON 문자열이 통째로 박힌 줄 → 풀어야 안쪽 값이 보인다
#   - 내용이 똑같이 반복되는 폴링 줄, 그리고 그 뒤의 상태 전이 → 접기 판정
#   - 접속 실패 호스트 (dead-01)
#
# 타임스탬프는 모두 마이크로초 단위까지 서로 다르게 두었다. 파이썬 구현은
# 마이크로초까지만 다루므로, 나노초에서만 갈리는 값을 넣으면 정렬 순서가
# 구현마다 달라져 출력 대조가 무의미해진다. 나노초 정렬은 파서 단위
# 테스트에서 따로 검증한다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
FIX="$ROOT/fixtures"
RID="rid-7f3a91"

# 2026-09-04T02:19:29.123Z 를 밀리초 epoch 으로. 단위 자동 판별을 때린다.
EPOCH_MS=1788488369123

# 파일을 지울 수 없는 환경(Cowork 샌드박스 등)에서도 돌아야 하므로 실패를
# 무시한다. 아래에서 모든 픽스처를 > 로 덮어쓰므로 남은 파일이 있어도 내용은
# 같다. 픽스처 구성을 바꿨는데 지우기가 막혀 있으면 옛 파일이 남아 결과가
# 달라질 수 있으니, 그때는 수동으로 test/fixtures 를 지운다.
rm -rf "$FIX" 2>/dev/null || true

req() { mkdir -p "$FIX/$1/var/log/ai-stt/requester"; }
rcv() { mkdir -p "$FIX/$1/var/log/ai-stt/receiver"; }
sch() { mkdir -p "$FIX/$1/var/log/ai-stt-scheduler"; }

# ── requester / kw41 ────────────────────────────────────────────────────────
# ISO Z 나노초 9자리, Go slog 의 source 객체, zap 의 caller 문자열
req kw41
cat > "$FIX/kw41/var/log/ai-stt/requester/requester.log" <<EOF
{"time":"2026-09-04T02:19:24.568353422Z","level":"INFO","source":{"function":"github.com/x/consumer.(*C).Handle","file":"/consumer/rabbitmq.go","line":300},"msg":"handle message start","rid":"$RID","content_id":"20260904-abc@subtitle@x","job_id":73720239,"cpk":"tenant-a"}
{"time":"2026-09-04T02:19:24.912000111Z","level":"DEBUG","caller":"consumer/rabbitmq.go:412","msg":"payload accepted","rid":"$RID"}
EOF

# 로테이션된 .gz — zgrep 없이 gzip -cd 로 풀리는지 본다.
#
# `gzip <파일>` 이 아니라 `gzip -c` 로 곧장 .gz 를 만든다. 전자는 원본을
# 지우는데, 파일 삭제가 막힌 환경에서 실패한다. 그리고 압축 안 된 원본이
# 남으면 requester.log* glob 에 둘 다 걸려 같은 줄이 두 번 나온다.
cat <<EOF | gzip -c > "$FIX/kw41/var/log/ai-stt/requester/requester.log.1.gz"
{"time":"2026-09-04T02:19:20.100000000Z","level":"INFO","msg":"rotated file hit","rid":"$RID"}
EOF

# ── requester / kw42 ────────────────────────────────────────────────────────
# 시각이 아예 없는 첫 줄(JSON 아님) + 다른 필드에 값이 든 줄
req kw42
cat > "$FIX/kw42/var/log/ai-stt/requester/requester.log" <<EOF
starting up with $RID
{"time":"2026-09-04T02:19:25.300000000Z","level":"INFO","msg":"child job","rid":"rid-other-1","parent_rid":"$RID"}
EOF

# ── scheduler / kw47 ────────────────────────────────────────────────────────
# 공백 구분 + 오프셋 타임존, 똑같은 폴링 줄 4회, 그리고 상태 전이
sch kw47
cat > "$FIX/kw47/var/log/ai-stt-scheduler/scheduler.log" <<EOF
{"ts":"2026-09-04 02:19:26.000000 +00:00","level":"DEBUG","msg":"worker checking task","rid":"$RID","state":"STARTED"}
{"ts":"2026-09-04 02:19:27.000000 +00:00","level":"DEBUG","msg":"worker checking task","rid":"$RID","state":"STARTED"}
{"ts":"2026-09-04 02:19:28.000000 +00:00","level":"DEBUG","msg":"worker checking task","rid":"$RID","state":"STARTED"}
{"ts":"2026-09-04 02:19:29.000000 +00:00","level":"DEBUG","msg":"worker checking task","rid":"$RID","state":"STARTED"}
{"ts":"2026-09-04 02:19:31.000000 +00:00","level":"INFO","msg":"worker checking task","rid":"$RID","state":"SUCCESS"}
EOF

# epoch ms 타임스탬프, body 에 JSON 문자열이 통째로 박힌 줄,
# 그리고 JSON 이 아닌 panic 과 시각 없는 연속 줄
cat > "$FIX/kw47/var/log/ai-stt-scheduler/debug.log" <<EOF
{"timestamp":$EPOCH_MS,"level":"INFO","message":"Mint status result","body":"{\"state\":\"STARTED\",\"info\":{\"storage_key\":\"req_uid_$RID.mp3\"}}"}
panic: runtime error: invalid memory address ($RID)
	goroutine 1 [running]: handling $RID
EOF

# monitor.log 은 인벤토리에 있지만 파일이 없다 — [ -r "\$f" ] 분기를 때린다
sch dead-01

# ── receiver / kw42 ─────────────────────────────────────────────────────────
# nested(배열 안 정확일치) 와 partial("<rid>.mp3") 판정
rcv kw42
cat > "$FIX/kw42/var/log/ai-stt/receiver/receiver.log" <<EOF
{"time":"2026-09-04T02:19:30.244000000Z","level":"DEBUG","source":{"file":"/handler/handler.go","line":501},"msg":"parameters","rid":"HandleSubtitle","form_data":{"source_file_name":["$RID.mp3"]}}
{"time":"2026-09-04T02:19:32.500000000Z","level":"INFO","msg":"nested exact","meta":{"ids":["$RID"]}}
EOF

echo "픽스처 생성 완료: $FIX"
find "$FIX" -type f | sort | sed "s|$FIX/|  |"
