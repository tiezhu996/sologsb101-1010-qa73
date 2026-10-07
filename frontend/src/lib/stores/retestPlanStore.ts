/**
 * 复测计划派生 store（跨 buildingStore / pointStore 的叶子模块）。
 *
 * 与 pointStats.ts 同理：依赖 buildingList / deviceList / pointList 的派生值
 * 统一下沉到独立模块，避免在 buildingStore 中反向 import pointStore 形成
 * ES 模块循环依赖。
 *
 * 到期判断的唯一依据见 utils/retest.ts：最近一次「覆盖全部装置且每个装置
 * 都有测点」的检测批次，绝不取单个测点的最新检测日期。
 */
import { derived } from 'svelte/store'
import { deviceList, buildingList } from '$lib/stores/buildingStore'
import { pointList } from '$lib/stores/pointStore'
import {
  buildRetestPlans,
  isPendingRetest,
  isRetestOverdue,
  type RetestPlan
} from '$lib/utils/retest'

/** 建筑物 id → 复测计划 */
export const retestPlanMap = derived([buildingList, deviceList, pointList], ([$buildings, $devices, $points]) =>
  buildRetestPlans($buildings, $devices, $points)
)

/** 全部建筑物的复测计划（与 buildingList 同序） */
export const retestPlanList = derived(retestPlanMap, ($map) => Array.from($map.values()))

/** 已过复测周期的建筑物 id 集合 */
export const overdueBuildingIds = derived(retestPlanMap, ($map) =>
  new Set(Array.from($map.values()).filter(isRetestOverdue).map((plan) => plan.buildingId))
)

/** 待补检（新增装置 / 测点缺失 / 检测日期未成批次）的建筑物 id 集合 */
export const pendingRetestBuildingIds = derived(retestPlanMap, ($map) =>
  new Set(Array.from($map.values()).filter(isPendingRetest).map((plan) => plan.buildingId))
)

/** 复测状态汇总计数 */
export const retestStatusCounts = derived(retestPlanList, ($plans) => {
  const counts = { 有效: 0, 即将到期: 0, 已到期: 0, 待补检: 0 }
  $plans.forEach((plan: RetestPlan) => {
    if (plan.status === '未检测') counts.待补检 += 1
    else counts[plan.status as '有效' | '即将到期' | '已到期' | '待补检'] += 1
  })
  return counts
})
