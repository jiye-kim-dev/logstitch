/**
 * 로그 한 줄에서 값을 꺼내는 규칙들. (파이썬 ltrace/fields.py 이식)
 *
 * 모듈마다 로거가 달라서 타임스탬프 키가 ts / time / timestamp 로 갈린다.
 * 모듈별 파서를 만드는 대신 아래 별칭 목록에 한 줄 추가해서 흡수한다.
 * 실제 환경에 맞추려면 이 파일 상단만 고치면 된다.
 */

import type { Ts } from './types.ts'

export const TS_KEYS = [
  'ts', 'time', 'timestamp', '@timestamp', 'eventTime', 'datetime', 'date',
] as const

export const LEVEL_KEYS = [
  'level', 'lvl', 'severity', 'log_level', 'levelname',
] as const

export const MSG_KEYS = ['msg', 'message', 'log', 'event', 'text'] as const

export const CALLER_KEYS = [
  'source', 'caller', 'logging.googleapis.com/sourceLocation',
] as const

/** 중첩 구조를 훑을 최대 깊이. */
export const MAX_NEST_DEPTH = 6

/** JSON 문자열이 든 필드를 풀 최대 깊이. */
export const EMBED_MAX_DEPTH = 3

/** 지문 계산에서 제거할 키 — 매 줄 달라지는 값들. */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set<string>([
  ...TS_KEYS,
  ...CALLER_KEYS,
])

/** 줄 안에서 타임스탬프처럼 보이는 부분을 찾는다 (JSON 이 아닌 줄용). */
const TS_SNIFF =
  /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)/

const ISO_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:[.,](\d{1,9}))?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/

/** 정렬은 나노초로만 한다. 시각을 못 읽은 줄은 맨 뒤로 보낸다. */
export const FAR_FUTURE_NANOS = 9_999_999_999_999_999_999n

function tsFromNanos(nanos: bigint): Ts {
  // Date 는 밀리초까지만 담는다. 나머지는 nanos 에 남아 정렬에만 쓰인다.
  return { date: new Date(Number(nanos / 1_000_000n)), nanos }
}

/**
 * epoch 값의 단위(초/밀리/마이크로/나노)를 크기로 판별한다.
 *
 * 1973 ~ 2096 범위로 떨어지는 단위를 고른다. 파이썬 _from_epoch 와 같은
 * 판정이고 순서도 같다 (초 → 밀리 → 마이크로 → 나노).
 */
const EPOCH_UNITS: ReadonlyArray<{ perSecond: bigint; toNanos: bigint }> = [
  { perSecond: 1n, toNanos: 1_000_000_000n },
  { perSecond: 1_000n, toNanos: 1_000_000n },
  { perSecond: 1_000_000n, toNanos: 1_000n },
  { perSecond: 1_000_000_000n, toNanos: 1n },
]

function inEpochRange(seconds: number): boolean {
  return seconds > 1e8 && seconds < 4e9
}

/**
 * 숫자 문자열로 들어온 epoch. BigInt 로 다루므로 나노초가 온전하다.
 * (파이썬은 여기서 float 로 바꿔 정밀도를 잃는다.)
 */
function fromEpochDigits(text: string): Ts | null {
  let value: bigint
  try {
    value = BigInt(text.split('.')[0]!)
  } catch {
    return null
  }
  for (const unit of EPOCH_UNITS) {
    if (inEpochRange(Number(value / unit.perSecond))) {
      return tsFromNanos(value * unit.toNanos)
    }
  }
  return null
}

/**
 * JSON 숫자로 들어온 epoch.
 *
 * 나노초 epoch(약 1.8e18)는 이미 Number.MAX_SAFE_INTEGER 를 넘으므로
 * 이 경로로 들어온 값은 원본 자체가 부정확하다. 파이썬도 같은 한계가 있다.
 * 마이크로초까지만 신뢰하고 그 아래는 0 으로 둔다.
 */
function fromEpochNumber(n: number): Ts | null {
  for (const div of [1, 1e3, 1e6, 1e9]) {
    const seconds = n / div
    if (inEpochRange(seconds)) {
      return tsFromNanos(BigInt(Math.round(seconds * 1e6)) * 1_000n)
    }
  }
  return null
}

