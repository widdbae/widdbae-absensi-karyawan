/**
 * Dynamic Shift Schedule, Lateness, Deduction & Overtime Rules Engine
 * -------------------------------------------------------------------
 * All rules are persisted in Firestore at `settings/attendance_rules`
 * and evaluated deterministically on attendance events and monthly recaps.
 */

import { db } from "./firebase-config.js";
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toDateObject } from "./auth.js";

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

/**
 * Default Enterprise Attendance Rules matching specification:
 * - Mon–Thu & Sat: 07:00 – 15:00
 * - Fri: 07:00 – 15:30
 * - Sun: Off-day
 */
export const DEFAULT_ATTENDANCE_RULES = {
  officeLat: -6.200000,
  officeLng: 106.816666,
  maxRadiusMeters: 50,
  maxGpsAccuracyMeters: 150,
  schedules: {
    "0": { isOff: true, start: "07:00", end: "15:00" },  // Sunday
    "1": { isOff: false, start: "07:00", end: "15:00" }, // Monday
    "2": { isOff: false, start: "07:00", end: "15:00" }, // Tuesday
    "3": { isOff: false, start: "07:00", end: "15:00" }, // Wednesday
    "4": { isOff: false, start: "07:00", end: "15:00" }, // Thursday
    "5": { isOff: false, start: "07:00", end: "15:30" }, // Friday
    "6": { isOff: false, start: "07:00", end: "15:00" }  // Saturday
  },
  gracePeriodMinutes: 5,
  deductionEnabled: true,
  deductionType: "per_minute", // "per_minute" | "tiered" | "percentage"
  deductionValue: 2000,        // IDR per minute (or % of dailyRate when deductionType === "percentage")
  deductionTiers: [
    { minMinutes: 1, maxMinutes: 15, amount: 25000 },
    { minMinutes: 16, maxMinutes: 30, amount: 50000 },
    { minMinutes: 31, maxMinutes: null, amount: 100000 }
  ],
  overtimeMode: "auto",        // "auto" | "approval_required"
  overtimeMinThresholdMinutes: 30,
  overtimeRateMultiplier: 1.5,
  defaultHourlyOvertimeRate: 35000
};

/**
 * Deep-merges partial Firestore rules with defaults so missing keys never break evaluation.
 * @param {object} [raw]
 * @returns {object}
 */
export function mergeWithDefaultRules(raw = {}) {
  const mergedSchedules = {};
  for (let d = 0; d <= 6; d++) {
    const key = String(d);
    mergedSchedules[key] = {
      ...DEFAULT_ATTENDANCE_RULES.schedules[key],
      ...(raw?.schedules?.[key] || {})
    };
  }

  return {
    ...DEFAULT_ATTENDANCE_RULES,
    ...raw,
    schedules: mergedSchedules,
    deductionTiers: Array.isArray(raw?.deductionTiers) && raw.deductionTiers.length
      ? raw.deductionTiers
      : DEFAULT_ATTENDANCE_RULES.deductionTiers
  };
}

/**
 * Fetches `settings/attendance_rules`, creating defaults if missing (when permitted).
 * @returns {Promise<object>}
 */
export async function getAttendanceRules() {
  const ref = doc(db, "settings", "attendance_rules");
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    return mergeWithDefaultRules({});
  }
  return mergeWithDefaultRules(snap.data());
}

/**
 * Subscribes to live changes on `settings/attendance_rules`.
 * @param {function(object): void} callback
 * @returns {function(): void} unsubscribe function
 */
export function subscribeAttendanceRules(callback) {
  const ref = doc(db, "settings", "attendance_rules");
  return onSnapshot(
    ref,
    (snap) => {
      callback(mergeWithDefaultRules(snap.exists() ? snap.data() : {}));
    },
    (err) => {
      console.warn("[Rules] Failed to listen to attendance_rules:", err);
      callback(mergeWithDefaultRules({}));
    }
  );
}

/**
 * Persists updated HRD attendance rules to Firestore (`settings/attendance_rules`).
 * @param {object} rules
 * @param {string} updatedByUid
 */
