/**
 * 프레임워크에 의존하지 않는 파싱 라이브러리 진입점.
 *
 * 2차에서 붙는 웹 백엔드(Hono)와 프론트가 이 모듈을 그대로 import 한다.
 * 그래서 여기에는 stdin/stdout, 인자 파싱, 색 출력 같은 CLI 관심사를 두지
 * 않는다 — 그건 cli.ts 의 일이다.
 */

export {
  CALLER_KEYS,
  EMBED_MAX_DEPTH,
  FAR_FUTURE_NANOS,
  LEVEL_KEYS,
  MAX_NEST_DEPTH,
  MSG_KEYS,
  TS_KEYS,
  VOLATILE_KEYS,
  callerOf,
  parseEmbeddedJson,
  parseTs,
  pick,
  sniffTs,
  stripVolatile,
} from './fields.ts'

export { Normalizer, classifyMatch, collapseRuns, findValuePaths } from './records.ts'
export type { NormalizerOptions } from './records.ts'

export {
  matchNote,
  paint,
  renderJsonl,
  renderSummary,
  renderText,
} from './render.ts'
export type { SummaryOptions, TextOptions } from './render.ts'

export { isWeakMatch } from './types.ts'
export type {
  CollectorEvent,
  Criterion,
  HostEvent,
  HostResult,
  HostStatus,
  LineEvent,
  LogRecord,
  MatchKind,
  MetaEvent,
  Ts,
} from './types.ts'
