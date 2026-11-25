/**
 * Employee Portal Controller (Mobile-First)
 * -----------------------------------------
 * Handles live clock, GPS geofence telemetry, Dual-Factor QR clock-in/out,
 * attendance history, client-side <150KB image compression, and leave/overtime requests.
 */

import { db } from "./firebase-config.js";
import {
  guardRoute,
  logoutUser,
  showToast,
  initNetworkMonitor,
  escapeHtml,
  formatIDR,
  toLocalDateKey,
  formatTimeShort
} from "./auth.js";
import {
  DAY_NAMES,
  subscribeAttendanceRules,
  getShiftForDate,
  evaluateClockIn,
  evaluateClockOut,
  getEffectiveOvertimeHourlyRate
} from "./rules-engine.js";
import {
  getCurrentGpsPosition,
  validateGeofence,
  EmployeeQrScanner,
  validateScannedQrToken
} from "./geo-qr.js";
import {
  animateEntrance,
  animateModalOpen,
  animateModalClose,
  bindMicroInteractions
} from "./animations.js";
import {
  doc,
  setDoc,
  updateDoc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

initNetworkMonitor();

const state = {
  user: null,
  profile: null,
  rules: null,
  latestGps: null,
  latestGeoValidation: null,
  todayAttendance: null,
  allAttendance: [],
  myRequests: [],
  compressedBase64: null,
  compressedName: null,
  scanner: new EmployeeQrScanner("qr-reader"),
  unsubscribers: []
};

// Guard route for authenticated employees
guardRoute({
  requiredRole: "employee",
  onAuthenticated: ({ user, profile }) => {
    state.user = user;
    state.profile = profile;
    bootstrapEmployeeApp();
  },
  onError: (err) => {
    showToast(err.message || "Authentication error", "error");
  }
});

function bootstrapEmployeeApp() {
  document.getElementById("app-loading-screen").classList.add("hidden");
  document.getElementById("employee-shell").classList.remove("hidden");

  populateProfileView();
  setupNavigation();
  setupClock();
  setupMonthPicker();
  setupRequestForm();
  setupScannerModal();
  bindMicroInteractions(document);

  // Live rules listener
  state.unsubscribers.push(
    subscribeAttendanceRules((rules) => {
      state.rules = rules;
      updateShiftDisplay();
      renderProfileSchedule();
      if (state.latestGps) {
        evaluateAndShowGps(state.latestGps);
      }
    })
  );

  // Live employee attendance listener
  const attQuery = query(collection(db, "attendance"), where("uid", "==", state.user.uid));
  state.unsubscribers.push(
    onSnapshot(
      attQuery,
      (snapshot) => {
        const docs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        docs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        state.allAttendance = docs;

        const todayKey = toLocalDateKey(new Date());
        state.todayAttendance = docs.find((d) => d.date === todayKey) || null;
        renderTodayAttendanceCard();
        renderHistoryList();
      },
      (err) => {
        console.error("[Attendance Snapshot Error]", err);
        showToast("Unable to sync attendance logs.", "error");
      }
    )
  );

  // Live employee requests listener
  const reqQuery = query(collection(db, "requests"), where("uid", "==", state.user.uid));
  state.unsubscribers.push(
    onSnapshot(
      reqQuery,
      (snapshot) => {
        const docs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        docs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        state.myRequests = docs;
        renderMyRequests();
      },
      (err) => {
        console.error("[Requests Snapshot Error]", err);
      }
    )
  );

  // Initial GPS check
  refreshGpsStatus();
  document.getElementById("refresh-gps-btn").addEventListener("click", refreshGpsStatus);
  document.getElementById("employee-logout-btn").addEventListener("click", () => {
    state.unsubscribers.forEach((u) => u && u());
    logoutUser();
  });

  animateEntrance("#tab-home > div", { duration: 0.35, staggerDelay: 0.06 });
}

function setupNavigation() {
  const navButtons = document.querySelectorAll(".emp-nav-btn");
  const panels = document.querySelectorAll(".tab-panel");

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;

      navButtons.forEach((b) => {
        const isActive = b.dataset.tab === target;
        b.classList.toggle("text-blue-600", isActive);
        b.classList.toggle("font-semibold", isActive);
        b.classList.toggle("text-slate-500", !isActive);
      });

      panels.forEach((panel) => {
        const show = panel.id === `tab-${target}`;
        panel.classList.toggle("hidden", !show);
        if (show) {
          animateEntrance(panel.children, { duration: 0.25, staggerDelay: 0.04 });
        }
      });

      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function setupClock() {
  const clockEl = document.getElementById("live-clock-text");
  const dateEl = document.getElementById("live-date-text");

  const update = () => {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    dateEl.textContent = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  };
  update();
  setInterval(update, 1000);
}

function updateShiftDisplay() {
  if (!state.rules) return;
  const shift = getShiftForDate(new Date(), state.rules);
  const pill = document.getElementById("header-shift-pill");
  if (shift.isOff) {
    pill.textContent = "Off-Day";
    pill.className = "px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200";
  } else {
    pill.textContent = `Shift ${shift.start}–${shift.end}`;
    pill.className = "px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-100";
  }
}

async function refreshGpsStatus() {
  const statusEl = document.getElementById("gps-status-text");
  const dotEl = document.getElementById("gps-indicator-dot");
  const distEl = document.getElementById("gps-distance-detail");
  const accEl = document.getElementById("gps-accuracy-detail");

  statusEl.textContent = "Acquiring high-accuracy GPS...";
  dotEl.className = "w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse";

  try {
    const coords = await getCurrentGpsPosition();
    state.latestGps = coords;
    evaluateAndShowGps(coords);
  } catch (err) {
    state.latestGps = null;
    state.latestGeoValidation = null;
    dotEl.className = "w-2.5 h-2.5 rounded-full bg-rose-500";
    statusEl.textContent = err.message;
    distEl.textContent = "Distance: Unavailable";
    accEl.textContent = "Accuracy: --";
  }
}

function evaluateAndShowGps(coords) {
  if (!state.rules) return;
  const check = validateGeofence(coords, state.rules);
  state.latestGeoValidation = check;

  const statusEl = document.getElementById("gps-status-text");
  const dotEl = document.getElementById("gps-indicator-dot");
  const distEl = document.getElementById("gps-distance-detail");
  const accEl = document.getElementById("gps-accuracy-detail");

  distEl.textContent = `Distance: ${check.distanceMeters} m (max ${check.maxRadiusMeters} m)`;
  accEl.textContent = `Accuracy: ±${check.accuracy} m`;

  if (check.allowed) {
    dotEl.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 text-emerald-500 live-pulse-ring relative";
    statusEl.textContent = "Inside Office Geofence";
    statusEl.className = "text-sm font-semibold text-emerald-700 mt-0.5";
  } else {
    dotEl.className = "w-2.5 h-2.5 rounded-full bg-rose-500";
    statusEl.textContent = check.reason;
    statusEl.className = "text-xs font-semibold text-rose-600 mt-0.5 leading-snug";
  }
}

function renderTodayAttendanceCard() {
  const rec = state.todayAttendance;
  const badge = document.getElementById("today-status-badge");
  const inVal = document.getElementById("today-clockin-val");
  const outVal = document.getElementById("today-clockout-val");
  const actionTitle = document.getElementById("scan-action-title");
  const actionSub = document.getElementById("scan-action-subtitle");
  const scanBtn = document.getElementById("open-scanner-btn");
  const scanBtnLabel = document.getElementById("open-scanner-btn-label");
  const breakdownCard = document.getElementById("today-breakdown-card");

  if (!rec) {
    badge.textContent = "Not Clocked In";
    badge.className = "px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white/10 text-slate-200 border border-white/15";
    inVal.textContent = "--:--";
    outVal.textContent = "--:--";
    actionTitle.textContent = "Ready to Clock In";
    actionSub.textContent = "Scan the 20-second rotating QR code on the HRD Kiosk within office radius.";
    scanBtn.disabled = false;
    scanBtnLabel.textContent = "Scan QR to Clock In";
    breakdownCard.classList.add("hidden");
    return;
  }

  inVal.textContent = formatTimeShort(rec.clockInTime);
  outVal.textContent = formatTimeShort(rec.clockOutTime);

  const statusStyles = {
    on_time: ["On Time", "bg-emerald-500/20 text-emerald-200 border-emerald-400/30"],
    late: ["Late", "bg-amber-500/20 text-amber-200 border-amber-400/30"],
    leave: ["Approved Leave", "bg-sky-500/20 text-sky-200 border-sky-400/30"],
    alpha: ["Absent", "bg-rose-500/20 text-rose-200 border-rose-400/30"]
  };
  const [label, cls] = statusStyles[rec.status] || ["Recorded", "bg-white/10 text-white border-white/20"];
  badge.textContent = label;
  badge.className = `px-2.5 py-1 rounded-full text-[11px] font-semibold border ${cls}`;

  breakdownCard.classList.remove("hidden");
  document.getElementById("today-late-mins").textContent = `${rec.lateMinutes || 0} min`;
  document.getElementById("today-deduction-val").textContent = formatIDR(rec.deductionAmount || 0);
  document.getElementById("today-ot-mins").textContent = `${rec.overtimeMinutes || 0} min`;

  const otStatusLabel =
    rec.overtimeStatus === "auto_approved" || rec.overtimeStatus === "approved"
      ? formatIDR(rec.overtimePay || 0)
      : rec.overtimeStatus === "pending_approval"
        ? "Pending Approval"
        : "None";
  document.getElementById("today-ot-pay").textContent = otStatusLabel;

  if (rec.status === "leave") {
    actionTitle.textContent = "Approved Leave Today";
    actionSub.textContent = "Your leave/sick request covers today's attendance.";
    scanBtn.disabled = true;
    scanBtnLabel.textContent = "On Approved Leave";
  } else if (rec.clockInTime && !rec.clockOutTime) {
    actionTitle.textContent = "Currently Clocked In";
    actionSub.textContent = "Scan the live HRD Kiosk QR again when finishing your shift.";
    scanBtn.disabled = false;
    scanBtnLabel.textContent = "Scan QR to Clock Out";
  } else if (rec.clockInTime && rec.clockOutTime) {
    actionTitle.textContent = "Shift Completed";
    actionSub.textContent = `Clocked in at ${formatTimeShort(rec.clockInTime)} and out at ${formatTimeShort(rec.clockOutTime)}.`;
    scanBtn.disabled = true;
    scanBtnLabel.textContent = "Attendance Completed Today";
  }
}

function setupScannerModal() {
  const modal = document.getElementById("qr-scanner-modal");
  const panel = document.getElementById("qr-scanner-panel");
  const openBtn = document.getElementById("open-scanner-btn");
  const closeBtn = document.getElementById("close-scanner-btn");
  const geoStatusEl = document.getElementById("scanner-geo-status");
  const errorBox = document.getElementById("scanner-error-box");
  const laserEl = document.getElementById("scanner-laser-overlay");
  const titleEl = document.getElementById("scanner-modal-title");

  const closeModal = async () => {
    laserEl.classList.add("hidden");
    await state.scanner.stop();
    await animateModalClose(panel);
    modal.classList.add("hidden");
  };

  closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  openBtn.addEventListener("click", async () => {
    if (!navigator.onLine) {
      showToast("Internet connection required to validate live QR attendance.", "error");
      return;
    }

    const isClockOut = Boolean(state.todayAttendance?.clockInTime && !state.todayAttendance?.clockOutTime);
    titleEl.textContent = isClockOut ? "Scan QR to Clock Out" : "Scan QR to Clock In";
    errorBox.classList.add("hidden");

    modal.classList.remove("hidden");
    animateModalOpen(panel);

    geoStatusEl.className = "rounded-xl px-3 py-2 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100";
    geoStatusEl.textContent = "Verifying live GPS coordinates...";

    try {
      const coords = await getCurrentGpsPosition();
      state.latestGps = coords;
      evaluateAndShowGps(coords);

      const geoCheck = validateGeofence(coords, state.rules);
      if (!geoCheck.allowed) {
        geoStatusEl.className = "rounded-xl px-3 py-2 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200";
        geoStatusEl.textContent = geoCheck.reason;
        errorBox.textContent = "Attendance blocked: move inside the office geofence radius and try again.";
        errorBox.classList.remove("hidden");
        return;
      }

      geoStatusEl.className = "rounded-xl px-3 py-2 text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200";
      geoStatusEl.textContent = geoCheck.reason;

      laserEl.classList.remove("hidden");
      await state.scanner.start(
        async (decodedText) => {
          laserEl.classList.add("hidden");
          await processScannedAttendance(decodedText, closeModal, errorBox);
        },
        (cameraErr) => {
          laserEl.classList.add("hidden");
          errorBox.textContent = cameraErr;
          errorBox.classList.remove("hidden");
        }
      );
    } catch (err) {
      laserEl.classList.add("hidden");
      geoStatusEl.className = "rounded-xl px-3 py-2 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200";
      geoStatusEl.textContent = err.message;
      errorBox.textContent = err.message;
      errorBox.classList.remove("hidden");
    }
  });
}

async function processScannedAttendance(rawQrText, closeModal, errorBox) {
  try {
    // 1. Re-verify fresh GPS coordinates at scan moment
    const freshCoords = await getCurrentGpsPosition();
    const geoCheck = validateGeofence(freshCoords, state.rules);
    if (!geoCheck.allowed) {
      errorBox.textContent = geoCheck.reason;
      errorBox.classList.remove("hidden");
      showToast(geoCheck.reason, "error");
      return;
    }

    // 2. Verify live QR token & expiry in Firestore
    const qrCheck = await validateScannedQrToken(rawQrText);
    if (!qrCheck.valid) {
      errorBox.textContent = qrCheck.reason;
      errorBox.classList.remove("hidden");
      showToast(qrCheck.reason, "error");
      return;
    }

    const now = new Date();
    const dateKey = toLocalDateKey(now);
    const docId = `${state.user.uid}_${dateKey}`;
    const docRef = doc(db, "attendance", docId);
    const existingSnap = await getDoc(docRef);

    if (!existingSnap.exists()) {
      // CLOCK IN
      const evalIn = evaluateClockIn(now, state.rules, state.profile);
      await setDoc(docRef, {
        uid: state.user.uid,
        employeeName: state.profile.name || "Employee",
        employeeId: state.profile.employeeId || "-",
        department: state.profile.department || "General",
        date: dateKey,
        clockInTime: now.toISOString(),
        clockOutTime: null,
        clockInCoords: {
          lat: freshCoords.lat,
          lng: freshCoords.lng,
          accuracy: geoCheck.accuracy
        },
        clockOutCoords: null,
        distanceMeters: geoCheck.distanceMeters,
        status: evalIn.status,
        lateMinutes: evalIn.lateMinutes,
        deductionAmount: evalIn.deductionAmount,
        overtimeMinutes: 0,
        overtimePay: 0,
        overtimeStatus: "none",
        qrTokenUsed: qrCheck.token
      });

      await closeModal();
      const msg = evalIn.status === "late"
        ? `Clocked in (${evalIn.lateMinutes} min late, deduction ${formatIDR(evalIn.deductionAmount)}).`
        : "Clocked in on time! Have a productive shift.";
      showToast(msg, evalIn.status === "late" ? "warning" : "success", 4500);
    } else {
      const existing = existingSnap.data();
      if (existing.clockOutTime) {
        await closeModal();
        showToast("You have already clocked out today.", "info");
        return;
      }

      // Check if an approved overtime request exists for today
      const hasApprovedOt = state.myRequests.some(
        (r) =>
          r.type === "lembur" &&
          r.status === "approved" &&
          r.startDate <= dateKey &&
          (r.endDate || r.startDate) >= dateKey
      );

      const evalOut = evaluateClockOut(now, state.rules, state.profile, hasApprovedOt);

      await updateDoc(docRef, {
        clockOutTime: now.toISOString(),
        clockOutCoords: {
          lat: freshCoords.lat,
          lng: freshCoords.lng,
          accuracy: geoCheck.accuracy
        },
        clockOutDistanceMeters: geoCheck.distanceMeters,
        overtimeMinutes: evalOut.overtimeMinutes,
        overtimePay: evalOut.overtimePay,
        overtimeStatus: evalOut.overtimeStatus
      });

      await closeModal();
      let msg = `Clocked out at ${formatTimeShort(now)}.`;
      if (evalOut.overtimeMinutes > 0) {
        msg += evalOut.overtimeStatus === "pending_approval"
          ? ` ${evalOut.overtimeMinutes} min overtime recorded (pending HRD approval).`
          : ` ${evalOut.overtimeMinutes} min overtime (${formatIDR(evalOut.overtimePay)}).`;
      }
      showToast(msg, "success", 4500);
    }
  } catch (err) {
    console.error("[Attendance Scan Error]", err);
    errorBox.textContent = err.message || "Failed to submit attendance.";
    errorBox.classList.remove("hidden");
    showToast(err.message || "Attendance submission failed.", "error");
  }
}

function setupMonthPicker() {
  const picker = document.getElementById("history-month-picker");
  const now = new Date();
  picker.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  picker.addEventListener("change", renderHistoryList);
}

function renderHistoryList() {
  const monthPrefix = document.getElementById("history-month-picker").value;
  const listEl = document.getElementById("history-list");

  const filtered = state.allAttendance.filter((r) => !monthPrefix || (r.date || "").startsWith(monthPrefix));

  let present = 0;
  let late = 0;
  let deduction = 0;
  let otPay = 0;

  filtered.forEach((r) => {
    if (r.status === "on_time" || r.status === "late") present += 1;
    if (r.status === "late") late += 1;
    deduction += Number(r.deductionAmount || 0);
    if (r.overtimeStatus === "approved" || r.overtimeStatus === "auto_approved") {
      otPay += Number(r.overtimePay || 0);
    }
  });

  document.getElementById("hist-kpi-present").textContent = String(present);
  document.getElementById("hist-kpi-late").textContent = String(late);
  document.getElementById("hist-kpi-deduction").textContent = formatIDR(deduction);
  document.getElementById("hist-kpi-overtime").textContent = formatIDR(otPay);

  if (!filtered.length) {
    listEl.innerHTML = `<div class="bg-white rounded-2xl border border-slate-200 p-6 text-center text-xs text-slate-400">No attendance records for ${escapeHtml(monthPrefix || "this month")}.</div>`;
    return;
  }

  const badgeMap = {
    on_time: "bg-emerald-50 text-emerald-700 border-emerald-200",
    late: "bg-amber-50 text-amber-700 border-amber-200",
    leave: "bg-sky-50 text-sky-700 border-sky-200",
    alpha: "bg-rose-50 text-rose-700 border-rose-200"
  };

  listEl.innerHTML = filtered
    .map((r) => {
      const badgeCls = badgeMap[r.status] || "bg-slate-100 text-slate-700 border-slate-200";
      return `
        <article class="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-sm">
          <div class="flex items-center justify-between">
            <p class="text-xs font-bold text-slate-900 font-mono-num">${escapeHtml(r.date)}</p>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${badgeCls}">
              ${escapeHtml(String(r.status || "").replace("_", " "))}
            </span>
          </div>
          <div class="mt-2.5 grid grid-cols-3 gap-2 text-[11px] bg-slate-50 rounded-xl p-2 border border-slate-100">
            <div>
              <span class="text-slate-400 block">In</span>
              <span class="font-semibold text-slate-800 font-mono-num">${formatTimeShort(r.clockInTime)}</span>
            </div>
            <div>
              <span class="text-slate-400 block">Out</span>
              <span class="font-semibold text-slate-800 font-mono-num">${formatTimeShort(r.clockOutTime)}</span>
            </div>
            <div>
              <span class="text-slate-400 block">Distance</span>
              <span class="font-semibold text-slate-800 font-mono-num">${r.distanceMeters ?? "-"} m</span>
            </div>
          </div>
          ${
            (r.lateMinutes > 0 || r.overtimeMinutes > 0)
              ? `<div class="mt-2 flex items-center justify-between text-[11px]">
                  <span class="text-rose-600 font-medium">${r.lateMinutes > 0 ? `Late ${r.lateMinutes}m (-${formatIDR(r.deductionAmount)})` : ""}</span>
                  <span class="text-emerald-700 font-medium">${r.overtimeMinutes > 0 ? `OT ${r.overtimeMinutes}m (${r.overtimeStatus === "pending_approval" ? "Pending" : formatIDR(r.overtimePay)})` : ""}</span>
                 </div>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

/**
 * Compresses an uploaded image File using HTML5 Canvas until Base64 payload < 150 KB.
 * Avoids paid Firebase Storage entirely.
 * @param {File} file
 * @returns {Promise<{ base64: string, sizeBytes: number }>}
 */
function compressImageToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read selected image."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Selected file is not a valid image."));
      img.onload = () => {
        const MAX_BYTES = 150 * 1024;
        const maxDim = 1024;
        let width = img.width;
        let height = img.height;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        const tryCompress = (w, h, quality) => {
          canvas.width = w;
          canvas.height = h;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL("image/jpeg", quality);
        };

        const qualities = [0.78, 0.62, 0.48, 0.35];
        let result = tryCompress(width, height, 0.78);
        for (const q of qualities) {
          result = tryCompress(width, height, q);
          if (result.length <= MAX_BYTES) {
            resolve({ base64: result, sizeBytes: result.length });
            return;
          }
        }

        // Further downscale dimensions if still > 150KB
        const scaledW = Math.round(width * 0.65);
        const scaledH = Math.round(height * 0.65);
        result = tryCompress(scaledW, scaledH, 0.45);
        if (result.length > MAX_BYTES) {
          result = tryCompress(Math.round(scaledW * 0.7), Math.round(scaledH * 0.7), 0.38);
        }
        resolve({ base64: result, sizeBytes: result.length });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setupRequestForm() {
  const form = document.getElementById("employee-request-form");
  const startInput = document.getElementById("req-start-date");
  const endInput = document.getElementById("req-end-date");
  const typeSelect = document.getElementById("req-type");
  const fileInput = document.getElementById("req-attachment-input");
  const previewBox = document.getElementById("req-attachment-preview-box");
  const previewImg = document.getElementById("req-attachment-preview");
  const previewName = document.getElementById("req-attachment-name");
  const previewSize = document.getElementById("req-attachment-size");
  const removeBtn = document.getElementById("req-attachment-remove");

  const today = toLocalDateKey(new Date());
  startInput.value = today;
  endInput.value = today;

  typeSelect.addEventListener("change", () => {
    if (typeSelect.value === "lembur") {
      endInput.value = startInput.value;
    }
  });

  startInput.addEventListener("change", () => {
    if (endInput.value < startInput.value || typeSelect.value === "lembur") {
      endInput.value = startInput.value;
    }
  });

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { base64, sizeBytes } = await compressImageToBase64(file);
      state.compressedBase64 = base64;
      state.compressedName = file.name;
      previewImg.src = base64;
      previewName.textContent = file.name;
      previewSize.textContent = `Compressed: ${(sizeBytes / 1024).toFixed(1)} KB`;
      previewBox.classList.remove("hidden");
      showToast(`Image compressed to ${(sizeBytes / 1024).toFixed(1)} KB`, "success", 2500);
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  removeBtn.addEventListener("click", () => {
    state.compressedBase64 = null;
    state.compressedName = null;
    fileInput.value = "";
    previewBox.classList.add("hidden");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById("req-submit-btn");
    const type = typeSelect.value;
    const startDate = startInput.value;
    const endDate = endInput.value || startDate;
    const reason = document.getElementById("req-reason").value.trim();

    if (!startDate || !reason) {
      showToast("Please select a date and provide a reason.", "warning");
      return;
    }
    if (endDate < startDate) {
      showToast("End date cannot be earlier than start date.", "warning");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
      const newDocRef = doc(collection(db, "requests"));
      await setDoc(newDocRef, {
        uid: state.user.uid,
        employeeName: state.profile.name || "Employee",
        employeeId: state.profile.employeeId || "-",
        department: state.profile.department || "General",
        type,
        startDate,
        endDate,
        reason,
        attachmentBase64: state.compressedBase64 || null,
        status: "pending",
        reviewedBy: null,
        reviewNote: null,
        createdAt: new Date().toISOString()
      });

      form.reset();
      startInput.value = today;
      endInput.value = today;
      state.compressedBase64 = null;
      previewBox.classList.add("hidden");
      showToast("Request submitted to HRD for approval.", "success");
    } catch (err) {
      console.error("[Request Submit Error]", err);
      showToast("Failed to submit request: " + err.message, "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Request";
    }
  });
}

function renderMyRequests() {
  const listEl = document.getElementById("my-requests-list");
  if (!state.myRequests.length) {
    listEl.innerHTML = `<div class="bg-white rounded-2xl border border-slate-200 p-5 text-center text-xs text-slate-400">No leave or overtime requests submitted yet.</div>`;
    return;
  }

  const statusBadge = {
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-rose-50 text-rose-700 border-rose-200"
  };

  const typeLabels = {
    izin: "Izin",
    sakit: "Sakit",
    cuti: "Cuti",
    lembur: "Lembur (OT)"
  };

  listEl.innerHTML = state.myRequests
    .map((req) => {
      const cls = statusBadge[req.status] || statusBadge.pending;
      return `
        <article class="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-sm space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-slate-900">${escapeHtml(typeLabels[req.type] || req.type)}</span>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${cls}">${escapeHtml(req.status)}</span>
          </div>
          <p class="text-[11px] font-mono-num text-slate-500">
            ${escapeHtml(req.startDate)}${req.endDate && req.endDate !== req.startDate ? ` → ${escapeHtml(req.endDate)}` : ""}
          </p>
          <p class="text-xs text-slate-700 leading-relaxed">${escapeHtml(req.reason)}</p>
          ${
            req.attachmentBase64
              ? `<img src="${req.attachmentBase64}" alt="Attachment" class="w-20 h-20 object-cover rounded-xl border border-slate-200 mt-1" />`
              : ""
          }
          ${
            req.reviewNote
              ? `<div class="bg-slate-50 rounded-xl p-2 text-[11px] text-slate-600 border border-slate-100">
                  <span class="font-semibold">HRD Note:</span> ${escapeHtml(req.reviewNote)}
                 </div>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function populateProfileView() {
  const p = state.profile;
  const initials = (p.name || "EM")
    .split(" ")
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  document.getElementById("header-emp-name").textContent = p.name || "Employee";
  document.getElementById("header-emp-meta").textContent = `${p.employeeId || "-"} • ${p.department || "General"}`;

  document.getElementById("profile-avatar").textContent = initials;
  document.getElementById("profile-name").textContent = p.name || "-";
  document.getElementById("profile-email").textContent = p.email || "-";
  document.getElementById("profile-emp-id").textContent = p.employeeId || "EMP";
  document.getElementById("profile-dept").textContent = p.department || "-";
  document.getElementById("profile-pos").textContent = p.position || "-";
  document.getElementById("profile-daily-rate").textContent = formatIDR(p.dailyRate || 0);
  document.getElementById("profile-ot-rate").textContent = formatIDR(
    getEffectiveOvertimeHourlyRate(p, state.rules || {})
  );
}

function renderProfileSchedule() {
  if (!state.rules) return;
  const container = document.getElementById("profile-schedule-list");
  container.innerHTML = DAY_NAMES.map((day, idx) => {
    const slot = state.rules.schedules[String(idx)];
    return `
      <div class="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-none">
        <span class="font-medium text-slate-700">${day}</span>
        <span class="font-mono-num ${slot.isOff ? "text-slate-400" : "text-slate-900 font-semibold"}">
          ${slot.isOff ? "Off-Day" : `${slot.start} – ${slot.end}`}
        </span>
      </div>
    `;
  }).join("");
}
