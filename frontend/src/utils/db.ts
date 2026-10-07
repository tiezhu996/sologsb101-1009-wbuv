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
import type { Bypass, BypassReadingDraft } from '@/types/bypass'
import { deviationPctOf, judgeReading, judgeWithBasis } from '@/utils/range'

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
  bypasses: Bypass[]
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
export type BypassRow = Bypass & Revisioned

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  bypasses!: Table<BypassRow, string>

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

    // v3：旁通作业。新增 bypasses 表；读数补作业归属/判据/区间快照/现场批次/处置单回填，
    // 泄漏单补作业来源/来源读数/判据。历史数据统一按平时标准区间回填，保证判级依据可追溯。
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, bypassId, ledgerState, leakId, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, bypassId, sourceReadingId, updatedAt',
        bypasses: 'id, code, stationId, deviceId, state, startTime, endTime, updatedAt'
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

        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))

        // 读数回填：历史读数按当时保存的偏差率沿用平时标准区间，记录判据与区间快照
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.bypassId !== 'string') reading.bypassId = ''
            if (reading.judgeBasis !== '临时安全区间') reading.judgeBasis = '平时标准区间'
            const point = pointMap.get(String(reading.pointId))
            reading.judgeMin = point ? point.standardMin : 0
            reading.judgeMax = point ? point.standardMax : 1
            const created = Number(reading.createdAt)
            reading.recordedAt = Number.isFinite(created) ? created : Date.now()
            if (typeof reading.recorder !== 'string') reading.recorder = ''
            if (reading.ledgerState !== '现场批次') reading.ledgerState = '已入账'
            if (typeof reading.leakId !== 'string') reading.leakId = ''
          })

        // 泄漏单回填：历史处置单均为平时标准区间派单
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.bypassId !== 'string') leak.bypassId = ''
            if (typeof leak.sourceReadingId !== 'string') leak.sourceReadingId = ''
            if (leak.judgeBasis !== '临时安全区间') leak.judgeBasis = '平时标准区间'
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

/** 播种用的读数原始行：[巡检, 点位, 读数, 备注] */
const SEED_READING_ROWS: Array<[string, string, number, string]> = [
  ['pa-1', 'pt-1', 0.41, ''],
  ['pa-1', 'pt-2', 0.23, ''],
  ['pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味'],
  ['pa-2', 'pt-1', 0.38, ''],
  ['pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度'],
  ['pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹'],
  ['pa-2', 'pt-5', 55, '法兰处检出微量泄漏'],
  ['pa-4', 'pt-7', 0.21, ''],
  ['pa-4', 'pt-8', 0.145, ''],
  ['pa-4', 'pt-9', 12, ''],
  ['pa-4', 'pt-10', 88, '阀体密封处浓度偏高']
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', bypassId: '', sourceReadingId: 'rd-3', judgeBasis: '平时标准区间', createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', bypassId: '', sourceReadingId: 'rd-7', judgeBasis: '平时标准区间', createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', bypassId: '', sourceReadingId: 'rd-11', judgeBasis: '平时标准区间', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'lk-4', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 135, foundTime: '2024-06-18', measure: '抢修临时开旁通期间，阀体浓度越过临时安全线 120 ppm，立即派单；关闭旁通后更换密封件复检合格', state: '已复检', retestValuePpm: 30, handler: '王强', bypassId: 'bp-1', sourceReadingId: 'rd-bp-2', judgeBasis: '临时安全区间', createdAt: stamp(-4) + 3600000, updatedAt: stamp(-3), revision: ROW_REVISION }
]

