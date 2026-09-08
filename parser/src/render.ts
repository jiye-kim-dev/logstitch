/**
 * 터미널 / JSONL 출력과 요약. (파이썬 ltrace/render.py 이식)
 *
 * 라운드2(파생키 재조회) 관련 항목은 1차 범위에서 제외되어 빠졌다.
 */

import { MAX_NEST_DEPTH } from './fields.ts'
import type { Criterion, HostResult, LogRecord, MatchKind, Ts } from './types.ts'

const COLORS: Record<string, string> = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

const AREA_COLORS = ['cyan', 'magenta', 'green', 'blue', 'yellow']

const LEVEL_COLORS: Record<string, string> = {
  ERROR: 'red',
  FATAL: 'red',
  PANIC: 'red',
  WARN: 'yellow',
  WARNING: 'yellow',
  DEBUG: 'dim',
}

export function paint(text: string, color: string | undefined, enabled: boolean): string {
  if (!enabled || color === undefined || COLORS[color] === undefined) return text
  return `${COLORS[color]}${text}${COLORS.reset}`
}

/** UTC 기준 HH:MM:SS.mmm. 시각을 물려받은 줄은 앞에 ~ 를 붙인다. */
function fmtTs(record: LogRecord): string {
  if (record.ts === null) return '--:--:--.---'
  const stamp = record.ts.date.toISOString().slice(11, 23)
  return record.tsInherited ? `~${stamp}` : ` ${stamp}`
}

function hms(ts: Ts): string {
  return ts.date.toISOString().slice(11, 19)
}

function utcDate(ts: Ts): string {
  return ts.date.toISOString().slice(0, 10)
}

function fmtDuration(seconds: number): string {
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  if (total < 3600) {
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
  }
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`
}

/** 정확일치가 아닌 줄에 왜 걸렸는지 한 줄로 알려준다. */
export function matchNote(match: MatchKind): string {
  switch (match.kind) {
    case 'nested':
      return `↳ 검색값이 중첩 구조 ${match.path} 안에 있음`
    case 'partial':
      return `↳ 검색값이 ${match.path} 의 값 안에 포함됨`
    case 'other':
      return `⚠ 검색값이 '${match.key}' 필드에서 매칭됨 (다른 요청일 수 있음)`
    case 'substring':
      return '⚠ 값이 든 위치를 특정하지 못함'
    default:
      return ''
  }
}

/**
 * 개별 값이 너무 길면 값 단위로 줄인다.
 *
 * 줄 전체를 뒤에서 자르면 키 정렬 때문에 알파벳 뒤쪽 키(rid, task_id ...)가
 * 통째로 사라진다. 값마다 줄이면 어떤 키가 있었는지는 남는다.
 */
function shortenValues(node: unknown, cap: number, depth = 0): unknown {
  if (cap <= 0 || depth > MAX_NEST_DEPTH) return node
  if (Array.isArray(node)) return node.map((v) => shortenValues(v, cap, depth + 1))
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = shortenValues(v, cap, depth + 1)
    return out
  }
  if (typeof node === 'string' && node.length > cap) return `${node.slice(0, cap - 1)}…`
  return node
}

function sortedStringify(node: unknown): string {
  if (node === undefined) return 'null'
  if (node === null || typeof node !== 'object') return JSON.stringify(node) ?? 'null'
  if (Array.isArray(node)) return `[${node.map(sortedStringify).join(',')}]`
  const obj = node as Record<string, unknown>
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}: ${sortedStringify(obj[k])}`)
    .join(', ')
  return `{${body}}`
}

function extraFields(record: LogRecord, width: number, valueCap: number): string {
  if (!record.isJson) return ''
  const skip = new Set(record.usedKeys)
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record.fields)) {
    if (!skip.has(k)) rest[k] = v
  }
  if (Object.keys(rest).length === 0) return ''

  const text = sortedStringify(shortenValues(rest, valueCap))
  if (width <= 0 || text.length <= width) return text
  return `${text.slice(0, width - 3)}...`
}

export interface TextOptions {
  color: boolean
  showExtra: boolean
  extraWidth: number
  valueCap: number
}

