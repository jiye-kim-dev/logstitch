/**
 * 수집기(Go)와 파서(TS) 사이의 계약, 그리고 파서가 만드는 레코드 타입.
 *
 * 수집기는 로그 줄을 불투명한 문자열로 넘긴다. 그 줄을 해석해서
 * LogRecord 로 만드는 것이 이 패키지의 일이다.
 */

// ── 수집기가 흘리는 NDJSON 이벤트 ───────────────────────────────────────────

export type HostStatus = 'ok' | 'timeout' | 'ssh_error' | 'no_ssh_binary'

/**
 * 검색 조건 하나.
 *
 * 여러 개면 수집기가 원격에서 grep 을 이어붙여 교집합을 만든다 — 모든 값이
 * 같은 줄에 있어야 남는다. 순서가 의미를 가지며 첫 항목이 주 식별자다.
 */
export interface Criterion {
  field: string
  value: string
}

/**
 * 앱 설정(apps.json)의 표현 힌트. 수집기는 해석하지 않고 그대로 실어 보낸다.
 *
 * 힌트만으로도 범용 뷰가 동작하도록 선언적인 값만 담는다 — FSM 해석 같은
 * 앱 의미론은 JSON 으로 표현하는 순간 설정 파일이 DSL 이 되므로, 그건
 * 파서의 앱 프로필 코드(profiles.ts)에 둔다.
 */
export interface ViewHint {
  /** 기본 뷰 이름. timeline | flow | contention */
  default?: string
  /** contention 뷰에서 레인을 나눌 필드 (예: server_id). 없으면 host 로 나눈다. */
  lane?: string
  /** 세션 구분 필드 (예: trace_id). 레인 안에서 세션이 바뀌는 지점을 표시한다. */
  session?: string
  /**
   * lane 필드가 없거나 빈 줄의 레인 폴백: 'host'(기본) 또는 'source'.
   *
   * 한 호스트가 인스턴스 여러 개를 돌리고 인벤토리 소스명이 인스턴스를
   * 식별하면(forwarder: 소스 forwarder-a/b = server_id 값) 'source' 로 두어야
   * 세션 컨텍스트 전에 찍힌 줄이 제 레인에 합류한다. 반대로 호스트마다
   * 같은 소스명을 쓰는 배치에서 'source' 를 쓰면 서로 다른 노드가 한 레인으로
   * 합쳐지므로 기본값은 'host' 다.
   */
  laneFallback?: string
}

export interface MetaEvent {
  type: 'meta'
  /**
   * 이 수집이 어느 앱·환경에서 왔는지.
   *
   * 줄마다 싣지 않고 여기 한 번만 온다. 파서가 모든 레코드에 찍어주므로
   * JSONL 파일만 봐도 어디서 온 것인지 알 수 있다.
   */
  app: string
  environment: string
  /** 검색 조건. 첫 항목이 주 식별자이고 매칭 종류 판정에 쓰인다. */
  fields: Criterion[]
  startedAt: string
  targets: number
  /**
   * 인벤토리에 정의된 영역 순서.
   *
   * 호스트별 결과는 도착 순서로 섞여 들어오므로, 출력 순서를 재현하려면
   * 수집기가 알려준 이 순서를 써야 한다.
   */
  areas?: string[]
  /** 앱 설정의 표현 힌트. 수집기가 apps.json 에서 그대로 실어 보낸다. */
  view?: ViewHint
}

export interface LineEvent {
  type: 'line'
  area: string
  host: string
  source: string
  file: string
  line: string
}

export interface HostEvent {
  type: 'host'
  area: string
  host: string
  status: HostStatus
  lineCount: number
  truncated: boolean
  error?: string
  elapsedMs: number
}

export type CollectorEvent = MetaEvent | LineEvent | HostEvent

// ── 타임스탬프 ──────────────────────────────────────────────────────────────