function fromIso(text: string): Ts | null {
  const m = ISO_RE.exec(text.trim())
  if (!m) return null

  const datePart = m[1]!
  const timePart = m[2] ?? '00:00:00'
  const frac = m[3] ?? ''
  let zone = m[4] ?? 'Z' // 타임존 표기가 없으면 UTC 로 간주 (전 구간 UTC 전제)

  if (zone === 'z') zone = 'Z'
  // Date.parse 는 ±HH:mm 만 보장한다. +0900 형태에 콜론을 넣어준다.
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`

  const time = timePart.length === 5 ? `${timePart}:00` : timePart
  const nanoStr = (frac + '000000000').slice(0, 9)

  const ms = Date.parse(`${datePart}T${time}.${nanoStr.slice(0, 3)}${zone}`)
  if (Number.isNaN(ms)) return null

  // ms 이하 6자리가 나노초 나머지다.
  const subMs = BigInt(nanoStr.slice(3))
  return { date: new Date(ms), nanos: BigInt(ms) * 1_000_000n + subMs }
}

/** 어떤 형태로 들어온 타임스탬프든 Ts 로 바꾼다. 못 읽으면 null. */
export function parseTs(value: unknown): Ts | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    return fromEpochNumber(value)
  }
  if (typeof value !== 'string') return null

  const text = value.trim()
  if (text === '') return null

  if (/^\d{9,19}(?:\.\d+)?$/.test(text)) return fromEpochDigits(text)
  return fromIso(text)
}

/** JSON 이 아닌 줄에서 타임스탬프처럼 보이는 부분을 찾아 파싱한다. */
export function sniffTs(line: string): Ts | null {
  const m = TS_SNIFF.exec(line)
  return m ? parseTs(m[1]!) : null
}

/**
 * 별칭 목록에서 처음으로 값이 있는 키를 고른다.
 * 파이썬 pick 과 같이 null 과 빈 문자열은 없는 것으로 본다 (0 과 false 는 유효).
 */
export function pick(
  fields: Record<string, unknown>,
  keys: readonly string[],
): [string | null, unknown] {
  for (const key of keys) {
    if (Object.hasOwn(fields, key)) {
      const value = fields[key]
      if (value !== null && value !== undefined && value !== '') {
        return [key, value]
      }
    }
  }
  return [null, undefined]
}

/**
 * 호출 위치를 'rabbitmq.go:300' 처럼 짧게 뽑는다.
 *
 * Go slog 의 source 객체는 function 경로가 아주 길어서 그대로 찍으면
 * 한 줄이 화면을 다 먹는다. 정작 필요한 건 파일명과 줄 번호다.
 * zap 의 "caller":"consumer/rabbitmq.go:300" 문자열도 같이 받는다.
 */
export function callerOf(fields: Record<string, unknown>): string {
  const [, raw] = pick(fields, CALLER_KEYS)

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    const base = basename(String(obj['file'] ?? ''))
    const line = obj['line']
    if (base !== '' && line !== null && line !== undefined) return `${base}:${line}`
    return base
  }
  if (typeof raw === 'string') return basename(raw)
  return ''
}

function basename(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * JSON 문자열이 통째로 들어있는 필드를 실제 객체로 풀어준다.
 *
 * 어떤 서비스는 외부 응답을 {"body":"{\"state\":\"STARTED\",...}"} 처럼
 * 문자열로 통째로 박는다. 풀어놓지 않으면 안쪽 값(state 등)을 볼 수도,
 * 반복 판정에 쓸 수도 없다. 원본 줄은 raw 에 그대로 남으므로 잃는 건 없다.
 */
export function parseEmbeddedJson(node: unknown, depth = 0): unknown {
  if (depth > EMBED_MAX_DEPTH) return node

  if (Array.isArray(node)) {
    return node.map((v) => parseEmbeddedJson(v, depth + 1))
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = parseEmbeddedJson(v, depth + 1)
    }
    return out
  }
  if (typeof node === 'string') {
    const text = node.trim()
    const opens = text.length > 1 && (text[0] === '{' || text[0] === '[')
    const closes = text.endsWith('}') || text.endsWith(']')
    if (opens && closes) {
      try {
        return parseEmbeddedJson(JSON.parse(text), depth + 1)
      } catch {
        return node
      }
    }
  }
  return node
}

/** 지문 계산 전에 매 줄 달라지는 키를 재귀적으로 제거한다. */
export function stripVolatile(node: unknown, depth = 0): unknown {
  if (depth > MAX_NEST_DEPTH) return node

  if (Array.isArray(node)) {
    return node.map((v) => stripVolatile(v, depth + 1))
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      if (!VOLATILE_KEYS.has(k)) out[k] = stripVolatile(v, depth + 1)
    }
    return out
  }
  return node
}
