#!/usr/bin/env node
/**
 * logstitch-parse — 단일 진입점. 수집 플래그(--app 등)를 주면 수집기(Go)를
 * 직접 실행해 그 출력을 파싱하고, 없으면 stdin 의 NDJSON 을 파싱한다.
 *
 *   logstitch-parse --app ai-stt --env prod --rid abc123        # 수집 모드
 *   logstitch --rid abc123 | logstitch-parse                    # 파이프 모드
 *   logstitch --rid abc123 | logstitch-parse --json > trace.jsonl
 *
 * 수집 모드에서도 ssh·인벤토리·원격 스크립트는 전부 수집기 소유다 — 여기는
 * 플래그를 검증 없이 그대로 전달할 뿐이다 (검증 규칙이 두 벌이 되지 않게).
 *
 * 수집기는 로그 내용을 모른다. 타임스탬프 파싱, 필드 별칭 해석, 매칭 종류
 * 판정, 반복 접기, 정렬이 전부 여기서 일어난다.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  FAR_FUTURE_NANOS,
  mergeAliases,
  parseParserHint,
  parseTs,
  rangeEndNanos,
} from './fields.ts'
import {
  PROFILES,
  VIEW_NAMES,
  contentionSetup,
  isViewName,
  parseViewHint,
  resolveView,
} from './profiles.ts'
import type { ViewName } from './profiles.ts'
import { Normalizer, collapseRuns } from './records.ts'
import { renderJsonl, renderSummary, renderText } from './render.ts'
import { isWeakMatch } from './types.ts'
import type { CollectorEvent, Criterion, HostResult, LogRecord, ViewHint } from './types.ts'
import { renderContention } from './view-contention.ts'
import { renderFlow } from './view-flow.ts'

interface WhereClause {
  key: string
  value: string
}

function fail(message: string): never {
  process.stderr.write(`[오류] ${message}\n`)
  process.exit(2)
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      strict: { type: 'boolean', default: false },
      where: { type: 'string', multiple: true, default: [] },
      view: { type: 'string' },
      'no-collapse': { type: 'boolean', default: false },
      'no-embed': { type: 'boolean', default: false },
      'no-extra': { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'extra-width': { type: 'string', default: '400' },
      'value-cap': { type: 'string', default: '120' },
      help: { type: 'boolean', default: false },
      // ── 수집기로 그대로 전달되는 플래그 (하나라도 주면 수집 모드) ──────
      app: { type: 'string' },
      env: { type: 'string' },
      rid: { type: 'string' },
      field: { type: 'string', multiple: true, default: [] },
      area: { type: 'string', multiple: true, default: [] },
      from: { type: 'string' },
      to: { type: 'string' },
      after: { type: 'string' },
      timeout: { type: 'string' },
      workers: { type: 'string' },
      'max-lines': { type: 'string' },
      'no-required': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      apps: { type: 'string' },
      inventory: { type: 'string' },
      // 수집기 바이너리 경로 (수집 모드 전용). 기본 탐색 순서는
      // resolveCollector 참고.
      collector: { type: 'string' },
    },
    strict: true,
  })

  if (values.help) {
    process.stdout.write(
      [
        '사용: logstitch-parse --app <앱> --env <환경> [수집 옵션] [파서 옵션]',
        '      logstitch --rid <값> | logstitch-parse [파서 옵션]',
        '',
        '수집 옵션 — 하나라도 주면 수집기(Go)를 직접 실행한다. 검증 없이 그대로',
        '전달되므로 의미는 logstitch --help 와 같다:',
        '  --app --env --rid --field --area --from --to --after --timeout',
        '  --workers --max-lines --no-required --dry-run --apps --inventory',
        '  --collector <경로>  수집기 바이너리. 기본: $LOGSTITCH_COLLECTOR →',
        '                     저장소의 .bin/logstitch → PATH 의 logstitch',
        '',
        '파서 옵션:',
        '  --strict           다른 요청으로 보이는 줄(other)과 위치를 특정하지',
        '                     못한 줄(substring)을 제외한다',
        '  --where key=value  추가 로컬 필터 (반복 가능)',
        '  --view <이름>       출력 뷰를 고른다: timeline | flow | contention',
        '                     기본값은 앱 설정(apps.json)의 view 힌트를 따른다',
        '                       timeline    전 영역 병합 타임라인 (기존 출력)',
        '                       flow        영역별 블록 + 핸드오프 갭 (순차 파이프라인용)',
        '                       contention  노드 레인 + Δ 간격 (경쟁 구도용)',
        '  --no-collapse      내용이 똑같이 반복되는 줄을 접지 않는다',
        '  --no-embed         JSON 문자열이 든 필드(body 등)를 풀지 않는다',
        '  --no-extra         나머지 JSON 필드를 출력하지 않는다',
        '  --no-color         색을 쓰지 않는다',
        '  --json             JSONL 로 출력한다',
        '  --extra-width N    회색 필드 줄의 최대 길이. 0 이면 자르지 않음 (기본 400)',
        '  --value-cap N      개별 값의 최대 길이. 0 이면 자르지 않음 (기본 120)',
        '',
      ].join('\n'),
    )
    process.exit(0)
  }

  const clauses: WhereClause[] = []
  for (const clause of values.where) {
    const cut = clause.indexOf('=')
    if (cut <= 0) fail(`--where 형식은 key=value 입니다: ${clause}`)
    clauses.push({ key: clause.slice(0, cut), value: clause.slice(cut + 1) })
  }

  const toInt = (raw: string, name: string): number => {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) fail(`${name} 은 0 이상의 정수여야 합니다: ${raw}`)
    return n
  }

  let view: ViewName | undefined
  if (values.view !== undefined) {
    if (!isViewName(values.view)) {
      fail(`--view 는 ${VIEW_NAMES.join(' | ')} 중 하나여야 합니다: ${values.view}`)
    }
    view = values.view
  }

  // ── 수집기로 넘길 인자를 모은다 — 하나라도 있으면 수집 모드다 ──────────
  // 숫자 플래그도 문자열 그대로 넘긴다. 여기서 파싱하면 검증 규칙이 두 벌이
  // 된다 (수집기 server.go 의 buildAPIRequest 와 같은 원칙).
  const collect: string[] = []
  const forward = (flag: string, value: string | undefined): void => {
    if (value !== undefined) collect.push(flag, value)
  }
  forward('--app', values.app)
  forward('--env', values.env)
  forward('--rid', values.rid)
  for (const spec of values.field) collect.push('--field', spec)
  // 검색 조건 밖의 수집 옵션은 따로 모은다 — .runs 의 meta.json 에도 남긴다.
  const opts: string[] = []
  const forwardOpt = (flag: string, value: string | undefined): void => {
    if (value !== undefined) opts.push(flag, value)
  }
  for (const name of values.area) opts.push('--area', name)
  forwardOpt('--from', values.from)
  forwardOpt('--to', values.to)
  forwardOpt('--after', values.after)
  forwardOpt('--timeout', values.timeout)
  forwardOpt('--workers', values.workers)
  forwardOpt('--max-lines', values['max-lines'])
  if (values['no-required']) opts.push('--no-required')
  collect.push(...opts)
  forward('--apps', values.apps)
  forward('--inventory', values.inventory)
  if (values['dry-run']) collect.push('--dry-run')

  // ── 설정 파일 기본값 ────────────────────────────────────────────────────
  // 수집기의 기본 경로(apps.json, inventory.<앱>.<환경>.json)는 CWD 상대라서,
  // 전역 링크된 이 명령을 아무 데서나 실행하면 못 찾는다. CWD 에 apps.json 이
  // 있으면 기존 파이프 모드처럼 수집기 기본값(CWD)에 맡기고, 없으면 수집기
  // 바이너리를 찾을 때와 같은 원리로 저장소 루트의 설정을 명시해서 넘긴다.
  if (collect.length > 0 && values.apps === undefined && !existsSync('apps.json')) {
    const rootApps = fileURLToPath(new URL('../../apps.json', import.meta.url))
    if (existsSync(rootApps)) {
      collect.push('--apps', rootApps)
      if (values.inventory === undefined) {
        collect.push('--inventory', fileURLToPath(new URL('../../inventory', import.meta.url)))
      }
    }
  }

  // ── 원본 보존용 실행 정보 (수집 모드, dry-run 제외) ─────────────────────
  const fields: Record<string, string> = {}
  if (values.rid !== undefined) fields['rid'] = values.rid
  for (const spec of values.field) {
    const cut = spec.indexOf('=')
    if (cut > 0 && !(spec.slice(0, cut) in fields)) fields[spec.slice(0, cut)] = spec.slice(cut + 1)
  }
  const run: RunInfo | null =
    collect.length > 0 && !values['dry-run']
      ? { app: values.app ?? 'app', env: values.env ?? '', fields, opts }
      : null

  return {
    strict: values.strict,
    where: clauses,
    view,
    collapse: !values['no-collapse'],
    embed: !values['no-embed'],
    showExtra: !values['no-extra'],
    json: values.json,
    color: !values['no-color'] && !values.json && process.stdout.isTTY === true,
    extraWidth: toInt(values['extra-width'], '--extra-width'),
    valueCap: toInt(values['value-cap'], '--value-cap'),
    collect: collect.length > 0 ? collect : null,
    collectorBin: values.collector,
    dryRun: values['dry-run'],
    run,
  }
}

/** .runs 에 남길 실행 정보. 기존 수집 스크립트의 meta.json 과 같은 모양이다. */
interface RunInfo {
  app: string
  env: string
  fields: Record<string, string>
  opts: string[]
}

