<script lang="ts">
  /**
   * 模块 5：/backup 检测结论与结构版本导出
   * 按建筑物出检测结论、查看 IndexedDB 结构版本、导入导出全量 JSON。
   * 复用 <EmptyPanel>、<StatBadge>。
   */
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte'
  import StatBadge from '$lib/components/common/StatBadge.svelte'
  import QualifyTag from '$lib/components/common/QualifyTag.svelte'
  import { buildingList, deviceList } from '$lib/stores/buildingStore.ts'
  import { pointList } from '$lib/stores/pointStore.ts'
  import { qualifyStats, rectifyList } from '$lib/stores/rectifyStore.ts'
  import {
    DB_NAME,
    DB_VERSION,
    countAll,
    readLastBackupAt,
    readStampedDbVersion,
    resetDatabase
  } from '$lib/utils/db.ts'
  import {
    buildBackupPayload,
    buildConclusionLines,
    countPayload,
    exportBackupJson,
    importBackup,
    readFileText,
    remapIds,
    validateBackup
  } from '$lib/utils/export.ts'
  import type { ConclusionLine, CountMap } from '$lib/utils/export.ts'
  import { RECTIFY_STATES } from '$lib/types/rectify.ts'

  const EMPTY_COUNTS: CountMap = { buildings: 0, devices: 0, points: 0, verdicts: 0, rectifies: 0 }

  let counts = $state<CountMap>(EMPTY_COUNTS)
  let lastBackupAt = $state<string | null>(null)
  let stampedVersion = $state<number>(DB_VERSION)
  let conclusions = $state<ConclusionLine[]>([])
  let overwriteOnImport = $state(true)
  let notice = $state('')
  let busy = $state(false)
  let fileInput = $state<HTMLInputElement | null>(null)

  async function refresh(): Promise<void> {
    counts = (await countAll()) as CountMap
    lastBackupAt = readLastBackupAt()
    stampedVersion = readStampedDbVersion()
    const payload = await buildBackupPayload()
    conclusions = buildConclusionLines(payload)
  }

  async function handleExport(): Promise<void> {
    busy = true
    try {
      const result = await exportBackupJson()
      await refresh()
      notice = `已导出 ${result.fileName}（共 ${Object.values(result.counts).reduce((sum, value) => sum + value, 0)} 条记录）。`
    } finally {
      busy = false
    }
  }

  async function handleFileChange(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    busy = true
    try {
      const text = await readFileText(file)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        notice = '文件不是合法的 JSON，无法解析。'
        return
      }
      const validation = validateBackup(parsed)
      if (!validation.ok || !validation.payload) {
        notice = `备份校验失败：${validation.errors.join('；')}`
        return
      }
      const payload = overwriteOnImport ? validation.payload : remapIds(validation.payload)
      const summary = countPayload(payload)
      const ok = window.confirm(
        `将导入 ${Object.entries(summary)
          .map(([key, value]) => `${key} ${value} 条`)
          .join('、')}；${overwriteOnImport ? '覆盖模式会先清空现有本地数据' : '追加模式会重新分配 id 保留现有数据'}。确认继续？`
      )
      if (!ok) return
      await importBackup(payload, overwriteOnImport)
      await refresh()
      notice = '导入完成，列表与结论已刷新。'
    } finally {
      busy = false
      input.value = ''
    }
  }

  async function handleReset(): Promise<void> {
    const ok = window.confirm('将清空全部本地数据并重新播种演示数据（建筑物、装置、测点、判定、整改建议）。确认继续？')
    if (!ok) return
    busy = true
    try {
      await resetDatabase()
      await refresh()
      notice = '本地数据已重置为演示数据。'
    } finally {
      busy = false
    }
  }

  async function copySummary(): Promise<void> {
    const text = conclusions
      .map((line) => {
        const retestText =
          line.retestStatus === '待补检'
            ? `复测状态待补检，缺检装置：${line.missingDevices.length > 0 ? line.missingDevices.join('、') : '装置或测点缺失'}，须同一日期补齐`
            : `复测状态${line.retestStatus}，最近全检批次 ${line.lastBatchDate ?? '—'}，到期日 ${line.dueDate ?? '—'}（${line.retestStatus === '已到期' ? `已超期 ${Math.abs(line.daysToDue ?? 0)} 天` : `剩 ${line.daysToDue ?? 0} 天`}）${line.missingDevices.length > 0 ? `，另有缺检装置：${line.missingDevices.join('、')}` : ''}`
        return `${line.buildingName}（${line.protectionClass} / ${line.usage}，周期 ${line.intervalMonths} 个月）：装置 ${line.deviceCount} 处，测点 ${line.pointCount} 个，不合格 ${line.unqualifiedCount} 个，合格率 ${line.qualifyRatePct}%。${line.conclusion}。最不利点：${line.worstPoint}。${retestText}。${line.advice}`
      })
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      notice = '检测结论已复制到剪贴板。'
    } catch {
      notice = '当前浏览器不允许读取剪贴板，请手动选中表格内容复制。'
    }
  }

  /** 全部测点判定行：按占限值比例降序，便于核对最不利点 */
  const pointRows = $derived(
    $pointList
      .map((point) => {
        const device = $deviceList.find((item) => item.id === point.deviceId)
        const building = device ? $buildingList.find((item) => item.id === device.buildingId) : undefined
        return { point, device, building }
      })
      .sort((a, b) => b.point.measuredOhm / b.point.limitOhm - a.point.measuredOhm / a.point.limitOhm)
  )

  refresh()
