/**
 * 旁通作业状态（Zustand）
 *
 * 核心规则：
 * - 同一设备存在未归档作业时禁止再开（ActiveBypassConflictError）
 * - 作业期读数按作业登记的临时安全区间判级，许可到期前不能改回平时标准
 * - 浓度类读数越过作业安全线立即派泄漏处置单，同一读数幂等只派一张
 * - 结束作业先核对读数↔泄漏单；台账写入失败保留现场批次，重试只补未完成项
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, ROW_REVISION, type BypassWorkRow, type LeakRow, type ReadingRow } from '@/utils/db'
import {
  ActiveBypassConflictError,
  DEFAULT_BYPASS_SAFETY_PPM,
  limitOfWork,
  type BypassBatch,
  type BypassBatchItem,
  type BypassPointLimit,
  type BypassWork,
  type BypassWorkDraft,
  type JudgeBasis
} from '@/types/bypass'
import type { ReadingJudgement } from '@/utils/range'
import { formatDate, inTimeWindow, judgeReading, parseDateTime } from '@/utils/range'
import { isOpenLeak } from '@/types/leak'
import { useStationStore } from '@/stores/stationStore'

/** 台账写入失败演练：置位后下一次归档前若干个待写条目会被模拟为失败，仅一次性生效 */
let pendingLedgerFailures = 0

/** 演练用：让下一次归档台账的前 count 个条目写入失败，用于验证现场批次保留与重试 */
export function armLedgerFailureDrill(count: number): void {
  pendingLedgerFailures = Math.max(0, Math.floor(count))
}

export interface CloseCheckIssue {
  level: 'danger' | 'warning'
  text: string
}

export interface CloseCheckReport {
  workId: string
  readingCount: number
  abnormalCount: number
  leakCount: number
  openLeakCount: number
  /** 应派未派（浓度越线读数没有对应泄漏单）——阻断归档 */
  missing: string[]
  /** 提示项（存在尚未复检闭环的泄漏单）——不阻断 */
  issues: CloseCheckIssue[]
  canClose: boolean
}

interface BypassState {
  works: BypassWork[]
  readings: ReadingRow[]
  leaks: LeakRow[]
  ready: boolean
  /** 列表筛选：作业状态 + 站点 + 关键字 */
  stateFilter: string[]
  stationId: string
  keyword: string
  activeWorkId: string | null
  patchFilter: (patch: { stateFilter?: string[]; stationId?: string; keyword?: string }) => void
  resetFilter: () => void
  setActiveWork: (id: string | null) => void

  createWork: (draft: BypassWorkDraft) => Promise<BypassWork>
  recordReading: (input: {
    workId: string
    pointId: string
    value: number
    note: string
    measuredText: string
  }) => Promise<{ reading: ReadingRow; leakCreated: boolean }>
  removeReading: (workId: string, readingId: string) => Promise<void>

  /** 结束作业前核对本次读数与泄漏单 */
  checkClose: (workId: string) => CloseCheckReport
  /** 生成现场批次（不落台账；simulateFailures>0 时演练首批写入失败） */
  prepareBatch: (workId: string, simulateFailures?: number) => BypassBatch
  /** 写台账：按现场批次逐条落库，只补未完成项，不重复派单 */
  runLedger: (workId: string) => Promise<{ batch: BypassBatch; archived: boolean }>
  /** 结束并归档（核对通过 → 建现场批次 → 写台账 → 全部成功后置已归档） */
  closeWork: (workId: string, closeNote: string, simulateFailures?: number) => Promise<{ archived: boolean; pending: number }>
  /** 台账失败后重试（只补未完成项） */
  retryLedger: (workId: string) => Promise<{ archived: boolean; pending: number }>
  /** 直接读库取最新作业（不依赖 liveQuery 回流） */
  getWork: (workId: string) => Promise<BypassWork | undefined>