export async function saveAttendanceRules(rules, updatedByUid) {
  const ref = doc(db, "settings", "attendance_rules");
  const clean = mergeWithDefaultRules(rules);
  await setDoc(
    ref,
    {
      ...clean,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedByUid || "admin"
    },
    { merge: true }
  );
  return clean;
}

/**
 * Parses a `"HH:mm"` string into a Date on the same calendar day as `baseDate`.
 * @param {Date} baseDate
 * @param {string} hhmm
 * @returns {Date}
 */
export function combineDateAndTime(baseDate, hhmm) {
  const [hh, mm] = String(hhmm || "07:00").split(":").map((n) => parseInt(n, 10));
  const result = new Date(baseDate);
  result.setHours(Number.isFinite(hh) ? hh : 7, Number.isFinite(mm) ? mm : 0, 0, 0);
  return result;
}

/**
 * Resolves the shift schedule for a given Date.
 * @param {Date} date
 * @param {object} rules
 * @returns {{ dayIndex: number, dayName: string, isOff: boolean, start: string, end: string }}
 */
export function getShiftForDate(date, rules) {
  const effectiveRules = mergeWithDefaultRules(rules);
  const dayIndex = date.getDay();
  const slot = effectiveRules.schedules[String(dayIndex)] || { isOff: false, start: "07:00", end: "15:00" };
  return {
    dayIndex,
    dayName: DAY_NAMES[dayIndex],
    isOff: Boolean(slot.isOff),
    start: slot.start || "07:00",
    end: slot.end || "15:00"
  };
}

/**
 * Evaluates clock-in lateness and calculates deduction amount according to HRD rules.
 *
 * @param {Date} clockInDate
 * @param {object} rules
 * @param {object} employeeProfile
 * @returns {{
 *   status: 'on_time'|'late',
 *   lateMinutes: number,
 *   rawLateMinutes: number,
 *   deductionAmount: number,
 *   shift: object
 * }}
 */
export function evaluateClockIn(clockInDate, rules, employeeProfile = {}) {
  const effectiveRules = mergeWithDefaultRules(rules);
  const shift = getShiftForDate(clockInDate, effectiveRules);

  if (shift.isOff) {
    return {
      status: "on_time",
      lateMinutes: 0,
      rawLateMinutes: 0,
      deductionAmount: 0,
      shift
    };
  }

  const shiftStart = combineDateAndTime(clockInDate, shift.start);
  const graceMinutes = Math.max(0, Number(effectiveRules.gracePeriodMinutes || 0));
  const graceCutoff = new Date(shiftStart.getTime() + graceMinutes * 60000);

  const rawLateMinutes = Math.max(0, Math.floor((clockInDate.getTime() - shiftStart.getTime()) / 60000));

  if (clockInDate.getTime() <= graceCutoff.getTime()) {
    return {
      status: "on_time",
      lateMinutes: 0,
      rawLateMinutes,
      deductionAmount: 0,
      shift
    };
  }

  // Minutes late beyond grace period
  const chargeableLateMinutes = Math.max(1, Math.ceil((clockInDate.getTime() - graceCutoff.getTime()) / 60000));
  const deductionAmount = computeDeductionAmount(chargeableLateMinutes, effectiveRules, employeeProfile);

  return {
    status: "late",
    lateMinutes: chargeableLateMinutes,
    rawLateMinutes,
    deductionAmount,
    shift
  };
}

/**
 * Computes monetary deduction based on HRD-configured deduction mode.
 * @param {number} lateMinutes
 * @param {object} rules
 * @param {object} employeeProfile
 * @returns {number}
 */
export function computeDeductionAmount(lateMinutes, rules, employeeProfile = {}) {
  if (!rules?.deductionEnabled || lateMinutes <= 0) return 0;

  const mode = rules.deductionType || "per_minute";
  const value = Number(rules.deductionValue || 0);
  const dailyRate = Number(employeeProfile.dailyRate || 0);

  if (mode === "per_minute") {
    return Math.round(lateMinutes * Math.max(0, value));
  }

  if (mode === "percentage") {
    const pct = Math.max(0, Math.min(100, value));
    return Math.round((dailyRate * pct) / 100);
  }

  if (mode === "tiered") {
    const tiers = Array.isArray(rules.deductionTiers) ? rules.deductionTiers : [];
    for (const tier of tiers) {
      const min = Number(tier.minMinutes ?? 0);
      const max = tier.maxMinutes === null || tier.maxMinutes === "" || tier.maxMinutes === undefined
        ? Infinity
        : Number(tier.maxMinutes);
      if (lateMinutes >= min && lateMinutes <= max) {
        return Math.round(Number(tier.amount || 0));
      }
    }
    // Fallback to highest tier if minutes exceed all configured bounds
    if (tiers.length > 0) {
      return Math.round(Number(tiers[tiers.length - 1].amount || 0));
    }
  }

  return 0;
}