</script>

<section class="page">
  <div class="gb-brand-bar"></div>

  <div class="page__head">
    <div>
      <h2 class="page__title">检测结论与结构版本导出</h2>
      <p class="gb-hint">
        按建筑物汇总检测结论（装置数、测点数、不合格数、合格率、最不利点与复测到期日 / 缺检装置），并可导出 / 导入全量 JSON 备份。
        到期判断只认覆盖全部装置的最近检测批次。
      </p>
    </div>
    <div class="page__actions">
      <button class="btn" type="button" onclick={refresh}>刷新</button>
      <button class="btn" type="button" onclick={copySummary}>复制结论</button>
      <button class="btn btn--primary" type="button" disabled={busy} onclick={handleExport}>导出 JSON</button>
    </div>
  </div>

  {#if notice}
    <p class="gb-alert">{notice}</p>
  {/if}

  <div class="gb-stats-row">
    <StatBadge label="建筑物" value={counts.buildings} suffix="栋" tone="primary" />
    <StatBadge label="防雷装置" value={counts.devices} suffix="处" tone="info" />
    <StatBadge label="接地电阻测点" value={counts.points} suffix="点" tone="default" />
    <StatBadge
      label="不合格测点"
      value={$qualifyStats.overall.failed}
      suffix="点"
      tone={$qualifyStats.overall.failed > 0 ? 'danger' : 'success'}
    />
    <StatBadge label="整体合格率" value={$qualifyStats.overall.rate} percent={$qualifyStats.overall.rate} tone="success" />
  </div>

  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>按建筑物的检测结论</h3>
      <span class="gb-hint">
        本地库 {DB_NAME} · 结构版本 v{DB_VERSION}（浏览器记录 v{stampedVersion}）·
        最近备份 {lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份'}
      </span>
    </div>

    {#if conclusions.length === 0}
      <EmptyPanel title="还没有建筑物" description="先到「建筑物台账」新建建筑物并录入测点，即可生成检测结论。" compact />
    {:else}
      <table class="gb-table">
        <thead>
          <tr>
            <th>建筑物</th>
            <th>类别 / 用途</th>
            <th class="is-num">装置</th>
            <th class="is-num">测点</th>
            <th class="is-num">不合格</th>
            <th>复测状态</th>
            <th>最近批次 / 周期</th>
            <th>到期日</th>
            <th>缺检装置</th>
            <th>检测结论</th>
            <th>最不利点</th>
            <th>整改建议</th>
          </tr>
        </thead>
        <tbody>
          {#each conclusions as line (line.buildingId)}
            <tr class:is-bad={line.unqualifiedCount > 0} class:is-due={line.retestStatus === '已到期'} class:is-supplement={line.retestStatus === '待补检'}>
              <td>{line.buildingName}</td>
              <td>
                <span class="gb-tag">{line.protectionClass}</span>
                <span class="gb-hint"> {line.usage}</span>
              </td>
              <td class="is-num gb-mono">{line.deviceCount}</td>
              <td class="is-num gb-mono">{line.pointCount}</td>
              <td class="is-num gb-mono">{line.unqualifiedCount}</td>
              <td><span class="retest-tag status-{line.retestStatus}">{line.retestStatus}</span></td>
              <td class="gb-mono gb-hint">
                {line.lastBatchDate ?? '无全覆盖批次'}<br />每 {line.intervalMonths} 个月
              </td>
              <td class="gb-mono">
                {#if line.dueDate}
                  {line.dueDate}
                  <span class="gb-hint">
                    <br />{line.retestStatus === '已到期' ? `超期 ${Math.abs(line.daysToDue ?? 0)} 天` : `剩 ${line.daysToDue ?? 0} 天`}
                  </span>
                {:else}
                  <span class="gb-danger">—</span>
                {/if}
              </td>
              <td class="gb-hint">
                {#if line.missingDevices.length > 0}
                  {line.missingDevices.join('、')}
                {:else}
                  <span class="ok-text">无</span>
                {/if}
              </td>
              <td>
                <div>{line.conclusion}</div>
                <div class="gb-hint">合格率 {line.qualifyRatePct}%</div>
              </td>
              <td class="gb-hint">{line.worstPoint}</td>
              <td class="gb-hint">{line.advice}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>全部测点判定一览</h3>
      <span class="gb-hint">按占限值比例降序，便于出具结论时快速核对最不利点</span>
    </div>
    {#if pointRows.length === 0}
      <EmptyPanel title="还没有测点" description="先录入接地电阻测点，再生成结论。" compact />
    {:else}
      <table class="gb-table">
        <thead>
          <tr>
            <th>建筑物</th>
            <th>装置</th>
            <th>测点编号</th>
            <th class="is-num">实测（Ω）</th>
            <th class="is-num">限值（Ω）</th>
            <th>判定</th>
            <th>检测日期</th>
          </tr>
        </thead>
        <tbody>
          {#each pointRows as row (row.point.id)}
            <tr>
              <td>{row.building?.name ?? '未知建筑物'}</td>
              <td><span class="gb-tag">{row.device?.type ?? '未知装置'}</span></td>
              <td class="gb-mono">{row.point.code}</td>
              <td class="is-num gb-mono">{row.point.measuredOhm}</td>
              <td class="is-num gb-mono">{row.point.limitOhm}</td>
              <td><QualifyTag measuredOhm={row.point.measuredOhm} limitOhm={row.point.limitOhm} size="small" /></td>
              <td class="gb-mono">{row.point.measureDate}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>全量 JSON 导入导出</h3>
      <span class="gb-hint">导出内容包含 buildings / devices / points / verdicts / rectifies 五张表</span>
    </div>
    <div class="import-row">
      <label class="gb-field">
        <span>导入模式</span>
        <select bind:value={overwriteOnImport}>
          <option value={true}>覆盖（先清空本地数据）</option>
          <option value={false}>追加（重新分配 id）</option>
        </select>
      </label>
      <label class="gb-field">
        <span>选择备份文件</span>
        <input type="file" accept="application/json" bind:this={fileInput} onchange={handleFileChange} />
      </label>
      <button class="btn btn--primary" type="button" disabled={busy} onclick={handleExport}>导出当前数据</button>
      <button class="btn btn--danger" type="button" disabled={busy} onclick={handleReset}>清空并重建演示数据</button>
    </div>

    <table class="gb-table">
      <tbody>
        <tr><th>本地库名</th><td class="gb-mono">{DB_NAME}</td><th>结构版本</th><td class="gb-mono">v{DB_VERSION}</td></tr>
        <tr>
          <th>建筑物 / 装置</th>
          <td class="gb-mono">{counts.buildings} / {counts.devices}</td>
          <th>测点 / 判定</th>
          <td class="gb-mono">{counts.points} / {counts.verdicts}</td>
        </tr>
        <tr>
          <th>整改建议</th>
          <td class="gb-mono">{counts.rectifies}</td>
          <th>最近备份时间</th>
          <td>{lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份'}</td>
        </tr>
        <tr>
          <th>状态分布</th>
          <td colspan="3">
            {#each RECTIFY_STATES as state (state)}
              <span class="gb-tag">{state} {$rectifyList.filter((item) => item.state === state).length}</span>
            {/each}
          </td>
        </tr>
      </tbody>
    </table>
    <p class="gb-hint">
      数据仅保存在当前浏览器 IndexedDB 中，换浏览器或清空站点数据后不会自动跟随，请通过 JSON 备份迁移。
    </p>
  </div>
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .page__head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .page__title {
    margin: 0 0 4px;
    font-size: 19px;
    color: #1d3557;
  }

  .page__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .import-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 12px;
  }

  tr.is-bad td {
    background: #fff6f4;
  }

  tr.is-due td {
    background: #fff0ee;
  }

  tr.is-supplement td {
    background: #fffaf0;
  }

  .retest-tag {
    display: inline-flex;
    align-items: center;
    padding: 1px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid transparent;
    white-space: nowrap;
  }

  .retest-tag.status-有效 {
    color: #1e8449;
    background: #eafaf1;
    border-color: #b8e6c9;
  }

  .retest-tag.status-已到期 {
    color: #c0392b;
    background: #fdedec;
    border-color: #f2b6af;
  }

  .retest-tag.status-待补检 {
    color: #8a5a12;
    background: #fff8ec;
    border-color: #f0c78a;
  }

  .ok-text {
    color: #1e8449;
  }
</style>