  worksOfDevice: (deviceId: string) => BypassWork[]
  activeWorkOfDevice: (deviceId: string) => BypassWork | undefined
  readingsOfWork: (workId: string) => ReadingRow[]
  leaksOfWork: (workId: string) => LeakRow[]
  filteredWorks: () => BypassWork[]
}

function sortWorks(list: BypassWork[]): BypassWork[] {
  return [...list].sort((a, b) => b.startAt - a.startAt || b.createdAt - a.createdAt)
}

function pendingCountOf(batch: BypassBatch): number {
  return batch.items.filter((item) => item.state !== '已写入').length
}

/** 由读数幂等派泄漏单：同一来源读数只派一张 */
async function ensureLeakForReading(work: BypassWork, reading: ReadingRow, pointName: string): Promise<boolean> {
  const existing = await db.leaks.where('sourceReadingId').equals(reading.id).first()
  if (existing) return false
  const now = Date.now()
  const row: LeakRow = {
    id: createId('lk'),
    deviceId: work.deviceId,
    stationId: work.stationId,
    concentrationPpm: reading.value,
    foundTime: formatDate(reading.measuredAt ?? now),
    measure: `旁通作业 ${work.code} 期间「${pointName}」实测 ${reading.value} ppm 越过安全线 ${work.safetyLinePpm} ppm，立即派单`,
    state: '待处置',
    retestValuePpm: 0,
    handler: work.manager,
    bypassWorkId: work.id,
    sourceReadingId: reading.id,
    createdAt: now,
    updatedAt: now,
    revision: ROW_REVISION
  }
  await db.leaks.put(row)
  await db.bypassworks.update(work.id, { leakIds: [...work.leakIds, row.id], updatedAt: now })
  return true
}

