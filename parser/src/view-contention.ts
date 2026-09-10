/**
 * contention 뷰 — 여러 노드가 같은 자원을 두고 경쟁하는 앱용 (forwarder).
 *
 * 전 노드의 로그를 엄격한 시간순으로 병합하고 레인(노드)별 컬럼에 이벤트를
 * 놓는다. 관심사는 "누가 선점했고 누가 대기했는가"이므로:
 *
 *   - Δ 컬럼: 직전 이벤트와의 간격. ms 단위 레이스 분석의 주력.
 *   - ≈ 마커: 레인이 다른 이벤트 간격이 5ms 미만이면 붙인다. 노드 간
 *     clock skew 로 순서가 뒤바뀌었을 수 있어 선점 판정을 단정하면 안 된다.
 *   - Active 겹침 감지: 서로 다른 레인의 Active 구간이 시간상 겹치면
 *     split-brain 의심으로 경고한다 (FSM 전이 정보가 있을 때만 가능).
 *   - 세션 귀속: 레인 근거(payload)가 없는 줄은 세션 값(trace_id 등)이
 *     확정해 둔 레인으로 귀속한다. 내부 로직 줄(heartbeat 등)이 폴백으로
 *     엉뚱한 레인에 섞이지 않게 한다.
 *
 * 모델(분류·구간 재구성)과 렌더링을 분리한다. 모델은 순수 함수라 테스트가
 * 쉽고, 웹 계층이 같은 모델로 스윔레인을 그릴 수 있다.
 */

import type { Classified, EventKind, LaneFallback } from './profiles.ts'
import { fmtDuration, fmtTs, hmsMs, makeDayTracker, matchNote, paint } from './render.ts'
import type { TextOptions } from './render.ts'
import { isWeakMatch } from './types.ts'
import type { LogRecord, Ts } from './types.ts'

/** 레인 간 간격이 이보다 좁으면 clock skew 로 순서가 뒤집혔을 수 있다. */
export const SKEW_SUSPECT_NANOS = 5_000_000n // 5ms

const LANE_COLORS = ['cyan', 'magenta', 'green', 'blue', 'yellow']

const KIND_SYMBOLS: Record<EventKind, string> = {
  start: '▶',
  acquire: '⚡',
  contend: '↗',
  demote: '⏸',
  fail: '✖',
  kick: '⛔',
  close: '■',
  info: '·',
}

const KIND_COLORS: Record<EventKind, string | undefined> = {
  start: 'bold',
  acquire: 'green',
  contend: 'cyan',
  demote: 'yellow',
  fail: 'red',
  kick: 'red',
  close: 'dim',
  info: undefined,
}

export interface ContentionOptions {
  /** 레인을 나눌 필드. null 이거나 레코드에 없으면 폴백을 쓴다. */
  lane: string | null
  /**
   * 세션 구분 필드. 레인 안에서 값이 바뀌면 새 세션 표시. null 이면 끔.
   * 레인 근거가 없는 줄을 같은 세션 값이 확정해 둔 레인에 귀속시키는 데도
   * 쓴다 (아래 sessionLane 매핑 참고).
   */
  session: string | null
  /** 레인 필드가 없거나 빈 줄의 귀속처. 생략하면 'host'. */
  laneFallback?: LaneFallback
  /**
   * 앱 프로필의 커스텀 레인 해석 (예: forwarder 의 server_id 정규화 →
   * domain/url 토큰). 값을 돌려주면 lane 필드보다 우선하고, null 이면
   * lane 필드 → laneFallback 의 범용 경로로 내려간다.
   */
  resolveLane?: ((record: LogRecord) => string | null) | null
  classify: (record: LogRecord) => Classified
}

export interface ContentionEvent {
  record: LogRecord
  lane: string
  classified: Classified
  /** 직전 이벤트(시각이 있는)와의 간격. 첫 이벤트나 시각 없는 줄은 null. */
  deltaNanos: bigint | null
  /** 직전 이벤트와 레인이 다르고 간격이 SKEW_SUSPECT_NANOS 미만. */
  skewSuspect: boolean
  /** 이 줄에서 레인의 세션 값이 바뀌었으면 그 값. */
  sessionStart: string | null
}

