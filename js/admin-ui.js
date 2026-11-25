/**
 * HRD Admin Dashboard & Live QR Kiosk Controller
 * ----------------------------------------------
 * Desktop-first HRD command center with:
 * - Real-time KPI counters & today's telemetry
 * - Dynamic 20-second rotating QR Kiosk (`qrcodejs`)
 * - Monthly attendance recap & detailed logs with SheetJS (.xlsx) + jsPDF (.pdf) export
 * - Leave / Sick / Overtime approval queue syncing automatically with attendance
 * - Employee provisioning via secondary Firebase Auth instance (keeps admin signed in)
 * - Dynamic HRD Rules & Geofence configuration
 */

import { db, getSecondaryAuth } from "./firebase-config.js";
import {
  guardRoute,
  logoutUser,
  showToast,
  initNetworkMonitor,
  escapeHtml,
  formatIDR,
  toLocalDateKey,
  formatTimeShort,
  formatAuthError
} from "./auth.js";
import {
  DAY_NAMES,
  subscribeAttendanceRules,
  saveAttendanceRules,
  getShiftForDate,
  getEffectiveOvertimeHourlyRate,
  computeMonthlyRecap
} from "./rules-engine.js";
import { DynamicQrKiosk, getCurrentGpsPosition } from "./geo-qr.js";
import {
  initSmoothScroll,
  initScrollReveals,
  animateCounter,
  animateModalOpen,
  animateModalClose,
  bindMicroInteractions,
  smoothScrollTo
} from "./animations.js";
import {
  createUserWithEmailAndPassword,
  signOut as secondarySignOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  setDoc,
  updateDoc,
  getDoc,
  collection,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

initNetworkMonitor();

const state = {
  adminUser: null,
  adminProfile: null,
  rules: null,
  users: [],
  attendance: [],
  requests: [],
  kiosk: null,
  kioskStarted: false,
  reqStatusFilter: "all",
  pendingReviewAction: null,
  unsubscribers: []
};

const SECTION_META = {
  overview: ["Dashboard Overview", "Real-time attendance telemetry & workforce status"],
  kiosk: ["Live QR Kiosk", "20-second rotating token synced to Firestore"],
  logs: ["Attendance Logs", "Monthly payroll recap, detailed logs, Excel & PDF exports"],
  approvals: ["Leave & Overtime Approvals", "Review employee izin, sakit, cuti & lembur requests"],
  employees: ["Employee Management", "Provision accounts, departments & compensation rates"],
  settings: ["Dynamic Rules & Geofence", "Configure office radius, schedules, deductions & overtime"]
};

guardRoute({
  requiredRole: "admin",
  onAuthenticated: ({ user, profile }) => {
    state.adminUser = user;
    state.adminProfile = profile;
    bootstrapAdminDashboard();
  },
  onError: (err) => {
    showToast(err.message || "Admin authentication error.", "error");
  }
});

function bootstrapAdminDashboard() {
  document.getElementById("admin-loading-screen").classList.add("hidden");
  document.getElementById("admin-shell").classList.remove("hidden");

  document.getElementById("admin-user-name").textContent = state.adminProfile.name || "HRD Admin";
  document.getElementById("admin-user-email").textContent = state.adminProfile.email || "";

  initSmoothScroll();
  initScrollReveals(document);
  bindMicroInteractions(document);

  setupAdminClock();
  setupSidebarNavigation();
  setupLogFiltersAndExports();
  setupApprovalsFilters();
  setupEmployeeModal();
  setupRulesForm();
  setupKioskControls();
  setupModals();

  document.getElementById("admin-logout-btn").addEventListener("click", () => {
    if (state.kiosk) state.kiosk.stop();
    state.unsubscribers.forEach((u) => u && u());
    logoutUser();
  });

  // Subscribe to Attendance Rules
  state.unsubscribers.push(
    subscribeAttendanceRules((rules) => {
      state.rules = rules;
      populateRulesForm(rules);
      renderOverviewPolicyStrip();
      document.getElementById("kiosk-geofence-label").textContent = `${rules.maxRadiusMeters} m radius`;
    })
  );

  // Subscribe to Users collection
  state.unsubscribers.push(
    onSnapshot(
      collection(db, "users"),
      (snap) => {
        state.users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
        state.users.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        populateLogFilterDropdowns();
        renderEmployeesTable();
        renderOverviewSection();
        renderLogsAndRecap();
      },
      (err) => {
        console.error("[Users Listener Error]", err);
        showToast("Failed to load employees list.", "error");
      }
    )
  );

  // Subscribe to Attendance collection
  state.unsubscribers.push(
    onSnapshot(
      collection(db, "attendance"),
      (snap) => {
        state.attendance = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        state.attendance.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        renderOverviewSection();
        renderKioskLiveFeed();
        renderLogsAndRecap();
      },
      (err) => {
        console.error("[Attendance Listener Error]", err);
        showToast("Failed to load attendance logs.", "error");
      }
    )
  );

  // Subscribe to Requests collection
  state.unsubscribers.push(
    onSnapshot(
      collection(db, "requests"),
      (snap) => {
        state.requests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        state.requests.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        renderOverviewSection();
        renderApprovalsSection();
        renderLogsAndRecap();
      },
      (err) => {
        console.error("[Requests Listener Error]", err);
      }
    )
  );
}

function setupAdminClock() {
  const el = document.getElementById("admin-live-clock");
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  };
  tick();
  setInterval(tick, 1000);
}

function switchAdminSection(sectionName) {
  const navButtons = document.querySelectorAll(".admin-nav-btn");
  const sections = document.querySelectorAll(".admin-section");

  navButtons.forEach((btn) => {
    const active = btn.dataset.section === sectionName;
    btn.className = active
      ? "admin-nav-btn w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 text-white shadow-md shadow-blue-600/20 transition"
      : "admin-nav-btn w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:bg-slate-900 hover:text-white transition";
  });

  sections.forEach((sec) => {
    sec.classList.toggle("hidden", sec.id !== `section-${sectionName}`);
  });

  const [title, subtitle] = SECTION_META[sectionName] || ["Dashboard", ""];
  document.getElementById("page-section-title").textContent = title;
  document.getElementById("page-section-subtitle").textContent = subtitle;

  if (sectionName === "kiosk" && !state.kioskStarted) {
    state.kioskStarted = true;
    state.kiosk.start();
  }

  closeMobileSidebar();
  smoothScrollTo(0);
  initScrollReveals(document.getElementById(`section-${sectionName}`));
}

