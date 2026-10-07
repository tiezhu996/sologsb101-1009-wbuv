/**
 * 旁通作业：调压站抢修临时开旁通期间，按临时安全区间判定读数的作业单。
 * - 负责人登记站点、设备、起止时间与临时安全区间
 * - 现场记录人把作业期读数归到同一作业下
 * - 同一设备已有未归档（进行中）作业时不能再开一条
 * - 作业期内按临时安全区间判定，到期前不能改用平时标准；结束并核对台账后归档
 */
import type { AbnormalLevel } from '@/utils/range'

/** 作业状态：进行中 → 已归档；台账失败时为待归档（现场批次保留，可重试） */
export type BypassState = '进行中' | '待归档' | '已归档'

/** 归档阶段的台账核对结果（仅 待归档 / 已归档 有值） */
export type BypassArchiveState = '未核对' | '待写台账' | '台账失败待重试' | '已归档'

export interface Bypass {
  id: string
  /** 作业单号，如 BP20261007-0001，便于纸质台账追溯 */
  code: string
  stationId: string
  deviceId: string
  /** 作业负责人 */
  leader: string
  /** 现场记录人 */
  recorder: string
  /** 作业事由，如 抢修临时开旁通 */
  reason: string
  /** 作业开始时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  startTime: string
  /** 许可截止时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  endTime: string
  /** 临时安全区间下限（与点位同单位） */
  safeMin: number
  /** 临时安全区间上限（浓度安全线，越过立即派单） */
  safeMax: number
  /** 临时安全区间单位（作业期只登记同单位点位读数，保证区间口径一致） */
  safeUnit: string
  /** 实际结束时间，未结束为空串 */
  finishedAt: string
  state: BypassState
  /** 台账归档核对状态 */
  archiveState: BypassArchiveState
  /** 台账最近一次写入失败原因 */
  archiveError: string
  /** 台账写入重试次数 */
  retryCount: number
  /** 结束作业时核对出的作业期读数条数 */
  readingCount: number
  /** 结束作业时核对出的作业期泄漏单条数 */
  leakCount: number
  /** 本次作业处置结论（结束时填写） */
  conclusion: string
  createdAt: number
  updatedAt: number
}

export const BYPASS_STATES: BypassState[] = ['进行中', '待归档', '已归档']

/** 未归档口径：进行中与待归档都占用设备，不能再开新作业 */
export const BYPASS_OPEN_STATES: BypassState[] = ['进行中', '待归档']

/** 作业状态机：进行中 → 待归档（结束核对）→ 已归档（台账写入成功） */
export const BYPASS_STATE_FLOW: Record<BypassState, BypassState | null> = {
  进行中: '待归档',
  待归档: '已归档',
  已归档: null
}

export interface BypassDraft {
  stationId: string
  deviceId: string
  leader: string
  recorder: string
  reason: string
  startTime: string
  endTime: string
  safeMin: number
  safeMax: number
  safeUnit: string
}

export const EMPTY_BYPASS_DRAFT: BypassDraft = {
  stationId: '',
  deviceId: '',
  leader: '',
  recorder: '',
  reason: '',
  startTime: '',
  endTime: '',
  safeMin: 0,
  safeMax: 100,
  safeUnit: 'ppm'
}

export function createEmptyBypassDraft(): BypassDraft {
  return { ...EMPTY_BYPASS_DRAFT }
}

/** 作业时间窗：起止时间解析为毫秒时间戳，无法解析返回 null */
export interface BypassWindow {
  startMs: number
  endMs: number
}

export function bypassWindow(bypass: Pick<Bypass, 'startTime' | 'endTime'>): BypassWindow | null {
  const startMs = Date.parse(bypass.startTime)
  const endMs = Date.parse(bypass.endTime)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null
  return { startMs, endMs }
}

/** 给定时刻是否落在作业许可窗口内（许可到期前一律按临时区间，不能改用平时标准） */
export function isWithinBypassWindow(
  bypass: Pick<Bypass, 'startTime' | 'endTime'>,
  atMs: number
): boolean {
  const window = bypassWindow(bypass)
  if (!window) return false
  return atMs >= window.startMs && atMs <= window.endMs
}

/** 许可是否已到期（当前时刻晚于截止时间） */
export function isBypassExpired(bypass: Pick<Bypass, 'endTime'>, nowMs = Date.now()): boolean {
  const endMs = Date.parse(bypass.endTime)
  return Number.isFinite(endMs) && nowMs > endMs
}

/** 一条读数在某作业下的判定依据（供台账与追溯展示） */
export interface BypassBasis {
  /** 归属作业 id；为空表示按平时标准区间判定 */
  bypassId: string
  /** 判定依据：临时安全区间 / 平时标准区间 */
  basis: '临时安全区间' | '平时标准区间'
  /** 判定时使用的上下限（冗余快照，作业区间事后修改也不影响历史判定） */
  judgeMin: number
  judgeMax: number
  level: AbnormalLevel
  deviationPct: number
  isAbnormal: boolean
}

/** 现场批次内单条读数记录（现场记录人录入） */
export interface BypassReadingDraft {
  pointId: string
  value: number
  /** 现场记录时刻（毫秒），决定归属哪个作业窗口 */
  recordedAt: number
  recorder: string
  note: string
}

/** 结束作业时台账核对结论 */
export interface BypassCloseCheck {
  readingCount: number
  leakCount: number
  abnormalCount: number
  /** 越过浓度安全线的读数条数 */
  overLimitCount: number
}

/** 台账写入结果：失败时保留现场批次并支持只补未完成部分重试 */
export interface BypassArchiveResult {
  ok: boolean
  readingCount: number
  leakCount: number
  error?: string
  retried: boolean
}

export function bypassStateTagColor(state: BypassState): string {
  if (state === '进行中') return 'red'
  if (state === '待归档') return 'orange'
  return 'green'
}
