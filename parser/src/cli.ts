#!/usr/bin/env node
/**
 * logstitch-parse — 수집기(Go)의 NDJSON 을 받아 파싱·정렬·병합해서 보여준다.
 *
 *   logstitch --rid abc123 | logstitch-parse
 *   logstitch --rid abc123 | logstitch-parse --json > trace.jsonl
 *   logstitch --rid abc123 | logstitch-parse --strict --no-collapse
 *
 * 수집기는 로그 내용을 모른다. 타임스탬프 파싱, 필드 별칭 해석, 매칭 종류
 * 판정, 반복 접기, 정렬이 전부 여기서 일어난다.
 */

import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

import { FAR_FUTURE_NANOS } from './fields.ts'
import { Normalizer, collapseRuns } from './records.ts'
import { renderJsonl, renderSummary, renderText } from './render.ts'
import { isWeakMatch } from './types.ts'
import type { CollectorEvent, HostResult, LogRecord } from './types.ts'

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
      'no-collapse': { type: 'boolean', default: false },
      'no-embed': { type: 'boolean', default: false },
      'no-extra': { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'extra-width': { type: 'string', default: '400' },
      'value-cap': { type: 'string', default: '120' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })

  if (values.help) {
    process.stdout.write(
      [
        '사용: logstitch --rid <값> | logstitch-parse [옵션]',
        '',
        '  --strict           다른 요청으로 보이는 줄(other)과 위치를 특정하지',
        '                     못한 줄(substring)을 제외한다',
        '  --where key=value  추가 로컬 필터 (반복 가능)',
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

  return {
    strict: values.strict,
    where: clauses,
    collapse: !values['no-collapse'],
    embed: !values['no-embed'],
    showExtra: !values['no-extra'],
    json: values.json,
    color: !values['no-color'] && !values.json && process.stdout.isTTY === true,
    extraWidth: toInt(values['extra-width'], '--extra-width'),
    valueCap: toInt(values['value-cap'], '--value-cap'),
  }
}

async function main(): Promise<number> {
  const opt = parseCliArgs()

  const records: LogRecord[] = []
  const hosts: HostResult[] = []
  const areaOrder: string[] = []
  const seenArea = new Set<string>()

  let normalizer: Normalizer | null = null
  let environment = ''
  let field = ''
  let value = ''
  let malformed = 0

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  for await (const line of rl) {
    if (line.trim() === '') continue

    let event: CollectorEvent
    try {
      event = JSON.parse(line) as CollectorEvent
    } catch {
      malformed += 1
      continue
    }

    switch (event.type) {
      case 'meta':
        environment = event.environment ?? ''
        field = event.field
        value = event.value
        normalizer = new Normalizer(environment, field, value, opt.embed)
        // 수집기가 인벤토리 순서를 알려주면 그걸 쓴다. 없으면 아래에서
        // 도착 순서로 채워지는데, 그건 실행마다 달라질 수 있다.
        for (const area of event.areas ?? []) {
          if (!seenArea.has(area)) {
            seenArea.add(area)
            areaOrder.push(area)
          }
        }
        break

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

  if (malformed > 0) {
    process.stderr.write(`[알림] NDJSON 으로 읽지 못한 줄 ${malformed}건을 건너뜀\n`)
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

  const summaryOptions = { environment, areaOrder, color: opt.color }

  if (kept.length === 0) {
    err(`결과 없음: ${field}=${value}`)
    renderSummary(kept, hosts, summaryOptions, err)
    return 1
  }

  if (opt.json) {
    renderJsonl(kept, out)
  } else {
    renderText(
      kept,
      areaOrder,
      {
        color: opt.color,
        showExtra: opt.showExtra,
        extraWidth: opt.extraWidth,
        valueCap: opt.valueCap,
      },
      out,
    )
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
