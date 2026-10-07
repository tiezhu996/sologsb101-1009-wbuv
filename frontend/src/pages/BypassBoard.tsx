/**
 * /bypasses 旁通作业（抢修临时开旁通）
 * 负责人登记站点、设备、起止时间与临时安全区间；现场记录人把作业期读数归到同一作业下。
 * 同一设备已有未归档作业不能再开；作业期按临时安全区间判定，越线立即派单；
 * 结束先核对读数与泄漏单，台账失败保留现场批次、只补未完成部分重试，不重复派单。
 * 消费 Bypass、Reading、Leak、Point、Device；复用 <AbnormalTag>、<StatBadge>、<FilterBar>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import AbnormalTag from '@/components/common/AbnormalTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useLeakStore } from '@/stores/leakStore'
import { useBypassStore } from '@/stores/bypassStore'
import type { BypassCloseCheckResult } from '@/utils/db'
import { BYPASS_STATES, bypassStateTagColor, type BypassState } from '@/types/bypass'
import type { Reading } from '@/types/reading'
import { judgeWithBasis } from '@/utils/range'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → datetime-local 输入值（YYYY-MM-DDTHH:mm，本地时区） */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function formatMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function formatWindow(value: string): string {
  return value.replace('T', ' ')
}

export default function BypassBoard() {
  const stationStore = useStationStore()
  const bypassStore = useBypassStore()
  const leakStore = useLeakStore()

  const [form] = Form.useForm<{
    stationId: string
    deviceId: string
    leader: string
    recorder: string
    reason: string
    safeMin: number
    safeMax: number
    safeUnit: string
  }>()
  const [readingForm] = Form.useForm<{ pointId: string; value: number; recorder: string; note: string }>()
  const [closeForm] = Form.useForm<{ conclusion: string }>()
  const [createOpen, setCreateOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [checkData, setCheckData] = useState<BypassCloseCheckResult | null>(null)
  const [formDeviceId, setFormDeviceId] = useState<string>('')
  const [formStartTime, setFormStartTime] = useState('')
  const [formEndTime, setFormEndTime] = useState('')

  const filter = bypassStore.filter

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'bypassState', label: '作业状态', multiple: false, options: BYPASS_STATES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = { keyword: '', stationId: filter.stationId, bypassState: filter.state }

  const onModelChange = (next: FilterModel): void => {
    bypassStore.patchFilter({
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      state: (typeof next.bypassState === 'string' ? next.bypassState : '') as BypassState | ''
    })
  }

  const bypasses = bypassStore.filteredBypasses()
  const active = activeId ? bypassStore.detailOf(activeId) : null
  const activeBypass = active?.bypass ?? null

  const stationName = (id: string): string => stationStore.stations.find((item) => item.id === id)?.name ?? '—'
  const deviceLabel = (id: string): string => {
    const device = stationStore.devices.find((item) => item.id === id)
    return device ? `${device.type} ${device.model}（${device.serialNo}）` : '—'
  }

  const formStationId = Form.useWatch('stationId', form) as string | undefined
  const deviceOptions = stationStore.devices
    .filter((device) => !formStationId || device.stationId === formStationId)
    .map((device) => ({
      label: `${stationName(device.stationId)} · ${device.type} ${device.model}`,
      value: device.id
    }))

  /** 新建表单当前选中设备的未归档作业（存在则禁止再开） */
  const occupied = formDeviceId ? bypassStore.openBypassOfDevice(formDeviceId) : undefined

  const openCreate = (): void => {
    if (stationStore.devices.length === 0) {
      Message.warning('请先在调压站台账登记设备')
      return
    }
    const now = new Date()
    const later = new Date(now.getTime() + 3 * 3600000)
    const start = toLocalInput(now)
    const end = toLocalInput(later)
    form.setFieldsValue({
      stationId: filter.stationId || stationStore.stations[0]?.id || '',
      deviceId: undefined,
      leader: '',
      recorder: '',
      reason: '抢修临时开旁通',
      safeMin: 0,
      safeMax: 120,
      safeUnit: 'ppm'
    })
    setFormDeviceId('')
    setFormStartTime(start)
    setFormEndTime(end)
    setCreateOpen(true)
  }

  const submitCreate = async (): Promise<void> => {
    const values = await form.validate().catch(() => null)
    if (!values) return
    if (!formStartTime || !formEndTime) {
      Message.error('请选择作业起止时间')
      return
    }
    if (occupied) {
      Message.error(`该设备已有未归档作业 ${occupied.code}，不能重复开作业`)
      return
    }
    try {
      const row = await bypassStore.create({
        ...values,
        deviceId: formDeviceId,
        startTime: formStartTime,
        endTime: formEndTime
      })
      Message.success(`旁通作业 ${row.code} 已登记，作业期按临时安全区间判定`)
      setCreateOpen(false)
      setActiveId(row.id)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '登记失败')
    }
  }

  const activeDevicePoints = useMemo(() => {
    if (!activeBypass) return []
    return stationStore.points.filter(
      (point) => point.deviceId === activeBypass.deviceId && point.unit === activeBypass.safeUnit
    )
  }, [activeBypass, stationStore.points])

  // 切换作业或作业结束后，重置现场读数表单，避免沿用上一个作业的点位
  useEffect(() => {
    if (activeBypass?.state === '进行中' && activeDevicePoints.length > 0) {
      readingForm.setFieldsValue({
        pointId: activeDevicePoints[0].id,
        recorder: activeBypass.recorder,
        value: undefined,
        note: ''
      })
    }
    // 仅在作业或可用点位集合变化时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBypass?.id, activeDevicePoints.length, activeBypass?.state])

  const submitReading = async (): Promise<void> => {
    if (!activeBypass) return
    const values = await readingForm.validate().catch(() => null)
    if (!values) return
    try {
      const { leakCreated } = await bypassStore.recordReading(activeBypass.id, {
        pointId: values.pointId,
        value: Number(values.value),
        recordedAt: Date.now(),
        recorder: values.recorder,
        note: values.note
      })
      if (leakCreated) {
        Message.warning(`浓度 ${values.value} ${activeBypass.safeUnit} 越过临时安全线 ${activeBypass.safeMax}，已立即派发泄漏处置单`)
      } else {
        Message.success('作业期读数已归入本作业（现场批次）')
      }
      readingForm.setFieldsValue({ value: undefined, note: '' })
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '读数登记失败')
    }
  }

  const openClose = async (): Promise<void> => {
    if (!activeBypass) return
    const check = await bypassStore.checkBeforeClose(activeBypass.id)
    setCheckData(check)
    closeForm.setFieldsValue({ conclusion: '' })
    setCloseOpen(true)
  }

  const submitClose = async (): Promise<void> => {
    if (!activeBypass) return
    const values = await closeForm.validate().catch(() => null)
    if (!values) return
    await bypassStore.close(activeBypass.id, values.conclusion)
    const result = await bypassStore.archive(activeBypass.id, false)
    if (result.ok) {
      Message.success(
        `作业已结束并归档：读数 ${result.readingCount} 条、泄漏单 ${result.leakCount} 张（本次补入账 ${result.readLedgered} 条、补派单 ${result.leaksCreated} 张）`
      )
    } else {
      Message.error('台账写入失败，现场批次已保留，可在右侧只补未完成部分重试')
    }
    setCloseOpen(false)
  }

  const retryArchive = async (simulateFailure: boolean): Promise<void> => {
    if (!activeBypass) return
    const result = await bypassStore.archive(activeBypass.id, simulateFailure)
    if (result.ok) {
      Message.success(
        simulateFailure
          ? '台账写入成功'
          : `台账补写完成：新入账 ${result.readLedgered} 条、补派单 ${result.leaksCreated} 张，未重复派单`
      )
    } else {
      Message.error(result.error ?? '台账写入失败，现场批次保留中')
    }
  }

  const readingColumns: TableColumnProps<Reading>[] = [
    {
      title: '记录时间',
      width: 150,
      render: (_v, record) => formatMs(record.recordedAt)
    },
    {
      title: '点位',
      width: 140,
      render: (_v, record) => stationStore.points.find((point) => point.id === record.pointId)?.name ?? '点位已删除'
    },
    {
      title: '读数',
      width: 110,
      render: (_v, record) => `${record.value} ${activeBypass?.safeUnit ?? ''}`
    },
    {
      title: '临时区间',
      width: 130,
      render: () => (activeBypass ? `${activeBypass.safeMin} ~ ${activeBypass.safeMax} ${activeBypass.safeUnit}` : '—')
    },
    {
      title: '判定',
      width: 150,
      render: (_v, record) => {
        const point = stationStore.points.find((item) => item.id === record.pointId)
        if (!activeBypass || !point) return <Tag>—</Tag>
        const judgement = judgeWithBasis(record.value, activeBypass.safeMin, activeBypass.safeMax, point.isCritical, '临时安全区间')
        return <AbnormalTag level={judgement.level} deviationPct={judgement.deviationPct} size="small" />
      }
    },
    { title: '记录人', dataIndex: 'recorder', width: 90, render: (v: string) => v || '—' },
    {
      title: '泄漏单',
      width: 100,
      render: (_v, record) =>
        record.leakId ? (
          <Tag color="red" size="small">
            已派单
          </Tag>
        ) : (
          <span className="muted">—</span>
        )
    },
    { title: '备注', dataIndex: 'note', render: (v: string) => v || '—' }
  ]

  const stats = {
    running: bypassStore.bypasses.filter((item) => item.state === '进行中').length,
    pending: bypassStore.bypasses.filter((item) => item.state === '待归档').length,
    archived: bypassStore.bypasses.filter((item) => item.state === '已归档').length,
    openLeak: leakStore.leaks.filter((leak) => leak.bypassId && leak.state !== '已复检').length
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">旁通作业（抢修临时开旁通）</h2>
          <p className="page-head__desc">
            作业期读数统一按负责人登记的临时安全区间判定，浓度越过安全线立即派单；同一设备未归档作业不可重复开，许可到期前不切回平时标准。
          </p>
        </div>
        <div className="page-head__actions">
          <Button type="primary" onClick={openCreate}>
            新建旁通作业
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="作业总数" value={bypassStore.bypasses.length} suffix="项" tone="primary" />
        <StatBadge label="进行中" value={stats.running} suffix="项" tone="danger" />
        <StatBadge label="待归档（台账重试）" value={stats.pending} suffix="项" tone="warning" />
        <StatBadge label="已归档" value={stats.archived} suffix="项" tone="success" />
        <StatBadge label="作业期待闭环泄漏单" value={stats.openLeak} suffix="张" tone="info" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="" onModelChange={onModelChange} />

      <div className="grid-two" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3 className="panel-title">作业单（{bypasses.length}）</h3>
          {bypasses.length === 0 ? (
            <EmptyPanel title="没有旁通作业" description="抢修临时开旁通前，由负责人登记站点、设备、起止时间与临时安全区间。" compact />
          ) : (
            bypasses.map((bypass) => {
              const expired = bypassStore.isExpired(bypass)
              return (
                <div
                  key={bypass.id}
                  className={`card-list-item${bypass.id === activeId ? ' is-active' : ''}`}
                  onClick={() => setActiveId(bypass.id)}
                >
                  <div className="card-list-item__head">
                    <span>{bypass.code}</span>
                    <Tag color={bypassStateTagColor(bypass.state)}>{bypass.state}</Tag>
                  </div>
                  <div className="card-list-item__meta">
                    <span>{stationName(bypass.stationId)}</span>
                    <span>· {deviceLabel(bypass.deviceId)}</span>
                  </div>
                  <div className="card-list-item__meta">
                    <span>
                      窗口 {formatWindow(bypass.startTime)} ~ {formatWindow(bypass.endTime)}
                    </span>
                  </div>
                  <div className="card-list-item__meta">
                    <span>
                      临时安全区间 {bypass.safeMin} ~ {bypass.safeMax} {bypass.safeUnit}
                    </span>
                    {expired ? (
                      <Tag color="red" size="small">
                        许可已到期
                      </Tag>
                    ) : null}
                  </div>
                  <div className="card-list-item__meta">
                    <span>负责人 {bypass.leader || '—'}</span>
                    <span>· 记录人 {bypass.recorder || '—'}</span>
                    <span>
                      · 读数 {bypass.readingCount || bypassStore.readingsOf(bypass.id).length} · 泄漏单{' '}
                      {bypass.leakCount || bypassStore.leaksOf(bypass.id).length}
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="panel">
          {active && activeBypass ? (
            <>
              <div className="panel-head">
                <h3 className="panel-title" style={{ margin: 0 }}>
                  {activeBypass.code}
                  <Tag color={bypassStateTagColor(activeBypass.state)} style={{ marginLeft: 8 }}>
                    {activeBypass.state}
                  </Tag>
                  {bypassStore.isExpired(activeBypass) ? (
                    <Tag color="red" style={{ marginLeft: 8 }}>
                      许可已到期，请尽快结束作业
                    </Tag>
                  ) : null}
                </h3>
                <Space>
                  {activeBypass.state === '进行中' ? (
                    <Button type="primary" size="small" onClick={openClose}>
                      结束作业
                    </Button>
                  ) : null}
                  <Popconfirm
                    title="删除作业将同时删除其现场批次读数（已派泄漏单保留），确认？"
                    onOk={() => {
                      void bypassStore.remove(activeBypass.id)
                      setActiveId(null)
                      Message.success('作业已删除')
                    }}
                  >
                    <Button type="text" size="small" status="danger">
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              </div>

              <div className="card-list-item__meta" style={{ marginBottom: 4 }}>
                <span>{stationName(activeBypass.stationId)}</span>
                <span>· {deviceLabel(activeBypass.deviceId)}</span>
              </div>
              <div className="card-list-item__meta" style={{ marginBottom: 4 }}>
                <span>
                  作业窗口 {formatWindow(activeBypass.startTime)} ~ {formatWindow(activeBypass.endTime)}
                </span>
                {activeBypass.finishedAt ? <span>· 实际结束 {formatWindow(activeBypass.finishedAt)}</span> : null}
              </div>
              <div className="card-list-item__meta" style={{ marginBottom: 4 }}>
                <Tag color="purple">
                  临时安全区间 {activeBypass.safeMin} ~ {activeBypass.safeMax} {activeBypass.safeUnit}
                </Tag>
                <span>负责人 {activeBypass.leader || '—'}</span>
                <span>· 记录人 {activeBypass.recorder || '—'}</span>
              </div>
              <div className="card-list-item__meta" style={{ marginBottom: 12 }}>
                <span>事由：{activeBypass.reason || '—'}</span>
              </div>

              {activeBypass.state === '待归档' ? (
                <Alert
                  type={activeBypass.archiveState === '台账失败待重试' ? 'warning' : 'info'}
                  style={{ marginBottom: 12 }}
                  content={
                    <div>
                      <div>
                        {activeBypass.archiveState === '台账失败待重试'
                          ? `台账写入失败（第 ${activeBypass.retryCount} 次）：${activeBypass.archiveError || '等待重试'}`
                          : '作业已结束，台账写入处理中：现场批次保留，完成后归档；失败可只补未完成部分重试。'}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        重试只补「现场批次」读数与缺处置单的越线读数，已入账/已派单不重复处理。
                      </div>
                      <Space style={{ marginTop: 8 }}>
                        <Button type="primary" size="small" onClick={() => retryArchive(false)}>
                          重试台账写入
                        </Button>
                        <Button size="small" onClick={() => retryArchive(true)}>
                          模拟台账失败
                        </Button>
                      </Space>
                    </div>
                  }
                />
              ) : null}

              {activeBypass.state === '进行中' ? (
                <div className="panel" style={{ padding: 12, marginBottom: 12, background: '#fafbfc' }}>
                  <h4 className="panel-title">现场记录人登记作业期读数</h4>
                  {activeDevicePoints.length === 0 ? (
                    <EmptyPanel
                      title="该设备没有同单位点位"
                      description={`临时安全区间单位为 ${activeBypass.safeUnit}，需先在点位配置页为该设备配置同单位点位。`}
                      compact
                    />
                  ) : (
                    <Form form={readingForm} layout="inline">
                      <Form.Item
                        field="pointId"
                        label="点位"
                        rules={[{ required: true, message: '请选择点位' }]}
                        initialValue={activeDevicePoints[0]?.id}
                      >
                        <Select
                          style={{ width: 180 }}
                          options={activeDevicePoints.map((point) => ({ label: point.name, value: point.id }))}
                        />
                      </Form.Item>
                      <Form.Item field="value" label={`读数(${activeBypass.safeUnit})`} rules={[{ required: true, message: '请填写读数' }]}>
                        <InputNumber style={{ width: 130 }} placeholder="现场实测" />
                      </Form.Item>
                      <Form.Item field="recorder" label="记录人" rules={[{ required: true, message: '请填写记录人' }]}>
                        <Input style={{ width: 110 }} placeholder={activeBypass.recorder || '记录人'} />
                      </Form.Item>
                      <Form.Item field="note" label="备注">
                        <Input style={{ width: 200 }} placeholder="现场情况（可选）" />
                      </Form.Item>
                      <Form.Item>
                        <Button type="primary" onClick={submitReading}>
                          归入本作业
                        </Button>
                      </Form.Item>
                    </Form>
                  )}
                  <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    读数按临时安全区间 {activeBypass.safeMin} ~ {activeBypass.safeMax} {activeBypass.safeUnit}{' '}
                    判定；高于安全线 {activeBypass.safeMax} {activeBypass.safeUnit} 立即派发泄漏处置单。
                  </div>
                </div>
              ) : null}

              <h4 className="panel-title">
                作业期读数（{active.readings.length}）
                {activeBypass.state !== '进行中' ? (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    现场批次 {active.readings.filter((r) => r.ledgerState === '现场批次').length} 条待入账
                  </span>
                ) : null}
              </h4>
              {active.readings.length === 0 ? (
                <EmptyPanel title="暂无作业期读数" description="由现场记录人在作业窗口内逐次登记。" compact />
              ) : (
                <Table<Reading>
                  rowKey="id"
                  size="small"
                  border
                  data={active.readings}
                  columns={readingColumns}
                  pagination={false}
                  scroll={{ x: 1000 }}
                />
              )}

              <h4 className="panel-title" style={{ marginTop: 16 }}>
                本作业泄漏处置单（{active.leaks.length}）
              </h4>
              {active.leaks.length === 0 ? (
                <EmptyPanel title="暂无泄漏单" description="作业期浓度未越过临时安全线。" compact />
              ) : (
                active.leaks.map((leak) => (
                  <div key={leak.id} className="card-list-item" style={{ cursor: 'default' }}>
                    <div className="card-list-item__head">
                      <span style={{ color: '#f53f3f', fontWeight: 600 }}>{leak.concentrationPpm} ppm</span>
                      <Tag color={leak.state === '已复检' ? 'green' : leak.state === '已处置' ? 'blue' : 'red'}>{leak.state}</Tag>
                    </div>
                    <div className="card-list-item__meta">
                      <span>发现 {leak.foundTime}</span>
                      <span>· 处置人 {leak.handler || '—'}</span>
                      <span>· 判据 {leak.judgeBasis}</span>
                      {leak.retestValuePpm > 0 ? <span>· 复检 {leak.retestValuePpm} ppm</span> : null}
                    </div>
                    <div className="card-list-item__meta">
                      <span>{leak.measure || '待填写处置措施'}</span>
                    </div>
                  </div>
                ))
              )}

              {activeBypass.state === '已归档' && activeBypass.conclusion ? (
                <Alert
                  style={{ marginTop: 12 }}
                  type="success"
                  content={
                    <div>
                      <div style={{ fontWeight: 600 }}>处置结果（已归档，可追溯）</div>
                      <div style={{ marginTop: 4 }}>{activeBypass.conclusion}</div>
                    </div>
                  }
                />
              ) : null}
            </>
          ) : (
            <EmptyPanel title="尚未选择旁通作业" description="在左侧作业单列表选择一项，查看作业期读数、泄漏单与归档核对结果。" compact />
          )}
        </div>
      </div>

      <Modal
        visible={createOpen}
        title="新建旁通作业（负责人登记）"
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        okText="登记开工"
        cancelText="取消"
        unmountOnExit
        maskClosable={false}
      >
        <Form form={form} layout="vertical">
          <Form.Item field="stationId" label="调压站" rules={[{ required: true, message: '请选择调压站' }]}>
            <Select
              placeholder="选择调压站"
              options={stationStore.stations.map((station) => ({ label: station.name, value: station.id }))}
              onChange={() => setFormDeviceId('')}
            />
          </Form.Item>
          <Form.Item field="deviceId" label="作业设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select
              showSearch
              placeholder="选择设备"
              options={deviceOptions}
              onChange={(value: unknown) => setFormDeviceId(String(value))}
            />
          </Form.Item>
          {occupied ? (
            <Alert
              type="error"
              style={{ marginBottom: 12 }}
              content={`该设备已有未归档作业 ${occupied.code}（${occupied.state}），结束并归档前不能再开一条。`}
            />
          ) : null}
          <Space size={12}>
            <Form.Item field="leader" label="负责人" rules={[{ required: true, message: '请填写负责人' }]}>
              <Input placeholder="如 王强" style={{ width: 200 }} />
            </Form.Item>
            <Form.Item field="recorder" label="现场记录人" rules={[{ required: true, message: '请填写记录人' }]}>
              <Input placeholder="如 李娜" style={{ width: 200 }} />
            </Form.Item>
          </Space>
          <Form.Item field="reason" label="作业事由" rules={[{ required: true, message: '请填写作业事由' }]}>
            <Input placeholder="如 调压器抢修，临时开旁通供气" />
          </Form.Item>
          <Space size={12}>
            <Form.Item label="开始时间" required>
              <input
                type="datetime-local"
                className="arco-input"
                style={{ width: 220, padding: '4px 12px', borderRadius: 4, border: '1px solid #e5e6eb' }}
                value={formStartTime}
                onChange={(e) => setFormStartTime(e.target.value)}
              />
            </Form.Item>
            <Form.Item label="许可截止时间" required>
              <input
                type="datetime-local"
                className="arco-input"
                style={{ width: 220, padding: '4px 12px', borderRadius: 4, border: '1px solid #e5e6eb' }}
                value={formEndTime}
                onChange={(e) => setFormEndTime(e.target.value)}
              />
            </Form.Item>
          </Space>
          <Space size={12}>
            <Form.Item field="safeMin" label="安全区间下限" rules={[{ required: true, message: '请填写下限' }]}>
              <InputNumber style={{ width: 150 }} />
            </Form.Item>
            <Form.Item field="safeMax" label="安全线上限" rules={[{ required: true, message: '请填写上限' }]}>
              <InputNumber style={{ width: 150 }} />
            </Form.Item>
            <Form.Item field="safeUnit" label="单位" rules={[{ required: true }]}>
              <Select style={{ width: 110 }} options={['ppm', 'MPa', 'kPa', '℃'].map((u) => ({ label: u, value: u }))} />
            </Form.Item>
          </Space>
          <Alert
            type="info"
            content="作业期内现场读数一律按该临时安全区间判定，许可到期前不能改用平时标准；浓度高于安全线上限立即派泄漏处置单。"
          />
        </Form>
      </Modal>

      <Modal
        visible={closeOpen}
        title={`结束作业 · ${activeBypass?.code ?? ''}`}
        onCancel={() => setCloseOpen(false)}
        onOk={submitClose}
        okText="核对并结束、写台账"
        cancelText="取消"
        unmountOnExit
      >
        {checkData ? (
          <div>
            <Alert
              type="info"
              style={{ marginBottom: 12 }}
              content={`先核对本次作业：作业期读数 ${checkData.readings.length} 条（异常 ${checkData.abnormalCount} 条、越过安全线 ${checkData.overLimitCount} 条），泄漏处置单 ${checkData.leaks.length} 张。`}
            />
            <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
              结束后现场批次保留并写台账；写入失败可重试，只补未完成部分，不重复派单。
            </div>
            <Form form={closeForm} layout="vertical">
              <Form.Item field="conclusion" label="处置结果" rules={[{ required: true, message: '请填写处置结果' }]}>
                <Input.TextArea placeholder="如 抢修完成恢复正常供气，越线读数已派单并复检合格" autoSize={{ minRows: 3, maxRows: 5 }} />
              </Form.Item>
            </Form>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
