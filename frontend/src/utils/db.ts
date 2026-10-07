/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { BypassWork } from '@/types/bypass'
import { deviationPctOf, judgeReading } from '@/utils/range'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyAbnormal: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyAbnormal: false }

export interface BackupPayload {
  app: 'gbgaspress'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  devices: Device[]
  points: Point[]
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  bypassworks: BypassWork[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned
export type BypassWorkRow = BypassWork & Revisioned

const ALL_TABLES = ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks', 'bypassworks'] as const

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  bypassworks!: Table<BypassWorkRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })

    // v2：点位/泄漏补 stationId 冗余列（按站点筛选免联表）；读数补 revision 与 note
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        // 迁移：点位缺少 stationId 时用所属设备回填
        const devices = (await tx.table('devices').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfDevice = new Map(devices.map((device) => [device.id, device.stationId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.stationId !== 'string' || point.stationId.length === 0) {
              point.stationId = stationOfDevice.get(String(point.deviceId)) ?? ''
            }
            if (typeof point.isCritical !== 'boolean') point.isCritical = false
          })

        // 迁移：泄漏处置补 stationId、复检值与病态状态
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.stationId !== 'string' || leak.stationId.length === 0) {
              leak.stationId = stationOfDevice.get(String(leak.deviceId)) ?? ''
            }
            if (typeof leak.retestValuePpm !== 'number' || !Number.isFinite(leak.retestValuePpm)) {
              leak.retestValuePpm = 0
            }
            if (leak.state !== '待处置' && leak.state !== '已处置' && leak.state !== '已复检') {
              leak.state = '待处置'
            }
          })

        // 迁移：读数补 note，并按偏差率重算 isAbnormal / deviationPct
        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
          isCritical: boolean
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const point = pointMap.get(String(reading.pointId))
            const value = Number(reading.value)
            if (point && Number.isFinite(value)) {
              const judgement = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
            } else {
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
            }
          })
      })

    // v3：旁通作业上线——新增 bypassworks 表；读数补作业归属/实测时刻/判级依据；
    // 泄漏单补作业归属与来源读数（幂等派单键）。历史读数判级依据回填为平时标准区间并冻结。
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, bypassWorkId, isAbnormal, measuredAt, updatedAt',
        leaks: 'id, deviceId, stationId, bypassWorkId, sourceReadingId, state, handler, updatedAt',
        bypassworks: 'id, code, stationId, deviceId, state, startAt, endAt, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ALL_TABLES) {
          if (name === 'bypassworks') continue
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        const points = (await tx.table('points').toArray()) as PointRow[]
        const pointMap = new Map(points.map((point) => [point.id, point]))

        // 历史读数补判级依据（平时标准区间快照）与实测时刻
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.bypassWorkId !== 'string') reading.bypassWorkId = ''
            if (!reading.judgeBasis) {
              const point = pointMap.get(String(reading.pointId))
              if (point) {
                reading.judgeBasis = {
                  type: '标准区间',
                  min: point.standardMin,
                  max: point.standardMax,
                  unit: point.unit,
                  source: '点位标准（历史回填）',
                  isCritical: point.isCritical
                }
              }
            }
            if (typeof reading.measuredAt !== 'number' || !Number.isFinite(reading.measuredAt)) {
              reading.measuredAt = Number(reading.updatedAt) || Number(reading.createdAt) || Date.now()
            }
          })

        // 历史泄漏单补来源字段
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.bypassWorkId !== 'string') leak.bypassWorkId = ''
            if (typeof leak.sourceReadingId !== 'string') leak.sourceReadingId = ''
          })
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '城东高中压调压站', location: '城东工业园区 A 区', designFlowM3h: 8000, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '2016-05-20', createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '西城新区调压站', location: '西城新区纬三路', designFlowM3h: 5000, inletPressureMpa: 0.2, grade: '中中压', commissionDate: '2019-08-12', createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_DEVICES: DeviceRow[] = [
  { id: 'dv-1', stationId: 'st-1', type: '调压器', model: 'RTZ-80/0.4', serialNo: 'SN20160520-01', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-2', stationId: 'st-1', type: '过滤器', model: 'GL-80', serialNo: 'SN20160520-02', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-3', stationId: 'st-1', type: '切断阀', model: 'QT-80', serialNo: 'SN20160520-03', installDate: '2016-05-20', state: '检修', createdAt: stamp(-289), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'dv-4', stationId: 'st-2', type: '调压器', model: 'RTZ-50/0.2', serialNo: 'SN20190812-01', installDate: '2019-08-12', state: '运行', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'dv-5', stationId: 'st-2', type: '放散阀', model: 'FS-50', serialNo: 'SN20190812-02', installDate: '2019-08-12', state: '运行', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_PATROLS: PatrolRow[] = [
  { id: 'pa-1', stationId: 'st-1', planDate: '2024-06-05', patrolDate: '2024-06-05', patrolman: '张伟', envNote: '晴，气温 26℃', state: '已完成', createdAt: stamp(-15), updatedAt: stamp(-15), revision: ROW_REVISION },
  { id: 'pa-2', stationId: 'st-1', planDate: '2024-06-12', patrolDate: '2024-06-12', patrolman: '张伟', envNote: '多云，风力 3 级', state: '已完成', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'pa-3', stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pa-4', stationId: 'st-2', planDate: '2024-06-06', patrolDate: '2024-06-08', patrolman: '李娜', envNote: '中雨，到场延迟 2 天', state: '已完成', createdAt: stamp(-14), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'pa-5', stationId: 'st-2', planDate: '2024-06-13', patrolDate: '', patrolman: '李娜', envNote: '计划未执行，人员调休', state: '漏检', createdAt: stamp(-7), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'pa-6', stationId: 'st-2', planDate: '2024-06-20', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的读数原始行：[巡检, 点位, 读数, 备注, 实测时刻偏移天] */
const SEED_READING_ROWS: Array<[string, string, number, string, number?]> = [
  ['pa-1', 'pt-1', 0.41, '', -15],
  ['pa-1', 'pt-2', 0.23, '', -15],
  ['pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味', -15],
  ['pa-2', 'pt-1', 0.38, '', -8],
  ['pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度', -8],
  ['pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹', -8],
  ['pa-2', 'pt-5', 55, '法兰处检出微量泄漏', -8],
  ['pa-4', 'pt-7', 0.21, '', -12],
  ['pa-4', 'pt-8', 0.145, '', -12],
  ['pa-4', 'pt-9', 12, '', -12],
  ['pa-4', 'pt-10', 88, '阀体密封处浓度偏高', -12]
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', bypassWorkId: '', sourceReadingId: '', createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', bypassWorkId: '', sourceReadingId: '', createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', bypassWorkId: '', sourceReadingId: '', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION },
  // 进行中的旁通作业：阀体泄漏浓度越过安全线，已立即派单待处置
  { id: 'lk-bp1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 110, foundTime: new Date().toISOString().slice(0, 10), measure: '旁通作业期在线监测越安全线，已派现场处置组复核', state: '待处置', retestValuePpm: 0, handler: '王强', bypassWorkId: 'bw-2', sourceReadingId: 'rd-bp4', createdAt: Date.now(), updatedAt: Date.now(), revision: ROW_REVISION }
]

/** 由原始行派生偏差率与异常标记 */
function buildSeedReadings(): ReadingRow[] {
  return SEED_READING_ROWS.map(([patrolId, pointId, value, note, offsetDays], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const judgement = point
      ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
      : { isAbnormal: false, deviationPct: deviationPctOf(value, 0, 1) }
    const at = stamp(offsetDays ?? -200 + index)
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      bypassWorkId: '',
      measuredAt: at,
      judgeBasis: point
        ? {
            type: '标准区间' as const,
            min: point.standardMin,
            max: point.standardMax,
            unit: point.unit,
            source: '点位标准',
            isCritical: point.isCritical
          }
        : undefined,
      createdAt: at,
      updatedAt: at,
      revision: ROW_REVISION
    }
  })
}

/** 旁通作业演示数据：一张已归档（历史可追溯）、一张进行中（许可期内按临时区间判级） */
function buildSeedBypassData(): { works: BypassWorkRow[]; readings: ReadingRow[] } {
  // bw-1：2024-06-10 城东调压器临时旁通，已归档；两个读数按更宽的临时区间均判正常，因此不补派泄漏单
  const bw1Start = Date.parse('2024-06-10T09:00:00+08:00')
  const bw1End = Date.parse('2024-06-10T15:00:00+08:00')
  const bw1Limit = { pointId: 'pt-2', pointName: '出口压力', unit: 'MPa', isCritical: true, tempMin: 0.16, tempMax: 0.3 }
  const bw1Judgement = judgeReading(0.27, bw1Limit.tempMin, bw1Limit.tempMax, true)
  const bw1Reading: ReadingRow = {
    id: 'rd-bp1',
    patrolId: '',
    pointId: 'pt-2',
    value: 0.27,
    isAbnormal: bw1Judgement.isAbnormal,
    deviationPct: bw1Judgement.deviationPct,
    note: '旁通投运后出口压力按临时区间受控',
    bypassWorkId: 'bw-1',
    measuredAt: Date.parse('2024-06-10T10:20:00+08:00'),
    judgeBasis: {
      type: '旁通临时区间',
      min: bw1Limit.tempMin,
      max: bw1Limit.tempMax,
      unit: bw1Limit.unit,
      source: '旁通作业 BP20240610-01',
      isCritical: true
    },
    createdAt: Date.parse('2024-06-10T10:20:00+08:00'),
    updatedAt: Date.parse('2024-06-10T10:20:00+08:00'),
    revision: ROW_REVISION
  }
  const bw1: BypassWorkRow = {
    id: 'bw-1',
    code: 'BP20240610-01',
    stationId: 'st-1',
    deviceId: 'dv-1',
    reason: '调压器主路密封垫更换，临时开旁通供气',
    manager: '王强',
    recorder: '张伟',
    startAt: bw1Start,
    endAt: bw1End,
    safetyLinePpm: 50,
    limits: [bw1Limit],
    state: '已归档',
    readingIds: ['rd-bp1'],
    leakIds: [],
    batch: {
      batchNo: 'BC20240610-01',
      total: 1,
      startedAt: Date.parse('2024-06-10T15:05:00+08:00'),
      lastRunAt: Date.parse('2024-06-10T15:05:00+08:00'),
      rounds: 1,
      items: [
        {
          key: 'readings:rd-bp1',
          kind: '读数',
          refId: 'rd-bp1',
          pointName: '出口压力',
          value: 0.27,
          unit: 'MPa',
          state: '已写入',
          error: '',
          attempts: 1,
          lastAttemptAt: Date.parse('2024-06-10T15:05:00+08:00')
        }
      ]
    },
    archivedAt: Date.parse('2024-06-10T15:05:00+08:00'),
    closeNote: '主路复装并气密试验合格，退出旁通，作业期读数全部入台账，无泄漏处置单。',
    createdAt: bw1Start,
    updatedAt: Date.parse('2024-06-10T15:05:00+08:00'),
    revision: ROW_REVISION
  }

  // bw-2：进行中——许可自当前时刻前 1 小时起、5 小时后到期
  const now = Date.now()
  const bw2Start = now - 3600000
  const bw2End = now + 5 * 3600000
  const bw2Limits: BypassWork['limits'] = [
    { pointId: 'pt-1', pointName: '进口压力', unit: 'MPa', isCritical: true, tempMin: 0.32, tempMax: 0.48 },
    { pointId: 'pt-2', pointName: '出口压力', unit: 'MPa', isCritical: true, tempMin: 0.16, tempMax: 0.3 },
    { pointId: 'pt-3', pointName: '阀体泄漏浓度', unit: 'ppm', isCritical: true, tempMin: 0, tempMax: 80 }
  ]
  const bp3At = now - 900000
  const bp4At = now - 300000
  const j3 = judgeReading(0.24, 0.16, 0.3, true)
  const j4 = judgeReading(110, 0, 80, true)
  const bp3: ReadingRow = {
    id: 'rd-bp3',
    patrolId: '',
    pointId: 'pt-2',
    value: 0.24,
    isAbnormal: j3.isAbnormal,
    deviationPct: j3.deviationPct,
    note: '旁通运行平稳',
    bypassWorkId: 'bw-2',
    measuredAt: bp3At,
    judgeBasis: { type: '旁通临时区间', min: 0.16, max: 0.3, unit: 'MPa', source: '旁通作业（进行中）', isCritical: true },
    createdAt: bp3At,
    updatedAt: bp3At,
    revision: ROW_REVISION
  }
  const bp4: ReadingRow = {
    id: 'rd-bp4',
    patrolId: '',
    pointId: 'pt-3',
    value: 110,
    isAbnormal: j4.isAbnormal,
    deviationPct: j4.deviationPct,
    note: '在线监测浓度越过安全线，已立即派单',
    bypassWorkId: 'bw-2',
    measuredAt: bp4At,
    judgeBasis: { type: '旁通临时区间', min: 0, max: 80, unit: 'ppm', source: '旁通作业（进行中）', isCritical: true },
    createdAt: bp4At,
    updatedAt: bp4At,
    revision: ROW_REVISION
  }
  const bw2: BypassWorkRow = {
    id: 'bw-2',
    code: `BP${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-02`,
    stationId: 'st-1',
    deviceId: 'dv-1',
    reason: '出口压力异常抢修，临时开旁通维持供气',
    manager: '王强',
    recorder: '李娜',
    startAt: bw2Start,
    endAt: bw2End,
    safetyLinePpm: 80,
    limits: bw2Limits,
    state: '进行中',
    readingIds: ['rd-bp3', 'rd-bp4'],
    leakIds: ['lk-bp1'],
    batch: null,
    archivedAt: null,
    closeNote: '',
    createdAt: bw2Start,
    updatedAt: bp4At,
    revision: ROW_REVISION
  }

  return { works: [bw1, bw2], readings: [bw1Reading, bp3, bp4] }
}

export async function seedDatabase(): Promise<void> {
  const bypassData = buildSeedBypassData()
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypassworks],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.readings.bulkPut([...buildSeedReadings(), ...bypassData.readings])
    await db.leaks.bulkPut(SEED_LEAKS)
    await db.bypassworks.bulkPut(bypassData.works)
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypassworks],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.bypassworks.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypassworks],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.bypassworks.where('deviceId').equals(deviceId).delete()
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypassworks],
      async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypassworks],
      async () => {
    // 仅删除该巡检的平时读数；旁通作业读数（patrolId 为空）不受影响
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
  const workIds = (await db.bypassworks.where('deviceId').anyOf(deviceIds).primaryKeys()) as string[]
  if (workIds.length > 0) {
    await db.readings.where('bypassWorkId').anyOf(workIds).delete()
    await db.bypassworks.bulkDelete(workIds)
  }
}