export interface ActiveInterval {
  lane: string
  from: Ts
  to: Ts
  /** 마지막 로그까지 닫히지 않아 끝을 마지막 시각으로 대신 채웠는지. */
  ongoing: boolean
}

export interface ActiveOverlap {
  lanes: [string, string]
  from: Ts
  to: Ts
}

export interface ContentionModel {
  /** 첫 등장 순서. 렌더러의 컬럼 순서가 된다. */
  laneOrder: string[]
  events: ContentionEvent[]
  /** 레인별 Active 구간. FSM 전이가 있는 레코드에서만 재구성된다. */
  intervals: ActiveInterval[]
  /** 서로 다른 레인의 Active 구간이 겹친 곳 — split-brain 의심. */
  overlaps: ActiveOverlap[]
  /** 레인 → 마지막으로 알려진 상태 설명. */
  finalState: Map<string, string>
}

function fieldText(record: LogRecord, key: string | null): string {
  if (key === null) return ''
  const value = record.fields[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

export function laneOf(
  record: LogRecord,
  laneField: string | null,
  fallback: LaneFallback = 'host',
): string {
  const value = fieldText(record, laneField)
  return value !== '' ? value : fallbackLane(record, fallback)
}

function fallbackLane(record: LogRecord, fallback: LaneFallback = 'host'): string {
  // 수집기가 소스를 못 알아낸 줄은 '?' 로 온다 — 그건 레인 이름이 못 된다.
  if (fallback === 'source' && record.source !== '' && record.source !== '?') {
    return record.source
  }
  return record.host
}

/** payload 근거(커스텀 해석 → lane 필드)만으로 레인을 정한다. 못 정하면 null. */
function payloadLane(record: LogRecord, opt: ContentionOptions): string | null {
  const custom = opt.resolveLane?.(record) ?? null
  if (custom !== null && custom !== '') return custom
  const value = fieldText(record, opt.lane)
  return value !== '' ? value : null
}

/** records 는 시간순 정렬이 끝난 상태여야 한다 (cli 가 정렬 후 넘긴다). */
export function buildContentionModel(
  records: LogRecord[],
  opt: ContentionOptions,
): ContentionModel {
  const laneOrder: string[] = []
  const seenLane = new Set<string>()
  const events: ContentionEvent[] = []

  // ── 1패스: 세션 → 레인 매핑 학습 ──────────────────────────────────────
  // server_id/domain/url 없는 내부 로직 줄(heartbeat 등)도 세션 값(trace_id)은
  // 들고 있다. payload 로 레인이 확정된 줄에서 세션 → 레인을 배워 두면 그런
  // 줄을 제 레인에 귀속시킬 수 있다. 규칙 둘:
  //   - 폴백(source/host)으로 정한 레인은 배우지 않는다. 폴백이 두 노드를
  //     한 레인으로 합쳐버린 배치에서 매핑까지 오염되면 안 된다.
  //   - 같은 세션 값이 서로 다른 레인에서 확정되면 노드를 넘나드는 id 다
  //     (flow 계열의 rid 등) — null 로 지워 귀속에 쓰지 않는다.
  // 2패스인 이유: 귀속될 줄이 매핑을 세우는 줄보다 먼저 올 수 있어서다
  // (노드 간 clock skew, 시각 없는 줄의 정렬 위치).
  const sessionLane = new Map<string, string | null>()
  if (opt.session !== null) {
    for (const record of records) {
      const session = fieldText(record, opt.session)
      if (session === '') continue
      const lane = payloadLane(record, opt)
      if (lane === null) continue
      const known = sessionLane.get(session)
      if (known === undefined) sessionLane.set(session, lane)
      else if (known !== null && known !== lane) sessionLane.set(session, null)
    }
  }

  const lastSession = new Map<string, string>()
  let prevTs: Ts | null = null
  let prevLane: string | null = null

  // Active 구간 재구성. 열림/닫힘은 FSM 전이(transition.to)가 근거이고,
  // kick/close 는 전이 없이 세션이 끝나는 이벤트라 방어적으로 같이 닫는다.
  const openSince = new Map<string, Ts>()
  const intervals: ActiveInterval[] = []
  const finalState = new Map<string, string>()
  let lastTs: Ts | null = null

  for (const record of records) {
    // 레인 결정: payload 근거 → 세션 매핑 → 폴백(source/host) 순.
    const session = fieldText(record, opt.session)
    const lane =
      payloadLane(record, opt) ??
      (session !== '' ? (sessionLane.get(session) ?? null) : null) ??
      fallbackLane(record, opt.laneFallback)
    if (!seenLane.has(lane)) {
      seenLane.add(lane)
      laneOrder.push(lane)
    }

    const classified = opt.classify(record)

    let deltaNanos: bigint | null = null
    let skewSuspect = false
    if (record.ts !== null && prevTs !== null) {
      deltaNanos = record.ts.nanos - prevTs.nanos
      skewSuspect =
        prevLane !== null &&
        prevLane !== lane &&
        deltaNanos >= 0n &&
        deltaNanos < SKEW_SUSPECT_NANOS
    }
    if (record.ts !== null) {
      prevTs = record.ts
      prevLane = lane
      lastTs = record.ts
    }

    let sessionStart: string | null = null
    if (session !== '' && lastSession.get(lane) !== session) {
      lastSession.set(lane, session)
      sessionStart = session
    }

    const transition = classified.transition
    if (transition !== undefined && record.ts !== null) {
      const active = transition.to.toLowerCase() === 'active'
      const open = openSince.get(lane)
      if (active && open === undefined) {
        openSince.set(lane, record.ts)
      } else if (!active && open !== undefined) {
        intervals.push({ lane, from: open, to: record.ts, ongoing: false })
        openSince.delete(lane)
      }
      finalState.set(
        lane,
        `${transition.to}${transition.reason !== '' ? ` (${transition.reason})` : ''}`,
      )
    } else if (classified.kind === 'kick' || classified.kind === 'close') {
      const open = openSince.get(lane)
      if (open !== undefined && record.ts !== null) {
        intervals.push({ lane, from: open, to: record.ts, ongoing: false })
        openSince.delete(lane)
      }
      finalState.set(lane, classified.kind === 'kick' ? '종료 (kick)' : '종료')
    }

    events.push({ record, lane, classified, deltaNanos, skewSuspect, sessionStart })
  }

  // 마지막 로그까지 Active 였던 레인 — 끝을 마지막 시각으로 채우되 표시해 둔다.
  if (lastTs !== null) {
    for (const [lane, from] of openSince) {
      intervals.push({ lane, from, to: lastTs, ongoing: true })
      if (!finalState.has(lane)) finalState.set(lane, 'active')
    }
  }

  // 서로 다른 레인의 Active 구간 겹침 = split-brain 의심.
  const overlaps: ActiveOverlap[] = []
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i]!
      const b = intervals[j]!
      if (a.lane === b.lane) continue
      const from = a.from.nanos > b.from.nanos ? a.from : b.from
      const to = a.to.nanos < b.to.nanos ? a.to : b.to
      if (from.nanos < to.nanos) {
        overlaps.push({ lanes: [a.lane, b.lane], from, to })
      }
    }
  }

  return { laneOrder, events, intervals, overlaps, finalState }
}

