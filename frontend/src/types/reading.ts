/** 读数：某次巡检中某个点位的实测读数 */
export interface Reading {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0 */
  deviationPct: number
  note: string
  /** 旁通作业归属：作业期现场读数归到同一作业下，非作业期为空串 */
  bypassId: string
  /** 判级依据：临时安全区间 / 平时标准区间 */
  judgeBasis: '临时安全区间' | '平时标准区间'
  /** 判定时使用的区间上下限快照（追溯判级依据用） */
  judgeMin: number
  judgeMax: number
  /** 现场记录时刻（毫秒），作业归属按该时刻落在哪个作业窗口决定 */
  recordedAt: number
  /** 现场记录人（旁通作业批次） */
  recorder: string
  /** 台账写入状态：现场批次先落地，归档时只补未完成部分 */
  ledgerState: '现场批次' | '已入账'
  /** 该读数已派生泄漏单时回填处置单 id（幂等去重，避免作业结束重复派单） */
  leakId: string
  createdAt: number
  updatedAt: number
}

export interface ReadingDraft {
  patrolId: string
  pointId: string
  value: number
  note: string
}

export const EMPTY_READING_DRAFT: ReadingDraft = {
  patrolId: '',
  pointId: '',
  value: 0,
  note: ''
}

/** 读数草稿表：`${patrolId}:${pointId}` → 输入值 */
export type ReadingDraftMap = Record<string, number>