function closeMobileSidebar() {
  document.getElementById("admin-sidebar").classList.add("-translate-x-full");
  document.getElementById("sidebar-backdrop").classList.add("hidden");
}

function setupSidebarNavigation() {
  document.querySelectorAll(".admin-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchAdminSection(btn.dataset.section));
  });

  document.getElementById("open-sidebar-btn").addEventListener("click", () => {
    document.getElementById("admin-sidebar").classList.remove("-translate-x-full");
    document.getElementById("sidebar-backdrop").classList.remove("hidden");
  });

  document.getElementById("close-sidebar-btn").addEventListener("click", closeMobileSidebar);
  document.getElementById("sidebar-backdrop").addEventListener("click", closeMobileSidebar);

  document.getElementById("quick-kiosk-jump-btn").addEventListener("click", () => switchAdminSection("kiosk"));
  document.getElementById("overview-edit-rules-btn").addEventListener("click", () => switchAdminSection("settings"));
  document.getElementById("overview-view-approvals-btn").addEventListener("click", () => switchAdminSection("approvals"));
}

/* ==================== OVERVIEW SECTION ==================== */

function renderOverviewPolicyStrip() {
  if (!state.rules) return;
  const shift = getShiftForDate(new Date(), state.rules);
  document.getElementById("overview-shift-info").textContent = shift.isOff
    ? `Today (${shift.dayName}): Off-Day`
    : `Today (${shift.dayName}): ${shift.start} – ${shift.end}`;

  document.getElementById("overview-geofence-info").textContent = `Geofence: ${state.rules.maxRadiusMeters}m radius`;
  document.getElementById("overview-deduction-info").textContent = state.rules.deductionEnabled
    ? `Deduction: ${state.rules.deductionType.replace("_", " ")} (Grace ${state.rules.gracePeriodMinutes}m)`
    : "Deduction: Disabled";
  document.getElementById("overview-overtime-info").textContent = `Overtime: ${state.rules.overtimeMode.replace("_", " ")} (min ${state.rules.overtimeMinThresholdMinutes}m)`;
}

function renderOverviewSection() {
  const todayKey = toLocalDateKey(new Date());
  document.getElementById("overview-today-date").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const activeEmployees = state.users.filter((u) => u.isActive !== false && u.role !== "admin" && u.role !== "hrd_admin");
  const todayLogs = state.attendance.filter((a) => a.date === todayKey);
  const presentToday = todayLogs.filter((a) => a.status === "on_time" || a.status === "late").length;
  const lateTodayLogs = todayLogs.filter((a) => a.status === "late");
  const lateDeductions = lateTodayLogs.reduce((sum, a) => sum + Number(a.deductionAmount || 0), 0);
  const pendingReqs = state.requests.filter((r) => r.status === "pending");

  animateCounter(document.getElementById("kpi-total-employees"), activeEmployees.length);
  animateCounter(document.getElementById("kpi-present-today"), presentToday);
  animateCounter(document.getElementById("kpi-late-today"), lateTodayLogs.length);
  animateCounter(document.getElementById("kpi-pending-approvals"), pendingReqs.length);

  const rate = activeEmployees.length ? Math.round((presentToday / activeEmployees.length) * 100) : 0;
  document.getElementById("kpi-present-rate").textContent = `${rate}% attendance rate`;
  document.getElementById("kpi-late-deductions").textContent = `${formatIDR(lateDeductions)} deductions today`;

  const badge = document.getElementById("sidebar-pending-badge");
  if (pendingReqs.length > 0) {
    badge.textContent = String(pendingReqs.length);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  // Today's table
  const tbody = document.getElementById("overview-today-tbody");
  if (!todayLogs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">No check-ins recorded yet today.</td></tr>`;
  } else {
    tbody.innerHTML = todayLogs
      .map((rec) => {
        const badgeCls =
          rec.status === "on_time"
            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
            : rec.status === "late"
              ? "bg-amber-50 text-amber-700 border-amber-200"
              : "bg-sky-50 text-sky-700 border-sky-200";
        return `
          <tr class="hover:bg-slate-50/80">
            <td class="px-4 py-3">
              <p class="font-semibold text-slate-900">${escapeHtml(rec.employeeName)}</p>
              <p class="text-[11px] text-slate-400">${escapeHtml(rec.department || "-")}</p>
            </td>
            <td class="px-4 py-3 font-mono-num text-slate-700">${formatTimeShort(rec.clockInTime)} / ${formatTimeShort(rec.clockOutTime)}</td>
            <td class="px-4 py-3 font-mono-num text-slate-600">${rec.distanceMeters ?? "-"} m</td>
            <td class="px-4 py-3">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${badgeCls}">${escapeHtml(String(rec.status).replace("_", " "))}</span>
            </td>
            <td class="px-4 py-3 text-right font-mono-num">
              ${rec.lateMinutes > 0 ? `<span class="text-rose-600">-${rec.lateMinutes}m</span>` : `<span class="text-slate-400">0m</span>`}
              ${rec.overtimeMinutes > 0 ? `<span class="ml-1.5 text-emerald-600">+${rec.overtimeMinutes}m OT</span>` : ""}
            </td>
          </tr>
        `;
      })
      .join("");
  }

  // Pending approvals quick list
  const pendingContainer = document.getElementById("overview-pending-list");
  if (!pendingReqs.length) {
    pendingContainer.innerHTML = `<div class="py-8 text-center text-xs text-slate-400">All leave and overtime requests have been reviewed.</div>`;
  } else {
    pendingContainer.innerHTML = pendingReqs
      .slice(0, 5)
      .map(
        (r) => `
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-slate-900">${escapeHtml(r.employeeName)}</span>
            <span class="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-amber-100 text-amber-800">${escapeHtml(r.type)}</span>
          </div>
          <p class="text-[11px] text-slate-500 font-mono-num">${escapeHtml(r.startDate)}${r.endDate && r.endDate !== r.startDate ? ` → ${escapeHtml(r.endDate)}` : ""}</p>
          <p class="text-xs text-slate-600 line-clamp-2">${escapeHtml(r.reason)}</p>
        </div>
      `
      )
      .join("");
  }
}

/* ==================== LIVE QR KIOSK ==================== */

function setupKioskControls() {
  state.kiosk = new DynamicQrKiosk({
    qrContainer: document.getElementById("qr-code-display"),
    countdownTextEl: document.getElementById("qr-countdown-text"),
    ringProgressEl: document.getElementById("qr-ring-progress"),
    tokenPreviewEl: document.getElementById("qr-token-preview"),
    expiresAtEl: document.getElementById("qr-expires-at"),
    onError: (err) => {
      showToast("QR Kiosk error: " + err.message, "error");
    }
  });

  document.getElementById("kiosk-rotate-now-btn").addEventListener("click", () => {
    state.kiosk.rotateNow();
  });

  document.getElementById("kiosk-fullscreen-btn").addEventListener("click", async () => {
    const target = document.getElementById("kiosk-fullscreen-target");
    try {
      if (!document.fullscreenElement) {
        await target.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      showToast("Fullscreen mode is not supported in this browser.", "warning");
    }
  });
}

function renderKioskLiveFeed() {
  const todayKey = toLocalDateKey(new Date());
  const todayLogs = state.attendance.filter((a) => a.date === todayKey);
  const feedEl = document.getElementById("kiosk-live-feed");

  if (!todayLogs.length) {
    feedEl.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">Waiting for employees to scan QR code...</div>`;
    return;
  }

  feedEl.innerHTML = todayLogs
    .map(
      (rec) => `
      <div class="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs font-bold text-slate-900 truncate">${escapeHtml(rec.employeeName)}</p>
          <p class="text-[11px] text-slate-500">${escapeHtml(rec.department || "-")} • ${rec.distanceMeters ?? "-"}m</p>
        </div>
        <div class="text-right shrink-0">
          <p class="text-xs font-mono-num font-semibold text-slate-800">${formatTimeShort(rec.clockInTime)}${rec.clockOutTime ? ` → ${formatTimeShort(rec.clockOutTime)}` : ""}</p>
          <span class="text-[10px] font-bold uppercase ${rec.status === "late" ? "text-amber-600" : "text-emerald-600"}">
            ${escapeHtml(String(rec.status).replace("_", " "))}
          </span>
        </div>
      </div>
    `
    )
    .join("");
}

/* ==================== LOGS, MONTHLY RECAP & EXPORTS ==================== */

function setupLogFiltersAndExports() {
  const monthInput = document.getElementById("filter-log-month");
  const now = new Date();
  monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  ["filter-log-month", "filter-log-dept", "filter-log-emp", "filter-log-status"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderLogsAndRecap);
  });
  document.getElementById("filter-log-search").addEventListener("input", renderLogsAndRecap);

  document.getElementById("export-xlsx-btn").addEventListener("click", exportMonthlyExcel);
  document.getElementById("export-pdf-btn").addEventListener("click", exportMonthlyPdf);
}