/** ms 레이스를 다루므로 1ms 미만은 µs, 1분 미만은 실수 초까지 보여준다. */
export function fmtDelta(nanos: bigint): string {
  if (nanos < 0n) return `-${fmtDelta(-nanos)}`
  if (nanos < 1_000_000n) return `+${(Number(nanos) / 1e3).toFixed(0)}µs`
  if (nanos < 1_000_000_000n) return `+${(Number(nanos) / 1e6).toFixed(0)}ms`
  if (nanos < 60_000_000_000n) return `+${(Number(nanos) / 1e9).toFixed(3)}s`
  return `+${fmtDuration(Number(nanos) / 1e9)}`
}

/** 컬럼 레이아웃은 이 레인 수까지만. 넘으면 태그 행 레이아웃으로 내려간다. */
const MAX_COLUMN_LANES = 3
const MIN_LANE_WIDTH = 26

export function renderContention(
  records: LogRecord[],
  opt: ContentionOptions,
  textOpt: TextOptions,
  write: (line: string) => void,
): void {
  const model = buildContentionModel(records, opt)
  const color = textOpt.color

  const laneColor = new Map<string, string>()
  model.laneOrder.forEach((lane, i) =>
    laneColor.set(lane, LANE_COLORS[i % LANE_COLORS.length]!),
  )

  const columns = model.laneOrder.length <= MAX_COLUMN_LANES
  const laneWidth = Math.max(
    MIN_LANE_WIDTH,
    ...model.laneOrder.map((lane) => lane.length + 4),
  )

  // ── 머리글 ────────────────────────────────────────────────────────────
  if (columns) {
    const head = model.laneOrder
      .map((lane) => paint('┆ ', 'dim', color) + paint(lane.padEnd(laneWidth - 2), laneColor.get(lane), color))
      .join('')
    write(`${paint(' UTC'.padEnd(13), 'dim', color)}  ${'Δ'.padStart(8)}  ${head}`)
  }

  const trackDay = makeDayTracker(color, write)
  let anySkew = false

  for (const event of model.events) {
    const { record, lane, classified } = event
    trackDay(record)

    let delta = event.deltaNanos === null ? '–' : fmtDelta(event.deltaNanos)
    if (event.skewSuspect) {
      delta = `≈${delta}`
      anySkew = true
    }

    let label = `${KIND_SYMBOLS[classified.kind]} ${classified.label}`
    if ((record.repeat ?? 1) > 1) label += `  ⟲ ×${record.repeat}`
    if (event.sessionStart !== null) {
      label += `  ${paint(`[세션 ${event.sessionStart.slice(0, 8)}]`, 'dim', color)}`
    }
    const painted = paint(label, KIND_COLORS[classified.kind], color)

    let line: string
    if (columns) {
      const index = model.laneOrder.indexOf(lane)
      const guide = paint('┆', 'dim', color)
      let cells = ''
      for (let i = 0; i < index; i++) cells += `${guide}${' '.repeat(laneWidth - 1)}`
      cells += `${guide} ${painted}`
      line = `${paint(fmtTs(record), 'dim', color)}  ${delta.padStart(8)}  ${cells}`
    } else {
      const laneTag = paint(
        lane.padEnd(Math.max(8, ...model.laneOrder.map((l) => l.length))),
        laneColor.get(lane), color)
      line = `${paint(fmtTs(record), 'dim', color)}  ${delta.padStart(8)}  ${laneTag}  ${painted}`
    }
    write(line)

    // 검색값이 다른 필드에서 걸렸거나 위치를 못 찾은 줄은 경고를 그대로 단다.
    if (isWeakMatch(record.match)) {
      write(paint(`      ${matchNote(record.match)}`, 'yellow', color))
    }
  }

  // ── 꼬리 요약 ─────────────────────────────────────────────────────────
  write('')
  for (const lane of model.laneOrder) {
    const laneEvents = model.events.filter((e) => e.lane === lane)
    const acquired = laneEvents.filter((e) => e.classified.kind === 'acquire').length
    const active = model.intervals.filter((i) => i.lane === lane)
    const state = model.finalState.get(lane) ?? '알 수 없음'
    write(
      `  ${paint(lane, laneColor.get(lane), color)}  ` +
        `이벤트 ${laneEvents.length}건 · Active 획득 ${acquired}회 · ` +
        `Active 구간 ${active.length}개 · 최종 ${state}`,
    )
  }

  for (const overlap of model.overlaps) {
    const seconds = Number(overlap.to.nanos - overlap.from.nanos) / 1e9
    write(
      paint(
        `  ⚠ split-brain 의심: ${overlap.lanes[0]} ↔ ${overlap.lanes[1]} Active 겹침 ` +
          `${hmsMs(overlap.from)} → ${hmsMs(overlap.to)} (${seconds.toFixed(3)}s)`,
        'red', color),
    )
  }

  if (anySkew) {
    write(
      paint(
        `  ≈ 표시: 레인 간 간격 ${Number(SKEW_SUSPECT_NANOS) / 1e6}ms 미만 — ` +
          `노드 간 clock skew 로 순서가 뒤바뀌었을 수 있음`,
        'dim', color),
    )
  }
}