/**
 * 나노초까지 보존하는 타임스탬프.
 *
 * JS Date 는 밀리초까지만 담는데 실제 로그는 나노초 9자리로 찍힌다
 * (`"time":"2026-09-04T02:19:24.568353422Z"`). 이 도구의 존재 이유가
 * 노드 간 인과 순서이므로, 같은 밀리초 안의 순서를 잃으면 안 된다.
 * 그래서 표시용 Date 와 정렬용 나노초를 따로 들고 다닌다.
 */
export interface Ts {
  /** 표시용. 밀리초까지만 정확하다. */
  date: Date
  /** 정렬용. epoch 기준 나노초. */
  nanos: bigint
}

// ── 매칭 종류 ───────────────────────────────────────────────────────────────

/**
 * 원격 grep 은 값이 어느 필드에 있든 잡는다. 여기서 어디에서 걸렸는지 구분한다.
 *
 * 파이썬 구현은 이걸 `"nested:form_data.source_file_name[0]"` 같은 문자열로
 * 두고 렌더링 시점에 다시 파싱했다. union 으로 두면 그 문자열 파싱이 사라진다.
 *
 * - `field`     찾던 필드에 정확히 그 값 (원하는 것)
 * - `nested`    중첩 구조 안에 값이 그대로 — 진짜 매칭이다
 * - `partial`   그 경로의 값 "안에" 포함 (`"<rid>.mp3"`, ffmpeg 명령줄의 경로)
 * - `other`     다른 최상위 필드에 같은 값 (`parent_rid`) — 다른 요청일 수 있다
 * - `substring` 값이 든 위치를 특정하지 못했다
 * - `raw`       JSON 이 아닌 줄 (panic/스택트레이스) — 항상 살린다
 */
export type MatchKind =
  | { kind: 'field' }
  | { kind: 'nested'; path: string }
  | { kind: 'partial'; path: string }
  | { kind: 'other'; key: string }
  | { kind: 'substring' }
  | { kind: 'raw' }

/** --strict 가 제외하는 종류. 다른 요청으로 보이거나 위치를 특정 못 한 줄. */
export function isWeakMatch(match: MatchKind): boolean {
  return match.kind === 'other' || match.kind === 'substring'
}

// ── 레코드 ──────────────────────────────────────────────────────────────────

export interface LogRecord {
  /** 어느 앱·환경에서 수집됐는지. meta 이벤트에서 받아 모든 레코드에 찍는다. */
  app: string
  environment: string
  area: string
  host: string
  source: string
  file: string

  /**
   * 같은 (호스트, 파일) 안에서의 원래 줄 순서.
   *
   * 정렬 키의 마지막 항목이라 같은 시각에 찍힌 줄들의 인과 순서가 뒤집히지
   * 않게 해준다. 전역 카운터를 쓰면 호스트별 응답이 도착 순서로 들어오는
   * 탓에 실행마다 값이 달라져서 JSONL 출력이 재현되지 않는다.
   */
  seq: number

  /** 원본 줄. JSON 파싱에 실패해도 이건 항상 남는다. */
  raw: string
  isJson: boolean
  fields: Record<string, unknown>

  ts: Ts | null
  /** 시각을 못 읽어서 직전 줄의 시각을 물려받았는지 (스택트레이스 연속 줄 등). */
  tsInherited: boolean
  tsKey: string | null

  level: string
  msg: string
  caller: string

  /** 회색 필드 줄에서 뺄 키 — 별칭 목록 전체가 아니라 실제로 쓴 키만. */
  usedKeys: string[]

  match: MatchKind
  /** 시각을 뺀 레코드 지문. 같으면 "내용이 똑같은 줄"이다. */
  sig: string | null

  /** 접힌 줄 수 (1 이면 안 접힘). */
  repeat?: number
  repeatUntil?: Ts
}

/** 호스트별 실행 결과. 요약에 쓴다. */
export interface HostResult {
  area: string
  host: string
  status: HostStatus
  lineCount: number
  truncated: boolean
  error?: string
  elapsedMs: number
}