/** 由原始行派生偏差率与异常标记 */
function buildSeedReadings(): ReadingRow[] {
  const normal = SEED_READING_ROWS.map(([patrolId, pointId, value, note], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const judgement = point
      ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
      : { isAbnormal: false, deviationPct: deviationPctOf(value, 0, 1) }
    const created = stamp(-200 + index)
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      bypassId: '',
      judgeBasis: '平时标准区间' as const,
      judgeMin: point ? point.standardMin : 0,
      judgeMax: point ? point.standardMax : 1,
      recordedAt: created,
      recorder: '',
      ledgerState: '已入账' as const,
      leakId: '',
      createdAt: created,
      updatedAt: created,
      revision: ROW_REVISION
    }
  })

  // 旁通作业 bp-1 的现场批次读数：按临时安全区间 0~120 ppm 判定
  const bp1Start = Date.parse('2024-06-18T09:00:00+08:00')
  const bpBatches: ReadingRow[] = [
    {
      id: 'rd-bp-1',
      patrolId: '',
      pointId: 'pt-3',
      value: 62,
      isAbnormal: false,
      deviationPct: 0,
      note: '开旁通后首测，临时安全区间内',
      bypassId: 'bp-1',
      judgeBasis: '临时安全区间',
      judgeMin: 0,
      judgeMax: 120,
      recordedAt: Date.parse('2024-06-18T09:20:00+08:00'),
      recorder: '李娜',
      ledgerState: '已入账',
      leakId: '',
      createdAt: bp1Start,
      updatedAt: bp1Start,
      revision: ROW_REVISION
    },
    {
      id: 'rd-bp-2',
      patrolId: '',
      pointId: 'pt-3',
      value: 135,
      isAbnormal: true,
      deviationPct: deviationPctOf(135, 0, 120),
      note: '浓度越过临时安全线，现场立即派单',
      bypassId: 'bp-1',
      judgeBasis: '临时安全区间',
      judgeMin: 0,
      judgeMax: 120,
      recordedAt: Date.parse('2024-06-18T10:05:00+08:00'),
      recorder: '李娜',
      ledgerState: '已入账',
      leakId: 'lk-4',
      createdAt: bp1Start + 3600000,
      updatedAt: bp1Start + 3600000,
      revision: ROW_REVISION
    }
  ]

  return [...normal, ...bpBatches]
}

/** 播种用旁通作业：一条已归档的抢修开旁通作业（含 2 条现场读数、1 张立即派单） */
const SEED_BYPASSES: BypassRow[] = [
  {
    id: 'bp-1',
    code: 'BP20240618-0001',
    stationId: 'st-1',
    deviceId: 'dv-1',
    leader: '王强',
    recorder: '李娜',
    reason: '调压器抢修，临时开旁通供气',
    startTime: '2024-06-18T09:00',
    endTime: '2024-06-18T12:00',
    safeMin: 0,
    safeMax: 120,
    safeUnit: 'ppm',
    finishedAt: '2024-06-18T11:40',
    state: '已归档',
    archiveState: '已归档',
    archiveError: '',
    retryCount: 0,
    readingCount: 2,
    leakCount: 1,
    conclusion: '抢修完成恢复正常供气，临时区间内 1 条读数正常，越线 1 条已立即派单并复检合格',
    createdAt: stamp(-4),
    updatedAt: stamp(-3),
    revision: ROW_REVISION
  }
]

