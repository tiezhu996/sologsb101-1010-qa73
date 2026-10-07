/**
 * 复测计划：按防雷类别（油库 / 化工厂统一 12 个月）计算复测周期、最近一次
 * 「覆盖全部装置且每个装置都有测点」的检测批次日期与到期状态。
 *
 * 唯一口径（禁止取单个测点的最新日期）：
 *   1. 建筑物没有装置、或任一装置没有测点 → 待补检（missingDevices 非空）；
 *   2. 对每个装置取该装置全部测点的检测日期集合，逐日期取交集，得到所有装置
 *      同一天都有测点的日期集合；其中最晚的日期即最近一次全覆盖检测批次；
 *   3. 不存在这样的日期 → 待补检（即便每台装置都有测点，但检测日期对不上，
 *      说明没有任何一个批次覆盖过全部装置）；
 *   4. 到期日 = 批次日期 + 周期月数；今天 > 到期日即已到期。
 * 这样漏检装置不会被个别新读数遮住：某装置后来补了新测点但没有同批次覆盖
 * 全部装置时，最近全覆盖批次仍停留在上一次。
 */
import type { Building, ProtectionClass } from '$lib/types/building'
import type { Device } from '$lib/types/device'
import type { Point } from '$lib/types/point'

/** 各防雷类别的复测周期（月） */
export const RETEST_CYCLE_MONTHS: Record<ProtectionClass, number> = {
  一类: 12,
  二类: 18,
  三类: 24
}

/** 无论防雷类别，统一按 12 个月周期的用途 */
export const FORCE_12M_USAGES: ReadonlySet<string> = new Set(['油库', '化工厂'])

/** 建筑物复测状态 */
export type RetestStatus = '有效' | '即将到期' | '已到期' | '待补检' | '未检测'

/** 即将到期的提前提醒天数 */
export const RETEST_DUE_SOON_DAYS = 30

/** 一台缺检 / 未纳入最近批次的装置 */
export interface RetestMissingDevice {
  deviceId: string
  deviceType: string
  spec: string
  /** 缺检原因：no-point 装置下没有测点；not-in-batch 有测点但最近全覆盖批次未覆盖到 */
  reason: 'no-point' | 'not-in-batch'
}

export interface RetestPlan {
  buildingId: string
  /** 复测周期（月） */
  cycleMonths: number
  status: RetestStatus
  /** 最近一次覆盖全部装置且都有测点的检测批次日期（YYYY-MM-DD），没有则为 null */
  lastBatchDate: string | null
  /** 复测到期日（YYYY-MM-DD），没有有效批次则为 null */
  dueDate: string | null
  /** 距到期天数：负数表示已过期天数；待补检 / 未检测为 null */
  daysToDue: number | null
  /** 缺检装置（含全新装置与批次未覆盖装置） */
  missingDevices: RetestMissingDevice[]
  /** 参与全覆盖批次判定的装置总数 */
  deviceCount: number
}

/** 日期加整月数（按日历月，月末溢出时落到该月最后一天） */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime())
  const day = result.getDate()
  result.setDate(1)
  result.setMonth(result.getMonth() + months)
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
  result.setDate(Math.min(day, lastDay))
  return result
}

/** YYYY-MM-DD 加整月，返回 YYYY-MM-DD */
export function addMonthsToDateString(dateText: string, months: number): string {
  const [year, month, day] = dateText.split('-').map(Number)
  const shifted = addMonths(new Date(year, (month ?? 1) - 1, day ?? 1), months)
  return shifted.toISOString().slice(0, 10)
}

/** 两个 YYYY-MM-DD 相差的天数（a - b，按本地日历天） */
export function diffDays(aText: string, bText: string): number {
  const [ay, am, ad] = aText.split('-').map(Number)
  const [by, bm, bd] = bText.split('-').map(Number)
  const a = Date.UTC(ay, (am ?? 1) - 1, ad ?? 1)
  const b = Date.UTC(by, (bm ?? 1) - 1, bd ?? 1)
  return Math.round((a - b) / 86400000)
}

/** 取建筑物的复测周期月数：油库 / 化工厂一律 12 个月，其余按防雷类别 */
export function retestCycleMonths(building: Pick<Building, 'protectionClass' | 'usage'>): number {
  if (FORCE_12M_USAGES.has(building.usage)) return 12
  return RETEST_CYCLE_MONTHS[building.protectionClass]
}

/** 周期的中文说明 */
export function describeCycle(building: Pick<Building, 'protectionClass' | 'usage'>): string {
  return FORCE_12M_USAGES.has(building.usage)
    ? '12 个月（油库 / 化工厂统一周期）'
    : `${retestCycleMonths(building)} 个月（${building.protectionClass}防雷建筑）`
}