function populateLogFilterDropdowns() {
  const deptSelect = document.getElementById("filter-log-dept");
  const empSelect = document.getElementById("filter-log-emp");
  const currentDept = deptSelect.value;
  const currentEmp = empSelect.value;

  const depts = Array.from(new Set(state.users.map((u) => u.department).filter(Boolean))).sort();
  deptSelect.innerHTML = `<option value="all">All Departments</option>` +
    depts.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  if (depts.includes(currentDept)) deptSelect.value = currentDept;

  empSelect.innerHTML = `<option value="all">All Employees</option>` +
    state.users.map((u) => `<option value="${escapeHtml(u.uid)}">${escapeHtml(u.name)} (${escapeHtml(u.employeeId || "-")})</option>`).join("");
  if (state.users.some((u) => u.uid === currentEmp)) empSelect.value = currentEmp;
}

function getFilteredLogsAndRecap() {
  const month = document.getElementById("filter-log-month").value;
  const dept = document.getElementById("filter-log-dept").value;
  const empUid = document.getElementById("filter-log-emp").value;
  const status = document.getElementById("filter-log-status").value;
  const search = document.getElementById("filter-log-search").value.trim().toLowerCase();

  const userMap = new Map(state.users.map((u) => [u.uid, u]));

  const filteredLogs = state.attendance.filter((rec) => {
    if (month && !(rec.date || "").startsWith(month)) return false;
    const emp = userMap.get(rec.uid);
    const recDept = rec.department || emp?.department || "";
    if (dept !== "all" && recDept !== dept) return false;
    if (empUid !== "all" && rec.uid !== empUid) return false;
    if (status !== "all" && rec.status !== status) return false;
    if (search) {
      const hay = `${rec.employeeName || ""} ${rec.date || ""} ${recDept}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const filteredUsers = state.users.filter((u) => {
    if (dept !== "all" && u.department !== dept) return false;
    if (empUid !== "all" && u.uid !== empUid) return false;
    if (search && !(u.name || "").toLowerCase().includes(search)) return false;
    return true;
  });

  const filteredReqs = state.requests.filter((r) => {
    if (month && !(r.startDate || "").startsWith(month)) return false;
    return true;
  });

  const recap = computeMonthlyRecap(filteredLogs, filteredUsers, filteredReqs);
  return { month, filteredLogs, recap };
}

function renderLogsAndRecap() {
  const { filteredLogs, recap } = getFilteredLogsAndRecap();
  const { rows, totals } = recap;

  document.getElementById("recap-sum-present").textContent = String(totals.totalPresent);
  document.getElementById("recap-sum-late-count").textContent = String(totals.totalLateCount);
  document.getElementById("recap-sum-late-mins").textContent = String(totals.totalLateMinutes);
  document.getElementById("recap-sum-ot-hours").textContent = String(totals.totalApprovedOvertimeHours);
  document.getElementById("recap-sum-leave").textContent = String(totals.totalLeaveDays);
  document.getElementById("recap-sum-deduction").textContent = formatIDR(totals.totalDeductionAmount);
  document.getElementById("recap-sum-ot-pay").textContent = formatIDR(totals.totalOvertimePay);
  document.getElementById("recap-employee-count").textContent = `${rows.length} employees`;

  const recapTbody = document.getElementById("recap-tbody");
  if (!rows.length) {
    recapTbody.innerHTML = `<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">No employees match the active filters.</td></tr>`;
  } else {
    recapTbody.innerHTML = rows
      .map(
        (r) => `
        <tr class="hover:bg-slate-50">
          <td class="px-4 py-3 font-semibold text-slate-900">${escapeHtml(r.name)} <span class="text-[11px] font-mono-num text-slate-400">(${escapeHtml(r.employeeId)})</span></td>
          <td class="px-4 py-3 text-slate-600">${escapeHtml(r.department)}</td>
          <td class="px-4 py-3 text-right font-mono-num font-semibold">${r.totalPresent}</td>
          <td class="px-4 py-3 text-right font-mono-num text-amber-700">${r.totalLateCount} / ${r.totalLateMinutes}m</td>
          <td class="px-4 py-3 text-right font-mono-num text-blue-700">${r.totalApprovedOvertimeHours}h</td>
          <td class="px-4 py-3 text-right font-mono-num text-sky-700">${r.totalLeaveDays}</td>
          <td class="px-4 py-3 text-right font-mono-num text-rose-600 font-semibold">${formatIDR(r.totalDeductionAmount)}</td>
          <td class="px-4 py-3 text-right font-mono-num text-emerald-600 font-semibold">${formatIDR(r.totalOvertimePay)}</td>
        </tr>
      `
      )
      .join("");
  }

  document.getElementById("logs-row-count").textContent = `${filteredLogs.length} records`;
  const logsTbody = document.getElementById("logs-tbody");
  if (!filteredLogs.length) {
    logsTbody.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-slate-400">No attendance logs found for the selected filter.</td></tr>`;
    return;
  }

  const badgeMap = {
    on_time: "bg-emerald-50 text-emerald-700 border-emerald-200",
    late: "bg-amber-50 text-amber-700 border-amber-200",
    leave: "bg-sky-50 text-sky-700 border-sky-200",
    alpha: "bg-rose-50 text-rose-700 border-rose-200"
  };

  logsTbody.innerHTML = filteredLogs
    .map((rec) => {
      const cls = badgeMap[rec.status] || "bg-slate-100 text-slate-700 border-slate-200";
      const pendingOtBtn =
        rec.overtimeStatus === "pending_approval" && rec.overtimeMinutes > 0
          ? `<button type="button" data-approve-ot="${escapeHtml(rec.id)}" class="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-semibold">Approve OT</button>`
          : `<span class="text-slate-400 text-[11px]">—</span>`;

      return `
        <tr class="hover:bg-slate-50">
          <td class="px-4 py-3 font-mono-num text-slate-700">${escapeHtml(rec.date)}</td>
          <td class="px-4 py-3">
            <p class="font-semibold text-slate-900">${escapeHtml(rec.employeeName)}</p>
            <p class="text-[11px] text-slate-400">${escapeHtml(rec.department || "-")}</p>
          </td>
          <td class="px-4 py-3 font-mono-num text-slate-700">${formatTimeShort(rec.clockInTime)}</td>
          <td class="px-4 py-3 font-mono-num text-slate-700">${formatTimeShort(rec.clockOutTime)}</td>
          <td class="px-4 py-3 font-mono-num text-slate-600">${rec.distanceMeters ?? "-"} m</td>
          <td class="px-4 py-3">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${cls}">${escapeHtml(String(rec.status || "").replace("_", " "))}</span>
          </td>
          <td class="px-4 py-3 text-right font-mono-num">
            ${rec.lateMinutes > 0 ? `<span class="text-rose-600">${rec.lateMinutes}m (${formatIDR(rec.deductionAmount)})</span>` : `<span class="text-slate-400">0m</span>`}
          </td>
          <td class="px-4 py-3 text-right font-mono-num">
            ${
              rec.overtimeMinutes > 0
                ? `<span class="${rec.overtimeStatus === "pending_approval" ? "text-amber-600" : "text-emerald-600"}">${rec.overtimeMinutes}m (${rec.overtimeStatus === "pending_approval" ? "Pending" : formatIDR(rec.overtimePay)})</span>`
                : `<span class="text-slate-400">0m</span>`
            }
          </td>
          <td class="px-4 py-3 text-right">${pendingOtBtn}</td>
        </tr>
      `;
    })
    .join("");

  logsTbody.querySelectorAll("[data-approve-ot]").forEach((btn) => {
    btn.addEventListener("click", () => approveOvertimeFromLog(btn.dataset.approveOt));
  });
}

async function approveOvertimeFromLog(docId) {
  const rec = state.attendance.find((a) => a.id === docId);
  if (!rec) return;
  const emp = state.users.find((u) => u.uid === rec.uid) || {};
  const hourlyRate = getEffectiveOvertimeHourlyRate(emp, state.rules || {});
  const otPay = Math.round((Number(rec.overtimeMinutes || 0) / 60) * hourlyRate);

  try {
    await updateDoc(doc(db, "attendance", docId), {
      overtimeStatus: "approved",
      overtimePay: otPay
    });
    showToast(`Approved ${rec.overtimeMinutes}m overtime (${formatIDR(otPay)}) for ${rec.employeeName}.`, "success");
  } catch (err) {
    showToast("Failed to approve overtime: " + err.message, "error");
  }
}

function exportMonthlyExcel() {
  if (typeof window.XLSX === "undefined") {
    showToast("SheetJS library not loaded yet. Check your internet connection.", "error");
    return;
  }

  const { month, filteredLogs, recap } = getFilteredLogsAndRecap();
  const wb = window.XLSX.utils.book_new();

  const recapRows = recap.rows.map((r) => ({
    "Employee ID": r.employeeId,
    "Employee Name": r.name,
    Department: r.department,
    "Total Present": r.totalPresent,
    "Late Count": r.totalLateCount,
    "Late Minutes": r.totalLateMinutes,
    "Approved OT (Hours)": r.totalApprovedOvertimeHours,
    "Leave / Sick Days": r.totalLeaveDays,
    "Total Deduction (IDR)": r.totalDeductionAmount,
    "Total Overtime Pay (IDR)": r.totalOvertimePay
  }));

  recapRows.push({
    "Employee ID": "TOTAL",
    "Employee Name": "",
    Department: "",
    "Total Present": recap.totals.totalPresent,
    "Late Count": recap.totals.totalLateCount,
    "Late Minutes": recap.totals.totalLateMinutes,
    "Approved OT (Hours)": recap.totals.totalApprovedOvertimeHours,
    "Leave / Sick Days": recap.totals.totalLeaveDays,
    "Total Deduction (IDR)": recap.totals.totalDeductionAmount,
    "Total Overtime Pay (IDR)": recap.totals.totalOvertimePay
  });

  const wsRecap = window.XLSX.utils.json_to_sheet(recapRows);
  wsRecap["!cols"] = [
    { wch: 14 }, { wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 12 },
    { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 22 }, { wch: 24 }
  ];
  window.XLSX.utils.book_append_sheet(wb, wsRecap, "Monthly Recap");

  const logRows = filteredLogs.map((l) => ({
    Date: l.date,
    "Employee Name": l.employeeName,
    Department: l.department || "-",
    "Clock In": formatTimeShort(l.clockInTime),
    "Clock Out": formatTimeShort(l.clockOutTime),
    "Distance (m)": l.distanceMeters ?? "-",
    Status: l.status,
    "Late (min)": l.lateMinutes || 0,
    "Deduction (IDR)": l.deductionAmount || 0,
    "Overtime (min)": l.overtimeMinutes || 0,
    "OT Status": l.overtimeStatus || "none",
    "Overtime Pay (IDR)": l.overtimePay || 0
  }));

  const wsLogs = window.XLSX.utils.json_to_sheet(logRows);
  wsLogs["!cols"] = [
    { wch: 12 }, { wch: 24 }, { wch: 18 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 18 }
  ];
  window.XLSX.utils.book_append_sheet(wb, wsLogs, "Detailed Logs");

  window.XLSX.writeFile(wb, `PulseHR_Attendance_${month || "All"}.xlsx`);
  showToast("Excel report downloaded.", "success");
}

function exportMonthlyPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast("jsPDF library not loaded yet. Check your internet connection.", "error");
    return;
  }

  const { month, filteredLogs, recap } = getFilteredLogsAndRecap();
  const { jsPDF } = window.jspdf;
  const docPdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

  docPdf.setFontSize(16);
  docPdf.text(`PulseHR — Monthly Attendance & Payroll Recap (${month || "All Periods"})`, 40, 40);
  docPdf.setFontSize(10);
  docPdf.setTextColor(100);
  docPdf.text(
    `Generated: ${new Date().toLocaleString()}   |   Present: ${recap.totals.totalPresent}   |   Late: ${recap.totals.totalLateCount} (${recap.totals.totalLateMinutes}m)   |   OT Hours: ${recap.totals.totalApprovedOvertimeHours}h   |   Deductions: ${formatIDR(recap.totals.totalDeductionAmount)}   |   OT Pay: ${formatIDR(recap.totals.totalOvertimePay)}`,
    40,
    58
  );

  docPdf.autoTable({
    startY: 74,
    head: [["ID", "Employee", "Dept", "Present", "Late (Cnt/Min)", "OT Hours", "Leave/Sick", "Deductions", "OT Pay"]],
    body: recap.rows.map((r) => [
      r.employeeId,
      r.name,
      r.department,
      String(r.totalPresent),
      `${r.totalLateCount} / ${r.totalLateMinutes}m`,
      `${r.totalApprovedOvertimeHours}h`,
      String(r.totalLeaveDays),
      formatIDR(r.totalDeductionAmount),
      formatIDR(r.totalOvertimePay)
    ]),
    styles: { fontSize: 8.5, cellPadding: 5 },
    headStyles: { fillColor: [37, 99, 235] }
  });

  if (filteredLogs.length > 0) {
    docPdf.addPage();
    docPdf.setFontSize(13);
    docPdf.setTextColor(15);
    docPdf.text(`Detailed Attendance Logs (${month || "All"})`, 40, 40);

    docPdf.autoTable({
      startY: 56,
      head: [["Date", "Employee", "In", "Out", "Dist(m)", "Status", "Late(m)", "Deduction", "OT(m)", "OT Pay"]],
      body: filteredLogs.map((l) => [
        l.date,
        l.employeeName,
        formatTimeShort(l.clockInTime),
        formatTimeShort(l.clockOutTime),
        String(l.distanceMeters ?? "-"),
        l.status,
        String(l.lateMinutes || 0),
        formatIDR(l.deductionAmount || 0),
        String(l.overtimeMinutes || 0),
        formatIDR(l.overtimePay || 0)
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [15, 23, 42] }
    });
  }

  docPdf.save(`PulseHR_Attendance_${month || "All"}.pdf`);
  showToast("PDF report downloaded.", "success");
}

/* ==================== LEAVE & OVERTIME APPROVALS ==================== */

function setupApprovalsFilters() {
  document.querySelectorAll(".req-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.reqStatusFilter = btn.dataset.reqStatus;
      document.querySelectorAll(".req-filter-btn").forEach((b) => {
        const active = b.dataset.reqStatus === state.reqStatusFilter;
        b.className = active
          ? "req-filter-btn px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 text-white"
          : "req-filter-btn px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200";
      });
      renderApprovalsSection();
    });
  });

  document.getElementById("filter-req-type").addEventListener("change", renderApprovalsSection);
}

