<script lang="ts">
  /**
   * <RetestTag> 复测计划状态标签：有效 / 即将到期 / 已到期 / 待补检。
   * 被建筑物台账（/buildings）、装置登记（/devices）与结论导出（/backup）消费。
   */
  import type { RetestStatus } from '$lib/utils/retest.ts'

  let {
    status = '待补检',
    size = 'default',
    title = ''
  }: {
    status?: RetestStatus
    size?: 'default' | 'small'
    title?: string
  } = $props()

  const TONE: Record<RetestStatus, { color: string; bg: string; icon: string; label: string }> = {
    有效: { color: '#1e8449', bg: '#eaf6ee', icon: '✔', label: '复测有效' },
    即将到期: { color: '#d68910', bg: '#fff4e0', icon: '!', label: '即将到期' },
    已到期: { color: '#c0392b', bg: '#fdecea', icon: '✕', label: '已过复测周期' },
    待补检: { color: '#a8480f', bg: '#fff1e8', icon: '?', label: '待补检' },
    未检测: { color: '#8c8479', bg: '#f2f2f2', icon: '?', label: '待补检' }
  }

  const tone = $derived(TONE[status] ?? TONE.待补检)
</script>

<span
  class="retest-tag is-{size}"
  style={`color:${tone.color};background:${tone.bg};border-color:${tone.color};`}
  title={title || tone.label}
>
  <i class="retest-tag__icon" aria-hidden="true">{tone.icon}</i>
  <b class="retest-tag__text">{tone.label}</b>
</span>

<style>
  .retest-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    line-height: 20px;
    white-space: nowrap;
  }

  .retest-tag.is-small {
    padding: 0 8px;
    font-size: 12px;
    line-height: 18px;
  }

  .retest-tag__icon {
    font-style: normal;
    font-size: 12px;
  }
</style>