export async function seedDatabase(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypasses],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.readings.bulkPut(buildSeedReadings())
    await db.leaks.bulkPut(SEED_LEAKS)
    await db.bypasses.bulkPut(SEED_BYPASSES)
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
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypasses],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.bypasses.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypasses],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypasses],
      async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypasses],
      async () => {
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
  await db.bypasses.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入 ============================ */

/** 写入读数：自动与标准区间比对并落 isAbnormal / deviationPct */
export async function putReading(row: {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  createdAt: number
  updatedAt: number
}): Promise<ReadingRow> {
  const point = await db.points.get(row.pointId)
  const judgement = point
    ? judgeReading(row.value, point.standardMin, point.standardMax, point.isCritical)
    : { isAbnormal: false, deviationPct: 0 }
  const existing = await db.readings.get(row.id)
  const next: ReadingRow = {
    ...row,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    bypassId: existing?.bypassId ?? '',
    judgeBasis: existing?.judgeBasis ?? '平时标准区间',
    judgeMin: existing?.judgeMin ?? (point ? point.standardMin : 0),
    judgeMax: existing?.judgeMax ?? (point ? point.standardMax : 1),
    recordedAt: existing?.recordedAt ?? row.createdAt,
    recorder: existing?.recorder ?? '',
    ledgerState: existing?.ledgerState ?? '已入账',
    leakId: existing?.leakId ?? '',
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/** 重算某点位全部读数的偏差率（标准值变更后调用；旁通作业读数沿用临时区间不重算） */
export async function recalculateReadingsOfPoint(pointId: string): Promise<void> {
  const point = await db.points.get(pointId)
  if (!point) return
  const rows = await db.readings.where('pointId').equals(pointId).toArray()
  if (rows.length === 0) return
  await db.readings.bulkPut(
    rows.map((row) => {
      // 作业期读数按临时安全区间判定，许可到期前也不能改用平时标准，故不参与平时重算
      if (row.bypassId) return row
      const judgement = judgeReading(row.value, point.standardMin, point.standardMax, point.isCritical)
      return {
        ...row,
        isAbnormal: judgement.isAbnormal,
        deviationPct: judgement.deviationPct,
        judgeBasis: '平时标准区间' as const,
        judgeMin: point.standardMin,
        judgeMax: point.standardMax,
        updatedAt: Date.now()
      }
    })
  )
}

/* ============================ 旁通作业 ============================ */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 毫秒时间戳 → YYYY-MM-DD（本地时区） */
export function dayOfMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 生成作业单号：BP + 日期 + 当日序号，如 BP20261007-0001 */
async function nextBypassCode(now: number): Promise<string> {
  const d = new Date(now)
  const day = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
  const prefix = `BP${day}-`
  const all = await db.bypasses.toArray()
  const seq = all.filter((item) => item.code.startsWith(prefix)).length + 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

/** 同一设备的未归档作业（进行中 / 待归档）；存在即不能再开新作业 */
export async function findOpenBypassOfDevice(deviceId: string): Promise<BypassRow | undefined> {
  const rows = await db.bypasses.where('deviceId').equals(deviceId).toArray()
  return rows.find((item) => item.state === '进行中' || item.state === '待归档')
}

/** 新建旁通作业：负责人登记站点、设备、起止时间与临时安全区间 */
export async function createBypass(draft: {
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
}): Promise<BypassRow> {
  const occupied = await findOpenBypassOfDevice(draft.deviceId)
  if (occupied) {
    throw new Error(`该设备已有未归档作业 ${occupied.code}，不能重复开作业`)
  }
  const startMs = Date.parse(draft.startTime)
  const endMs = Date.parse(draft.endTime)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('作业起止时间无效：截止时间必须晚于开始时间')
  }
  const min = Math.min(Number(draft.safeMin), Number(draft.safeMax))
  const max = Math.max(Number(draft.safeMin), Number(draft.safeMax))
  const now = Date.now()
  const row: BypassRow = {
    id: createId('bp'),
    code: await nextBypassCode(now),
    stationId: draft.stationId,
    deviceId: draft.deviceId,
    leader: draft.leader.trim(),
    recorder: draft.recorder.trim(),
    reason: draft.reason.trim(),
    startTime: draft.startTime,
    endTime: draft.endTime,
    safeMin: min,
    safeMax: max,
    safeUnit: draft.safeUnit,
    finishedAt: '',
    state: '进行中',
    archiveState: '未核对',
    archiveError: '',
    retryCount: 0,
    readingCount: 0,
    leakCount: 0,
    conclusion: '',
    createdAt: now,
    updatedAt: now,
    revision: ROW_REVISION
  }
  await db.bypasses.put(row)
  return row
}

export interface BypassReadingResult {
  reading: ReadingRow
  /** 浓度越过临时安全线时立即派出的处置单（已派过则不重复派） */
  leak: LeakRow | null
}

/**
 * 现场记录人登记一条作业期读数：
 * - 归到同一作业下，按临时安全区间判定（记录判据与区间快照）
 * - 先落「现场批次」，台账归档时只补未入账部分
 * - 浓度越过安全线立即派单，并把处置单 id 回填到读数，保证不重复派单
 */
export async function putBypassReading(
  bypass: BypassRow,
  draft: BypassReadingDraft
): Promise<BypassReadingResult> {
  const point = await db.points.get(draft.pointId)
  if (!point) throw new Error('点位不存在，无法登记作业读数')
  if (point.deviceId !== bypass.deviceId) throw new Error('该点位不属于本次作业设备')
  if (point.unit !== bypass.safeUnit) {
    throw new Error(`作业临时安全区间单位为 ${bypass.safeUnit}，只能登记同单位点位读数`)
  }
  const now = Date.now()
  const judgement = judgeWithBasis(draft.value, bypass.safeMin, bypass.safeMax, point.isCritical, '临时安全区间')
  const readingId = createId('rd')
  const reading: ReadingRow = {
    id: readingId,
    patrolId: '',
    pointId: point.id,
    value: draft.value,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    note: draft.note.trim(),
    bypassId: bypass.id,
    judgeBasis: '临时安全区间',
    judgeMin: bypass.safeMin,
    judgeMax: bypass.safeMax,
    recordedAt: draft.recordedAt || now,
    recorder: draft.recorder.trim() || bypass.recorder,
    ledgerState: '现场批次',
    leakId: '',
    createdAt: now,
    updatedAt: now,
    revision: ROW_REVISION
  }

  let leak: LeakRow | null = null
  await db.transaction('rw', [db.readings, db.leaks], async () => {
    // 浓度越过安全线（高于临时上限）立即派单；区间内或低于下限不派泄漏单
    if (draft.value > bypass.safeMax) {
      leak = {
        id: createId('lk'),
        deviceId: bypass.deviceId,
        stationId: bypass.stationId,
        concentrationPpm: draft.value,
        foundTime: dayOfMs(reading.recordedAt),
        measure: `旁通作业 ${bypass.code} 期间，${point.name} 浓度 ${draft.value} ${point.unit} 越过临时安全线 ${bypass.safeMax} ${bypass.safeUnit}，现场立即派单`,
        state: '待处置',
        retestValuePpm: 0,
        handler: bypass.leader,
        bypassId: bypass.id,
        sourceReadingId: readingId,
        judgeBasis: '临时安全区间',
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      }
      await db.leaks.put(leak)
      reading.leakId = leak.id
    }
    await db.readings.put(reading)
  })

  return { reading, leak }
}

/** 结束作业前的台账核对：本次作业期读数与泄漏单 */
export interface BypassCloseCheckResult {
  bypass: BypassRow
  readings: ReadingRow[]
  leaks: LeakRow[]
  abnormalCount: number
  overLimitCount: number
}

export async function checkBypassBeforeClose(bypassId: string): Promise<BypassCloseCheckResult> {
  const bypass = await db.bypasses.get(bypassId)
  if (!bypass) throw new Error('作业不存在')
  const readings = await db.readings.where('bypassId').equals(bypassId).toArray()
  const leaks = await db.leaks.where('bypassId').equals(bypassId).toArray()
  const abnormalCount = readings.filter((item) => item.isAbnormal).length
  const overLimitCount = readings.filter((item) => item.value > bypass.safeMax).length
  return { bypass, readings, leaks, abnormalCount, overLimitCount }
}

/**
 * 结束作业：先核对本次读数与泄漏单，置「待归档」（现场批次保留），等待台账写入。
 * 不能在核对前直接归档；核对结果写入作业，供历史追溯。
 */
export async function closeBypass(bypassId: string, conclusion: string): Promise<BypassRow> {
  const check = await checkBypassBeforeClose(bypassId)
  const next: Partial<BypassRow> = {
    state: '待归档',
    archiveState: '待写台账',
    finishedAt: new Date().toISOString().slice(0, 16),
    readingCount: check.readings.length,
    leakCount: check.leaks.length,
    conclusion: conclusion.trim(),
    updatedAt: Date.now()
  }
  await db.bypasses.update(bypassId, next)
  const updated = await db.bypasses.get(bypassId)
  if (!updated) throw new Error('作业不存在')
  return updated
}

export interface ArchiveBypassOptions {
  /** 演示台账写入失败：置失败状态并保留现场批次，不写台账，便于演示重试 */
  simulateFailure?: boolean
}

export interface ArchiveBypassOutcome {
  ok: boolean
  /** 本次新入账的读数条数（只补未完成部分） */
  readLedgered: number
  /** 本次补派的泄漏单数（只补未完成部分） */
  leaksCreated: number
  readingCount: number
  leakCount: number
  retryCount: number
  retried: boolean
  error?: string
}

/**
 * 台账写入（可重试、幂等）：
 * - 台账失败后现场批次保留，重试只补「现场批次」的读数与缺处置单的越线读数
 * - 已入账读数与已有处置单不重复处理，绝不重复派单
 */
export async function archiveBypassLedger(
  bypassId: string,
  options: ArchiveBypassOptions = {}
): Promise<ArchiveBypassOutcome> {
  const bypass = await db.bypasses.get(bypassId)
  if (!bypass) throw new Error('作业不存在')
  if (bypass.state === '已归档') {
    const [readings, leaks] = await Promise.all([
      db.readings.where('bypassId').equals(bypassId).toArray(),
      db.leaks.where('bypassId').equals(bypassId).toArray()
    ])
    return {
      ok: true,
      readLedgered: 0,
      leaksCreated: 0,
      readingCount: readings.length,
      leakCount: leaks.length,
      retryCount: bypass.retryCount,
      retried: false
    }
  }

  const readings = await db.readings.where('bypassId').equals(bypassId).toArray()
  const leaks = await db.leaks.where('bypassId').equals(bypassId).toArray()

  if (options.simulateFailure) {
    const error = '台账写入失败（模拟）：现场批次已保留，请排查后重试，仅补未完成部分'
    await db.bypasses.update(bypassId, {
      state: '待归档',
      archiveState: '台账失败待重试',
      archiveError: error,
      retryCount: bypass.retryCount + 1,
      updatedAt: Date.now()
    })
    return {
      ok: false,
      readLedgered: 0,
      leaksCreated: 0,
      readingCount: readings.length,
      leakCount: leaks.length,
      retryCount: bypass.retryCount + 1,
      retried: bypass.archiveState === '台账失败待重试',
      error
    }
  }

  try {
    let readLedgered = 0
    let leaksCreated = 0
    await db.transaction('rw', [db.readings, db.leaks, db.bypasses, db.points], async () => {
      const now = Date.now()

      // 只补未入账读数
      for (const reading of readings) {
        if (reading.ledgerState === '已入账') continue
        await db.readings.update(reading.id, { ledgerState: '已入账', updatedAt: now })
        readLedgered += 1
      }

      // 只补漏派的越线读数：以读数回填的 leakId 是否能查到现存处置单为准，
      // 现场批次保留而处置单缺失（未完成）时必须补派，已存在的不重复派
      for (const reading of readings) {
        if (reading.value <= bypass.safeMax) continue
        const stillLinked = reading.leakId ? await db.leaks.get(reading.leakId) : undefined
        if (stillLinked) continue
        const point = await db.points.get(reading.pointId)
        const leakRow: LeakRow = {
          id: createId('lk'),
          deviceId: bypass.deviceId,
          stationId: bypass.stationId,
          concentrationPpm: reading.value,
          foundTime: dayOfMs(reading.recordedAt),
          measure: `旁通作业 ${bypass.code} 台账补登：${point?.name ?? '浓度点位'} ${reading.value} ${
            point?.unit ?? bypass.safeUnit
          } 越过临时安全线 ${bypass.safeMax} ${bypass.safeUnit}`,
          state: '待处置',
          retestValuePpm: 0,
          handler: bypass.leader,
          bypassId: bypass.id,
          sourceReadingId: reading.id,
          judgeBasis: '临时安全区间',
          createdAt: now,
          updatedAt: now,
          revision: ROW_REVISION
        }
        await db.leaks.put(leakRow)
        await db.readings.update(reading.id, { leakId: leakRow.id, updatedAt: now })
        leaksCreated += 1
      }

      const [allReadings, allLeaks] = await Promise.all([
        db.readings.where('bypassId').equals(bypassId).toArray(),
        db.leaks.where('bypassId').equals(bypassId).toArray()
      ])
      await db.bypasses.update(bypassId, {
        state: '已归档',
        archiveState: '已归档',
        archiveError: '',
        finishedAt: bypass.finishedAt || new Date().toISOString().slice(0, 16),
        readingCount: allReadings.length,
        leakCount: allLeaks.length,
        updatedAt: now
      })
    })

    const [allReadings, allLeaks, updated] = await Promise.all([
      db.readings.where('bypassId').equals(bypassId).toArray(),
      db.leaks.where('bypassId').equals(bypassId).toArray(),
      db.bypasses.get(bypassId)
    ])
    return {
      ok: true,
      readLedgered,
      leaksCreated,
      readingCount: allReadings.length,
      leakCount: allLeaks.length,
      retryCount: updated?.retryCount ?? bypass.retryCount,
      retried: bypass.archiveState === '台账失败待重试'
    }
  } catch (err) {
    const error = `台账写入失败：${err instanceof Error ? err.message : '未知错误'}，现场批次已保留，可重试只补未完成部分`
    await db.bypasses.update(bypassId, {
      state: '待归档',
      archiveState: '台账失败待重试',
      archiveError: error,
      retryCount: bypass.retryCount + 1,
      updatedAt: Date.now()
    })
    return {
      ok: false,
      readLedgered: 0,
      leaksCreated: 0,
      readingCount: readings.length,
      leakCount: leaks.length,
      retryCount: bypass.retryCount + 1,
      retried: bypass.archiveState === '台账失败待重试',
      error
    }
  }
}

/** 删除旁通作业（同时删除其现场批次读数；已派泄漏单保留可追溯） */
export async function deleteBypass(bypassId: string): Promise<void> {
  await db.transaction('rw', [db.bypasses, db.readings], async () => {
    await db.readings.where('bypassId').equals(bypassId).delete()
    await db.bypasses.delete(bypassId)
  })
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, bypasses] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.bypasses.count()
  ])
  return { stations, devices, points, patrols, readings, leaks, bypasses }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, bypasses] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.bypasses.toArray()
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
    bypasses: bypasses.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypasses],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.bypasses.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut((payload.readings ?? []).map(rev))
    await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
    await db.bypasses.bulkPut((payload.bypasses ?? []).map(rev))
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.bypasses],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.bypasses.clear()
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
