/**
 * 旁通作业状态（Zustand）
 * 维护抢修临时开旁通作业单：登记、互斥、作业期读数归组、结束核对、台账失败重试与历史追溯。
 * 数据通过模块级 liveQuery 订阅 Dexie，写入后自动回流。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  archiveBypassLedger,
  checkBypassBeforeClose,
  closeBypass,
  createBypass,
  db,
  deleteBypass,
  findOpenBypassOfDevice,
  putBypassReading,
  type ArchiveBypassOutcome,
  type BypassCloseCheckResult,
  type BypassRow
} from '@/utils/db'
import {
  BYPASS_OPEN_STATES,
  bypassWindow,
  isBypassExpired,
  isWithinBypassWindow,
  type Bypass,
  type BypassDraft,
  type BypassReadingDraft,
  type BypassState
} from '@/types/bypass'
import type { Leak } from '@/types/leak'
import type { Reading } from '@/types/reading'

interface BypassFilterState {
  stationId: string
  state: BypassState | ''
}

export interface BypassDetail {
  bypass: Bypass
  readings: Reading[]
  leaks: Leak[]
}

interface BypassState_ {
  bypasses: Bypass[]
  readings: Reading[]
  leaks: Leak[]
  filter: BypassFilterState
  ready: boolean
  patchFilter: (patch: Partial<BypassFilterState>) => void
  resetFilter: () => void
  create: (draft: BypassDraft) => Promise<Bypass>
  remove: (id: string) => Promise<void>
  recordReading: (bypassId: string, draft: BypassReadingDraft) => Promise<{ leakCreated: boolean }>
  checkBeforeClose: (id: string) => Promise<BypassCloseCheckResult>
  close: (id: string, conclusion: string) => Promise<Bypass>
  archive: (id: string, simulateFailure?: boolean) => Promise<ArchiveBypassOutcome>
  /** 同一设备是否已有未归档作业（未归档不能再开一条） */
  openBypassOfDevice: (deviceId: string) => Bypass | undefined
  /** 指定设备与时刻命中的进行中作业（作业窗口判定） */
  activeBypassFor: (deviceId: string, atMs: number) => Bypass | undefined
  readingsOf: (bypassId: string) => Reading[]
  leaksOf: (bypassId: string) => Leak[]
  detailOf: (bypassId: string) => BypassDetail | null
  filteredBypasses: () => Bypass[]
  isExpired: (bypass: Bypass) => boolean
}

export const useBypassStore = create<BypassState_>((set, get) => ({
  bypasses: [],
  readings: [],
  leaks: [],
  filter: { stationId: '', state: '' },
  ready: false,

  patchFilter(patch) {
    set({ filter: { ...get().filter, ...patch } })
  },

  resetFilter() {
    set({ filter: { stationId: '', state: '' } })
  },

  async create(draft) {
    return createBypass(draft)
  },

  async remove(id) {
    await deleteBypass(id)
  },

  async recordReading(bypassId, draft) {
    const bypass = get().bypasses.find((item) => item.id === bypassId)
    if (!bypass) throw new Error('作业不存在')
    if (bypass.state === '已归档') throw new Error('作业已归档，不能再补录读数')
    const result = await putBypassReading(bypass as BypassRow, draft)
    return { leakCreated: result.leak !== null }
  },

  async checkBeforeClose(id) {
    return checkBypassBeforeClose(id)
  },

  async close(id, conclusion) {
    return closeBypass(id, conclusion)
  },

  async archive(id, simulateFailure = false) {
    return archiveBypassLedger(id, { simulateFailure })
  },

  openBypassOfDevice(deviceId) {
    return get().bypasses.find(
      (bypass) => bypass.deviceId === deviceId && (BYPASS_OPEN_STATES as BypassState[]).includes(bypass.state)
    )
  },

  activeBypassFor(deviceId, atMs) {
    return get().bypasses.find(
      (bypass) =>
        bypass.state === '进行中' &&
        bypass.deviceId === deviceId &&
        isWithinBypassWindow(bypass, atMs)
    )
  },

  readingsOf(bypassId) {
    return get()
      .readings.filter((reading) => reading.bypassId === bypassId)
      .sort((a, b) => a.recordedAt - b.recordedAt)
  },

  leaksOf(bypassId) {
    return get()
      .leaks.filter((leak) => leak.bypassId === bypassId)
      .sort((a, b) => b.createdAt - a.createdAt)
  },

  detailOf(bypassId) {
    const bypass = get().bypasses.find((item) => item.id === bypassId)
    if (!bypass) return null
    return {
      bypass,
      readings: get().readingsOf(bypassId),
      leaks: get().leaksOf(bypassId)
    }
  },

  filteredBypasses() {
    const { bypasses, filter } = get()
    return bypasses
      .filter((bypass) => {
        if (filter.stationId && bypass.stationId !== filter.stationId) return false
        if (filter.state && bypass.state !== filter.state) return false
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  },

  isExpired(bypass) {
    return bypass.state === '进行中' && isBypassExpired(bypass)
  }
}))

liveQuery(async () => (await db.bypasses.toArray()).sort((a, b) => b.createdAt - a.createdAt)).subscribe({
  next: (rows) => useBypassStore.setState({ bypasses: rows, ready: true }),
  error: () => useBypassStore.setState({ ready: true })
})

liveQuery(async () => (await db.readings.toArray()).sort((a, b) => a.recordedAt - b.recordedAt)).subscribe({
  next: (rows) => useBypassStore.setState({ readings: rows })
})

liveQuery(async () => (await db.leaks.toArray()).sort((a, b) => b.createdAt - a.createdAt)).subscribe({
  next: (rows) => useBypassStore.setState({ leaks: rows })
})

export { bypassWindow, findOpenBypassOfDevice }