export function renderText(
  records: LogRecord[],
  areaOrder: string[],
  opt: TextOptions,
  write: (line: string) => void,
): void {
  const areaColor = new Map<string, string>()
  areaOrder.forEach((name, i) => areaColor.set(name, AREA_COLORS[i % AREA_COLORS.length]!))

  const labelWidth = Math.max(
    12,
    ...records.map((r) => `${r.area}/${r.source}`.length),
  )
  const hostWidth = Math.max(8, ...records.map((r) => r.host.length))

  let prevDay: string | null = null

  for (const record of records) {
    if (record.ts !== null && utcDate(record.ts) !== prevDay) {
      prevDay = utcDate(record.ts)
      write(paint(`\n──── ${prevDay} (UTC) ────`, 'dim', opt.color))
    }

    const label = `${record.area}/${record.source}`.padEnd(labelWidth)
    const level = record.level.slice(0, 5).padEnd(5)

    let body = record.msg !== '' ? record.msg : record.raw
    if (record.caller !== '') {
      body += `  ${paint(`(${record.caller})`, 'dim', opt.color)}`
    }

    write(
      [
        paint(fmtTs(record), 'dim', opt.color),
        paint(label, areaColor.get(record.area), opt.color),
        record.host.padEnd(hostWidth),
        paint(level, LEVEL_COLORS[record.level], opt.color),
        body,
      ].join('  '),
    )

    // 값이 중첩 구조나 더 긴 값 안에 숨어 있는 줄은 --no-extra 여도 필드를
    // 보여준다. 그런 줄은 메인 한 줄만 봐서는 왜 걸렸는지 알 수 없다.
    const buried = record.match.kind === 'nested' || record.match.kind === 'partial'
    if (opt.showExtra || buried) {
      const extra = extraFields(record, opt.extraWidth, opt.valueCap)
      if (extra !== '') write(paint(`      ${extra}`, 'dim', opt.color))
    }

    const repeat = record.repeat ?? 1
    if (repeat > 1) {
      let span = ''
      if (record.ts !== null && record.repeatUntil !== undefined) {
        const seconds =
          Number(record.repeatUntil.nanos - record.ts.nanos) / 1e9
        span =
          ` — ${hms(record.ts)} → ${hms(record.repeatUntil)}` +
          ` (${fmtDuration(seconds)})`
      }
      write(paint(`      ⟲ 같은 내용 ${repeat}회 반복${span}`, 'cyan', opt.color))
    }

    const note = matchNote(record.match)
    if (note !== '') write(paint(`      ${note}`, 'yellow', opt.color))
  }
}

/**
 * JSONL 출력. 웹 계층이 나중에 소비할 계약이므로 형태를 명시적으로 고정한다.
 * bigint 는 JSON 으로 직렬화되지 않으므로 문자열로 낸다.
 */
export function renderJsonl(records: LogRecord[], write: (line: string) => void): void {
  for (const record of records) {
    write(
      JSON.stringify({
        ts: record.ts === null ? null : record.ts.date.toISOString(),
        tsNanos: record.ts === null ? null : record.ts.nanos.toString(),
        tsInherited: record.tsInherited,
        tsKey: record.tsKey,
        app: record.app,
        environment: record.environment,
        area: record.area,
        host: record.host,
        source: record.source,
        file: record.file,
        seq: record.seq,
        level: record.level,
        msg: record.msg,
        caller: record.caller,
        match: record.match,
        repeat: record.repeat ?? 1,
        repeatUntil:
          record.repeatUntil === undefined ? null : record.repeatUntil.date.toISOString(),
        isJson: record.isJson,
        raw: record.raw,
        fields: record.fields,
      }),
    )
  }
}

export interface SummaryOptions {
  /** 어느 앱·환경 수집인지. 요약 머리글에 찍는다. */
  app: string
  environment: string
  areaOrder: string[]
  color: boolean
  /**
   * 검색 조건. 두 개 이상이면 원격에서 교집합으로 걸러진 결과이므로,
   * 결과가 적을 때 조건이 과했는지 판단할 수 있게 머리글 아래에 적는다.
   */
  criteria?: Criterion[]
  /** 반복돼서 접힌 줄 수. */
  collapsed?: number
}

