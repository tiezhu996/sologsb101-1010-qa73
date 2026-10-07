/**
 * 复测计划：防雷建筑物接地电阻检测的周期、状态与筛选口径。
 *
 * 周期口径：
 * - 一类防雷建筑 12 个月、二类 18 个月、三类 24 个月；
 * - 油库、化工厂等爆炸火灾危险场所统一按 12 个月（用途命中关键字即收严，不取类别周期）。
 *
 * 到期口径（唯一依据）：最近一次「覆盖该建筑物全部装置、且每个装置都有测点」的
 * 检测批次（以测点 measureDate 归批）。单个测点的最新读数不延长有效期，
 * 避免漏检装置被个别新读数遮住。
 */

/** 复测状态：有效（批次在周期内）/ 已到期（超过复测周期）/ 待补检（无全覆盖批次） */
export type RetestStatus = '有效' | '已到期' | '待补检'

export const RETEST_STATUSES: RetestStatus[] = ['有效', '已到期', '待补检']

/** 用途中命中任一关键字即强制按 12 个月周期（油库、化工厂等危险场所） */
export const FORCED_12M_USAGE_KEYWORDS = ['油库', '化工']

/** 按防雷类别给出基础复测周期（月） */
export const CLASS_INTERVAL_MONTHS: Record<string, number> = {
  一类: 12,
  二类: 18,
  三类: 24
}

/**
 * 计算复测周期（月）：油库 / 化工厂统一 12 个月，其余按防雷类别取
 * 一类 12、二类 18、三类 24。
 */
export function retestIntervalMonths(building: { usage: string; protectionClass: string }): number {
  const usage = building.usage ?? ''
  if (FORCED_12M_USAGE_KEYWORDS.some((keyword) => usage.includes(keyword))) return 12
  return CLASS_INTERVAL_MONTHS[building.protectionClass] ?? 24
}
