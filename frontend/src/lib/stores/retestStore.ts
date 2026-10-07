/**
 * 复测计划 store：建筑物维度的复测批次、到期日与待补检状态的响应式派生。
 *
 * 与 pointStats.ts 同为叶子模块：仅依赖 buildingStore / pointStore 与纯函数
 * utils/retest，不被任一基础 store 反向引用，避免 ES 模块循环依赖白屏。
 * 到期口径见 utils/retest.ts：只认覆盖全部装置的检测批次，不看单个测点最新日期。
 */
import { derived } from 'svelte/store'
import { buildingList, deviceList } from '$lib/stores/buildingStore'
import { pointList } from '$lib/stores/pointStore'
import { buildRetestPlans, type RetestPlan } from '$lib/utils/retest'

/** buildingId → 复测计划（与 store 数据实时同步） */
export const retestPlans = derived([buildingList, deviceList, pointList], ([$buildings, $devices, $points]) =>
  buildRetestPlans($buildings, $devices, $points)
)

/** 台账顶部统计：有效 / 已到期 / 待补检各多少栋 */
export const retestCounts = derived(retestPlans, ($plans) => {
  const counts = { 有效: 0, 已到期: 0, 待补检: 0 }
  $plans.forEach((plan) => {
    counts[plan.status] += 1
  })
  return counts
})
