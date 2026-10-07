/**
 * 泄漏处置状态（Zustand）
 * 维护处置单状态机、复检值与闭环统计。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, type LeakRow } from '@/utils/db'
import {
  LEAK_RETEST_PASS_PPM,
  retestPassed,
  type Leak,
  type LeakDraft,
  type LeakState
} from '@/types/leak'

interface LeakState_ {
  leaks: Leak[]
  stateFilter: LeakState[]
  stationId: string
  onlyOpen: boolean
  ready: boolean
  patchFilter: (patch: { stateFilter?: LeakState[]; stationId?: string; onlyOpen?: boolean }) => void
  resetFilter: () => void
  createLeak: (draft: LeakDraft) => Promise<Leak>
  updateLeak: (id: string, patch: Partial<LeakDraft>) => Promise<void>
  removeLeak: (id: string) => Promise<void>
  advance: (id: string, params?: { handler?: string; measure?: string }) => Promise<LeakState | null>
  submitRetest: (id: string, retestValuePpm: number, handler: string) => Promise<boolean>
  hasLeakOfDevice: (deviceId: string) => boolean
  createFromAbnormal: (payload: {
    deviceId: string
    stationId: string
    concentrationPpm: number
    foundTime: string
    measure: string
  }) => Promise<Leak>
  /** 由异常读数幂等派单：该读数已派过则直接返回原单，不重复派单 */
  dispatchFromReading: (payload: {
    readingId: string
    deviceId: string
    stationId: string
    concentrationPpm: number
    foundTime: string
    measure: string
  }) => Promise<{ leak: Leak; created: boolean }>
  counts: () => Record<LeakState, number>
  closedPercent: () => number
  retestPassCount: () => number
  filteredLeaks: () => Leak[]
}

export const useLeakStore = create<LeakState_>((set, get) => ({
  leaks: [],
  stateFilter: [],
  stationId: '',
  onlyOpen: false,
  ready: false,

  patchFilter(patch) {
    set({
      stateFilter: patch.stateFilter ?? get().stateFilter,
      stationId: patch.stationId ?? get().stationId,
      onlyOpen: patch.onlyOpen ?? get().onlyOpen
    })
  },

  resetFilter() {
    set({ stateFilter: [], stationId: '', onlyOpen: false })
  },

  async createLeak(draft) {
    const device = await db.devices.get(draft.deviceId)
    const now = Date.now()
    const row: LeakRow = {
      id: createId('lk'),
      deviceId: draft.deviceId,
      stationId: device ? device.stationId : '',
      concentrationPpm: Number(draft.concentrationPpm) || 0,
      foundTime: draft.foundTime,
      measure: draft.measure.trim(),
      state: draft.state,
      retestValuePpm: Number(draft.retestValuePpm) || 0,
      handler: draft.handler.trim(),
      bypassId: '',
      sourceReadingId: '',
      judgeBasis: '平时标准区间',
      createdAt: now,
      updatedAt: now
    }
    await db.leaks.put(row)
    return row
  },

  async updateLeak(id, patch) {
    const next: Partial<LeakRow> = { ...patch, updatedAt: Date.now() }
    if (patch.measure !== undefined) next.measure = patch.measure.trim()
    if (patch.handler !== undefined) next.handler = patch.handler.trim()
    await db.leaks.update(id, next)
  },

  async removeLeak(id) {
    await db.leaks.delete(id)
  },

  async advance(id, params) {
    const leak = get().leaks.find((item) => item.id === id)
    if (!leak) return null
    const next: LeakState | null = leak.state === '待处置' ? '已处置' : leak.state === '已处置' ? '已复检' : null
    if (!next) return null
    const patch: Partial<LeakRow> = { state: next, updatedAt: Date.now() }
    if (params?.handler !== undefined) patch.handler = params.handler.trim()
    if (params?.measure !== undefined) patch.measure = params.measure.trim()
    await db.leaks.update(id, patch)
    return next
  },

  async submitRetest(id, retestValuePpm, handler) {
    const value = Number(retestValuePpm) || 0
    await db.leaks.update(id, {
      state: '已复检',
      retestValuePpm: value,
      handler: handler.trim() || '未署名',
      updatedAt: Date.now()
    })
    return retestPassed(value)
  },

  hasLeakOfDevice(deviceId) {
    return get().leaks.some((leak) => leak.deviceId === deviceId)
  },

  async createFromAbnormal(payload) {
    const leak = await get().createLeak({
      deviceId: payload.deviceId,
      concentrationPpm: payload.concentrationPpm,
      foundTime: payload.foundTime,
      measure: payload.measure,
      state: '待处置',
      retestValuePpm: 0,
      handler: ''
    })
    return leak
  },

  async dispatchFromReading(payload) {
    // 幂等：该读数已派生过处置单（回填 leakId 或同 sourceReadingId），直接返回原单
    const existing = get().leaks.find((leak) => leak.sourceReadingId === payload.readingId)
    if (existing) return { leak: existing, created: false }
    const source = await db.readings.get(payload.readingId)
    if (source?.leakId) {
      const linked = get().leaks.find((leak) => leak.id === source.leakId)
      if (linked) return { leak: linked, created: false }
    }
    const device = await db.devices.get(payload.deviceId)
    const now = Date.now()
    const basis = source?.judgeBasis === '临时安全区间' ? '临时安全区间' : '平时标准区间'
    const row: LeakRow = {
      id: createId('lk'),
      deviceId: payload.deviceId,
      stationId: payload.stationId || (device ? device.stationId : ''),
      concentrationPpm: Number(payload.concentrationPpm) || 0,
      foundTime: payload.foundTime,
      measure: payload.measure.trim(),
      state: '待处置',
      retestValuePpm: 0,
      handler: '',
      bypassId: source?.bypassId ?? '',
      sourceReadingId: payload.readingId,
      judgeBasis: basis,
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.leaks, db.readings], async () => {
      await db.leaks.put(row)
      await db.readings.update(payload.readingId, { leakId: row.id, updatedAt: now })
    })
    return { leak: row, created: true }
  },

  counts() {
    const counts: Record<LeakState, number> = { 待处置: 0, 已处置: 0, 已复检: 0 }
    get().leaks.forEach((leak) => {
      counts[leak.state] += 1
    })
    return counts
  },

  closedPercent() {
    const { leaks } = get()
    if (leaks.length === 0) return 0
    const closed = leaks.filter((leak) => leak.state === '已复检').length
    return Math.round((closed / leaks.length) * 100)
  },

  retestPassCount() {
    return get().leaks.filter((leak) => leak.state === '已复检' && retestPassed(leak.retestValuePpm)).length
  },

  filteredLeaks() {
    const { leaks, stateFilter, stationId, onlyOpen } = get()
    return leaks
      .filter((leak) => {
        if (stationId && leak.stationId !== stationId) return false
        if (stateFilter.length > 0 && !stateFilter.includes(leak.state)) return false
        if (onlyOpen && leak.state === '已复检') return false
        return true
      })
      .sort((a, b) => b.foundTime.localeCompare(a.foundTime))
  }
}))

liveQuery(async () => (await db.leaks.toArray()).sort((a, b) => b.foundTime.localeCompare(a.foundTime))).subscribe({
  next: (rows) => useLeakStore.setState({ leaks: rows, ready: true }),
  error: () => useLeakStore.setState({ ready: true })
})

export { LEAK_RETEST_PASS_PPM }