/**
 * 计算单栋建筑物的复测计划。
 * @param todayText 今天（YYYY-MM-DD），默认本地今天，参数化便于测试
 */
export function buildRetestPlan(
  building: Building,
  devices: Device[],
  points: Point[],
  todayText: string = new Date().toISOString().slice(0, 10)
): RetestPlan {
  const cycleMonths = retestCycleMonths(building)
  const buildingDevices = devices.filter((device) => device.buildingId === building.id)
  const deviceCount = buildingDevices.length

  if (deviceCount === 0) {
    return {
      buildingId: building.id,
      cycleMonths,
      status: '待补检',
      lastBatchDate: null,
      dueDate: null,
      daysToDue: null,
      missingDevices: [],
      deviceCount: 0
    }
  }

  // 每个装置：测点的检测日期集合
  const dateSets: Array<{ device: Device; dates: Set<string> }> = buildingDevices.map((device) => {
    const own = points.filter((point) => point.deviceId === device.id)
    return { device, dates: new Set(own.map((point) => point.measureDate).filter(Boolean)) }
  })

  const noPointDevices = dateSets
    .filter((entry) => entry.dates.size === 0)
    .map((entry) => ({
      deviceId: entry.device.id,
      deviceType: entry.device.type,
      spec: entry.device.spec,
      reason: 'no-point' as const
    }))

  // 所有装置同一天都有测点的日期 = 各装置日期集合的交集
  const [first, ...rest] = dateSets
  const coveredDates = new Set<string>(first ? first.dates : [])
  rest.forEach((entry) => {
    for (const date of coveredDates) {
      if (!entry.dates.has(date)) coveredDates.delete(date)
    }
  })

  if (noPointDevices.length > 0 || coveredDates.size === 0) {
    // 有测点但从未与其他装置同日检测的装置，也算缺检，需在同一日期补齐
    const notInBatch: RetestMissingDevice[] =
      noPointDevices.length === 0
        ? dateSets
            .filter((entry) => entry.dates.size > 0)
            .map((entry) => ({
              deviceId: entry.device.id,
              deviceType: entry.device.type,
              spec: entry.device.spec,
              reason: 'not-in-batch' as const
            }))
        : []
    return {
      buildingId: building.id,
      cycleMonths,
      status: noPointDevices.length > 0 && dateSets.every((entry) => entry.dates.size === 0) ? '未检测' : '待补检',
      lastBatchDate: null,
      dueDate: null,
      daysToDue: null,
      missingDevices: [...noPointDevices, ...notInBatch],
      deviceCount
    }
  }

  const lastBatchDate = Array.from(coveredDates).sort().at(-1) ?? null
  if (lastBatchDate === null) {
    return {
      buildingId: building.id,
      cycleMonths,
      status: '未检测',
      lastBatchDate: null,
      dueDate: null,
      daysToDue: null,
      missingDevices: [],
      deviceCount
    }
  }

  const dueDate = addMonthsToDateString(lastBatchDate, cycleMonths)
  const daysToDue = diffDays(dueDate, todayText)
  const status: RetestStatus =
    daysToDue < 0 ? '已到期' : daysToDue <= RETEST_DUE_SOON_DAYS ? '即将到期' : '有效'
  return {
    buildingId: building.id,
    cycleMonths,
    status,
    lastBatchDate,
    dueDate,
    daysToDue,
    missingDevices: [],
    deviceCount
  }
}

/** 批量计算全部建筑物复测计划（buildingId → plan） */
export function buildRetestPlans(
  buildings: Building[],
  devices: Device[],
  points: Point[],
  todayText: string = new Date().toISOString().slice(0, 10)
): Map<string, RetestPlan> {
  return new Map(
    buildings.map((building) => [building.id, buildRetestPlan(building, devices, points, todayText)])
  )
}

/** 是否需要补检：待补检（含未检测） */
export function isPendingRetest(plan: RetestPlan): boolean {
  return plan.status === '待补检' || plan.status === '未检测'
}

/** 是否已过复测周期 */
export function isRetestOverdue(plan: RetestPlan): boolean {
  return plan.status === '已到期'
}

/** 状态的中文展示与说明 */
export function describeRetestStatus(plan: RetestPlan): string {
  switch (plan.status) {
    case '有效':
      return `有效期至 ${plan.dueDate ?? '—'}`
    case '即将到期':
      return `${plan.dueDate ?? '—'} 到期（剩 ${plan.daysToDue ?? 0} 天）`
    case '已到期':
      return `${plan.dueDate ?? '—'} 已到期（超期 ${Math.abs(plan.daysToDue ?? 0)} 天）`
    case '待补检':
      return '待补检：存在装置无测点或检测日期未成批次'
    case '未检测':
      return '待补检：尚未组织过检测'
  }
}