function renderApprovalsSection() {
  const typeFilter = document.getElementById("filter-req-type").value;
  const grid = document.getElementById("approvals-grid");

  const filtered = state.requests.filter((r) => {
    if (state.reqStatusFilter !== "all" && r.status !== state.reqStatusFilter) return false;
    if (typeFilter !== "all" && r.type !== typeFilter) return false;
    return true;
  });

  if (!filtered.length) {
    grid.innerHTML = `<div class="col-span-full bg-white rounded-2xl border border-slate-200 p-10 text-center text-xs text-slate-400">No requests match this filter.</div>`;
    return;
  }

  const badgeCls = {
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-rose-50 text-rose-700 border-rose-200"
  };

  grid.innerHTML = filtered
    .map(
      (req) => `
      <article class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex flex-col justify-between gap-4">
        <div class="space-y-2.5">
          <div class="flex items-start justify-between gap-2">
            <div>
              <h3 class="text-sm font-bold text-slate-900">${escapeHtml(req.employeeName)}</h3>
              <p class="text-[11px] text-slate-500">${escapeHtml(req.employeeId || "-")} • ${escapeHtml(req.department || "General")}</p>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-slate-100 text-slate-700">${escapeHtml(req.type)}</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${badgeCls[req.status] || badgeCls.pending}">${escapeHtml(req.status)}</span>
            </div>
          </div>

          <p class="text-xs font-mono-num text-slate-600 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-100 inline-block">
            ${escapeHtml(req.startDate)}${req.endDate && req.endDate !== req.startDate ? ` → ${escapeHtml(req.endDate)}` : ""}
          </p>

          <p class="text-xs text-slate-700 leading-relaxed">${escapeHtml(req.reason)}</p>

          ${
            req.attachmentBase64
              ? `<button type="button" data-view-img="${escapeHtml(req.id)}" class="group flex items-center gap-2.5 p-2 rounded-xl border border-slate-200 hover:border-blue-400 bg-slate-50 transition text-left">
                  <img src="${req.attachmentBase64}" alt="Proof attachment" class="w-12 h-12 rounded-lg object-cover border border-slate-300" />
                  <span class="text-xs font-semibold text-blue-600 group-hover:underline">View Compressed Attachment</span>
                 </button>`
              : ""
          }

          ${
            req.reviewNote
              ? `<p class="text-[11px] text-slate-500 italic">HRD Note: ${escapeHtml(req.reviewNote)}</p>`
              : ""
          }
        </div>

        ${
          req.status === "pending"
            ? `<div class="flex items-center gap-2 pt-2 border-t border-slate-100">
                <button type="button" data-review-req="${escapeHtml(req.id)}" data-decision="approved" data-motion-btn class="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition">Approve</button>
                <button type="button" data-review-req="${escapeHtml(req.id)}" data-decision="rejected" data-motion-btn class="flex-1 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold transition">Reject</button>
               </div>`
            : `<div class="pt-2 border-t border-slate-100 text-[11px] text-slate-400">Reviewed by ${escapeHtml(req.reviewedByName || req.reviewedBy || "HRD")}</div>`
        }
      </article>
    `
    )
    .join("");

  grid.querySelectorAll("[data-view-img]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const req = state.requests.find((r) => r.id === btn.dataset.viewImg);
      if (!req?.attachmentBase64) return;
      document.getElementById("attachment-modal-title").textContent = `${req.employeeName} — ${req.type.toUpperCase()} Attachment`;
      document.getElementById("attachment-modal-img").src = req.attachmentBase64;
      const modal = document.getElementById("attachment-modal");
      modal.classList.remove("hidden");
      animateModalOpen(document.getElementById("attachment-modal-panel"));
    });
  });

  grid.querySelectorAll("[data-review-req]").forEach((btn) => {
    btn.addEventListener("click", () => openReviewModal(btn.dataset.reviewReq, btn.dataset.decision));
  });
}