/**
 * Resolves effective hourly overtime rate for an employee.
 * Uses employee's `hourlyOvertimeRate` if > 0; otherwise falls back to
 * `(dailyRate / 8) * overtimeRateMultiplier` or `defaultHourlyOvertimeRate`.
 * @param {object} employeeProfile
 * @param {object} rules
 * @returns {number}
 */
export function getEffectiveOvertimeHourlyRate(employeeProfile = {}, rules = {}) {
  const empRate = Number(employeeProfile.hourlyOvertimeRate || 0);
  if (empRate > 0) return empRate;

  const dailyRate = Number(employeeProfile.dailyRate || 0);
  const multiplier = Number(rules.overtimeRateMultiplier || 1.5);
  if (dailyRate > 0) {
    return Math.round((dailyRate / 8) * multiplier);
  }

  return Number(rules.defaultHourlyOvertimeRate || 0);
}

/**
 * Evaluates clock-out overtime minutes, status, and pay according to HRD rules.
 *
 * @param {Date} clockOutDate
 * @param {object} rules
 * @param {object} employeeProfile
 * @param {boolean} [hasApprovedOvertimeRequest]
 * @returns {{
 *   overtimeMinutes: number,
 *   overtimePay: number,
 *   overtimeStatus: 'none'|'auto_approved'|'pending_approval'|'approved'
 * }}
 */
export function evaluateClockOut(clockOutDate, rules, employeeProfile = {}, hasApprovedOvertimeRequest = false) {
  const effectiveRules = mergeWithDefaultRules(rules);
  const shift = getShiftForDate(clockOutDate, effectiveRules);

  const shiftEnd = shift.isOff
    ? combineDateAndTime(clockOutDate, "07:00")
    : combineDateAndTime(clockOutDate, shift.end);

  const extraMinutes = Math.floor((clockOutDate.getTime() - shiftEnd.getTime()) / 60000);
  const threshold = Math.max(0, Number(effectiveRules.overtimeMinThresholdMinutes || 30));

  if (extraMinutes < threshold) {
    return {
      overtimeMinutes: 0,
      overtimePay: 0,
      overtimeStatus: "none"
    };
  }

  const hourlyRate = getEffectiveOvertimeHourlyRate(employeeProfile, effectiveRules);
  const computedPay = Math.round((extraMinutes / 60) * hourlyRate);

  if (effectiveRules.overtimeMode === "auto") {
    return {
      overtimeMinutes: extraMinutes,
      overtimePay: computedPay,
      overtimeStatus: "auto_approved"
    };
  }

  // Approval-required mode
  if (hasApprovedOvertimeRequest) {
    return {
      overtimeMinutes: extraMinutes,
      overtimePay: computedPay,
      overtimeStatus: "approved"
    };
  }

  return {
    overtimeMinutes: extraMinutes,
    overtimePay: 0,
    overtimeStatus: "pending_approval"
  };
}

/**
 * Generates an automated Monthly Attendance & Payroll Recap grouped by employee.
 *
 * @param {Array<object>} attendanceRecords - Filtered attendance docs
 * @param {Array<object>} users - Employee user profiles
 * @param {Array<object>} [requests] - Leave/Overtime requests for the period
 * @returns {{
 *   rows: Array<object>,
 *   totals: {
 *     totalPresent: number,
 *     totalLateCount: number,
 *     totalLateMinutes: number,
 *     totalApprovedOvertimeMinutes: number,
 *     totalApprovedOvertimeHours: number,
 *     totalLeaveDays: number,
 *     totalDeductionAmount: number,
 *     totalOvertimePay: number
 *   }
 * }}
 */