/* ============================ 读数写入 ============================ */

/** 写入读数：自动与标准区间比对并落 isAbnormal / deviationPct（平时巡检读数） */
export async function putReading(row: {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  measuredAt?: number
  createdAt: number
  updatedAt: number
}): Promise<ReadingRow> {
  const point = await db.points.get(row.pointId)
  const judgement = point
    ? judgeReading(row.value, point.standardMin, point.standardMax, point.isCritical)
    : { isAbnormal: false, deviationPct: 0 }
  const next: ReadingRow = {
    ...row,
    bypassWorkId: '',
    measuredAt: row.measuredAt ?? row.updatedAt,
    judgeBasis: point
      ? {
          type: '标准区间',
          min: point.standardMin,
          max: point.standardMax,
          unit: point.unit,
          source: '点位标准',
          isCritical: point.isCritical
        }
      : undefined,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/** 重算某点位全部读数的偏差率（标准值变更后调用）；旁通作业读数按临时区间冻结，不回改 */
export async function recalculateReadingsOfPoint(pointId: string): Promise<void> {
  const point = await db.points.get(pointId)
  if (!point) return
  const rows = await db.readings.where('pointId').equals(pointId).toArray()
  if (rows.length === 0) return
  const movable = rows.filter((row) => !row.bypassWorkId)
  if (movable.length === 0) return
  await db.readings.bulkPut(
    movable.map((row) => {
      const judgement = judgeReading(row.value, point.standardMin, point.standardMax, point.isCritical)
      return {
        ...row,
        isAbnormal: judgement.isAbnormal,
        deviationPct: judgement.deviationPct,
        judgeBasis: {
          type: '标准区间' as const,
          min: point.standardMin,
          max: point.standardMax,
          unit: point.unit,
          source: '点位标准',
          isCritical: point.isCritical
        },
        updatedAt: Date.now()
      }
    })
  )
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, bypassworks] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.bypassworks.count()
  ])
  return { stations, devices, points, patrols, readings, leaks, bypassworks }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, bypassworks] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.bypassworks.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbgaspress',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    devices: devices.map(strip),
    points: points.map(strip),
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip),
    bypassworks: bypassworks.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypassworks],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.bypassworks.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut((payload.readings ?? []).map(rev))
    await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
    await db.bypassworks.bulkPut((payload.bypassworks ?? []).map(rev))
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypassworks],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.bypassworks.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyAbnormal: parsed.onlyAbnormal === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