/**
 * .runs/<로컬시각>-<앱>-<주값 8자>/ 를 만들고 meta.json 을 쓴다.
 * 이름 규약은 기존 수집 스크립트가 만들던 것과 같다 (20260911-150417-forwarder-rjcgd0cu).
 */
// ponytail: .runs 는 항상 저장소 루트에 쓴다 — 다른 위치가 필요해지면 그때 플래그로
function newRunDir(run: RunInfo): string {
  const now = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_')
  const slug = clean(Object.values(run.fields)[0] ?? '').slice(0, 8) || 'run'

  const dir = fileURLToPath(
    new URL(`../../.runs/${stamp}-${clean(run.app)}-${slug}`, import.meta.url),
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'meta.json'),
    `${JSON.stringify({
      app: run.app,
      env: run.env,
      fields: run.fields,
      opts: run.opts,
      collected_at: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    })}\n`,
  )
  return dir
}

/**
 * 수집기(Go 바이너리) 경로를 정한다:
 * --collector > $LOGSTITCH_COLLECTOR > 저장소의 빌드 산출물 > PATH.
 */
function resolveCollector(flagValue: string | undefined): string {
  if (flagValue !== undefined) return flagValue
  const fromEnv = process.env['LOGSTITCH_COLLECTOR']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const local = fileURLToPath(new URL('../../.bin/logstitch', import.meta.url))
  return existsSync(local) ? local : 'logstitch'
}

