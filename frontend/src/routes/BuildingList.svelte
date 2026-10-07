<script lang="ts">
  /**
   * 模块 1：/buildings 建筑物与防雷类别台账
   * 新建建筑物与防雷类别、按用途与类别筛选；卡片回显测点数与不合格数。
   * 复用 <StatBadge>、<EmptyPanel>。
   */
  import StatBadge from '$lib/components/common/StatBadge.svelte'
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte'
  import FilterBar from '$lib/components/common/FilterBar.svelte'
  import type { FilterChange } from '$lib/components/common/FilterBar.svelte'
  import RetestTag from '$lib/components/common/RetestTag.svelte'
  import {
    buildingFilter,
    createBuilding,
    deviceList,
    filteredBuildings,
    patchBuildingFilter,
    removeBuilding,
    resetBuildingFilter,
    selectBuilding,
    updateBuilding,
    usageOptions
  } from '$lib/stores/buildingStore.ts'
  import { pointList } from '$lib/stores/pointStore.ts'
  import { rectifyList } from '$lib/stores/rectifyStore.ts'
  import { retestPlanMap, retestStatusCounts } from '$lib/stores/retestPlanStore.ts'
  import { DB_NAME, initDatabase } from '$lib/utils/db.ts'
  import { COMMON_USAGES, PROTECTION_CLASSES } from '$lib/types/building.ts'
  import type { Building, ProtectionClass } from '$lib/types/building.ts'
  import { isQualified, qualifyRate, suggestLimitOhm } from '$lib/utils/resistance.ts'
  import { describeCycle, describeRetestStatus, isPendingRetest, isRetestOverdue } from '$lib/utils/retest.ts'
  import { readQuery, writeQuery } from '$lib/utils/query.ts'
  import { useRouter } from '$lib/utils/router.ts'

  const { push } = useRouter()

  interface BuildingForm {
    name: string
    usage: string
    protectionClass: ProtectionClass
    floors: number
    heightM: number
    address: string
  }

  let showDialog = $state(false)
  let editingId = $state<string | null>(null)
  let formError = $state('')
  let form = $state<BuildingForm>({
    name: '',
    usage: '住宅',
    protectionClass: '三类',
    floors: 1,
    heightM: 4,
    address: ''
  })

  // 首次进入时按 URL query 恢复筛选条件
  const query = readQuery()
  if (Object.keys(query).length > 0) {
    patchBuildingFilter({
      keyword: query.kw ?? '',
      usages: query.usage ? query.usage.split(',') : [],
      protectionClasses: (query.cls ? query.cls.split(',') : []) as ProtectionClass[],
      minFloors: query.minFloors ? Number(query.minFloors) : null,
      onlyDue: query.due === '1',
      onlyPendingRetest: query.pending === '1'
    })
  }

  const filterValues = $derived<Record<string, string | string[]>>({
    usages: $buildingFilter.usages as string[],
    protectionClasses: $buildingFilter.protectionClasses as string[]
  })

  /** 建筑物卡片：汇总装置数、测点数、不合格数、合格率与复测计划 */
  const cards = $derived(
    $filteredBuildings
      .map((building: Building) => {
        const devices = $deviceList.filter((device) => device.buildingId === building.id)
        const deviceIds = new Set(devices.map((device) => device.id))
        const points = $pointList.filter((point) => deviceIds.has(point.deviceId))
        const flags = points.map((point) => isQualified(point.measuredOhm, point.limitOhm))
        const pendingRectify = $rectifyList.filter(
          (rectify) => rectify.buildingId === building.id && rectify.state !== '已复检'
        ).length
        const plan = $retestPlanMap.get(building.id)
        return {
          building,
          devices,
          deviceIds,
          deviceCount: devices.length,
          pointCount: points.length,
          unqualified: flags.filter((flag) => !flag).length,
          rate: qualifyRate(flags),
          pendingRectify,
          plan: plan ?? null
        }
      })
      // 复测筛选：到期 / 待补检，口径以最近一次全覆盖检测批次为准
      .filter((card) => {
        if ($buildingFilter.onlyDue && !(card.plan && isRetestOverdue(card.plan))) return false
        if ($buildingFilter.onlyPendingRetest && !(card.plan && isPendingRetest(card.plan))) return false
        return true
      })
  )

  const totals = $derived({
    buildings: cards.length,
    devices: cards.reduce((sum, card) => sum + card.deviceCount, 0),
    points: cards.reduce((sum, card) => sum + card.pointCount, 0),
    unqualified: cards.reduce((sum, card) => sum + card.unqualified, 0),
    due: cards.filter((card) => card.plan && isRetestOverdue(card.plan)).length,
    pending: cards.filter((card) => card.plan && isPendingRetest(card.plan)).length
  })

  /** 筛选结果范围内全部测点的合格率 */
  const overallRate = $derived(
    qualifyRate(
      $pointList
        .filter((point) => cards.some((card) => card.deviceIds.has(point.deviceId)))
        .map((point) => isQualified(point.measuredOhm, point.limitOhm))
    )
  )

  /** 切换到期 / 待补检快捷筛选并同步 query */
  function toggleRetestFilter(key: 'onlyDue' | 'onlyPendingRetest'): void {
    const next = !$buildingFilter[key]
    const due = key === 'onlyDue' ? next : $buildingFilter.onlyDue
    const pending = key === 'onlyPendingRetest' ? next : $buildingFilter.onlyPendingRetest
    patchBuildingFilter({ [key]: next })
    writeQuery('/buildings', {
      kw: $buildingFilter.keyword,
      usage: $buildingFilter.usages.join(','),
      cls: $buildingFilter.protectionClasses.join(','),
      due: due ? '1' : null,
      pending: pending ? '1' : null
    })
  }

  function clearRetestFilters(): void {
    patchBuildingFilter({ onlyDue: false, onlyPendingRetest: false })
    writeQuery('/buildings', {
      kw: $buildingFilter.keyword,
      usage: $buildingFilter.usages.join(','),
      cls: $buildingFilter.protectionClasses.join(',')
    })
  }

  function openCreate(): void {
    editingId = null
    formError = ''
    form = {
      name: '',
      usage: $usageOptions[0] ?? '住宅',
      protectionClass: '三类',
      floors: 1,
      heightM: 4,
      address: ''
    }
    showDialog = true
  }

  function openEdit(building: Building): void {
    editingId = building.id
    formError = ''
    form = {
      name: building.name,
      usage: building.usage,
      protectionClass: building.protectionClass,
      floors: building.floors,
      heightM: building.heightM,
      address: building.address
    }
    showDialog = true
  }

  async function submitForm(): Promise<void> {
    if (form.name.trim().length === 0) {
      formError = '请填写建筑物名称'
      return
    }
    if (!Number.isFinite(Number(form.floors)) || Number(form.floors) < 1) {
      formError = '层数应为不小于 1 的整数'
      return
    }
    if (!Number.isFinite(Number(form.heightM)) || Number(form.heightM) <= 0) {
      formError = '建筑高度应为大于 0 的数字（m）'
      return
    }
    const payload = {
      name: form.name.trim(),
      usage: form.usage.trim() || '其他',
      protectionClass: form.protectionClass,
      floors: Number(form.floors),
      heightM: Number(form.heightM),
      address: form.address.trim()
    }
    if (editingId) {
      await updateBuilding(editingId, payload)
      showDialog = false
      return
    }
    const created = await createBuilding(payload)
    selectBuilding(created.id)
    showDialog = false
    // 新建后直接进入装置登记，符合「新建后进入装置登记」的动作要求
    push('/devices')
  }

  async function confirmRemove(building: Building): Promise<void> {
    const ok = window.confirm(
      `删除建筑物「${building.name}」将同时删除其防雷装置、测点、判定与整改建议，确认删除？`
    )
    if (!ok) return
    await removeBuilding(building.id)
  }

  async function gotoDevices(building: Building): Promise<void> {
    selectBuilding(building.id)
    push('/devices')
  }

  async function gotoPoints(building: Building): Promise<void> {
    selectBuilding(building.id)
    const firstDevice = $deviceList.find((device) => device.buildingId === building.id)
    if (firstDevice) {
      writeQuery('/points', { device: firstDevice.id })
    } else {
      push('/points')
    }
  }

  function handleFilterChange(next: FilterChange): void {
    patchBuildingFilter({
      keyword: next.keyword,
      usages: (next.values.usages as string[]) ?? [],
      protectionClasses: ((next.values.protectionClasses as string[]) ?? []) as ProtectionClass[]
    })
    writeQuery('/buildings', {
      kw: next.keyword,
      usage: ((next.values.usages as string[]) ?? []).join(','),
      cls: ((next.values.protectionClasses as string[]) ?? []).join(','),
      due: $buildingFilter.onlyDue ? '1' : null,
      pending: $buildingFilter.onlyPendingRetest ? '1' : null
    })
  }

  function handleReset(): void {
    resetBuildingFilter()
    writeQuery('/buildings', {})
  }

  async function reseed(): Promise<void> {
    await initDatabase()
  }
