/**
 * apps.json ↔ 폼 편집용 초안(Draft) 변환. 스키마: schemas/apps.schema.json
 *
 * 폼이 모르는 키는 extra 로 보존했다가 저장 때 되돌려 쓴다 — 폼으로 편집했다는
 * 이유로 사람이 손으로 적어둔 값이 조용히 사라지면 안 되기 때문이다.
 * 반대로 폼으로 표현할 수 없는 모양(타입이 다른 값)은 parseDraft 가 던지고,
 * 편집기는 JSON 모드로 떨어진다.
 */

export const VIEW_DEFAULTS = ['timeline', 'flow', 'contention'] as const
export type ViewDefault = (typeof VIEW_DEFAULTS)[number]

export const LANE_FALLBACKS = ['host', 'source'] as const
export type LaneFallback = (typeof LANE_FALLBACKS)[number]

export const PARSER_KEYS = ['tsKeys', 'levelKeys', 'msgKeys', 'callerKeys'] as const
export type ParserKey = (typeof PARSER_KEYS)[number]

type Json = Record<string, unknown>

export interface AppDraft {
  /** React key 전용 — 이름은 편집 중에 바뀌므로 key 로 못 쓴다 */
  id: number
  name: string
  required: string[]
  note: string
  /** _comment — 한 줄이 배열 원소 하나 */
  comment: string
  commentAsString: boolean
  view: {
    default: ViewDefault | ''
    lane: string
    session: string
    laneFallback: LaneFallback | ''
  }
  viewExtra: Json
  parser: Record<ParserKey, string[]>
  parserExtra: Json
  extra: Json
}

export interface Draft {
  schema: string | null
  comment: string
  commentAsString: boolean
  apps: AppDraft[]
  extra: Json
}

// ── 읽기 ────────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strArr(v: unknown, where: string): string[] {
  if (v === undefined) return []
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return [...(v as string[])]
  throw new Error(`${where} 는 문자열 배열이어야 합니다`)
}

function str(v: unknown, where: string): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  throw new Error(`${where} 는 문자열이어야 합니다`)
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T | '' {
  if (v === undefined) return ''
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
  throw new Error(`${where} 는 ${allowed.join(' | ')} 중 하나여야 합니다`)
}

function commentIn(v: unknown, where: string): { text: string; asString: boolean } {
  if (v === undefined) return { text: '', asString: false }
  if (typeof v === 'string') return { text: v, asString: true }
  return { text: strArr(v, where).join('\n'), asString: false }
}

function rest(o: Json, known: readonly string[]): Json {
  const out: Json = {}
  for (const [k, v] of Object.entries(o)) if (!known.includes(k)) out[k] = v
  return out
}

let nextId = 1

export function emptyApp(): AppDraft {
  return {
    id: nextId++,
    name: '',
    required: [],
    note: '',
    comment: '',
    commentAsString: false,
    view: { default: '', lane: '', session: '', laneFallback: '' },
    viewExtra: {},
    parser: { tsKeys: [], levelKeys: [], msgKeys: [], callerKeys: [] },
    parserExtra: {},
    extra: {},
  }
}

function appFrom(name: string, v: unknown): AppDraft {
  const at = `apps.${name}`
  if (!isObj(v)) throw new Error(`${at} 가 객체가 아닙니다`)
  const view = v['view'] ?? {}
  if (!isObj(view)) throw new Error(`${at}.view 가 객체가 아닙니다`)
  const parser = v['parser'] ?? {}
  if (!isObj(parser)) throw new Error(`${at}.parser 가 객체가 아닙니다`)
  const c = commentIn(v['_comment'], `${at}._comment`)
  return {
    id: nextId++,
    name,
    required: strArr(v['required'], `${at}.required`),
    note: str(v['note'], `${at}.note`),
    comment: c.text,
    commentAsString: c.asString,
    view: {
      default: oneOf(view['default'], VIEW_DEFAULTS, `${at}.view.default`),
      lane: str(view['lane'], `${at}.view.lane`),
      session: str(view['session'], `${at}.view.session`),
      laneFallback: oneOf(view['laneFallback'], LANE_FALLBACKS, `${at}.view.laneFallback`),
    },
    viewExtra: rest(view, ['default', 'lane', 'session', 'laneFallback']),
    parser: {
      tsKeys: strArr(parser['tsKeys'], `${at}.parser.tsKeys`),
      levelKeys: strArr(parser['levelKeys'], `${at}.parser.levelKeys`),
      msgKeys: strArr(parser['msgKeys'], `${at}.parser.msgKeys`),
      callerKeys: strArr(parser['callerKeys'], `${at}.parser.callerKeys`),
    },
    parserExtra: rest(parser, PARSER_KEYS),
    extra: rest(v, ['_comment', 'required', 'view', 'parser', 'note']),
  }
}