export const useBypassStore = create<BypassState>((set, get) => ({
  works: [],
  readings: [],
  leaks: [],
  ready: false,
  stateFilter: [],
  stationId: '',
  keyword: '',
  activeWorkId: null,

  patchFilter(patch) {
    set({
      stateFilter: patch.stateFilter ?? get().stateFilter,
      stationId: patch.stationId ?? get().stationId,
      keyword: patch.keyword ?? get().keyword
    })
  },

  resetFilter() {
    set({ stateFilter: [], stationId: '', keyword: '' })
  },

  setActiveWork(id) {
    set({ activeWorkId: id })
  },

  async createWork(draft) {
    const startAt = parseDateTime(draft.startText)
    const endAt = parseDateTime(draft.endText)
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
      throw new Error('请填写正确的许可起止时间（YYYY-MM-DD HH:mm）')
    }
    if (endAt <= startAt) throw new Error('许可到期时间必须晚于开始时间')
    if (!draft.stationId || !draft.deviceId) throw new Error('请选择调压站与设备')
    if (!draft.manager.trim()) throw new Error('请填写作业负责人')

    // 同一设备已有未归档作业时不能再开一条（同设备可能有多条历史作业，必须按状态过滤）
    const conflict = await db.bypassworks
      .where('deviceId')
      .equals(draft.deviceId)
      .filter((row) => row.state === '进行中')
      .first()
    if (conflict) throw new ActiveBypassConflictError(conflict.id)

    const safetyLinePpm = Number(draft.safetyLinePpm) || DEFAULT_BYPASS_SAFETY_PPM
    // 浓度类点位统一以作业安全线为临时上限；其余点位保留登记的临时区间
    const limits: BypassPointLimit[] = draft.limits.map((limit) =>
      limit.unit === 'ppm' ? { ...limit, tempMin: 0, tempMax: safetyLinePpm } : { ...limit }
    )

    const now = Date.now()
    const code = `BP${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`
    const row: BypassWorkRow = {
      id: createId('bw'),
      code,
      stationId: draft.stationId,
      deviceId: draft.deviceId,
      reason: draft.reason.trim(),
      manager: draft.manager.trim(),
      recorder: draft.recorder.trim(),
      startAt,
      endAt,
      safetyLinePpm,
      limits,
      state: '进行中',
      readingIds: [],
      leakIds: [],
      batch: null,
      archivedAt: null,
      closeNote: '',
      createdAt: now,
      updatedAt: now,
      revision: ROW_REVISION
    }
    await db.bypassworks.put(row)
    set({ activeWorkId: row.id })
    return row
  },

  async recordReading(input) {
    const work = get().works.find((item) => item.id === input.workId)
    if (!work) throw new Error('旁通作业不存在')
    if (work.state !== '进行中') throw new Error('该作业已归档，不能再登记作业期读数')

    const measuredAt = parseDateTime(input.measuredText)
    if (!Number.isFinite(measuredAt)) throw new Error('请填写正确的测量时间')
    // 作业期读数必须落在许可窗口内；到期前不得改用平时标准，到期后也不得再按临时区间录数
    if (!inTimeWindow(measuredAt, work.startAt, work.endAt)) {
      throw new Error('测量时间不在许可起止时间内，作业期读数必须落在临时安全区间适用窗口中')
    }

    const point = await db.points.get(input.pointId)
    if (!point) throw new Error('点位不存在或已删除')

    const limit: BypassPointLimit =
      limitOfWork(work, input.pointId) ?? {
        pointId: point.id,
        pointName: point.name,
        unit: point.unit,
        isCritical: point.isCritical,
        tempMin: point.standardMin,
        tempMax: point.standardMax
      }
    const judgement: ReadingJudgement = judgeReading(input.value, limit.tempMin, limit.tempMax, limit.isCritical)
    const basis: JudgeBasis = {
      type: '旁通临时区间',
      min: limit.tempMin,
      max: limit.tempMax,
      unit: limit.unit,
      source: `旁通作业 ${work.code}`,
      isCritical: limit.isCritical
    }

    // 同一点位重复录入覆盖（保留 id 与创建时间），始终归属同一作业；直接查库避免 liveQuery 回流延迟
    const existing = await db.readings
      .where('bypassWorkId')
      .equals(work.id)
      .filter((row) => row.pointId === input.pointId)
      .first()
    const now = Date.now()
    const reading: ReadingRow = {
      id: existing?.id ?? createId('rd'),
      patrolId: '',
      pointId: input.pointId,
      value: Number(input.value),
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note: input.note.trim(),
      bypassWorkId: work.id,
      measuredAt,
      judgeBasis: basis,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revision: ROW_REVISION
    }
    await db.readings.put(reading)

    // 浓度越过作业安全线：立即派单（幂等，同一读数不重复派）
    let leakCreated = false
    if (point.unit === 'ppm' && input.value > work.safetyLinePpm) {
      leakCreated = await ensureLeakForReading(work, reading, point.name)
    }

    const readingIds = existing ? work.readingIds : [...work.readingIds, reading.id]
    await db.bypassworks.update(work.id, { readingIds, updatedAt: now })

    return { reading, leakCreated }
  },

  async removeReading(workId, readingId) {
    const reading = await db.readings.get(readingId)
    if (!reading || reading.bypassWorkId !== workId) return
    await db.readings.delete(readingId)
    const work = await db.bypassworks.get(workId)
    if (work) {
      await db.bypassworks.update(workId, {
        readingIds: work.readingIds.filter((id) => id !== readingId),
        updatedAt: Date.now()
      })
    }
  },

  checkClose(workId) {
    const work = get().works.find((item) => item.id === workId)
    const readings = work ? get().readingsOfWork(workId) : []
    const leaks = work ? get().leaksOfWork(workId) : []
    const points = useStationStore.getState().points

    const missing: string[] = []
    readings.forEach((reading) => {
      const unit = reading.judgeBasis?.unit
      if (unit !== 'ppm' || !work) return
      const overLine = reading.value > work.safetyLinePpm
      const linked = leaks.some((leak) => leak.sourceReadingId === reading.id)
      if (overLine && !linked) {
        const point = points.find((item) => item.id === reading.pointId)
        missing.push(`${point ? point.name : '浓度点位'} ${reading.value} ppm`)
      }
    })

    const openLeaks = leaks.filter((leak) => isOpenLeak(leak.state))
    const issues: CloseCheckIssue[] = []
    if (openLeaks.length > 0) {
      issues.push({
        level: 'warning',
        text: `作业关联 ${openLeaks.length} 张泄漏单尚未复检闭环（可先归档作业，泄漏单继续在处置台跟踪）。`
      })
    }
    if (missing.length > 0) {
      issues.push({ level: 'danger', text: `有 ${missing.length} 条越安全线读数缺少泄漏处置单，请先派单再结束。` })
    }
    return {
      workId,
      readingCount: readings.length,
      abnormalCount: readings.filter((reading) => reading.isAbnormal).length,
      leakCount: leaks.length,
      openLeakCount: openLeaks.length,
      missing,
      issues,
      canClose: missing.length === 0
    }
  },

  prepareBatch(workId, simulateFailures = 0) {
    const work = get().works.find((item) => item.id === workId)
    if (!work) throw new Error('旁通作业不存在')
    const readings = get().readingsOfWork(workId)
    const leaks = get().leaksOfWork(workId)
    const points = useStationStore.getState().points
    const pointName = (pointId: string): string => points.find((point) => point.id === pointId)?.name ?? '点位已删除'

    const items: BypassBatchItem[] = [
      ...readings.map((reading) => ({
        key: `readings:${reading.id}`,
        kind: '读数' as const,
        refId: reading.id,
        pointName: pointName(reading.pointId),
        value: reading.value,
        unit: reading.judgeBasis?.unit ?? '',
        state: '待写入' as const,
        error: '',
        attempts: 0,
        lastAttemptAt: 0
      })),
      ...leaks.map((leak) => ({
        key: `leaks:${leak.id}`,
        kind: '泄漏单' as const,
        refId: leak.id,
        pointName: `${pointName(
          points.find((point) => point.deviceId === leak.deviceId && point.unit === 'ppm')?.id ?? ''
        )} ${leak.concentrationPpm} ppm`,
        value: leak.concentrationPpm,
        unit: 'ppm',
        state: '待写入' as const,
        error: '',
        attempts: 0,
        lastAttemptAt: 0
      }))
    ]

    if (simulateFailures > 0) armLedgerFailureDrill(simulateFailures)

    const now = Date.now()
    return {
      batchNo: work.batch?.batchNo ?? createId('BC'),
      total: items.length,
      items,
      startedAt: now,
      lastRunAt: now,
      rounds: 0
    }
  },

  async runLedger(workId) {
    const work = await db.bypassworks.get(workId)
    if (!work) throw new Error('旁通作业不存在')
    // 台账失败后现场批次保留在 work.batch；没有批次（理论上不会）则现场补建
    const source: BypassBatch = work.batch ?? get().prepareBatch(workId)
    const now = Date.now()
    const batch: BypassBatch = {
      ...source,
      items: source.items.map((item) => ({ ...item })),
      lastRunAt: now,
      rounds: source.rounds + 1
    }

    for (const item of batch.items) {
      // 只补未完成部分：已写入条目跳过，读数不重判、泄漏单不重建，绝不重复派单
      if (item.state === '已写入') continue
      item.attempts += 1
      item.lastAttemptAt = now
      try {
        if (pendingLedgerFailures > 0) {
          pendingLedgerFailures -= 1
          throw new Error('台账服务暂不可用（演练注入失败）')
        }
        if (item.kind === '读数') {
          const reading = await db.readings.get(item.refId)
          if (!reading) throw new Error('读数已不存在')
          if (reading.bypassWorkId !== workId) throw new Error('读数缺少作业归属')
          await db.readings.update(reading.id, { updatedAt: now })
        } else {
          const leak = await db.leaks.get(item.refId)
          if (!leak) throw new Error('泄漏单已不存在')
          if (leak.bypassWorkId !== workId) throw new Error('泄漏单与作业归属不一致')
          await db.leaks.update(leak.id, { updatedAt: now })
        }
        item.state = '已写入'
        item.error = ''
      } catch (error) {
        // 台账写入失败：保留现场批次条目，等待重试
        item.state = '写入失败'
        item.error = error instanceof Error ? error.message : '台账写入失败'
      }
    }

    const pending = pendingCountOf(batch)
    const archived = pending === 0
    await db.bypassworks.update(workId, {
      batch,
      state: archived ? '已归档' : '进行中',
      archivedAt: archived ? batch.lastRunAt : null,
      updatedAt: now
    })
    return { batch, archived }
  },

  async closeWork(workId, closeNote, simulateFailures = 0) {
    const report = get().checkClose(workId)
    if (!report.canClose) throw new Error('核对未通过：存在越安全线读数未派泄漏单')
    // 先生成并保留现场批次（含可能的失败演练注入），再逐条写台账
    const batch = get().prepareBatch(workId, simulateFailures)
    await db.bypassworks.update(workId, { batch, updatedAt: Date.now() })
    const result = await get().runLedger(workId)
    if (result.archived) {
      await db.bypassworks.update(workId, { closeNote: closeNote.trim(), updatedAt: Date.now() })
    }
    return { archived: result.archived, pending: pendingCountOf(result.batch) }
  },

  async retryLedger(workId) {
    const result = await get().runLedger(workId)
    if (result.archived) {
      const work = await db.bypassworks.get(workId)
      if (work && !work.closeNote.trim()) {
        await db.bypassworks.update(workId, {
          closeNote: '现场批次重试后剩余条目全部入台账，作业归档。',
          updatedAt: Date.now()
        })
      }
    }
    return { archived: result.archived, pending: pendingCountOf(result.batch) }
  },

  async getWork(workId) {
    return db.bypassworks.get(workId)
  },

  worksOfDevice(deviceId) {
    return get().works.filter((work) => work.deviceId === deviceId)
  },

  activeWorkOfDevice(deviceId) {
    return get().works.find((work) => work.deviceId === deviceId && work.state === '进行中')
  },

  readingsOfWork(workId) {
    return get()
      .readings.filter((reading) => reading.bypassWorkId === workId)
      .sort((a, b) => (a.measuredAt ?? 0) - (b.measuredAt ?? 0))
  },

  leaksOfWork(workId) {
    return get().leaks.filter((leak) => leak.bypassWorkId === workId)
  },

  filteredWorks() {
    const { works, stateFilter, stationId, keyword } = get()
    const text = keyword.trim().toLowerCase()
    return sortWorks(
      works.filter((work) => {
        if (stateFilter.length > 0 && !stateFilter.includes(work.state)) return false
        if (stationId && work.stationId !== stationId) return false
        if (text.length === 0) return true
        return (
          work.code.toLowerCase().includes(text) ||
          work.reason.toLowerCase().includes(text) ||
          work.manager.toLowerCase().includes(text) ||
          work.recorder.toLowerCase().includes(text)
        )
      })
    )
  }
}))

liveQuery(() => db.bypassworks.toArray()).subscribe({
  next: (rows) => useBypassStore.setState({ works: sortWorks(rows), ready: true }),
  error: () => useBypassStore.setState({ ready: true })
})

liveQuery(() => db.readings.filter((reading) => (reading.bypassWorkId?.length ?? 0) > 0).toArray()).subscribe({
  next: (rows) => useBypassStore.setState({ readings: rows })
})

liveQuery(() => db.leaks.filter((leak) => (leak.bypassWorkId?.length ?? 0) > 0).toArray()).subscribe({
  next: (rows) => useBypassStore.setState({ leaks: rows })
})

export { DEFAULT_BYPASS_SAFETY_PPM }