</script>

<section class="page">
  <div class="gb-brand-bar"></div>

  <div class="page__head">
    <div>
      <h2 class="page__title">建筑物与防雷类别台账</h2>
      <p class="gb-hint">
        维护建筑物基本信息与防雷类别，卡片回显装置数、测点数、最近全覆盖检测批次与复测到期日。新建后可直接进入装置登记。
      </p>
    </div>
    <button class="btn btn--primary" type="button" onclick={openCreate}>＋ 新建建筑物</button>
  </div>

  <FilterBar
    keyword={$buildingFilter.keyword}
    selects={[
      { key: 'usages', label: '用途', options: $usageOptions.map((usage) => ({ label: usage, value: usage })) },
      {
        key: 'protectionClasses',
        label: '防雷类别',
        options: PROTECTION_CLASSES.map((item) => ({ label: item, value: item }))
      }
    ]}
    values={filterValues}
    keywordPlaceholder="搜索建筑物名称 / 用途 / 地址"
    onChange={handleFilterChange}
    onReset={handleReset}
  >
    {#snippet actions()}
      <button class="btn btn--small" type="button" onclick={reseed}>补齐演示数据</button>
    {/snippet}
  </FilterBar>

  <div class="retest-filter">
    <span class="gb-hint">复测筛选（以最近一次覆盖全部装置且都有测点的检测批次为唯一口径）：</span>
    <label class:is-active={$buildingFilter.onlyDue}>
      <input
        type="checkbox"
        checked={$buildingFilter.onlyDue}
        onchange={() => toggleRetestFilter('onlyDue')}
      />
      已过复测周期（{$retestStatusCounts.已到期}）
    </label>
    <label class:is-active={$buildingFilter.onlyPendingRetest}>
      <input
        type="checkbox"
        checked={$buildingFilter.onlyPendingRetest}
        onchange={() => toggleRetestFilter('onlyPendingRetest')}
      />
      待补检（{$retestStatusCounts.待补检}）
    </label>
    {#if $buildingFilter.onlyDue || $buildingFilter.onlyPendingRetest}
      <button class="btn btn--small" type="button" onclick={clearRetestFilters}>清除复测筛选</button>
    {/if}
  </div>

  <div class="gb-stats-row">
    <StatBadge label="筛选后建筑物" value={totals.buildings} suffix="栋" tone="primary" />
    <StatBadge label="防雷装置" value={totals.devices} suffix="处" tone="info" />
    <StatBadge label="接地电阻测点" value={totals.points} suffix="点" tone="default" />
    <StatBadge
      label="不合格测点"
      value={totals.unqualified}
      suffix="点"
      tone={totals.unqualified > 0 ? 'danger' : 'success'}
    />
    <StatBadge
      label="已过复测周期"
      value={totals.due}
      suffix="栋"
      tone={totals.due > 0 ? 'danger' : 'success'}
    />
    <StatBadge
      label="待补检"
      value={totals.pending}
      suffix="栋"
      tone={totals.pending > 0 ? 'warning' : 'success'}
    />
    <StatBadge label="整体合格率" value={overallRate} percent={overallRate} tone="success" />
  </div>

  {#if cards.length === 0}
    <EmptyPanel
      title={$buildingFilter.keyword ||
      $buildingFilter.usages.length > 0 ||
      $buildingFilter.onlyDue ||
      $buildingFilter.onlyPendingRetest
        ? '没有符合条件的建筑物'
        : '还没有建筑物'}
      description="新建第一栋建筑物后即可登记接闪器、引下线与接地装置，并录入接地电阻测点。"
      actionText="新建建筑物"
      secondaryText="重置筛选"
      onAction={openCreate}
      onSecondary={handleReset}
    />
  {:else}
    <div class="gb-grid-cards">
      {#each cards as card (card.building.id)}
        <article
          class="gb-card"
          class:is-bad={card.unqualified > 0 || (card.plan ? isRetestOverdue(card.plan) || isPendingRetest(card.plan) : false)}
          class:is-ok={card.unqualified === 0 && card.plan?.status === '有效'}
        >
          <header class="card__head">
            <strong class="card__name">{card.building.name}</strong>
            <span class="gb-tag">{card.building.protectionClass}防雷</span>
          </header>

          <div class="card__meta">
            <span>用途：{card.building.usage}</span>
            <span>{card.building.floors} 层 / {card.building.heightM} m</span>
            {#if card.building.address}
              <span class="gb-hint">{card.building.address}</span>
            {/if}
          </div>

          <div class="gb-stats-row">
            <StatBadge label="装置" value={card.deviceCount} suffix="处" size="small" tone="info" />
            <StatBadge label="测点" value={card.pointCount} suffix="点" size="small" tone="primary" />
            <StatBadge
              label="不合格"
              value={card.unqualified}
              suffix="点"
              size="small"
              tone={card.unqualified > 0 ? 'danger' : 'success'}
            />
            <StatBadge label="合格率" value={card.rate} percent={card.rate} size="small" tone="success" />
          </div>

          {#if card.plan}
            <div
              class="card__retest"
              class:is-warn={card.plan.status === '即将到期'}
              class:is-bad={card.plan.status === '已到期' || isPendingRetest(card.plan)}
            >
              <div class="retest-line">
                <RetestTag status={card.plan.status} size="small" title={describeRetestStatus(card.plan)} />
                <span class="gb-hint">周期 {describeCycle(card.building)}</span>
              </div>
              <div class="retest-line gb-hint">
                <span>最近全覆盖批次：{card.plan.lastBatchDate ?? '—'}</span>
                <span>复测到期日：{card.plan.dueDate ?? '—'}</span>
              </div>
              {#if isPendingRetest(card.plan)}
                {#if card.plan.missingDevices.length > 0}
                  <p class="gb-alert">
                    缺检装置 {card.plan.missingDevices.length} 处：
                    {card.plan.missingDevices
                      .map((item) => `${item.deviceType}${item.spec ? `（${item.spec}）` : ''}`)
                      .join('、')}
                    ，需在同一日期补齐测点后恢复有效。
                  </p>
                {:else}
                  <p class="gb-alert">尚未登记装置或组织检测，补齐同一日期的全覆盖批次后恢复有效。</p>
                {/if}
              {:else if card.plan.status === '已到期'}
                <p class="gb-alert">{describeRetestStatus(card.plan)}，请尽快安排复测。</p>
              {/if}
            </div>
          {/if}

          {#if card.pendingRectify > 0}
            <p class="gb-alert">存在 {card.pendingRectify} 条未完成复检闭环的整改建议</p>
          {/if}

          <footer class="card__actions">
            <button class="btn btn--primary btn--small" type="button" onclick={() => gotoDevices(card.building)}>
              装置登记
            </button>
            <button class="btn btn--small" type="button" onclick={() => gotoPoints(card.building)}>测点录入</button>
            <button class="btn btn--small" type="button" onclick={() => openEdit(card.building)}>编辑</button>
            <button class="btn btn--danger btn--small" type="button" onclick={() => confirmRemove(card.building)}>
              删除
            </button>
          </footer>
        </article>
      {/each}
    </div>
  {/if}

  <p class="gb-hint">
    复测周期：一类防雷建筑 12 个月、二类 18 个月、三类 24 个月；油库与化工厂统一 12 个月。
    到期判断只认最近一次「覆盖全部装置且每个装置都有测点」的检测批次，不取单个测点的最新日期；
    新增装置或测点缺失时整栋标「待补检」，全部装置在同一日期补齐测点后恢复有效。
    数据保存在浏览器本地库 {DB_NAME}（IndexedDB），初始限值按防雷类别自动建议（一类/二类接地装置 4 Ω，其余 10 Ω），
    最终以设计文件与规范条款为准。
  </p>
</section>

{#if showDialog}
  <div class="gb-modal-backdrop" role="presentation" onclick={() => (showDialog = false)}>
    <div
      class="gb-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event: MouseEvent) => event.stopPropagation()}
      onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
    >
      <div class="gb-modal__head">
        <h3>{editingId ? '编辑建筑物' : '新建建筑物'}</h3>
        <button class="gb-modal__close" type="button" onclick={() => (showDialog = false)}>×</button>
      </div>
      <div class="gb-modal__body">
        {#if formError}
          <p class="gb-alert">{formError}</p>
        {/if}
        <div class="gb-modal__grid">
          <label class="gb-field">
            <span>建筑物名称 *</span>
            <input bind:value={form.name} placeholder="如：临港油库综合楼" maxlength="40" />
          </label>
          <label class="gb-field">
            <span>用途</span>
            <input bind:value={form.usage} list="usage-options" placeholder="如：油库" maxlength="20" />
            <datalist id="usage-options">
              {#each Array.from(new Set([...$usageOptions, ...COMMON_USAGES])) as usage (usage)}
                <option value={usage}></option>
              {/each}
            </datalist>
          </label>
          <label class="gb-field">
            <span>防雷类别 *</span>
            <select bind:value={form.protectionClass}>
              {#each PROTECTION_CLASSES as item (item)}
                <option value={item}>{item}</option>
              {/each}
            </select>
          </label>
          <label class="gb-field">
            <span>层数 *</span>
            <input type="number" min="1" max="200" bind:value={form.floors} />
          </label>
          <label class="gb-field">
            <span>建筑高度（m）*</span>
            <input type="number" min="1" max="800" step="0.1" bind:value={form.heightM} />
          </label>
          <label class="gb-field">
            <span>地址</span>
            <input bind:value={form.address} placeholder="如：临港工业园区纬三路 18 号" maxlength="80" />
          </label>
        </div>
        <p class="gb-hint">
          建议接地电阻限值：接地体 {suggestLimitOhm(form.protectionClass, '接地体')} Ω，引下线/接闪器
          {suggestLimitOhm(form.protectionClass, '引下线')} Ω。
        </p>
      </div>
      <div class="gb-modal__foot">
        <button class="btn" type="button" onclick={() => (showDialog = false)}>取消</button>
        <button class="btn btn--primary" type="button" onclick={submitForm}>
          {editingId ? '保存修改' : '新建并登记装置'}
        </button>
      </div>
    </div>
  </div>
{/if}

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

  .card__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .card__name {
    font-size: 16px;
    color: #16232e;
  }

  .card__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 13px;
    color: #5b6b78;
  }

  .card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .retest-filter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    background: #ffffff;
    border: 1px dashed #cfd8e3;
    border-radius: 10px;
    font-size: 13px;
  }

  .retest-filter label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid #cfd8e3;
    cursor: pointer;
    color: #445566;
  }

  .retest-filter label.is-active {
    border-color: #1d3557;
    background: #eef2f8;
    color: #1d3557;
    font-weight: 600;
  }

  .card__retest {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid #dfe4ea;
    background: #f7fafc;
  }

  .card__retest.is-warn {
    border-color: #f0c78a;
    background: #fff8ec;
  }

  .card__retest.is-bad {
    border-color: #f0b4ac;
    background: #fff6f4;
  }

  .retest-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
</style>