function openReviewModal(requestId, decision) {
  const req = state.requests.find((r) => r.id === requestId);
  if (!req) return;
  state.pendingReviewAction = { req, decision };

  const isApprove = decision === "approved";
  document.getElementById("review-modal-title").textContent = isApprove ? "Approve Request" : "Reject Request";
  document.getElementById("review-modal-summary").textContent =
    `${isApprove ? "Approve" : "Reject"} ${req.type.toUpperCase()} request from ${req.employeeName} (${req.startDate}${req.endDate && req.endDate !== req.startDate ? ` to ${req.endDate}` : ""})?`;
  document.getElementById("review-note-input").value = "";

  const confirmBtn = document.getElementById("confirm-review-btn");
  confirmBtn.textContent = isApprove ? "Confirm Approval" : "Confirm Rejection";
  confirmBtn.className = isApprove
    ? "px-4 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700"
    : "px-4 py-2 rounded-xl text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700";

  const modal = document.getElementById("review-modal");
  modal.classList.remove("hidden");
  animateModalOpen(document.getElementById("review-modal-panel"));
}

async function executeReviewDecision(e) {
  e.preventDefault();
  if (!state.pendingReviewAction) return;
  const { req, decision } = state.pendingReviewAction;
  const note = document.getElementById("review-note-input").value.trim();
  const btn = document.getElementById("confirm-review-btn");

  btn.disabled = true;
  try {
    await updateDoc(doc(db, "requests", req.id), {
      status: decision,
      reviewedBy: state.adminUser.uid,
      reviewedByName: state.adminProfile.name || "HRD Admin",
      reviewNote: note || null,
      reviewedAt: new Date().toISOString()
    });

    // Automatically sync approved Leave/Sick/Permission to Attendance collection
    if (decision === "approved" && ["izin", "sakit", "cuti"].includes(req.type)) {
      const start = new Date(`${req.startDate}T00:00:00`);
      const end = new Date(`${req.endDate || req.startDate}T00:00:00`);
      const cursor = new Date(start);

      while (cursor <= end) {
        const dateKey = toLocalDateKey(cursor);
        const attRef = doc(db, "attendance", `${req.uid}_${dateKey}`);
        const existing = await getDoc(attRef);
        if (!existing.exists()) {
          await setDoc(attRef, {
            uid: req.uid,
            employeeName: req.employeeName,
            employeeId: req.employeeId || "-",
            department: req.department || "General",
            date: dateKey,
            clockInTime: null,
            clockOutTime: null,
            clockInCoords: null,
            clockOutCoords: null,
            distanceMeters: null,
            status: "leave",
            leaveType: req.type,
            lateMinutes: 0,
            deductionAmount: 0,
            overtimeMinutes: 0,
            overtimePay: 0,
            overtimeStatus: "none"
          });
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // Sync approved/rejected Overtime request with any recorded attendance overtime
    if (req.type === "lembur") {
      const attRef = doc(db, "attendance", `${req.uid}_${req.startDate}`);
      const snap = await getDoc(attRef);
      if (snap.exists()) {
        const att = snap.data();
        if (decision === "approved" && Number(att.overtimeMinutes || 0) > 0) {
          const emp = state.users.find((u) => u.uid === req.uid) || {};
          const hourlyRate = getEffectiveOvertimeHourlyRate(emp, state.rules || {});
          const otPay = Math.round((Number(att.overtimeMinutes) / 60) * hourlyRate);
          await updateDoc(attRef, { overtimeStatus: "approved", overtimePay: otPay });
        } else if (decision === "rejected") {
          await updateDoc(attRef, { overtimeStatus: "rejected", overtimePay: 0 });
        }
      }
    }

    await closeReviewModal();
    showToast(`Request ${decision}.`, "success");
  } catch (err) {
    console.error("[Review Request Error]", err);
    showToast("Failed to update request: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function closeReviewModal() {
  const modal = document.getElementById("review-modal");
  await animateModalClose(document.getElementById("review-modal-panel"));
  modal.classList.add("hidden");
  state.pendingReviewAction = null;
}

/* ==================== EMPLOYEE MANAGEMENT ==================== */

function setupEmployeeModal() {
  document.getElementById("emp-search-input").addEventListener("input", renderEmployeesTable);
  document.getElementById("open-add-emp-btn").addEventListener("click", () => openEmployeeModal(null));
  document.getElementById("close-emp-modal-btn").addEventListener("click", closeEmployeeModal);
  document.getElementById("cancel-emp-modal-btn").addEventListener("click", closeEmployeeModal);
  document.getElementById("employee-form").addEventListener("submit", handleEmployeeSave);
}

function openEmployeeModal(userObj) {
  const isEdit = Boolean(userObj);
  document.getElementById("emp-modal-title").textContent = isEdit ? "Edit Employee" : "Add New Employee";
  document.getElementById("emp-edit-uid").value = isEdit ? userObj.uid : "";
  document.getElementById("emp-name").value = userObj?.name || "";
  document.getElementById("emp-id").value = userObj?.employeeId || "";
  document.getElementById("emp-email").value = userObj?.email || "";
  document.getElementById("emp-email").disabled = isEdit;
  document.getElementById("emp-password-wrap").classList.toggle("hidden", isEdit);
  document.getElementById("emp-password").value = "";
  document.getElementById("emp-dept").value = userObj?.department || "";
  document.getElementById("emp-pos").value = userObj?.position || "";
  document.getElementById("emp-daily-rate").value = userObj?.dailyRate ?? 250000;
  document.getElementById("emp-ot-rate").value = userObj?.hourlyOvertimeRate ?? 45000;
  document.getElementById("emp-role").value = userObj?.role === "admin" || userObj?.role === "hrd_admin" ? "admin" : "employee";
  document.getElementById("emp-active").checked = userObj?.isActive !== false;

  const modal = document.getElementById("employee-modal");
  modal.classList.remove("hidden");
  animateModalOpen(document.getElementById("employee-modal-panel"));
}

async function closeEmployeeModal() {
  const modal = document.getElementById("employee-modal");
  await animateModalClose(document.getElementById("employee-modal-panel"));
  modal.classList.add("hidden");
}

async function handleEmployeeSave(e) {
  e.preventDefault();
  const editUid = document.getElementById("emp-edit-uid").value;
  const name = document.getElementById("emp-name").value.trim();
  const employeeId = document.getElementById("emp-id").value.trim();
  const email = document.getElementById("emp-email").value.trim();
  const password = document.getElementById("emp-password").value;
  const department = document.getElementById("emp-dept").value.trim();
  const position = document.getElementById("emp-pos").value.trim();
  const dailyRate = Number(document.getElementById("emp-daily-rate").value || 0);
  const hourlyOvertimeRate = Number(document.getElementById("emp-ot-rate").value || 0);
  const role = document.getElementById("emp-role").value;
  const isActive = document.getElementById("emp-active").checked;

  if (!name || !employeeId || !email || !department || !position) {
    showToast("Please complete all required employee fields.", "warning");
    return;
  }

  const saveBtn = document.getElementById("save-emp-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    if (editUid) {
      await updateDoc(doc(db, "users", editUid), {
        name,
        employeeId,
        department,
        position,
        dailyRate,
        hourlyOvertimeRate,
        role,
        isActive,
        updatedAt: new Date().toISOString()
      });
      showToast(`Updated profile for ${name}.`, "success");
    } else {
      if (!password || password.length < 6) {
        showToast("Initial password must be at least 6 characters.", "warning");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Employee";
        return;
      }

      // Create Firebase Auth user using secondary app so Admin stays logged in
      const secondaryAuth = getSecondaryAuth();
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      const newUid = cred.user.uid;
      await secondarySignOut(secondaryAuth);

      await setDoc(doc(db, "users", newUid), {
        name,
        employeeId,
        email,
        role,
        department,
        position,
        dailyRate,
        hourlyOvertimeRate,
        isActive,
        createdAt: new Date().toISOString()
      });
      showToast(`Provisioned account for ${name}.`, "success");
    }
    await closeEmployeeModal();
  } catch (err) {
    console.error("[Save Employee Error]", err);
    showToast(formatAuthError(err), "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Employee";
  }
}

function renderEmployeesTable() {
  const search = document.getElementById("emp-search-input").value.trim().toLowerCase();
  const tbody = document.getElementById("employees-tbody");

  const filtered = state.users.filter((u) => {
    if (!search) return true;
    const hay = `${u.name || ""} ${u.employeeId || ""} ${u.email || ""} ${u.department || ""} ${u.position || ""}`.toLowerCase();
    return hay.includes(search);
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">No employees found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((u) => {
      const isAdmin = u.role === "admin" || u.role === "hrd_admin";
      const active = u.isActive !== false;
      return `
        <tr class="hover:bg-slate-50">
          <td class="px-4 py-3">
            <p class="font-semibold text-slate-900">${escapeHtml(u.name)}</p>
            <p class="text-[11px] text-slate-400">${escapeHtml(u.email)}</p>
          </td>
          <td class="px-4 py-3">
            <p class="font-mono-num font-semibold text-slate-800">${escapeHtml(u.employeeId || "-")}</p>
            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${isAdmin ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}">
              ${isAdmin ? "HRD Admin" : "Employee"}
            </span>
          </td>
          <td class="px-4 py-3">
            <p class="text-slate-800 font-medium">${escapeHtml(u.department || "-")}</p>
            <p class="text-[11px] text-slate-400">${escapeHtml(u.position || "-")}</p>
          </td>
          <td class="px-4 py-3 text-right font-mono-num text-slate-700">${formatIDR(u.dailyRate || 0)}</td>
          <td class="px-4 py-3 text-right font-mono-num text-slate-700">${formatIDR(u.hourlyOvertimeRate || 0)}</td>
          <td class="px-4 py-3">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${active ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}">
              ${active ? "Active" : "Inactive"}
            </span>
          </td>
          <td class="px-4 py-3 text-right space-x-2">
            <button type="button" data-edit-emp="${escapeHtml(u.uid)}" class="text-xs font-semibold text-blue-600 hover:underline">Edit</button>
            <button type="button" data-toggle-emp="${escapeHtml(u.uid)}" class="text-xs font-semibold ${active ? "text-rose-600" : "text-emerald-600"} hover:underline">
              ${active ? "Deactivate" : "Activate"}
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-edit-emp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = state.users.find((x) => x.uid === btn.dataset.editEmp);
      if (u) openEmployeeModal(u);
    });
  });

  tbody.querySelectorAll("[data-toggle-emp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const u = state.users.find((x) => x.uid === btn.dataset.toggleEmp);
      if (!u) return;
      if (u.uid === state.adminUser.uid) {
        showToast("You cannot deactivate your own active admin account.", "warning");
        return;
      }
      await updateDoc(doc(db, "users", u.uid), { isActive: u.isActive === false });
      showToast(`Employee ${u.name} ${u.isActive === false ? "activated" : "deactivated"}.`, "info");
    });
  });
}

/* ==================== DYNAMIC RULES & GEOFENCE SETTINGS ==================== */

function setupRulesForm() {
  // Build day-by-day schedule inputs (Monday..Saturday..Sunday)
  const container = document.getElementById("rule-schedules-grid");
  const order = [1, 2, 3, 4, 5, 6, 0];
  container.innerHTML = order
    .map(
      (dayIdx) => `
      <div class="flex items-center justify-between gap-2 p-3 rounded-xl bg-slate-50 border border-slate-200">
        <div class="flex items-center gap-2.5 min-w-[120px]">
          <input id="sched-off-${dayIdx}" type="checkbox" class="w-4 h-4 rounded text-blue-600" />
          <div>
            <p class="text-xs font-bold text-slate-800">${DAY_NAMES[dayIdx]}</p>
            <label for="sched-off-${dayIdx}" class="text-[10px] text-slate-500 cursor-pointer">Mark Off-Day</label>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <input id="sched-start-${dayIdx}" type="time" class="px-2 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-mono-num" />
          <span class="text-slate-400 text-xs">–</span>
          <input id="sched-end-${dayIdx}" type="time" class="px-2 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-mono-num" />
        </div>
      </div>
    `
    )
    .join("");

  document.getElementById("rule-deduction-type").addEventListener("change", syncDeductionModeUi);

  document.getElementById("detect-office-gps-btn").addEventListener("click", async () => {
    try {
      const coords = await getCurrentGpsPosition();
      document.getElementById("rule-office-lat").value = coords.lat.toFixed(6);
      document.getElementById("rule-office-lng").value = coords.lng.toFixed(6);
      updateMapPreviewLink();
      showToast(`Office GPS captured (±${Math.round(coords.accuracy)}m accuracy). Click Save Rules to apply.`, "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  ["rule-office-lat", "rule-office-lng"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateMapPreviewLink);
  });

  document.getElementById("rules-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById("save-rules-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
      const schedules = {};
      for (let d = 0; d <= 6; d++) {
        schedules[String(d)] = {
          isOff: document.getElementById(`sched-off-${d}`).checked,
          start: document.getElementById(`sched-start-${d}`).value || "07:00",
          end: document.getElementById(`sched-end-${d}`).value || "15:00"
        };
      }

      const payload = {
        officeLat: Number(document.getElementById("rule-office-lat").value),
        officeLng: Number(document.getElementById("rule-office-lng").value),
        maxRadiusMeters: Number(document.getElementById("rule-max-radius").value || 50),
        maxGpsAccuracyMeters: Number(document.getElementById("rule-max-accuracy").value || 150),
        schedules,
        deductionEnabled: document.getElementById("rule-deduction-enabled").checked,
        gracePeriodMinutes: Number(document.getElementById("rule-grace-minutes").value || 0),
        deductionType: document.getElementById("rule-deduction-type").value,
        deductionValue: Number(document.getElementById("rule-deduction-value").value || 0),
        deductionTiers: [
          { minMinutes: 1, maxMinutes: 15, amount: Number(document.getElementById("rule-tier-1").value || 0) },
          { minMinutes: 16, maxMinutes: 30, amount: Number(document.getElementById("rule-tier-2").value || 0) },
          { minMinutes: 31, maxMinutes: null, amount: Number(document.getElementById("rule-tier-3").value || 0) }
        ],
        overtimeMode: document.getElementById("rule-overtime-mode").value,
        overtimeMinThresholdMinutes: Number(document.getElementById("rule-ot-threshold").value || 30),
        overtimeRateMultiplier: Number(document.getElementById("rule-ot-multiplier").value || 1.5),
        defaultHourlyOvertimeRate: Number(document.getElementById("rule-ot-default-rate").value || 35000)
      };

      await saveAttendanceRules(payload, state.adminUser.uid);
      showToast("HRD Rules & Geofence settings saved to Firestore!", "success");
    } catch (err) {
      console.error("[Save Rules Error]", err);
      showToast("Failed to save rules: " + err.message, "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save All HRD Rules";
    }
  });
}

function populateRulesForm(rules) {
  document.getElementById("rule-office-lat").value = rules.officeLat;
  document.getElementById("rule-office-lng").value = rules.officeLng;
  document.getElementById("rule-max-radius").value = rules.maxRadiusMeters;
  document.getElementById("rule-max-accuracy").value = rules.maxGpsAccuracyMeters ?? 150;
  updateMapPreviewLink();

  for (let d = 0; d <= 6; d++) {
    const slot = rules.schedules[String(d)];
    document.getElementById(`sched-off-${d}`).checked = Boolean(slot.isOff);
    document.getElementById(`sched-start-${d}`).value = slot.start || "07:00";
    document.getElementById(`sched-end-${d}`).value = slot.end || "15:00";
  }

  document.getElementById("rule-deduction-enabled").checked = Boolean(rules.deductionEnabled);
  document.getElementById("rule-grace-minutes").value = rules.gracePeriodMinutes ?? 5;
  document.getElementById("rule-deduction-type").value = rules.deductionType || "per_minute";
  document.getElementById("rule-deduction-value").value = rules.deductionValue ?? 2000;

  const tiers = rules.deductionTiers || [];
  document.getElementById("rule-tier-1").value = tiers[0]?.amount ?? 25000;
  document.getElementById("rule-tier-2").value = tiers[1]?.amount ?? 50000;
  document.getElementById("rule-tier-3").value = tiers[2]?.amount ?? 100000;

  document.getElementById("rule-overtime-mode").value = rules.overtimeMode || "auto";
  document.getElementById("rule-ot-threshold").value = rules.overtimeMinThresholdMinutes ?? 30;
  document.getElementById("rule-ot-multiplier").value = rules.overtimeRateMultiplier ?? 1.5;
  document.getElementById("rule-ot-default-rate").value = rules.defaultHourlyOvertimeRate ?? 35000;

  syncDeductionModeUi();
}

function syncDeductionModeUi() {
  const mode = document.getElementById("rule-deduction-type").value;
  const valWrap = document.getElementById("rule-deduction-value-wrap");
  const valLabel = document.getElementById("rule-deduction-value-label");
  const tiersPanel = document.getElementById("rule-tiered-brackets-panel");

  if (mode === "tiered") {
    valWrap.classList.add("hidden");
    tiersPanel.classList.remove("hidden");
  } else if (mode === "percentage") {
    valWrap.classList.remove("hidden");
    tiersPanel.classList.add("hidden");
    valLabel.textContent = "Percentage of Daily Rate (%)";
  } else {
    valWrap.classList.remove("hidden");
    tiersPanel.classList.add("hidden");
    valLabel.textContent = "Deduction Value (IDR / minute)";
  }
}

function updateMapPreviewLink() {
  const lat = document.getElementById("rule-office-lat").value;
  const lng = document.getElementById("rule-office-lng").value;
  document.getElementById("preview-office-map-link").href = `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
}

/* ==================== SHARED MODALS ==================== */

function setupModals() {
  const attModal = document.getElementById("attachment-modal");
  document.getElementById("close-attachment-modal").addEventListener("click", async () => {
    await animateModalClose(document.getElementById("attachment-modal-panel"));
    attModal.classList.add("hidden");
  });

  document.getElementById("close-review-modal").addEventListener("click", closeReviewModal);
  document.getElementById("cancel-review-modal").addEventListener("click", closeReviewModal);
  document.getElementById("review-modal-form").addEventListener("submit", executeReviewDecision);
}
