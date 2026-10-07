/**
 * 标准区间判定、偏差率计算、ppm 与压力单位换算
 */
export type AbnormalLevel = '正常' | '轻微超标' | '严重超标'

/** 非关键点偏差率超过 10% 判严重超标 */
export const SEVERE_DEVIATION_PCT = 10
/** 关键点偏差率超过 5% 即判严重超标 */
export const CRITICAL_DEVIATION_PCT = 5

export const ABNORMAL_THEME: Record<AbnormalLevel, 'green' | 'orange' | 'red'> = {
  正常: 'green',
  轻微超标: 'orange',
  严重超标: 'red'
}

export const ABNORMAL_COLOR: Record<AbnormalLevel, string> = {
  正常: '#2f7a4f',
  轻微超标: '#d68910',
  严重超标: '#b03a2e'
}

export const ABNORMAL_BG: Record<AbnormalLevel, string> = {
  正常: '#eaf6ee',
  轻微超标: '#fdf3e3',
  严重超标: '#fdecea'
}

/** 权重：严重超标按关键点加权，用于异常分级排序 */
export function abnormalWeight(level: AbnormalLevel, isCritical: boolean): number {
  if (level === '严重超标') return isCritical ? 50 : 30
  if (level === '轻微超标') return isCritical ? 30 : 20
  return 0
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 两个 YYYY-MM-DD 之间的天数（to - from） */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00`)
  const end = Date.parse(`${to}T00:00:00`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.round((end - start) / 86400000)
}

/** 是否落在标准区间内 */
export function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max
}

/**
 * 偏差率（%）：区间内为 0；越限时按越限幅度相对边界值计算
 */
export function deviationPctOf(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < min) {
    const base = Math.abs(min) > 1e-6 ? Math.abs(min) : 1
    return round(((min - value) / base) * 100, 2)
  }
  if (value > max) {
    const base = Math.abs(max) > 1e-6 ? Math.abs(max) : 1
    return round(((value - max) / base) * 100, 2)
  }
  return 0
}

/** 异常分级：关键点阈值更严 */
export function abnormalLevelOf(deviationPct: number, isCritical: boolean): AbnormalLevel {
  if (deviationPct <= 0) return '正常'
  const limit = isCritical ? CRITICAL_DEVIATION_PCT : SEVERE_DEVIATION_PCT
  return deviationPct > limit ? '严重超标' : '轻微超标'
}

/** 读数的异常判定结果 */
export interface ReadingJudgement {
  value: number
  deviationPct: number
  isAbnormal: boolean
  level: AbnormalLevel
  weight: number
}

export function judgeReading(value: number, min: number, max: number, isCritical: boolean): ReadingJudgement {
  const deviationPct = deviationPctOf(value, min, max)
  const level = abnormalLevelOf(deviationPct, isCritical)
  return {
    value,
    deviationPct,
    isAbnormal: level !== '正常',
    level,
    weight: abnormalWeight(level, isCritical)
  }
}

export function rangeText(min: number, max: number, unit: string): string {
  return `${min} ~ ${max} ${unit}`
}

export function formatValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '—'
  const digits = unit === 'ppm' || unit === '℃' ? 0 : 3
  return `${value.toFixed(digits)} ${unit}`
}

export function formatDeviation(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(2)}%`
}

/** 浓度单位换算：ppm → 体积百分比 */
export function ppmToPercent(ppm: number): number {
  return round(ppm / 10000, 6)
}

/** 体积百分比 → ppm */
export function percentToPpm(percent: number): number {
  return round(percent * 10000, 3)
}

/** 压力换算：kPa → MPa */
export function kpaToMpa(value: number): number {
  return round(value / 1000, 5)
}

/** 压力换算：MPa → kPa */
export function mpaToKpa(value: number): number {
  return round(value * 1000, 2)
}

/** 压力换算：bar → MPa（1 bar = 0.1 MPa） */
export function barToMpa(value: number): number {
  return round(value * 0.1, 5)
}

export function formatLeakConcentration(ppm: number): string {
  if (!Number.isFinite(ppm)) return '—'
  return `${ppm.toFixed(0)} ppm`
}

/* ============================ 时间窗（旁通作业许可期） ============================ */

/** 解析 `YYYY-MM-DD HH:mm[:ss]` 为毫秒时间戳，非法返回 NaN */
export function parseDateTime(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return NaN
  return Date.parse(trimmed.replace(' ', 'T'))
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 格式化为 `YYYY-MM-DD HH:mm` */
export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
    date.getMinutes()
  )}`
}

/** 格式化为 `YYYY-MM-DD` */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 时刻是否落在许可时间窗 [startAt, endAt] 内 */
export function inTimeWindow(at: number, startAt: number, endAt: number): boolean {
  return Number.isFinite(at) && at >= startAt && at <= endAt
}

/** 许可剩余分钟数（已到期为负数） */
export function remainingMinutes(endAt: number, now: number = Date.now()): number {
  return Math.round((endAt - now) / 60000)
}

/** 许可剩余时间文案 */
export function remainingText(endAt: number, now: number = Date.now()): string {
  const minutes = remainingMinutes(endAt, now)
  if (minutes < 0) return `已到期 ${Math.abs(minutes)} 分钟`
  if (minutes < 60) return `剩余 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `剩余 ${hours} 小时 ${rest} 分`
}
