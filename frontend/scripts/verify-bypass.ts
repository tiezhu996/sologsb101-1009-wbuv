import 'fake-indexeddb/auto'
import { db, seedDatabase } from '../src/utils/db'
import { useBypassStore, armLedgerFailureDrill } from '../src/stores/bypassStore'
import { useStationStore } from '../src/stores/stationStore'
import type { BypassWorkDraft } from '../src/types/bypass'
import { formatDateTime } from '../src/utils/range'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${msg}`)
  } else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

async function flush(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  await seedDatabase()
  await flush()

  console.log('1) 播种数据')
  assert(useBypassStore.getState().works.length === 2, '播种 2 张旁通作业（1 进行中 + 1 已归档）')
  assert(useStationStore.getState().points.length === 11, '播种 11 个点位')
  const bw2 = useBypassStore.getState().works.find((w) => w.id === 'bw-2')!
  assert(bw2.state === '进行中', 'bw-2 为进行中')
  assert(bw2.readingIds.length === 2, 'bw-2 含 2 条作业期读数')
  assert(bw2.leakIds.includes('lk-bp1'), 'bw-2 越线读数已立即派单 lk-bp1')
  const rd4 = await db.readings.get('rd-bp4')
  assert(rd4?.isAbnormal === true && rd4.judgeBasis?.type === '旁通临时区间', '110ppm 按临时安全线 80 判异常（非平时 50）')

  console.log('2) 同一设备未归档作业冲突')
  let conflicted = false
  try {
    const draft: BypassWorkDraft = {
      stationId: 'st-1',
      deviceId: 'dv-1',
      reason: '重复开旁通',
      manager: '甲',
      recorder: '乙',
      startText: formatDateTime(Date.now()),
      endText: formatDateTime(Date.now() + 3600000),
      safetyLinePpm: 50,
      limits: []
    }
    await useBypassStore.getState().createWork(draft)
  } catch (e) {
    conflicted = (e as Error).message.includes('不能再开')
  }
  assert(conflicted, 'dv-1 已有进行中作业时禁止再开')

  console.log('3) 另一台设备开工 + 作业期临时区间判级 + 越线立即派单')
  const dv4Points = useStationStore.getState().points.filter((p) => p.deviceId === 'dv-4')
  const now = Date.now()
  const limits = dv4Points.map((p) => ({
    pointId: p.id,
    pointName: p.name,
    unit: p.unit,
    isCritical: p.isCritical,
    tempMin: p.unit === 'ppm' ? 0 : p.standardMin,
    tempMax: p.unit === 'ppm' ? 90 : p.unit === 'MPa' && p.name === '出口压力' ? 0.2 : p.standardMax
  }))
  const work = await useBypassStore.getState().createWork({
    stationId: 'st-2',
    deviceId: 'dv-4',
    reason: '逻辑验证作业',
    manager: '负责人A',
    recorder: '记录人B',
    startText: formatDateTime(now - 600000),
    endText: formatDateTime(now + 7200000),
    safetyLinePpm: 90,
    limits
  })
  await flush()

  // pt-8 出口压力：平时上限 0.15，读数 0.18 平时超标，但临时上限 0.2 → 作业期正常
  const r1 = await useBypassStore.getState().recordReading({
    workId: work.id,
    pointId: 'pt-8',
    value: 0.18,
    note: '临时区间内',
    measuredText: formatDateTime(now)
  })
  assert(r1.reading.isAbnormal === false, '0.18 MPa 按临时上限 0.2 判正常（平时 0.15 会判异常）')
  assert(r1.reading.judgeBasis?.type === '旁通临时区间', '判级依据冻结为旁通临时区间')

  // 窗口外时间拒绝
  let windowRejected = false
  try {
    await useBypassStore.getState().recordReading({
      workId: work.id,
      pointId: 'pt-8',
      value: 0.18,
      note: '',
      measuredText: formatDateTime(now + 10 * 3600000)
    })
  } catch {
    windowRejected = true
  }
  assert(windowRejected, '许可窗口外的测量时间被拒绝（到期不能改用平时标准）')

  // pt-10 浓度 95 > 安全线 90 → 异常 + 立即派单
  const r2 = await useBypassStore.getState().recordReading({
    workId: work.id,
    pointId: 'pt-10',
    value: 95,
    note: '越线',
    measuredText: formatDateTime(now + 60000)
  })
  assert(r2.reading.isAbnormal === true, '95 ppm 越过安全线 90 判异常')
  assert(r2.leakCreated === true, '越线读数立即派单')

  // 同一点位重复录更高值：幂等不再派新单
  const r2b = await useBypassStore.getState().recordReading({
    workId: work.id,
    pointId: 'pt-10',
    value: 120,
    note: '复测更高',
    measuredText: formatDateTime(now + 120000)
  })
  assert(r2b.leakCreated === false, '同一读数（覆盖后同 id）不重复派单')
  await flush()
  const leakCount = (await db.leaks.where('bypassWorkId').equals(work.id).toArray()).length
  assert(leakCount === 1, '该作业只派了 1 张泄漏单')

  console.log('4) 标准值变更不回改旁通读数（旧读数不补派）')
  const { recalculateReadingsOfPoint } = await import('../src/utils/db')
  await db.points.update('pt-8', { standardMin: 0.08, standardMax: 0.1 })
  await recalculateReadingsOfPoint('pt-8')
  const r1again = await db.readings.get(r1.reading.id)
  assert(r1again!.isAbnormal === false && r1again!.judgeBasis?.type === '旁通临时区间', '旁通读数按临时区间冻结，标准值收紧不回判异常')
  await db.points.update('pt-8', { standardMin: 0.08, standardMax: 0.15 })

  console.log('5) 结束核对：越线读数都有单 → canClose')
  const report = useBypassStore.getState().checkClose(work.id)
  assert(report.canClose === true, '核对通过（越线读数均已派单）')

  console.log('5b) 应派未派阻断结束（泄漏单缺失时禁止归档）')
  const createdLeak = await db.leaks.where('sourceReadingId').equals(r2.reading.id).first()
  assert(Boolean(createdLeak), '越线读数对应泄漏单存在')
  await db.leaks.delete(createdLeak!.id)
  await db.bypassworks.update(work.id, { leakIds: work.leakIds.filter((id) => id !== createdLeak!.id) })
  await flush()
  const reportBlocked = useBypassStore.getState().checkClose(work.id)
  assert(reportBlocked.canClose === false && reportBlocked.missing.length === 1, '缺少泄漏单时核对不通过（应派未派 1 条）')
  let closeBlocked = false
  try {
    await useBypassStore.getState().closeWork(work.id, '强行结束')
  } catch {
    closeBlocked = true
  }
  assert(closeBlocked, '应派未派时结束作业被拦截')
  // 恢复泄漏单以继续后续归档流程（模拟现场补派）
  await db.leaks.put({ ...createdLeak!, updatedAt: Date.now() })
  await db.bypassworks.update(work.id, { leakIds: [...(await db.bypassworks.get(work.id))!.leakIds, createdLeak!.id] })
  await flush()

  console.log('6) 台账写入失败：保留现场批次，重试只补未完成项，不重复派单')
  armLedgerFailureDrill(2)
  const first = await useBypassStore.getState().closeWork(work.id, '验证处置结果', 0)
  assert(first.archived === false && first.pending === 2, '首批 2 项失败：作业未归档，保留 2 个未完成项')
  const storedAfterFail = (await db.bypassworks.get(work.id))!
  assert(storedAfterFail.state === '进行中' && storedAfterFail.batch !== null, '现场批次已持久化保留')
  const leaksBeforeRetry = await db.leaks.where('bypassWorkId').equals(work.id).count()
  const retry = await useBypassStore.getState().retryLedger(work.id)
  const leaksAfterRetry = await db.leaks.where('bypassWorkId').equals(work.id).count()
  assert(retry.archived === true && retry.pending === 0, '重试后全部入账并归档')
  assert(leaksAfterRetry === leaksBeforeRetry, '重试不重复派单')
  const storedAfterRetry = (await db.bypassworks.get(work.id))!
  assert(storedAfterRetry.state === '已归档' && storedAfterRetry.batch?.rounds === 2, '台账轮次=2（首轮 + 重试）')
  assert(storedAfterRetry.batch.items.every((i) => i.state === '已写入'), '全部条目状态为已写入')

  console.log('7) 归档后不能再录数')
  let archivedRejected = false
  try {
    await useBypassStore.getState().recordReading({
      workId: work.id,
      pointId: 'pt-8',
      value: 0.1,
      note: '',
      measuredText: formatDateTime(now)
    })
  } catch {
    archivedRejected = true
  }
  assert(archivedRejected, '已归档作业拒绝新读数')

  console.log('8) 归档后同设备可再开新作业')
  const work2 = await useBypassStore.getState().createWork({
    stationId: 'st-2',
    deviceId: 'dv-4',
    reason: '再次抢修',
    manager: '负责人A',
    recorder: '记录人B',
    startText: formatDateTime(now),
    endText: formatDateTime(now + 3600000),
    safetyLinePpm: 90,
    limits: []
  })
  assert(Boolean(work2.id), '前序作业归档后同设备允许再开')

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
  await db.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
