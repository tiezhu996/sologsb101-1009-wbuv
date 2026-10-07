/**
 * /bypass 旁通作业（抢修临时开旁通）
 *
 * - 负责人登记站点、设备、许可起止时间与临时安全区间；同一设备有未归档作业时禁止再开
 * - 现场记录人把作业期读数归到同一作业下，按临时安全区间判级；浓度越过安全线立即派单
 * - 结束作业先核对本次读数与泄漏单，再写台账；写入失败保留现场批次，重试只补未完成项
 * - 历史作业、判级依据、处置结果、批次轮次全程可追溯
 *
 * 消费 BypassWork、Reading、Leak、Point、Device、Station；复用 FilterBar、StatBadge、EmptyPanel、AbnormalTag、BasisTag。
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
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
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import AbnormalTag from '@/components/common/AbnormalTag'
import BasisTag from '@/components/common/BasisTag'
import { useStationStore } from '@/stores/stationStore'
import { useBypassStore, type CloseCheckReport } from '@/stores/bypassStore'
import { BYPASS_STATES, isExpiredOpen, type BypassPointLimit, type BypassWork } from '@/types/bypass'
import type { ReadingRow } from '@/utils/db'
import type { LeakRow } from '@/utils/db'
import { abnormalLevelOf, formatDateTime, formatLeakConcentration, remainingText } from '@/utils/range'
import { exportBypassCsv } from '@/utils/export'

interface CreateFormValues {
  stationId: string
  deviceId: string
  reason: string
  manager: string
  recorder: string
  safetyLinePpm: number
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shiftText(minutes: number): string {
  return formatDateTime(Date.now() + minutes * 60000)
}

export default function BypassBoard() {
  const navigate = useNavigate()
  const stationStore = useStationStore()
  const bypassStore = useBypassStore()

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm<CreateFormValues>()
  const [startText, setStartText] = useState('')
  const [endText, setEndText] = useState('')
  const [tempLimits, setTempLimits] = useState<BypassPointLimit[]>([])
  const [creating, setCreating] = useState(false)

  const [recordOpen, setRecordOpen] = useState(false)
  const [recordPointId, setRecordPointId] = useState('')
  const [recordValue, setRecordValue] = useState<number | undefined>(undefined)
  const [recordMeasured, setRecordMeasured] = useState('')
  const [recordNote, setRecordNote] = useState('')

  const [closeOpen, setCloseOpen] = useState(false)
  const [closeTarget, setCloseTarget] = useState<BypassWork | null>(null)
  const [closeReport, setCloseReport] = useState<CloseCheckReport | null>(null)
  const [closeNote, setCloseNote] = useState('')
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [closing, setClosing] = useState(false)

  const [detailId, setDetailId] = useState<string | null>(bypassStore.activeWorkId)

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'states', label: '作业状态', options: BYPASS_STATES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = {
    keyword: bypassStore.keyword,
    stationId: bypassStore.stationId,
    states: bypassStore.stateFilter
  }

  const onModelChange = (next: FilterModel): void => {
    bypassStore.patchFilter({
      keyword: String(next.keyword ?? ''),
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      stateFilter: Array.isArray(next.states) ? next.states : []
    })
  }

  const works = bypassStore.filteredWorks()
  const activeWorks = works.filter((work) => work.state === '进行中')
  const archivedWorks = works.filter((work) => work.state === '已归档')

  const stationName = (id: string): string => stationStore.stations.find((item) => item.id === id)?.name ?? '—'
  const deviceLabel = (id: string): string => {
    const device = stationStore.devices.find((item) => item.id === id)
    return device ? `${device.type} ${device.model}` : '—'
  }
  const pointOf = (pointId: string) => stationStore.points.find((point) => point.id === pointId) ?? null

  const selectedWork =
    (detailId ? bypassStore.works.find((work) => work.id === detailId) : undefined) ??
    bypassStore.works.find((work) => work.id === bypassStore.activeWorkId) ??
    activeWorks[0] ??
    null

  const devicePoints = useMemo(() => {
    if (!selectedWork) return []
    return stationStore.points.filter((point) => point.deviceId === selectedWork.deviceId)
  }, [selectedWork, stationStore.points])

  const selectedReadings = selectedWork ? bypassStore.readingsOfWork(selectedWork.id) : []
  const selectedLeaks = selectedWork ? bypassStore.leaksOfWork(selectedWork.id) : []

  /* ------------------------------ 新建作业 ------------------------------ */

  const openCreate = (): void => {
    if (stationStore.stations.length === 0) {
      Message.warning('请先在调压站台账登记站点与设备')
      return
    }
    const stationId = stationStore.currentStation()?.id ?? stationStore.stations[0]?.id ?? ''
    createForm.setFieldsValue({
      stationId,
      deviceId: undefined,
      reason: '',
      manager: '',
      recorder: '',
      safetyLinePpm: 50
    })
    setStartText(nowText())
    setEndText(shiftText(4 * 60))
    setTempLimits([])
    setCreateOpen(true)
  }

  const syncTempLimits = (stationId: string, deviceId: string, safetyLinePpm: number): void => {
    const points = stationStore.points.filter(
      (point) => point.deviceId === deviceId && stationStore.devices.some((d) => d.id === deviceId && d.stationId === stationId)
    )
    setTempLimits(
      points.map((point) => ({
        pointId: point.id,
        pointName: point.name,
        unit: point.unit,
        isCritical: point.isCritical,
        tempMin: point.unit === 'ppm' ? 0 : point.standardMin,
        tempMax: point.unit === 'ppm' ? safetyLinePpm : point.standardMax
      }))
    )
  }

  const submitCreate = async (): Promise<void> => {
    const values = await createForm.validate().catch(() => null)
    if (!values) return
    if (!startText || !endText) {
      Message.warning('请填写许可起止时间')
      return
    }
    setCreating(true)
    try {
      const work = await bypassStore.createWork({
        stationId: values.stationId,
        deviceId: values.deviceId,
        reason: values.reason,
        manager: values.manager,
        recorder: values.recorder,
        startText,
        endText,
        safetyLinePpm: values.safetyLinePpm,
        limits: tempLimits
      })
      Message.success(`旁通作业 ${work.code} 已开工，作业期读数将按临时安全区间判定`)
      setCreateOpen(false)
      setDetailId(work.id)
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '开工失败')
    } finally {
      setCreating(false)
    }
  }

  /* ------------------------------ 现场录数 ------------------------------ */

  const openRecord = (work: BypassWork): void => {
    if (isExpiredOpen(work)) {
      Message.error('作业许可已到期：到期前不能改用平时标准，如需继续请由负责人重新登记作业')
      return
    }
    const points = stationStore.points.filter((point) => point.deviceId === work.deviceId)
    setRecordPointId(points[0]?.id ?? '')
    setRecordValue(undefined)
    setRecordMeasured(nowText())
    setRecordNote('')
    setRecordOpen(true)
  }

  const submitRecord = async (): Promise<void> => {
    if (!selectedWork) return
    if (!recordPointId || recordValue === undefined || !Number.isFinite(Number(recordValue))) {
      Message.warning('请选择点位并填写读数')
      return
    }
    try {
      const result = await bypassStore.recordReading({
        workId: selectedWork.id,
        pointId: recordPointId,
        value: Number(recordValue),
        note: recordNote,
        measuredText: recordMeasured
      })
      if (result.leakCreated) {
        Message.error(`浓度 ${recordValue} ppm 越过安全线，已立即派发泄漏处置单`)
      } else if (result.reading.isAbnormal) {
        Message.warning(`读数按临时安全区间判为异常（偏差 ${result.reading.deviationPct.toFixed(2)}%）`)
      } else {
        Message.success('读数已归入本旁通作业（按临时安全区间判定正常）')
      }
      setRecordOpen(false)
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '读数登记失败')
    }
  }

  /* ------------------------------ 结束归档 ------------------------------ */

  const openClose = (work: BypassWork): void => {
    const report = bypassStore.checkClose(work.id)
    setCloseTarget(work)
    setCloseReport(report)
    setCloseNote(work.closeNote ?? '')
    setSimulateFailure(false)
    setCloseOpen(true)
  }

  const submitClose = async (): Promise<void> => {
    if (!closeTarget || !closeReport) return
    if (!closeReport.canClose) {
      Message.error('核对未通过，请先为越安全线读数派发泄漏单')
      return
    }
    setClosing(true)
    try {
      const result = await bypassStore.closeWork(closeTarget.id, closeNote, simulateFailure ? 2 : 0)
      if (result.archived) {
        Message.success('本次读数与泄漏单已全部写入台账，作业归档完成')
        setCloseOpen(false)
      } else {
        Message.warning(`台账写入失败，现场批次已保留：剩余 ${result.pending} 项未完成，可点击「重试写台账」只补未完成项`)
        const latest = await bypassStore.getWork(closeTarget.id)
        if (latest) {
          setCloseTarget(latest)
          setCloseReport(bypassStore.checkClose(closeTarget.id))
        }
      }
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '归档失败')
    } finally {
      setClosing(false)
    }
  }

  const retry = async (): Promise<void> => {
    if (!closeTarget) return
    setClosing(true)
    try {
      const result = await bypassStore.retryLedger(closeTarget.id)
      if (result.archived) {
        Message.success('重试成功：未完成项已补齐，作业归档完成（未重复派单）')
        setCloseOpen(false)
      } else {
        Message.warning(`仍有 ${result.pending} 项未写入，现场批次继续保留，可再次重试`)
        const latest = await bypassStore.getWork(closeTarget.id)
        if (latest) setCloseTarget(latest)
      }
    } finally {
      setClosing(false)
    }
  }

  /* ------------------------------ 表格列 ------------------------------ */

  const workColumns: TableColumnProps<BypassWork>[] = [
    {
      title: '作业单号 / 事由',
      width: 260,
      render: (_v, record) => (
        <div>
          <strong>{record.code}</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            {record.reason || '—'}
          </div>
        </div>
      )
    },
    { title: '调压站', width: 150, render: (_v, record) => stationName(record.stationId) },
    { title: '设备', width: 150, render: (_v, record) => deviceLabel(record.deviceId) },
    { title: '许可时段', width: 250, render: (_v, record) => `${formatDateTime(record.startAt)} ~ ${formatDateTime(record.endAt)}` },
    { title: '负责人', dataIndex: 'manager', width: 90 },
    { title: '记录人', dataIndex: 'recorder', width: 90, render: (v: string) => v || '—' },
    {
      title: '安全线',
      width: 100,
      render: (_v, record) => (
        <Tag color="red" size="small">
          {record.safetyLinePpm} ppm
        </Tag>
      )
    },
    {
      title: '状态',
      width: 130,
      render: (_v, record) =>
        record.state === '已归档' ? (
          <Tag color="green">已归档</Tag>
        ) : isExpiredOpen(record) ? (
          <Tag color="red">进行中 · 已到期</Tag>
        ) : (
          <Tag color="blue">进行中 · {remainingText(record.endAt)}</Tag>
        )
    },
    {
      title: '操作',
      width: 200,
      render: (_v, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => setDetailId(record.id)}>
            查看
          </Button>
          {record.state === '进行中' ? (
            <>
              <Button type="text" size="small" onClick={() => openRecord(record)}>
                现场录数
              </Button>
              <Button type="text" size="small" status="warning" onClick={() => openClose(record)}>
                结束作业
              </Button>
            </>
          ) : null}
        </Space>
      )
    }
  ]

  const readingColumns: TableColumnProps<ReadingRow>[] = [
    {
      title: '测量时间',
      width: 150,
      render: (_v, record) => formatDateTime(record.measuredAt ?? record.createdAt)
    },
    {
      title: '点位',
      width: 150,
      render: (_v, record) => pointOf(record.pointId)?.name ?? '点位已删除'
    },
    {
      title: '临时安全区间',
      width: 180,
      render: (_v, record) =>
        record.judgeBasis ? `${record.judgeBasis.min} ~ ${record.judgeBasis.max} ${record.judgeBasis.unit}` : '—'
    },
    {
      title: '读数',
      width: 110,
      render: (_v, record) => `${record.value} ${record.judgeBasis?.unit ?? ''}`
    },
    { title: '偏差率', width: 100, render: (_v, record) => `${record.deviationPct.toFixed(2)}%` },
    {
      title: '判定 / 依据',
      width: 250,
      render: (_v, record) => {
        const point = pointOf(record.pointId)
        const level = record.judgeBasis
          ? abnormalLevelOf(record.deviationPct, record.judgeBasis.isCritical)
          : point
            ? abnormalLevelOf(record.deviationPct, point.isCritical)
            : '正常'
        return (
          <Space size={6} wrap>
            <AbnormalTag level={level} deviationPct={record.deviationPct} size="small" />
            <BasisTag basis={record.judgeBasis} />
          </Space>
        )
      }
    },
    { title: '备注', dataIndex: 'note', width: 200, render: (v: string) => v || '—' },
    {
      title: '操作',
      width: 90,
      render: (_v, record) =>
        selectedWork?.state === '进行中' ? (
          <Popconfirm
            title="删除该作业期读数？已据此派的泄漏单不会自动撤销。"
            onOk={() => bypassStore.removeReading(selectedWork.id, record.id)}
          >
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        ) : (
          <span className="muted">已归档</span>
        )
    }
  ]

  const leakColumns: TableColumnProps<LeakRow>[] = [
    { title: '发现日期', dataIndex: 'foundTime', width: 110 },
    {
      title: '浓度',
      width: 120,
      render: (_v, record) => <span style={{ color: '#f53f3f', fontWeight: 600 }}>{formatLeakConcentration(record.concentrationPpm)}</span>
    },
    { title: '状态', width: 100, render: (_v, record) => <Tag color={record.state === '已复检' ? 'green' : 'red'}>{record.state}</Tag> },
    { title: '处置人', dataIndex: 'handler', width: 90, render: (v: string) => v || '—' },
    { title: '处置措施', dataIndex: 'measure', render: (v: string) => v || '—' },
    {
      title: '操作',
      width: 110,
      render: () => (
        <Button type="text" size="small" onClick={() => navigate('/leaks')}>
          去处置
        </Button>
      )
    }
  ]

  const exportCsv = (): void => {
    if (!selectedWork) return
    const filename = exportBypassCsv(
      selectedWork,
      selectedReadings,
      selectedLeaks,
      stationName(selectedWork.stationId),
      deviceLabel(selectedWork.deviceId)
    )
    Message.success(`已导出 ${filename}`)
  }

  const openCount = bypassStore.works.filter((work) => work.state === '进行中').length
  const expiredCount = bypassStore.works.filter((work) => isExpiredOpen(work)).length
  const archivedCount = bypassStore.works.length - openCount

  const createDeviceOptions = (stationId: string) =>
    stationStore.devices
      .filter((device) => device.stationId === stationId)
      .map((device) => {
        const busy = bypassStore.activeWorkOfDevice(device.id)
        return {
          label: `${device.type} ${device.model}${busy ? `（${busy.code} 作业中，不可再开）` : ''}`,
          value: device.id,
          disabled: Boolean(busy)
        }
      })

  const currentBatch = selectedWork?.batch ?? null

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">旁通作业（抢修临时开旁通）</h2>
          <p className="page-head__desc">
            作业期读数按登记的临时安全区间判级，浓度越过安全线立即派单；许可到期前不能改用平时标准，结束作业核对读数与泄漏单后写入台账。
          </p>
        </div>
        <div className="page-head__actions">
          <Button disabled={!selectedWork} onClick={exportCsv}>
            导出作业台账 CSV
          </Button>
          <Button type="primary" onClick={openCreate}>
            登记旁通作业
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="作业总数" value={bypassStore.works.length} suffix="次" tone="primary" />
        <StatBadge label="进行中" value={openCount} suffix="次" tone="info" />
        <StatBadge label="已到期未结束" value={expiredCount} suffix="次" tone="danger" />
        <StatBadge label="已归档" value={archivedCount} suffix="次" tone="success" />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索单号 / 事由 / 负责人 / 记录人"
        onModelChange={onModelChange}
      />

      <div className="grid-two" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3 className="panel-title">作业列表（{works.length}）</h3>
          {works.length === 0 ? (
            <EmptyPanel
              title="暂无旁通作业"
              description="抢修临时开旁通时，由负责人登记站点、设备、许可时段与临时安全区间后开工。"
              actionText="登记旁通作业"
              onAction={openCreate}
              compact
            />
          ) : (
            <Table<BypassWork>
              rowKey="id"
              size="small"
              border
              data={works}
              columns={workColumns}
              pagination={false}
              scroll={{ x: 1500 }}
              onRow={(record) => ({
                onClick: () => setDetailId(record.id),
                style: { cursor: 'pointer' }
              })}
            />
          )}
        </div>

        <div className="panel">
          {selectedWork ? (
            <>
              <div className="panel-head">
                <h3 className="panel-title" style={{ margin: 0 }}>
                  {selectedWork.code}
                  <span className="muted"> · {stationName(selectedWork.stationId)} / {deviceLabel(selectedWork.deviceId)}</span>
                </h3>
                <Space size={6}>
                  {selectedWork.state === '进行中' ? (
                    <>
                      <Button size="small" type="primary" onClick={() => openRecord(selectedWork)}>
                        现场录数
                      </Button>
                      <Button size="small" status="warning" onClick={() => openClose(selectedWork)}>
                        结束作业
                      </Button>
                    </>
                  ) : (
                    <Tag color="green">已归档 · {formatDateTime(selectedWork.archivedAt ?? 0)}</Tag>
                  )}
                </Space>
              </div>

              {isExpiredOpen(selectedWork) ? (
                <Alert
                  type="error"
                  style={{ marginBottom: 12 }}
                  content={`作业许可已到期（${formatDateTime(selectedWork.endAt)}）。到期前不能改用平时标准；如需继续按临时区间录数，请重新登记作业。`}
                />
              ) : selectedWork.state === '进行中' ? (
                <Alert
                  type="info"
                  style={{ marginBottom: 12 }}
                  content={`许可窗口 ${formatDateTime(selectedWork.startAt)} ~ ${formatDateTime(selectedWork.endAt)}（${remainingText(
                    selectedWork.endAt
                  )}），窗口内读数一律按临时安全区间判定。`}
                />
              ) : null}

              <div className="card-list-item__meta" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 12 }}>
                <span>负责人：{selectedWork.manager}</span>
                <span>记录人：{selectedWork.recorder || '—'}</span>
                <span>
                  浓度安全线：
                  <Tag color="red" size="small">
                    {selectedWork.safetyLinePpm} ppm
                  </Tag>
                </span>
                <span>事由：{selectedWork.reason || '—'}</span>
              </div>

              <h4 className="panel-title">临时安全区间</h4>
              <Space wrap size={8} style={{ marginBottom: 12 }}>
                {selectedWork.limits.map((limit) => (
                  <Tag key={limit.pointId} color="purple" size="small">
                    {limit.pointName}：{limit.tempMin} ~ {limit.tempMax} {limit.unit}
                    {limit.isCritical ? '（关键）' : ''}
                  </Tag>
                ))}
              </Space>

              <div className="panel-head">
                <h4 className="panel-title" style={{ margin: 0 }}>
                  作业期读数（{selectedReadings.length}）
                </h4>
                <span className="muted">异常 {selectedReadings.filter((r) => r.isAbnormal).length} 项 · 泄漏单 {selectedLeaks.length} 张</span>
              </div>
              {selectedReadings.length === 0 ? (
                <EmptyPanel title="暂无作业期读数" description="现场记录人点击「现场录数」，读数会自动归到本作业下。" compact />
              ) : (
                <Table<ReadingRow>
                  rowKey="id"
                  size="small"
                  border
                  data={selectedReadings}
                  columns={readingColumns}
                  pagination={false}
                  scroll={{ x: 1200 }}
                />
              )}

              <h4 className="panel-title" style={{ marginTop: 12 }}>
                关联泄漏处置单（{selectedLeaks.length}）
              </h4>
              {selectedLeaks.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  作业期内浓度未越过安全线，无泄漏处置单。
                </p>
              ) : (
                <Table<LeakRow>
                  rowKey="id"
                  size="small"
                  border
                  data={selectedLeaks}
                  columns={leakColumns}
                  pagination={false}
                />
              )}

              {selectedWork.state === '已归档' ? (
                <div style={{ marginTop: 12 }}>
                  <h4 className="panel-title">处置结果与归档追溯</h4>
                  <Alert type="success" content={selectedWork.closeNote || '作业已归档。'} style={{ marginBottom: 8 }} />
                  {currentBatch ? (
                    <p className="muted" style={{ fontSize: 13 }}>
                      现场批次 {currentBatch.batchNo}：共 {currentBatch.total} 项，写入轮次 {currentBatch.rounds}，成功{' '}
                      {currentBatch.items.filter((item) => item.state === '已写入').length} 项，最近写入 {formatDateTime(currentBatch.lastRunAt)}。
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <EmptyPanel title="尚未选择旁通作业" description="在左侧选择一张作业查看明细，或登记新的旁通作业。" compact />
          )}
        </div>
      </div>

      {archivedWorks.length > 0 ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3 className="panel-title" style={{ margin: 0 }}>
              历史作业（{archivedWorks.length}）
            </h3>
            <span className="muted">历史作业、判级依据、泄漏单与处置结果全部保留可追溯</span>
          </div>
          <Table<BypassWork>
            rowKey="id"
            size="small"
            border
            data={archivedWorks}
            columns={workColumns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        </div>
      ) : null}

      {/* 新建旁通作业 */}
      <Modal
        visible={createOpen}
        title="登记旁通作业"
        style={{ width: 760 }}
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        confirmLoading={creating}
        okText="开工"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={createForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item field="stationId" label="调压站" rules={[{ required: true, message: '请选择调压站' }]} style={{ flex: 1 }}>
              <Select
                placeholder="选择调压站"
                options={stationStore.stations.map((station) => ({ label: station.name, value: station.id }))}
                onChange={(value: string) => {
                  createForm.setFieldsValue({ deviceId: undefined })
                  setTempLimits([])
                  const safety = createForm.getFieldValue('safetyLinePpm') ?? 50
                  void value
                  void safety
                }}
              />
            </Form.Item>
            <Form.Item shouldUpdate noStyle>
              {(values) => (
                <Form.Item field="deviceId" label="设备" rules={[{ required: true, message: '请选择设备' }]} style={{ flex: 1 }}>
                  <Select
                    placeholder="选择抢修设备"
                    options={createDeviceOptions(String(values.stationId ?? ''))}
                    onChange={(value: string) => {
                      const stationId = String(createForm.getFieldValue('stationId') ?? '')
                      const safety = Number(createForm.getFieldValue('safetyLinePpm')) || 50
                      syncTempLimits(stationId, value, safety)
                    }}
                  />
                </Form.Item>
              )}
            </Form.Item>
          </Space>

          <Form.Item field="reason" label="抢修 / 开旁通事由" rules={[{ required: true, message: '请填写事由' }]}>
            <Input placeholder="如 调压器主路密封垫更换，临时开旁通供气" />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item field="manager" label="作业负责人" rules={[{ required: true, message: '请填写负责人' }]} style={{ flex: 1 }}>
              <Input placeholder="如 王强" />
            </Form.Item>
            <Form.Item field="recorder" label="现场记录人" style={{ flex: 1 }}>
              <Input placeholder="如 李娜" />
            </Form.Item>
            <Form.Item field="safetyLinePpm" label="浓度安全线(ppm)" rules={[{ required: true, message: '请填写安全线' }]} style={{ flex: 1 }}>
              <InputNumber
                min={1}
                style={{ width: '100%' }}
                onChange={(value: number | undefined) => {
                  const stationId = String(createForm.getFieldValue('stationId') ?? '')
                  const deviceId = String(createForm.getFieldValue('deviceId') ?? '')
                  if (deviceId) syncTempLimits(stationId, deviceId, Number(value) || 50)
                }}
              />
            </Form.Item>
          </Space>

          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item label="许可开始时间" required style={{ flex: 1 }}>
              <DatePicker
                showTime
                format="YYYY-MM-DD HH:mm"
                style={{ width: '100%' }}
                value={startText ? new Date(startText.replace(' ', 'T')) : undefined}
                onChange={(dateString: string) => setStartText(dateString)}
              />
            </Form.Item>
            <Form.Item label="许可到期时间" required style={{ flex: 1 }}>
              <DatePicker
                showTime
                format="YYYY-MM-DD HH:mm"
                style={{ width: '100%' }}
                value={endText ? new Date(endText.replace(' ', 'T')) : undefined}
                onChange={(dateString: string) => setEndText(dateString)}
              />
            </Form.Item>
          </Space>

          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            许可窗口内现场读数按下方临时安全区间判定；窗口结束前不能改回平时标准。同一设备已有未归档作业时不能再开。
          </div>

          <Form.Item label="临时安全区间（可调整；浓度类统一以安全线为上限）">
            <Space direction="vertical" size={8} style={{ display: 'flex' }}>
              {tempLimits.length === 0 ? (
                <span className="muted" style={{ fontSize: 13 }}>
                  请先选择设备，自动带出该设备点位与临时区间。
                </span>
              ) : (
                tempLimits.map((limit, index) => (
                  <Space key={limit.pointId} size={8}>
                    <span style={{ minWidth: 120 }}>
                      {limit.pointName}
                      {limit.isCritical ? <Tag color="orange" size="small" style={{ marginLeft: 4 }}>关键</Tag> : null}
                    </span>
                    {limit.unit === 'ppm' ? (
                      <Tag color="red" size="small">
                        0 ~ {limit.tempMax} ppm（安全线）
                      </Tag>
                    ) : (
                      <>
                        <InputNumber
                          size="small"
                          style={{ width: 110 }}
                          value={limit.tempMin}
                          onChange={(v: number | undefined) => {
                            if (v === undefined) return
                            const next = [...tempLimits]
                            next[index] = { ...limit, tempMin: Number(v) }
                            setTempLimits(next)
                          }}
                        />
                        <span>~</span>
                        <InputNumber
                          size="small"
                          style={{ width: 110 }}
                          value={limit.tempMax}
                          onChange={(v: number | undefined) => {
                            if (v === undefined) return
                            const next = [...tempLimits]
                            next[index] = { ...limit, tempMax: Number(v) }
                            setTempLimits(next)
                          }}
                        />
                        <span className="muted">{limit.unit}</span>
                      </>
                    )}
                  </Space>
                ))
              )}
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* 现场录数 */}
      <Modal
        visible={recordOpen}
        title={`作业期现场录数 · ${selectedWork?.code ?? ''}`}
        onCancel={() => setRecordOpen(false)}
        onOk={submitRecord}
        okText="保存读数"
        cancelText="取消"
        unmountOnExit
      >
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          <div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
              点位
            </div>
            <Select
              style={{ width: '100%' }}
              value={recordPointId || undefined}
              options={devicePoints.map((point) => {
                const limit = selectedWork?.limits.find((item) => item.pointId === point.id)
                return {
                  label: `${point.name}（临时 ${limit ? limit.tempMin : point.standardMin} ~ ${limit ? limit.tempMax : point.standardMax} ${point.unit}）`,
                  value: point.id
                }
              })}
              onChange={(value: string) => setRecordPointId(value)}
            />
          </div>
          <div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
              测量时间（须在许可窗口内）
            </div>
            <DatePicker
              showTime
              format="YYYY-MM-DD HH:mm"
              style={{ width: '100%' }}
              value={recordMeasured ? new Date(recordMeasured.replace(' ', 'T')) : undefined}
              onChange={(dateString: string) => setRecordMeasured(dateString)}
            />
          </div>
          <div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
              读数（{pointOf(recordPointId)?.unit ?? ''}）
            </div>
            <InputNumber
              style={{ width: '100%' }}
              value={recordValue}
              step={pointOf(recordPointId)?.unit === 'ppm' ? 1 : 0.01}
              onChange={(v: number | undefined) => setRecordValue(v)}
            />
            {recordPointId && recordValue !== undefined ? (
              <div style={{ marginTop: 6 }}>
                <AbnormalTag
                  level={abnormalLevelOf(
                    (() => {
                      const limit = selectedWork?.limits.find((item) => item.pointId === recordPointId)
                      const point = pointOf(recordPointId)
                      const min = limit?.tempMin ?? point?.standardMin ?? 0
                      const max = limit?.tempMax ?? point?.standardMax ?? 1
                      const base = Math.abs(max) > 1e-6 ? Math.abs(max) : 1
                      return recordValue > max
                        ? ((recordValue - max) / base) * 100
                        : recordValue < min
                          ? ((min - recordValue) / (Math.abs(min) > 1e-6 ? Math.abs(min) : 1)) * 100
                          : 0
                    })(),
                    pointOf(recordPointId)?.isCritical ?? false
                  )}
                  size="small"
                />
                <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                  按旁通临时安全区间预判
                </span>
              </div>
            ) : null}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
              现场备注
            </div>
            <Input.TextArea
              value={recordNote}
              autoSize={{ minRows: 2, maxRows: 4 }}
              onChange={(value: string) => setRecordNote(value)}
            />
          </div>
        </Space>
      </Modal>

      {/* 结束作业核对 + 台账写入 */}
      <Modal
        visible={closeOpen}
        title={`结束作业核对 · ${closeTarget?.code ?? ''}`}
        style={{ width: 680 }}
        onCancel={() => setCloseOpen(false)}
        onOk={submitClose}
        confirmLoading={closing}
        okText={closeReport?.canClose ? '核对通过并写入台账' : '存在应派未派'}
        okButtonProps={{ status: closeReport?.canClose ? 'success' : 'danger', disabled: !closeReport?.canClose }}
        cancelText="取消"
        unmountOnExit
      >
        {closeTarget && closeReport ? (
          <Space direction="vertical" size={12} style={{ display: 'flex' }}>
            <Space size={20}>
              <span>本次读数：<strong>{closeReport.readingCount}</strong> 条</span>
              <span>异常：<strong style={{ color: '#ff7d00' }}>{closeReport.abnormalCount}</strong> 条</span>
              <span>泄漏单：<strong style={{ color: '#f53f3f' }}>{closeReport.leakCount}</strong> 张</span>
              <span>未闭环：{closeReport.openLeakCount} 张</span>
            </Space>

            {closeReport.issues.map((issue, index) => (
              <Alert
                key={index}
                type={issue.level === 'danger' ? 'error' : 'warning'}
                content={issue.text}
              />
            ))}
            {closeReport.missing.length > 0 ? (
              <Alert type="error" content={`应派未派：${closeReport.missing.join('；')}。请回到作业面板对越线读数派单后再结束。`} />
            ) : null}

            <div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
                处置结果 / 归档备注
              </div>
              <Input.TextArea
                value={closeNote}
                placeholder="如 主路复装并气密试验合格，退出旁通；泄漏单已派现场处置组。"
                autoSize={{ minRows: 2, maxRows: 4 }}
                onChange={(value: string) => setCloseNote(value)}
              />
            </div>

            <Checkbox checked={simulateFailure} onChange={setSimulateFailure}>
              台账写入失败演练（首批前 2 项模拟失败，验证现场批次保留与重试）
            </Checkbox>

            {closeTarget.batch && closeTarget.batch.items.some((item) => item.state !== '已写入') ? (
              <Alert
                type="error"
                content={
                  <div>
                    现场批次有未完成项，重试只会补写未成功条目，已写入项与已派泄漏单不会重复处理。
                    <Button size="mini" type="primary" status="danger" style={{ marginLeft: 8 }} loading={closing} onClick={retry}>
                      重试写台账（{closeTarget.batch.items.filter((i) => i.state !== '已写入').length} 项）
                    </Button>
                  </div>
                }
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}
