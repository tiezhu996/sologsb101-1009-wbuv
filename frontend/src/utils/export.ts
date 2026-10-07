/**
 * 导出工具：整库 JSON 存档、巡检/泄漏台账 CSV、结构版本导出
 */
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { BypassWork } from '@/types/bypass'
import type { ReadingRow } from '@/utils/db'
import type { LeakRow } from '@/utils/db'
import { abnormalLevelOf, deviationPctOf, formatDateTime, formatLeakConcentration } from '@/utils/range'

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function stampSuffix(): string {
  const date = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

export function exportBackupJson(payload: unknown): string {
  const filename = `gbgaspress-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8')
  return filename
}

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 巡检读数台账 CSV */
export function exportReadingCsv(
  stations: Station[],
  devices: Device[],
  points: Point[],
  patrols: Patrol[],
  readings: Reading[]
): string {
  const header = [
    '调压站',
    '设备',
    '点位',
    '判定依据',
    '依据下限',
    '依据上限',
    '单位',
    '关键点',
    '计划日期',
    '实际日期',
    '巡检人',
    '巡检状态',
    '读数',
    '偏差率(%)',
    '判定',
    '备注'
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  readings.forEach((reading) => {
    const point = points.find((item) => item.id === reading.pointId)
    const patrol = patrols.find((item) => item.id === reading.patrolId)
    const device = point ? devices.find((item) => item.id === point.deviceId) : undefined
    const station = patrol ? stations.find((item) => item.id === patrol.stationId) : undefined
    lines.push(
      [
        station ? station.name : '—',
        device ? `${device.type} ${device.model}` : '—',
        point ? point.name : '—',
        reading.judgeBasis ? (reading.judgeBasis.type === '旁通临时区间' ? '旁通临时安全区间' : '平时标准区间') : '平时标准区间',
        reading.judgeBasis?.min ?? point?.standardMin ?? '—',
        reading.judgeBasis?.max ?? point?.standardMax ?? '—',
        point ? point.unit : '—',
        point ? (point.isCritical ? '是' : '否') : '—',
        patrol ? patrol.planDate : '—',
        patrol ? patrol.patrolDate || '未执行' : '—',
        patrol ? patrol.patrolman || '—' : '—',
        patrol ? patrol.state : (reading.bypassWorkId ? '旁通作业' : '—'),
        reading.value,
        reading.deviationPct.toFixed(2),
        point ? abnormalLevelOf(reading.deviationPct, reading.judgeBasis?.isCritical ?? point.isCritical) : '—',
        reading.note || '—'
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `巡检读数台账-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 旁通作业台账 CSV：作业信息、作业期读数判级依据、关联泄漏单、处置结果与归档批次可追溯 */
export function exportBypassCsv(
  work: BypassWork,
  readings: ReadingRow[],
  leaks: LeakRow[],
  stationName: string,
  deviceName: string
): string {
  const header = [
    '作业单号',
    '作业状态',
    '调压站',
    '设备',
    '事由',
    '负责人',
    '记录人',
    '许可开始',
    '许可到期',
    '安全线(ppm)',
    '归档时间',
    '台账轮次',
    '测量时间',
    '判级依据',
    '依据区间',
    '读数',
    '单位',
    '偏差率(%)',
    '判定',
    '关联泄漏单',
    '泄漏单状态',
    '处置人',
    '处置结果/备注'
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  const leakOfReading = (readingId: string): LeakRow | undefined =>
    leaks.find((leak) => leak.sourceReadingId === readingId)

  const pushRow = (cells: Array<string | number>): void => {
    lines.push(cells.map(csvCell).join(','))
  }

  const baseCells = (): Array<string | number> => [
    work.code,
    work.state,
    stationName,
    deviceName,
    work.reason,
    work.manager,
    work.recorder,
    formatDateTime(work.startAt),
    formatDateTime(work.endAt),
    work.safetyLinePpm,
    work.archivedAt ? formatDateTime(work.archivedAt) : '—',
    work.batch ? work.batch.rounds : '—'
  ]

  if (readings.length === 0) {
    pushRow([...baseCells(), '—', '（无作业期读数）', '—', '—', '—', '—', '—', '—', leaks.length, '—', '—', work.closeNote || '—'])
  }
  readings.forEach((reading) => {
    const leak = leakOfReading(reading.id)
    const basis = reading.judgeBasis
    pushRow([
      ...baseCells(),
      formatDateTime(reading.measuredAt ?? reading.createdAt),
      basis ? (basis.type === '旁通临时区间' ? '旁通临时安全区间' : '平时标准区间') : '—',
      basis ? `${basis.min} ~ ${basis.max} ${basis.unit}` : '—',
      reading.value,
      basis?.unit ?? '',
      reading.deviationPct.toFixed(2),
      abnormalLevelOf(reading.deviationPct, basis?.isCritical ?? false),
      leak ? `${leak.concentrationPpm} ppm` : '—',
      leak ? leak.state : '—',
      leak ? leak.handler || '—' : '—',
      reading.note || (work.state === '已归档' ? work.closeNote : '—')
    ])
  })

  const filename = `旁通作业台账-${work.code}-${stampSuffix()}.csv`
  download(filename, `﻿${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 泄漏处置台账 CSV */
export function exportLeakCsv(stations: Station[], devices: Device[], leaks: Leak[]): string {
  const header = ['调压站', '设备', '出厂编号', '来源', '浓度(ppm)', '发现时间', '处置措施', '状态', '复检值(ppm)', '复检结论', '处置人']
  const lines: string[] = [header.map(csvCell).join(',')]
  leaks.forEach((leak) => {
    const device = devices.find((item) => item.id === leak.deviceId)
    const station = stations.find((item) => item.id === leak.stationId)
    const pass = leak.retestValuePpm > 0 && leak.retestValuePpm <= 50
    lines.push(
      [
        station ? station.name : '—',
        device ? `${device.type} ${device.model}` : '—',
        device ? device.serialNo : '—',
        leak.bypassWorkId ? '旁通作业越线即派' : '巡检异常派单',
        leak.concentrationPpm,
        leak.foundTime,
        leak.measure || '—',
        leak.state,
        leak.retestValuePpm,
        leak.state === '已复检' ? (pass ? '合格' : '不合格') : '未复检',
        leak.handler || '—'
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `泄漏处置台账-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 点位标准值配置 CSV */
export function exportPointCsv(stations: Station[], devices: Device[], points: Point[]): string {
  const header = ['调压站', '设备类型', '设备型号', '点位名', '标准下限', '标准上限', '单位', '关键点', '区间宽度']
  const lines: string[] = [header.map(csvCell).join(',')]
  points.forEach((point) => {
    const device = devices.find((item) => item.id === point.deviceId)
    const station = stations.find((item) => item.id === point.stationId)
    lines.push(
      [
        station ? station.name : '—',
        device ? device.type : '—',
        device ? device.model : '—',
        point.name,
        point.standardMin,
        point.standardMax,
        point.unit,
        point.isCritical ? '是' : '否',
        (point.standardMax - point.standardMin).toFixed(4)
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `点位标准值-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 导出结构版本（库名、版本号、各表行数） */
export function exportStructureVersion(summary: {
  dbName: string
  dbVersion: number
  counts: Record<string, number>
  missedPatrolCount: number
  exportedAt: string
}): string {
  const filename = `gbgaspress-structure-${stampSuffix()}.json`
  download(filename, JSON.stringify(summary, null, 2), 'application/json;charset=utf-8')
  return filename
}

/** 供异常分级页复用的偏差率计算 */
export function deviationOf(value: number, min: number, max: number): number {
  return deviationPctOf(value, min, max)
}

export function concentrationText(ppm: number): string {
  return formatLeakConcentration(ppm)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}
