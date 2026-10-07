/**
 * 旁通作业：调压站抢修临时开旁通期间，按临时安全区间对现场读数判级
 *
 * 关键约束：
 * - 同一设备存在「进行中」（未归档）作业时，不能再开一条
 * - 作业期内读数一律按作业登记的临时安全区间判定，许可到期前不能改回平时标准
 * - 浓度类点位越过作业安全线立即派泄漏处置单（幂等：同一读数最多派一张）
 * - 结束作业先核对读数与泄漏单；台账写入失败保留现场批次，重试只补未完成项
 */

/** 作业状态：进行中 → 已归档（结束并完成台账写入） */
export type BypassWorkState = '进行中' | '已归档'

export const BYPASS_STATES: BypassWorkState[] = ['进行中', '已归档']

/** 判级依据类型：旁通作业期=临时安全区间，平时巡检=点位标准区间 */
export type JudgeBasisType = '标准区间' | '旁通临时区间'

/** 读数判级依据快照（录入时冻结，标准值或作业变更均不回改） */
export interface JudgeBasis {
  type: JudgeBasisType
  /** 判级使用的下限 */
  min: number
  /** 判级使用的上限（浓度类即安全线） */
  max: number
  unit: string
  /** 依据来源：点位标准 / 旁通作业编号或名称 */
  source: string
  /** 是否关键点 */
  isCritical: boolean
}

/** 作业登记的点位临时安全区间；浓度类点位以安全线为上限（0 ~ safetyLinePpm） */
export interface BypassPointLimit {
  pointId: string
  pointName: string
  unit: string
  isCritical: boolean
  tempMin: number
  tempMax: number
}

/** 现场批次条目状态：待入台账 → 已入台账 / 台账失败（可重试） */
export type BypassBatchItemState = '待写入' | '已写入' | '写入失败'

export interface BypassBatchItem {
  /** readings:<readingId> / leaks:<leakId> */
  key: string
  kind: '读数' | '泄漏单'
  refId: string
  pointName: string
  value: number
  unit: string
  state: BypassBatchItemState
  error: string
  attempts: number
  /** 最近一次写入时刻 */
  lastAttemptAt: number
}

/** 现场批次：结束作业后生成，台账写入失败时整批保留，重试只补未完成项 */
export interface BypassBatch {
  batchNo: string
  total: number
  /** 尚未成功写入的条目（首次全部失败为 0 成功、全部保留） */
  items: BypassBatchItem[]
  startedAt: number
  lastRunAt: number
  /** 已执行的写入轮次（首次归档=1，每重试一次 +1） */
  rounds: number
}

export interface BypassWork {
  id: string
  /** 作业单号，便于现场登记与追溯 */
  code: string
  stationId: string
  deviceId: string
  /** 抢修事由 */
  reason: string
  /** 作业负责人 */
  manager: string
  /** 现场记录人 */
  recorder: string
  /** 许可开始时刻（ms） */
  startAt: number
  /** 许可到期时刻（ms），到期前不得改用平时标准 */
  endAt: number
  /** 浓度类点位安全线（ppm），越过立即派单 */
  safetyLinePpm: number
  /** 临时安全区间（按点位冻结） */
  limits: BypassPointLimit[]
  state: BypassWorkState
  /** 作业期读数 id 清单 */
  readingIds: string[]
  /** 作业期泄漏单 id 清单（含越线立即派单） */
  leakIds: string[]
  /** 现场批次（归档台账）；进行中作业为空 */
  batch: BypassBatch | null
  /** 归档时间（ms） */
  archivedAt: number | null
  /** 归档备注 / 处置结果摘要 */
  closeNote: string
  createdAt: number
  updatedAt: number
}

export interface BypassWorkDraft {
  stationId: string
  deviceId: string
  reason: string
  manager: string
  recorder: string
  /** 时刻文本 `YYYY-MM-DD HH:mm` */
  startText: string
  endText: string
  safetyLinePpm: number
  limits: BypassPointLimit[]
}

/** 同一设备存在未归档作业时抛出 */
export class ActiveBypassConflictError extends Error {
  constructor(public existingId: string) {
    super('该设备已有未归档的旁通作业，结束归档前不能再开一条')
    this.name = 'ActiveBypassConflictError'
  }
}

/** 默认浓度安全线（ppm）：与点位平时标准上限保持一致 */
export const DEFAULT_BYPASS_SAFETY_PPM = 50

export function createEmptyBypassDraft(): BypassWorkDraft {
  return {
    stationId: '',
    deviceId: '',
    reason: '',
    manager: '',
    recorder: '',
    startText: '',
    endText: '',
    safetyLinePpm: DEFAULT_BYPASS_SAFETY_PPM,
    limits: []
  }
}

/** 判级依据短文案 */
export function judgeBasisLabel(basis: JudgeBasis | undefined): string {
  if (!basis) return '平时标准区间'
  return basis.type === '旁通临时区间' ? '旁通临时安全区间' : '平时标准区间'
}

/** 作业是否在许可期内 */
export function isWithinPermit(work: BypassWork, at: number): boolean {
  return at >= work.startAt && at <= work.endAt
}

/** 作业是否已到期但仍在进行（许可到期后禁止再按临时区间录数） */
export function isExpiredOpen(work: BypassWork, now: number = Date.now()): boolean {
  return work.state === '进行中' && now > work.endAt
}

/** 取作业某点位的临时限值 */
export function limitOfWork(work: BypassWork, pointId: string): BypassPointLimit | undefined {
  return work.limits.find((limit) => limit.pointId === pointId)
}
