/**
 * flow 뷰 — 하나의 요청이 여러 영역(애플리케이션)을 순차 통과하는 앱용.
 *
 * 병합 타임라인과 반대로 영역별 블록으로 묶는다. "요청이 어느 애플리케이션에서
 * 얼마나 머물렀고, 다음으로 넘어갈 때 얼마나 걸렸는가"가 관심사일 때
 * (ai-stt 처럼) 섞인 타임라인보다 블록 + 핸드오프 갭이 빨리 읽힌다.
 *
 * 모델(그룹·갭 계산)과 렌더링을 분리해 둔다 — 모델은 순수 함수라 테스트가
 * 쉽고, 나중에 웹 계층이 같은 모델을 다른 형태로 그릴 수 있다.
 */

import {
  areaColorMap,
  fmtDuration,
  hmsMs,
  makeDayTracker,
  paint,
  writeRecord,
} from './render.ts'
import type { TextOptions } from './render.ts'
import type { LogRecord, Ts } from './types.ts'

export interface FlowGroup {
  area: string
  records: LogRecord[]
  /** 시각이 있는 레코드 기준 구간. 전부 시각이 없으면 null. */
  first: Ts | null
  last: Ts | null
}

export interface FlowModel {
  /** areaOrder 순서. 레코드가 없는 영역은 뺀다 (요약이 이미 '결과 없음'을 말해준다). */
  groups: FlowGroup[]
  /**
   * groups[i] 와 groups[i+1] 사이의 핸드오프 간격(초).
   * 음수면 두 영역의 로그가 시간상 겹친 것이다. 시각을 못 읽어 계산이
   * 불가능하면 null.
   */
  gaps: Array<number | null>
}

/** records 는 시간순 정렬이 끝난 상태여야 한다 (cli 가 정렬 후 넘긴다). */
export function buildFlowModel(records: LogRecord[], areaOrder: string[]): FlowModel {
  const byArea = new Map<string, LogRecord[]>()
  for (const record of records) {
    const bucket = byArea.get(record.area)
    if (bucket === undefined) byArea.set(record.area, [record])
    else bucket.push(record)
  }

  // areaOrder 에 없는 영역(방어적)은 뒤에 붙인다.
  const order = [...areaOrder]
  for (const area of byArea.keys()) {
    if (!order.includes(area)) order.push(area)
  }

  const groups: FlowGroup[] = []
  for (const area of order) {
    const bucket = byArea.get(area)
    if (bucket === undefined || bucket.length === 0) continue

    let first: Ts | null = null
    let last: Ts | null = null
    for (const record of bucket) {
      if (record.ts === null) continue
      if (first === null || record.ts.nanos < first.nanos) first = record.ts
      if (last === null || record.ts.nanos > last.nanos) last = record.ts
    }
    groups.push({ area, records: bucket, first, last })
  }

  const gaps: Array<number | null> = []
  for (let i = 0; i + 1 < groups.length; i++) {
    const prev = groups[i]!
    const next = groups[i + 1]!
    if (prev.last === null || next.first === null) {
      gaps.push(null)
      continue
    }
    gaps.push(Number(next.first.nanos - prev.last.nanos) / 1e9)
  }

  return { groups, gaps }
}

/** 1분 미만은 ms 까지 — 영역 체류 시간은 초 미만 차이가 정보다. */
function fmtSpan(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(3)}s` : fmtDuration(seconds)
}

export function renderFlow(
  records: LogRecord[],
  areaOrder: string[],
  opt: TextOptions,
  write: (line: string) => void,
): void {
  const model = buildFlowModel(records, areaOrder)
  const areaColor = areaColorMap(areaOrder)
  const hostWidth = Math.max(8, ...records.map((r) => r.host.length))

  // 날짜 추적은 전역 하나로 충분하다 — 값이 "달라질 때" 찍으므로 그룹이
  // 시간상 되감겨도(겹침) 날짜가 바뀌면 다시 찍힌다.
  const trackDay = makeDayTracker(opt.color, write)

  model.groups.forEach((group, index) => {
    const sourceWidth = Math.max(8, ...group.records.map((r) => r.source.length))

    let span = ''
    if (group.first !== null && group.last !== null) {
      const seconds = Number(group.last.nanos - group.first.nanos) / 1e9
      span = ` · ${hmsMs(group.first)} → ${hmsMs(group.last)} (${fmtSpan(seconds)})`
    }
    write('')
    write(
      paint(`━━ ${group.area} ━━ ${group.records.length}건${span}`,
        areaColor.get(group.area), opt.color),
    )

    for (const record of group.records) {
      trackDay(record)
      writeRecord(record, record.source.padEnd(sourceWidth), undefined, hostWidth, opt, write)
    }

    const gap = model.gaps[index]
    if (gap !== undefined) {
      if (gap === null) {
        write(paint('   ↓ 핸드오프 간격 계산 불가 (시각 없는 줄)', 'yellow', opt.color))
      } else if (gap < 0) {
        write(
          paint(
            `   ↓ 핸드오프 ${gap.toFixed(3)}s — 다음 영역과 시간이 겹침 (병렬 처리 또는 clock skew)`,
            'yellow', opt.color),
        )
      } else {
        // 요약의 갭과 같은 기준: 5초를 넘으면 눈에 띄게.
        write(paint(`   ↓ 핸드오프 +${gap.toFixed(3)}s`, gap > 5 ? 'red' : 'dim', opt.color))
      }
    }
  })
}
