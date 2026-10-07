/**
 * 复测计划工具：纯函数，不依赖任何 store / Dexie，页面、store 与结论导出共用同一套口径。
 *
 * 「检测批次」按测点检测日期（measureDate）归批：某日期上该建筑物的每个装置
 * 都至少有一个测点，即构成一次全覆盖检测批次。有效期只能由全覆盖批次延续，
 * 不使用单个测点的最新日期——否则漏检装置会被个别新读数遮住。
 *
 * 设备新增或测点缺失（含某装置在任何日期都没有测点）时不存在全覆盖批次，
 * 整栋标「待补检」；只有在同一日期把全部装置补齐测点后才恢复为有效/到期判定。
 */
import type { Building } from '$lib/types/building'
import type { Device } from '$lib/types/device'
import type { Point } from '$lib/types/point'
import { retestIntervalMonths, type RetestStatus } from '$lib/types/retest'

/** 某建筑物的复测计划与有效状态 */
export interface RetestPlan {
  buildingId: string
  status: RetestStatus
  /** 复测周期（月） */
  intervalMonths: number
  /** 最近一次全覆盖检测批次日期；无全覆盖批次时为 null */
  lastBatchDate: string | null
  /** 到期日（批次日期 + 周期）；待补检时为 null */
  dueDate: string | null
  /** 距离到期天数（负数表示已超期天数）；待补检时为 null */
  daysToDue: number | null
  /** 缺检装置（无任何测点，或最近检测日期上没测到的装置） */
  missingDevices: MissingDevice[]
  /** 最近一次检测日期（可能只覆盖部分装置，用于提示补检日期） */
  latestMeasureDate: string | null
}

/** 缺检装置信息 */
export interface MissingDevice {
  deviceId: string
  type: string
  spec: string
  /** 无任何测点 true；有过测点但最近检测日期上没测到 false */
  noPointAtAll: boolean
}

/** 今天（本地日期 YYYY-MM-DD） */
export function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 日期加整月（UTC 计算，YYYY-MM-DD 入参出参）。
 * 月末溢出时收敛到目标月最后一天，如 2024-01-31 + 1 月 → 2024-02-29。
 */
export function addMonths(isoDate: string, months: number): string {
  const [yearText, monthText, dayText] = isoDate.split('-')
  const year = Number(yearText)
  const month0 = Number(monthText) - 1
  const day = Number(dayText)
  if (!year || !monthText || !day) return isoDate
  const target = new Date(Date.UTC(year, month0 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}

/** 两个 YYYY-MM-DD 日期相差的整天数（to - from），字符串字典序可直接比较 */
export function diffDays(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime()
  const to = new Date(`${toIso}T00:00:00Z`).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.round((to - from) / 86400000)
}

/**
 * 计算单栋建筑物的复测计划。
 * @param building 建筑物
 * @param devices  该建筑物的全部装置（新增装置也在内）
 * @param points   上述装置名下的全部测点
 * @param today    判定基准日（默认今天，便于测试注入）
 */
export function buildRetestPlan(
  building: Building,
  devices: Device[],
  points: Point[],
  today: string = todayString()
): RetestPlan {
  const intervalMonths = retestIntervalMonths(building)
  const dated = points.filter((point) => typeof point.measureDate === 'string' && point.measureDate.length > 0)
  const latestMeasureDate =
    dated.length === 0 ? null : dated.map((point) => point.measureDate).sort().at(-1) ?? null

  // 无装置或无测点：不可能构成全覆盖批次 → 待补检
  const basePlan: RetestPlan = {
    buildingId: building.id,
    status: '待补检',
    intervalMonths,
    lastBatchDate: null,
    dueDate: null,
    daysToDue: null,
    missingDevices: devices.map((device) => ({
      deviceId: device.id,
      type: device.type,
      spec: device.spec,
      noPointAtAll: points.every((point) => point.deviceId !== device.id)
    })),
    latestMeasureDate
  }

  if (devices.length === 0 || dated.length === 0) return basePlan

  // 每个装置在哪些日期有测点
  const datesByDevice = new Map<string, Set<string>>()
  const devicesWithAnyPoint = new Set<string>()
  for (const point of dated) {
    const set = datesByDevice.get(point.deviceId) ?? new Set<string>()
    set.add(point.measureDate)
    datesByDevice.set(point.deviceId, set)
    devicesWithAnyPoint.add(point.deviceId)
  }

  // 全覆盖批次日期 = 每个装置都至少有一个测点的日期
  const fullBatchDates = Array.from(new Set(dated.map((point) => point.measureDate)))
    .filter((date) => devices.every((device) => datesByDevice.get(device.id)?.has(date)))
    .sort()
  const lastBatchDate = fullBatchDates.at(-1) ?? null

  if (!lastBatchDate) {
    // 设备新增 / 测点缺失：没有任何日期覆盖全部装置，整栋待补检。
    // 缺检装置 = 没有任何测点的装置；若都有测点但日期没凑齐，
    // 则以最近检测日期为参照，列出该日期上没测到的装置。
    const referenceDate = latestMeasureDate
    const missingDevices: MissingDevice[] = devices
      .filter((device) => {
        if (!devicesWithAnyPoint.has(device.id)) return true
        if (referenceDate && !datesByDevice.get(device.id)?.has(referenceDate)) return true
        return false
      })
      .map((device) => ({
        deviceId: device.id,
        type: device.type,
        spec: device.spec,
        noPointAtAll: !devicesWithAnyPoint.has(device.id)
      }))
    return { ...basePlan, missingDevices }
  }

  const dueDate = addMonths(lastBatchDate, intervalMonths)
  const daysToDue = diffDays(today, dueDate)
  const status: RetestStatus = dueDate < today ? '已到期' : '有效'

  // 全覆盖批次之后又做过部分检测时，列出最近检测日期上漏掉的装置；
  // 它们不会改变批次有效期，但必须在下次同日期补检时一并覆盖。
  const missingDevices: MissingDevice[] =
    latestMeasureDate && latestMeasureDate > lastBatchDate
      ? devices
          .filter((device) => !datesByDevice.get(device.id)?.has(latestMeasureDate))
          .map((device) => ({ deviceId: device.id, type: device.type, spec: device.spec, noPointAtAll: false }))
      : []

  return {
    buildingId: building.id,
    status,
    intervalMonths,
    lastBatchDate,
    dueDate,
    daysToDue,
    missingDevices,
    latestMeasureDate
  }
}

/** 批量计算多栋建筑物的复测计划（buildingId → plan） */
export function buildRetestPlans(
  buildings: Building[],
  devices: Device[],
  points: Point[],
  today: string = todayString()
): Map<string, RetestPlan> {
  const result = new Map<string, RetestPlan>()
  for (const building of buildings) {
    const ownDevices = devices.filter((device) => device.buildingId === building.id)
    const deviceIds = new Set(ownDevices.map((device) => device.id))
    const ownPoints = points.filter((point) => deviceIds.has(point.deviceId))
    result.set(building.id, buildRetestPlan(building, ownDevices, ownPoints, today))
  }
  return result
}

/** 缺检装置的可读名称（如「接地体 500×400×60」） */
export function formatMissingDevice(device: MissingDevice): string {
  const label = device.spec ? `${device.type} ${device.spec}` : device.type
  return device.noPointAtAll ? `${label}（无测点）` : label
}
