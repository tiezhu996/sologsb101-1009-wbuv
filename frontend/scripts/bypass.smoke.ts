/* eslint-disable */
// 旁通作业核心流程冒烟测试：fake-indexeddb + tsx 运行（开发期临时脚本）
import 'fake-indexeddb/auto'
import {
  archiveBypassLedger,
  checkBypassBeforeClose,
  closeBypass,
  createBypass,
  db,
  deleteBypass,
  findOpenBypassOfDevice,
  initDatabase,
  putBypassReading
} from '../src/utils/db'

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

async function main(): Promise<void> {
  await initDatabase()

  // 播种后应有一条已归档旁通作业
  const seeded = await db.bypasses.toArray()
  assert(seeded.some((b) => b.code === 'BP20240618-0001' && b.state === '已归档'), '播种含一条已归档旁通作业')
  const bp1Readings = await db.readings.where('bypassId').equals('bp-1').toArray()
  assert(bp1Readings.length === 2, '播种作业含 2 条现场读数')
  const bp1Leaks = await db.leaks.where('bypassId').equals('bp-1').toArray()
  assert(bp1Leaks.length === 1 && bp1Leaks[0].sourceReadingId === 'rd-bp-2', '播种作业 1 张泄漏单且回填来源读数')
  assert(bp1Readings.find((r) => r.id === 'rd-bp-2')?.leakId === 'lk-4', '越线读数回填 leakId')
  // 62 在平时标准(<=50)会异常，但在临时区间(0~120)正常
  const normal62 = bp1Readings.find((r) => r.value === 62)
  assert(normal62 !== undefined && !normal62.isAbnormal, '62ppm 在临时区间内判正常（平时标准会判异常）')
  // 135 越过临时安全线 120
  const over135 = bp1Readings.find((r) => r.value === 135)
  assert(over135 !== undefined && over135.isAbnormal, '135ppm 越过临时安全线 120 判异常')

  // 新建作业（dv-1，已有的 bp-1 已归档，允许新开）
  const bp = await createBypass({
    stationId: 'st-1',
    deviceId: 'dv-1',
    leader: '王强',
    recorder: '李娜',
    reason: '测试抢修开旁通',
    startTime: '2026-10-07T08:00',
    endTime: '2026-10-07T12:00',
    safeMin: 0,
    safeMax: 120,
    safeUnit: 'ppm'
  })
  assert(bp.state === '进行中' && /^BP\d{8}-\d{4}$/.test(bp.code), '新建作业为进行中并生成单号')

  // 同一设备不能再开未归档作业
  let blocked = false
  try {
    await createBypass({
      stationId: 'st-1',
      deviceId: 'dv-1',
      leader: 'x',
      recorder: 'y',
      reason: '',
      startTime: '2026-10-07T13:00',
      endTime: '2026-10-07T14:00',
      safeMin: 0,
      safeMax: 200,
      safeUnit: 'ppm'
    })
  } catch {
    blocked = true
  }
  assert(blocked, '同一设备存在进行中作业时不能再开一条')
  assert((await findOpenBypassOfDevice('dv-1'))?.id === bp.id, 'findOpenBypassOfDevice 命中进行中作业')

  // 作业期读数：区间内 → 现场批次，无泄漏单
  const r1 = await putBypassReading(bp, {
    pointId: 'pt-3',
    value: 80,
    recordedAt: Date.parse('2026-10-07T08:30:00'),
    recorder: '李娜',
    note: '区间内'
  })
  assert(!r1.reading.isAbnormal && r1.leak === null, '区间内读数判正常且不派单')
  assert(r1.reading.ledgerState === '现场批次' && r1.reading.bypassId === bp.id, '读数归到本作业并标记现场批次')
  assert(r1.reading.judgeBasis === '临时安全区间' && r1.reading.judgeMax === 120, '读数记录临时区间判据快照')

  // 越线读数 → 立即派单并回填
  const r2 = await putBypassReading(bp, {
    pointId: 'pt-3',
    value: 150,
    recordedAt: Date.parse('2026-10-07T09:00:00'),
    recorder: '李娜',
    note: '越线'
  })
  assert(r2.leak !== null && r2.leak.state === '待处置', '浓度越过安全线立即派待处置单')
  assert(r2.reading.leakId === r2.leak?.id, '越线读数回填泄漏单 id')
  assert(r2.leak.bypassId === bp.id && r2.leak.sourceReadingId === r2.reading.id, '泄漏单记录作业与来源读数')

  // 单位不符的点位不能登记
  let unitBlocked = false
  try {
    await putBypassReading(bp, { pointId: 'pt-1', value: 0.4, recordedAt: Date.now(), recorder: '李娜', note: '' })
  } catch {
    unitBlocked = true
  }
  assert(unitBlocked, '非安全区间单位（MPa）的点位读数不能登记到 ppm 作业')

  // 结束前核对
  const check = await checkBypassBeforeClose(bp.id)
  assert(check.readings.length === 2 && check.leaks.length === 1, '结束前核对：2 读数 1 泄漏单')
  assert(check.overLimitCount === 1, '核对出 1 条越过安全线')

  // 结束 → 台账模拟失败
  await closeBypass(bp.id, '测试结论')
  const fail = await archiveBypassLedger(bp.id, { simulateFailure: true })
  assert(!fail.ok && fail.retryCount === 1, '台账写入失败：作业保留待归档并累计重试次数')
  const afterFail = await db.bypasses.get(bp.id)
  assert(afterFail?.state === '待归档' && afterFail.archiveState === '台账失败待重试', '失败后状态为待归档/待重试')
  const stillBatch = await db.readings.where('bypassId').equals(bp.id).toArray()
  assert(stillBatch.every((r) => r.ledgerState === '现场批次'), '失败后现场批次全部保留')

  // 再次模拟失败：仍不重复派单
  const leaksBefore = (await db.leaks.where('bypassId').equals(bp.id).toArray()).length
  await archiveBypassLedger(bp.id, { simulateFailure: true })
  const leaksMid = (await db.leaks.where('bypassId').equals(bp.id).toArray()).length
  assert(leaksBefore === leaksMid && leaksMid === 1, '失败重试期间不重复派单')

  // 重试成功：现场批次入账，越线已派单不重复派
  const ok = await archiveBypassLedger(bp.id, { simulateFailure: false })
  assert(ok.ok && ok.readLedgered === 2, '重试成功：2 条现场批次补入账')
  assert(ok.leaksCreated === 0 && ok.leakCount === 1, '越线读数已有单，不重复派（补派 0 张，总数 1）')
  const archived = await db.bypasses.get(bp.id)
  assert(archived?.state === '已归档' && archived.readingCount === 2 && archived.leakCount === 1, '作业已归档且计数正确')
  const ledgered = await db.readings.where('bypassId').equals(bp.id).toArray()
  assert(ledgered.every((r) => r.ledgerState === '已入账'), '全部读数已入账')

  // 归档后再调用幂等
  const again = await archiveBypassLedger(bp.id, { simulateFailure: false })
  assert(again.ok && again.readLedgered === 0 && again.leaksCreated === 0, '归档后重试幂等：不补任何数据')

  // 只补未完成部分：制造一条漏派越线读数（无 leakId），归档时只补它
  // 重新开一个作业验证补派
  const bp2 = await createBypass({
    stationId: 'st-1',
    deviceId: 'dv-2',
    leader: '赵六',
    recorder: '钱七',
    reason: '过滤器旁通',
    startTime: '2026-10-08T08:00',
    endTime: '2026-10-08T12:00',
    safeMin: 0,
    safeMax: 100,
    safeUnit: 'ppm'
  })
  await putBypassReading(bp2, { pointId: 'pt-5', value: 130, recordedAt: Date.parse('2026-10-08T09:00:00'), recorder: '钱七', note: '越线' })
  await putBypassReading(bp2, { pointId: 'pt-5', value: 40, recordedAt: Date.parse('2026-10-08T10:00:00'), recorder: '钱七', note: '正常' })
  await closeBypass(bp2.id, '第二条作业')
  // 模拟台账失败后删除已派泄漏单，制造"漏派"现场批次
  const firstLeak = (await db.leaks.where('bypassId').equals(bp2.id).toArray())[0]
  await db.leaks.delete(firstLeak.id)
  await db.readings.where('bypassId').equals(bp2.id).modify({ leakId: '' })
  const re = await archiveBypassLedger(bp2.id, { simulateFailure: false })
  assert(re.leaksCreated === 1 && re.readLedgered === 2, '重试只补未完成：补派 1 张漏派单、2 条读数入账')
  const bp2Leaks = await db.leaks.where('bypassId').equals(bp2.id).toArray()
  assert(bp2Leaks.length === 1, '补派后作业泄漏单总数为 1（不重复）')

  await deleteBypass(bp2.id)
  assert((await db.bypasses.get(bp2.id)) === undefined, '删除作业成功')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
