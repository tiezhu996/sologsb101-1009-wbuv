/**
 * <BasisTag> 判级依据标签
 * 区分「平时标准区间」与「旁通临时安全区间」，被巡检录入、异常分级、旁通作业、泄漏处置页消费，
 * 保证每条读数/异常的判级依据可追溯。
 */
import { Tag, Tooltip } from '@arco-design/web-react'
import { IconThunderbolt } from '@arco-design/web-react/icon'
import type { JudgeBasis } from '@/types/bypass'
import { judgeBasisLabel } from '@/types/bypass'

export interface BasisTagProps {
  basis?: JudgeBasis
  size?: 'small' | 'default'
}

export function BasisTag({ basis, size = 'small' }: BasisTagProps) {
  const isBypass = basis?.type === '旁通临时区间'
  const tag = (
    <Tag
      color={isBypass ? 'purple' : 'gray'}
      size={size}
      icon={isBypass ? <IconThunderbolt /> : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      {judgeBasisLabel(basis)}
    </Tag>
  )
  if (!basis) return tag
  return (
    <Tooltip
      content={`依据：${basis.source}；区间 ${basis.min} ~ ${basis.max} ${basis.unit}${basis.isCritical ? '（关键点）' : ''}`}
    >
      {tag}
    </Tooltip>
  )
}

export default BasisTag