export function renderSummary(
  records: LogRecord[],
  hosts: HostResult[],
  opt: SummaryOptions,
  write: (line: string) => void,
): void {
  const { areaOrder, color } = opt
  const collapsed = opt.collapsed ?? 0

  const where = [opt.app, opt.environment].filter((s) => s !== '').join(' / ')
  const label = where === '' ? '요약' : `요약 (${where})`
  write(paint(`\n===== ${label} =====`, 'bold', color))

  const criteria = opt.criteria ?? []
  if (criteria.length > 1) {
    // 조건이 여러 개면 원격에서 교집합으로 걸러졌다 — 모든 값이 같은 줄에
    // 있어야 남는다. 결과가 적을 때 조건이 과했는지 여기서 보인다.
    write(
      paint(
        `  조건 ${criteria.length}개 교집합: ` +
          criteria.map((c) => `${c.field}=${c.value}`).join(' AND '),
        'dim',
        color,
      ),
    )
  }

  const counts = new Map<string, number>()
  for (const r of records) {
    const key = `${r.area} ${r.source} ${r.host}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  for (const area of areaOrder) {
    const rows = [...counts.entries()].filter(([k]) => k.startsWith(`${area} `))
    if (rows.length === 0) {
      write(paint(`  ${area.padEnd(12)} 결과 없음`, 'yellow', color))
      continue
    }
    const total = rows.reduce((sum, [, n]) => sum + n, 0)
    const detail = rows
      .map(([k, n]) => {
        const [, source, host] = k.split(' ')
        return `${host}:${source}=${n}`
      })
      .sort()
      .join(', ')
    write(`  ${area.padEnd(12)} ${String(total).padStart(4)}건  (${detail})`)
  }

  // 구간 갭 — 이 도구의 진짜 목적
  const spans: Array<{ area: string; first: Ts; last: Ts }> = []
  for (const area of areaOrder) {
    const stamps = records
      .filter((r) => r.area === area && r.ts !== null)
      .map((r) => r.ts!)
    if (stamps.length === 0) continue
    let first = stamps[0]!
    let last = stamps[0]!
    for (const ts of stamps) {
      if (ts.nanos < first.nanos) first = ts
      if (ts.nanos > last.nanos) last = ts
    }
    spans.push({ area, first, last })
  }

  if (spans.length > 1) {
    write(paint('\n  구간 (UTC)', 'bold', color))
    spans.forEach((span, index) => {
      const duration = Number(span.last.nanos - span.first.nanos) / 1e9
      write(
        `    ${span.area.padEnd(12)} ${span.first.date.toISOString().slice(11, 23)}` +
          ` → ${span.last.date.toISOString().slice(11, 23)}  (${duration.toFixed(3)}s)`,
      )
      const next = spans[index + 1]
      if (next !== undefined) {
        const gap = Number(next.first.nanos - span.last.nanos) / 1e9
        const marker = gap > 5 ? 'red' : 'dim'
        write(paint(`      ↓ 갭 ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}s`, marker, color))
      }
    })
  }

  const noTs = records.filter((r) => r.ts === null).length
  if (noTs > 0) {
    write(
      paint(
        `  ⚠ 타임스탬프를 못 읽은 줄 ${noTs}건 (맨 뒤로 정렬됨)` +
          ` — TS_KEYS 에 키 추가 필요할 수 있음`,
        'yellow',
        color,
      ),
    )
  }

  if (collapsed > 0) {
    write(`\n  반복돼서 접힌 줄 ${collapsed}건 (--no-collapse 로 전부 보기)`)
  }

  const count = (kind: MatchKind['kind']): number =>
    records.filter((r) => r.match.kind === kind).length

  const soft: string[] = []
  if (count('nested') > 0) soft.push(`중첩 구조 안 ${count('nested')}건`)
  if (count('partial') > 0) soft.push(`더 긴 값 안에 포함 ${count('partial')}건`)
  if (soft.length > 0) {
    write(`\n  필드 정확일치는 아니지만 같은 요청으로 보이는 줄: ${soft.join(', ')}`)
  }

  const weak: string[] = []
  if (count('other') > 0) weak.push(`다른 필드 매칭 ${count('other')}건`)
  if (count('substring') > 0) weak.push(`위치 특정 실패 ${count('substring')}건`)
  if (weak.length > 0) {
    write(paint(`  ⚠ ${weak.join(', ')} (--strict 로 제외 가능)`, 'yellow', color))
  }

  const truncated = hosts.filter((h) => h.truncated)
  if (truncated.length > 0) {
    write(
      paint(
        `\n  ⚠ 줄 수 상한에 걸려 잘린 호스트 ${truncated.length}대: ` +
          truncated.map((h) => `${h.area}/${h.host}`).join(', ') +
          ' (--max-lines 로 조정)',
        'yellow',
        color,
      ),
    )
  }

  // 종료코드가 0 이어도 stderr 에 뭔가 있으면 남긴다 — 부분적으로만 읽힌
  // 경우를 놓치지 않기 위해서다. 죽은 노드가 장애 원인일 때가 많다.
  const problems = hosts.filter((h) => h.status !== 'ok' || (h.error ?? '') !== '')
  if (problems.length > 0) {
    const failed = problems.filter((h) => h.status !== 'ok').length
    write(
      paint(
        `\n  실패/경고 호스트 ${problems.length}대 (실패 ${failed}대)`,
        failed > 0 ? 'red' : 'yellow',
        color,
      ),
    )
    for (const h of problems) {
      write(
        paint(
          `    ${h.area}/${h.host}: ${h.status}${h.error ? ` — ${h.error}` : ''}`,
          h.status !== 'ok' ? 'red' : 'yellow',
          color,
        ),
      )
    }
  }
}