async function main(): Promise<number> {
  const opt = parseCliArgs()

  // ── 입력 소스: 수집 모드면 수집기를 spawn, 아니면 stdin ─────────────────
  // 수집기 stderr(진행/요약)는 터미널로 그대로 상속된다 — 파이프 모드와 동일.
  let input: NodeJS.ReadableStream = process.stdin
  let collectorDone: Promise<number | null> | null = null
  if (opt.collect !== null) {
    const bin = resolveCollector(opt.collectorBin)
    const child = spawn(bin, opt.collect, { stdio: ['ignore', 'pipe', 'inherit'] })
    child.on('error', (error) => {
      fail(
        `수집기를 실행할 수 없습니다 (${bin}): ${error.message}\n` +
          `       go build -C collector -o ../.bin/logstitch . 으로 빌드하거나\n` +
          `       LOGSTITCH_COLLECTOR 또는 --collector 로 경로를 지정하세요`,
      )
    })
    // close 는 stdout 을 다 읽기 전에도 날 수 있으므로 지금 구독해둔다 —
    // 나중에 once() 로 기다리면 이미 지나간 이벤트를 영영 기다리게 된다.
    collectorDone = new Promise((resolve) => {
      child.on('close', (code) => resolve(code))
    })
    if (child.stdout === null) fail('수집기 stdout 파이프를 열지 못했습니다')
    input = child.stdout

    if (opt.dryRun) {
      // dry-run 출력은 NDJSON 이 아니라 원격 스크립트다. 파싱 없이 그대로 흘린다.
      input.pipe(process.stdout)
      return (await collectorDone) ?? 0
    }
  }

  const records: LogRecord[] = []
  const hosts: HostResult[] = []
  const areaOrder: string[] = []
  const seenArea = new Set<string>()

  let normalizer: Normalizer | null = null
  let app = ''
  let environment = ''
  let criteria: Criterion[] = []
  let viewHint: ViewHint | undefined
  let malformed = 0
  // 수집기 --from/--to 의 시각 범위. 원격 awk 는 관대한 프리필터라서
  // (시각을 못 읽은 줄과 epoch 숫자는 통과) 정확한 판정은 여기서 한다.
  let timeFrom = ''
  let timeTo = ''
  let timeFromNanos: bigint | null = null
  let timeToEndNanos: bigint | null = null // 배타적 상한

  // ── 원본 보존 ─────────────────────────────────────────────────────────
  // 수집기를 파서가 삼키는 구조라 여기서 남기지 않으면 원본 NDJSON 이
  // 사라진다. 첫 이벤트가 오면 .runs/ 아래에 raw.ndjson 을 연다 (수집기가
  // 검증에서 죽어 아무것도 안 오면 빈 디렉토리도 안 생긴다). 같은 검색을
  // ssh 없이 재파싱할 수 있다: logstitch-parse [파서 옵션] < raw.ndjson
  let rawSink: WriteStream | null = null
  let rawPath = ''
  const runInfo = opt.run

  const rl = createInterface({ input, crlfDelay: Infinity })

  for await (const line of rl) {
    if (line.trim() === '') continue

    if (runInfo !== null) {
      if (rawSink === null) {
        const dir = newRunDir(runInfo)
        rawPath = join(dir, 'raw.ndjson')
        rawSink = createWriteStream(rawPath)
      }
      rawSink.write(`${line}\n`)
    }

    let event: CollectorEvent
    try {
      event = JSON.parse(line) as CollectorEvent
    } catch {
      malformed += 1
      continue
    }

    switch (event.type) {
      case 'meta': {
        app = event.app ?? ''
        environment = event.environment ?? ''
        criteria = event.fields ?? []
        // 범위는 수집기가 이미 검증·정규화했다. 그래도 못 읽으면 버전이
        // 어긋난 것이므로, 필터가 조용히 무효가 되는 대신 소리 내고 죽는다.
        timeFrom = event.timeFrom ?? ''
        timeTo = event.timeTo ?? ''
        if (timeFrom !== '') {
          timeFromNanos = parseTs(timeFrom)?.nanos ?? null
          if (timeFromNanos === null) fail(`meta 의 timeFrom 을 해석할 수 없습니다: ${timeFrom}`)
        }
        if (timeTo !== '') {
          timeToEndNanos = rangeEndNanos(timeTo)
          if (timeToEndNanos === null) fail(`meta 의 timeTo 를 해석할 수 없습니다: ${timeTo}`)
        }
        // 수집기는 view/parser 힌트를 해석하지 않고 흘리므로 형태 보장이 없다.
        viewHint = parseViewHint(event.view)
        // 주 식별자만 매칭 종류 판정에 쓴다. 나머지 조건은 수집기가 원격에서
        // 교집합으로 이미 걸러냈으므로 여기서 다시 볼 필요가 없다.
        const primary = criteria[0] ?? { field: '', value: '' }
        normalizer = new Normalizer({
          app,
          environment,
          field: primary.field,
          value: primary.value,
          embed: opt.embed,
          // 앱별 필드 별칭(apps.json 의 parser 힌트)을 전역 별칭 앞에 얹는다.
          aliases: mergeAliases(parseParserHint(event.parser)),
        })
        // 수집기가 인벤토리 순서를 알려주면 그걸 쓴다. 없으면 아래에서
        // 도착 순서로 채워지는데, 그건 실행마다 달라질 수 있다.
        for (const area of event.areas ?? []) {
          if (!seenArea.has(area)) {
            seenArea.add(area)
            areaOrder.push(area)
          }
        }
        break
      }

      case 'line': {
        if (normalizer === null) {
          fail('meta 이벤트가 먼저 오지 않았습니다 — 수집기 출력이 맞는지 확인하세요')
        }
        if (!seenArea.has(event.area)) {
          seenArea.add(event.area)
          areaOrder.push(event.area)
        }
        records.push(normalizer.push(event))
        break
      }

      case 'host':
        if (!seenArea.has(event.area)) {
          seenArea.add(event.area)
          areaOrder.push(event.area)
        }
        hosts.push({
          area: event.area,
          host: event.host,
          status: event.status,
          lineCount: event.lineCount,
          truncated: event.truncated,
          error: event.error,
          elapsedMs: event.elapsedMs,
        })
        break
    }
  }

  if (rawSink !== null) {
    // main 이 끝나면 process.exit 로 죽는데, exit 는 스트림 버퍼를 기다리지
    // 않는다. flush 완료를 기다려야 원본이 온전히 남는다.
    const sink = rawSink
    await new Promise<void>((resolve) => {
      sink.end(() => resolve())
    })
    process.stderr.write(`[원본] ${rawPath}\n`)
  }

  if (malformed > 0) {
    process.stderr.write(`[알림] NDJSON 으로 읽지 못한 줄 ${malformed}건을 건너뜀\n`)
  }

  if (collectorDone !== null) {
    const code = await collectorDone
    // 2 는 수집기의 검증·실행 오류다. 메시지는 stderr 상속으로 이미 나갔으니
    // 빈 "결과 없음" 요약을 덧붙이지 않고 같은 코드로 끝낸다. 1(결과 없음)은
    // meta·host 이벤트가 정상 도착하므로 아래에서 파서가 스스로 판정한다.
    if (code !== null && code >= 2) return code
  }

  // ── 로컬 필터 ─────────────────────────────────────────────────────────
  let kept = records
  if (opt.strict) {
    kept = kept.filter((r) => !isWeakMatch(r.match))
  }
  for (const clause of opt.where) {
    // JSON 이 아닌 줄(panic 등)은 필터를 통과시킨다 — 파이썬과 같은 규약.
    kept = kept.filter(
      (r) => !r.isJson || String(r.fields[clause.key]) === clause.value,
    )
  }
  if (timeFromNanos !== null || timeToEndNanos !== null) {
    // 시각을 못 읽은 줄은 통과시킨다 — --where 와 같은 규약. 여기서 자르면
    // panic 줄을 잃는다. (직전 줄에서 물려받은 시각은 판정에 쓴다.)
    kept = kept.filter((r) => {
      if (r.ts === null) return true
      if (timeFromNanos !== null && r.ts.nanos < timeFromNanos) return false
      if (timeToEndNanos !== null && r.ts.nanos >= timeToEndNanos) return false
      return true
    })
  }

  // ── 정렬 ──────────────────────────────────────────────────────────────
  // 전 구간 UTC 이므로 시각만 맞추면 그대로 정렬된다. 같은 시각이면 원래
  // 스트림 순서(seq)를 유지해서 인과 순서가 안 뒤집히게 한다.
  kept.sort((a, b) => {
    const an = a.ts?.nanos ?? FAR_FUTURE_NANOS
    const bn = b.ts?.nanos ?? FAR_FUTURE_NANOS
    if (an !== bn) return an < bn ? -1 : 1
    if (a.host !== b.host) return a.host < b.host ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.seq - b.seq
  })

  const beforeCollapse = kept.length
  if (opt.collapse) kept = collapseRuns(kept)
  const collapsed = beforeCollapse - kept.length

  const out = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  const err = (line: string): void => {
    process.stderr.write(`${line}\n`)
  }

  const summaryOptions = { app, environment, areaOrder, criteria, color: opt.color }

  if (kept.length === 0) {
    const shown = criteria.map((c) => `${c.field}=${c.value}`).join(' AND ')
    const range =
      timeFrom !== '' || timeTo !== '' ? ` (time ${timeFrom || '…'} ~ ${timeTo || '…'})` : ''
    err(`결과 없음: ${shown}${range}`)
    renderSummary(kept, hosts, summaryOptions, err)
    return 1
  }

  if (opt.json) {
    renderJsonl(kept, out)
  } else {
    const textOptions = {
      color: opt.color,
      showExtra: opt.showExtra,
      extraWidth: opt.extraWidth,
      valueCap: opt.valueCap,
    }

    // 뷰 선택: --view 플래그 > apps.json 힌트 > 앱 프로필 > timeline.
    const profile = PROFILES[app]
    const view = resolveView(opt.view, viewHint, profile)

    switch (view) {
      case 'flow':
        renderFlow(kept, areaOrder, textOptions, out)
        break
      case 'contention':
        renderContention(kept, contentionSetup(viewHint, profile), textOptions, out)
        break
      case 'timeline':
        renderText(kept, areaOrder, textOptions, out)
        break
    }
  }

  renderSummary(kept, hosts, { ...summaryOptions, collapsed }, err)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`[오류] ${String(error)}\n`)
    process.exit(2)
  })
