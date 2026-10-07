import type { JudgeBasis } from '@/types/bypass'

/**
 * 读数：某次巡检（或某次旁通作业）中某个点位的实测读数
 * - 平时巡检：patrolId 有值、bypassWorkId 为空
 * - 旁通作业：patrolId 为空、bypassWorkId 指向所属作业
 */
export interface Reading {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0 */
  deviationPct: number
  note: string
  /** 旁通作业归属；为空表示平时巡检读数 */
  bypassWorkId?: string
  /** 实测时刻（ms）；旁通作业读数必填，用于判定是否落在许可期内 */
  measuredAt?: number
  /** 判级依据快照（平时标准区间 / 旁通临时安全区间），录入即冻结，历史可追溯 */
  judgeBasis?: JudgeBasis
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