/** JSON 문법 오류는 SyntaxError, 폼으로 표현 못 하는 모양은 Error 로 던진다. */
export function parseDraft(text: string): Draft {
  const parsed: unknown = JSON.parse(text)
  if (!isObj(parsed)) throw new Error('최상위가 객체가 아닙니다')
  const apps = parsed['apps'] ?? {}
  if (!isObj(apps)) throw new Error('apps 가 객체가 아닙니다')
  const schema = parsed['$schema']
  if (schema !== undefined && typeof schema !== 'string') throw new Error('$schema 는 문자열이어야 합니다')
  const c = commentIn(parsed['_comment'], '_comment')
  return {
    schema: schema ?? null,
    comment: c.text,
    commentAsString: c.asString,
    apps: Object.entries(apps).map(([name, v]) => appFrom(name, v)),
    extra: rest(parsed, ['$schema', '_comment', 'apps']),
  }
}

// ── 쓰기 ────────────────────────────────────────────────────────────────────

function commentOut(text: string, asString: boolean): string | string[] | undefined {
  if (text.trim() === '') return undefined
  if (asString && !text.includes('\n')) return text
  return text.split('\n')
}

function appOut(a: AppDraft): Json {
  const o: Json = {}
  const comment = commentOut(a.comment, a.commentAsString)
  if (comment !== undefined) o['_comment'] = comment
  o['required'] = a.required

  const view: Json = {}
  if (a.view.default !== '') view['default'] = a.view.default
  if (a.view.lane.trim() !== '') view['lane'] = a.view.lane.trim()
  if (a.view.session.trim() !== '') view['session'] = a.view.session.trim()
  if (a.view.laneFallback !== '') view['laneFallback'] = a.view.laneFallback
  Object.assign(view, a.viewExtra)
  if (Object.keys(view).length > 0) o['view'] = view

  const parser: Json = {}
  for (const k of PARSER_KEYS) if (a.parser[k].length > 0) parser[k] = a.parser[k]
  Object.assign(parser, a.parserExtra)
  if (Object.keys(parser).length > 0) o['parser'] = parser

  if (a.note.trim() !== '') o['note'] = a.note.trim()
  Object.assign(o, a.extra)
  return o
}

export function serializeDraft(d: Draft): string {
  const o: Json = {}
  if (d.schema !== null) o['$schema'] = d.schema
  const comment = commentOut(d.comment, d.commentAsString)
  if (comment !== undefined) o['_comment'] = comment
  const apps: Json = {}
  for (const a of d.apps) apps[a.name.trim()] = appOut(a)
  o['apps'] = apps
  Object.assign(o, d.extra)
  return `${formatJson(o)}\n`
}

// 손으로 쓴 파일과 같은 모양: 원시값만 담은 짧은 배열/객체는 한 줄로 접는다
// ("required": ["rid"], "view": { "default": "flow" }). 그 외는 2칸 들여쓰기.
const WIDTH = 140

function isPrim(v: unknown): boolean {
  return v === null || typeof v !== 'object'
}

function inline(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${v.map(inline).join(', ')}]`
  if (isObj(v)) {
    const e = Object.entries(v)
    if (e.length === 0) return '{}'
    return `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`
  }
  return JSON.stringify(v)
}

/**
 * lead: 같은 줄에서 이 값 앞에 이미 찍힌 글자 수 (들여쓰기 + "key": ).
 * expand: 짧아도 접지 않는다 — _comment 는 산문이라 한 줄에 하나씩 둔다.
 */
export function formatJson(v: unknown, indent = '', lead = 0, expand = false): string {
  if (isPrim(v)) return JSON.stringify(v)
  const flat = Array.isArray(v) ? v.every(isPrim) : Object.values(v as Json).every(isPrim)
  if (flat && !(expand && Array.isArray(v) && v.length > 0)) {
    const s = inline(v)
    if (lead + s.length <= WIDTH) return s
  }
  const inner = `${indent}  `
  if (Array.isArray(v)) {
    return `[\n${v.map((x) => inner + formatJson(x, inner, inner.length)).join(',\n')}\n${indent}]`
  }
  const lines = Object.entries(v as Json).map(([k, x]) => {
    const key = `${JSON.stringify(k)}: `
    return inner + key + formatJson(x, inner, inner.length + key.length, k === '_comment')
  })
  return `{\n${lines.join(',\n')}\n${indent}}`
}

// ── 검증 (스키마의 필수 제약만) ─────────────────────────────────────────────

export interface Problems {
  global: string[]
  byApp: Map<number, string[]>
  count: number
}

export function validate(d: Draft): Problems {
  const global: string[] = []
  const byApp = new Map<number, string[]>()
  if (d.apps.length === 0) global.push('앱이 최소 1개 필요합니다')

  const seen = new Map<string, number>()
  for (const a of d.apps) seen.set(a.name.trim(), (seen.get(a.name.trim()) ?? 0) + 1)

  for (const a of d.apps) {
    const p: string[] = []
    const name = a.name.trim()
    if (name === '') p.push('앱 이름이 비어 있습니다')
    else if ((seen.get(name) ?? 0) > 1) p.push(`앱 이름 "${name}" 이 중복됩니다`)
    else if (name === '__proto__') p.push('사용할 수 없는 이름입니다')
    if (a.required.length === 0) p.push('필수 필드(required)가 최소 1개 필요합니다')
    if (p.length > 0) byApp.set(a.id, p)
  }
  let count = global.length
  for (const p of byApp.values()) count += p.length
  return { global, byApp, count }
}
