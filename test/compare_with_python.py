#!/usr/bin/env python3
"""기존 파이썬 구현과 새 Go+TS 파이프라인의 JSONL 출력을 대조한다.

이식이 끝나면 파이썬은 사라지므로 이 스크립트도 함께 지운다. 그때까지는
"돌아가는 구현"이 하나 남아 있다는 사실이 가장 값싼 회귀 테스트다.

두 출력은 필드 이름이 다르므로(파이썬은 _area, TS 는 area) 같은 모양으로
투영해서 비교한다. 비교하지 않는 것:

  - _sig / _used_keys : 내부 계산용. 값이 아니라 동작으로 검증된다.
  - 나노초            : 파이썬은 마이크로초까지만 다룬다. 표시 정밀도인
                        밀리초로 맞춰서 본다.
  - fields            : 임베디드 JSON 을 푼 결과까지 같은지는 raw 로 갈음한다.

사용:
    python3 test/compare_with_python.py <py.jsonl> <ts.jsonl>
"""

import json
import sys


def match_to_string(match):
    """TS 의 MatchKind union 을 파이썬의 문자열 형태로 되돌린다."""
    kind = match["kind"]
    if kind == "nested":
        return f"nested:{match['path']}"
    if kind == "partial":
        return f"partial:{match['path']}"
    if kind == "other":
        return f"other:{match['key']}"
    return kind


def ms(stamp):
    """isoformat 을 밀리초 UTC 문자열로 정규화한다."""
    if not stamp:
        return None
    text = stamp.replace("Z", "+00:00")
    # 2026-09-04T02:19:24.568353+00:00 → 2026-09-04T02:19:24.568
    head, _, _tz = text.partition("+")
    if "." in head:
        base, _, frac = head.partition(".")
        return f"{base}.{frac[:3]:<03s}"
    return f"{head}.000"


def from_python(rec):
    return {
        "ts": ms(rec["_ts"]),
        "ts_inherited": rec.get("_ts_inherited", False),
        "ts_key": rec.get("_ts_key"),
        "area": rec["_area"],
        "host": rec["_host"],
        "source": rec["_source"],
        "file": rec["_file"],
        "seq": rec["_seq"],
        "level": rec["_level"],
        "msg": rec["_msg"],
        "caller": rec["_caller"],
        "match": rec["_match"],
        "repeat": rec.get("_repeat", 1),
        "is_json": rec["_json"],
        "raw": rec["_raw"],
    }


def from_ts(rec):
    return {
        "ts": ms(rec["ts"]),
        "ts_inherited": rec["tsInherited"],
        "ts_key": rec["tsKey"],
        "area": rec["area"],
        "host": rec["host"],
        "source": rec["source"],
        "file": rec["file"],
        "seq": rec["seq"],
        "level": rec["level"],
        "msg": rec["msg"],
        "caller": rec["caller"],
        "match": match_to_string(rec["match"]),
        "repeat": rec["repeat"],
        "is_json": rec["isJson"],
        "raw": rec["raw"],
    }


def load(path, project):
    with open(path, encoding="utf-8") as fp:
        return [project(json.loads(line)) for line in fp if line.strip()]


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2

    left = load(argv[0], from_python)
    right = load(argv[1], from_ts)

    if len(left) != len(right):
        print(f"❌ 줄 수 불일치: 파이썬 {len(left)}건, TS {len(right)}건")
        for index in range(max(len(left), len(right))):
            l = left[index] if index < len(left) else None
            r = right[index] if index < len(right) else None
            if l != r:
                print(f"  첫 차이 #{index}")
                print(f"    py: {l}")
                print(f"    ts: {r}")
                break
        return 1

    failures = 0
    for index, (l, r) in enumerate(zip(left, right)):
        if l == r:
            continue
        failures += 1
        print(f"❌ #{index} 불일치 ({l['area']}/{l['source']} {l['host']})")
        for key in l:
            if l[key] != r[key]:
                print(f"    {key}:")
                print(f"      py: {l[key]!r}")
                print(f"      ts: {r[key]!r}")

    if failures:
        print(f"\n{failures}/{len(left)}건 불일치")
        return 1

    print(f"✅ {len(left)}건 전부 일치 (ts/level/msg/caller/match/repeat/seq/raw)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