export function computeMonthlyRecap(attendanceRecords = [], users = [], requests = []) {
  const map = new Map();

  users.forEach((u) => {
    map.set(u.uid, {
      uid: u.uid,
      employeeId: u.employeeId || "-",
      name: u.name || "Unknown",
      department: u.department || "General",
      position: u.position || "-",
      totalPresent: 0,
      totalLateCount: 0,
      totalLateMinutes: 0,
      totalApprovedOvertimeMinutes: 0,
      totalApprovedOvertimeHours: 0,
      totalLeaveDays: 0,
      totalDeductionAmount: 0,
      totalOvertimePay: 0
    });
  });

  attendanceRecords.forEach((rec) => {
    if (!map.has(rec.uid)) {
      map.set(rec.uid, {
        uid: rec.uid,
        employeeId: "-",
        name: rec.employeeName || "Unknown",
        department: rec.department || "General",
        position: "-",
        totalPresent: 0,
        totalLateCount: 0,
        totalLateMinutes: 0,
        totalApprovedOvertimeMinutes: 0,
        totalApprovedOvertimeHours: 0,
        totalLeaveDays: 0,
        totalDeductionAmount: 0,
        totalOvertimePay: 0
      });
    }

    const row = map.get(rec.uid);
    if (rec.status === "on_time" || rec.status === "late") {
      row.totalPresent += 1;
    }
    if (rec.status === "late") {
      row.totalLateCount += 1;
      row.totalLateMinutes += Number(rec.lateMinutes || 0);
    }
    if (rec.status === "leave") {
      row.totalLeaveDays += 1;
    }

    row.totalDeductionAmount += Number(rec.deductionAmount || 0);

    if (rec.overtimeStatus === "approved" || rec.overtimeStatus === "auto_approved") {
      row.totalApprovedOvertimeMinutes += Number(rec.overtimeMinutes || 0);
      row.totalOvertimePay += Number(rec.overtimePay || 0);
    }
  });

  // Also include approved leave/sick/permission days if not already counted via attendance docs
  const leaveDatesSeen = new Set(
    attendanceRecords.filter((r) => r.status === "leave").map((r) => `${r.uid}_${r.date}`)
  );

  requests.forEach((req) => {
    if (req.status !== "approved") return;
    if (!["izin", "sakit", "cuti"].includes(req.type)) return;
    const row = map.get(req.uid);
    if (!row) return;

    const start = toDateObject(req.startDate);
    const end = toDateObject(req.endDate || req.startDate);
    if (!start || !end || Number.isNaN(start.getTime())) return;

    const cursor = new Date(start);
    while (cursor <= end) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, "0");
      const d = String(cursor.getDate()).padStart(2, "0");
      const key = `${req.uid}_${y}-${m}-${d}`;
      if (!leaveDatesSeen.has(key)) {
        leaveDatesSeen.add(key);
        row.totalLeaveDays += 1;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  const rows = Array.from(map.values()).map((row) => ({
    ...row,
    totalApprovedOvertimeHours: Number((row.totalApprovedOvertimeMinutes / 60).toFixed(2))
  }));

  const totals = rows.reduce(
    (acc, r) => {
      acc.totalPresent += r.totalPresent;
      acc.totalLateCount += r.totalLateCount;
      acc.totalLateMinutes += r.totalLateMinutes;
      acc.totalApprovedOvertimeMinutes += r.totalApprovedOvertimeMinutes;
      acc.totalLeaveDays += r.totalLeaveDays;
      acc.totalDeductionAmount += r.totalDeductionAmount;
      acc.totalOvertimePay += r.totalOvertimePay;
      return acc;
    },
    {
      totalPresent: 0,
      totalLateCount: 0,
      totalLateMinutes: 0,
      totalApprovedOvertimeMinutes: 0,
      totalApprovedOvertimeHours: 0,
      totalLeaveDays: 0,
      totalDeductionAmount: 0,
      totalOvertimePay: 0
    }
  );
  totals.totalApprovedOvertimeHours = Number((totals.totalApprovedOvertimeMinutes / 60).toFixed(2));

  return { rows, totals };
}
