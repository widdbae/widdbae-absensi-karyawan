/**
 * Authentication, Role-Based Access Guard & Shared UI Utilities
 * -------------------------------------------------------------
 */

import { auth, db, isFirebaseConfigured } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/**
 * Normalizes role values so both 'admin' and 'hrd_admin' map cleanly to HRD Admin.
 * @param {string} role
 * @returns {'admin'|'employee'}
 */
export function normalizeRole(role) {
  const val = String(role || "").toLowerCase().trim();
  if (val === "admin" || val === "hrd_admin") return "admin";
  return "employee";
}

/**
 * Signs in an existing user with email and password.
 * @param {string} email
 * @param {string} password
 */
export async function loginWithEmail(email, password) {
  if (!isFirebaseConfigured()) {
    throw new Error("Firebase is not configured yet. Please update js/firebase-config.js first.");
  }
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  const profile = await fetchUserProfile(cred.user.uid);
  if (!profile) {
    await signOut(auth);
    throw new Error("Account profile not found in Firestore (users collection). Contact HRD Admin.");
  }
  if (profile.isActive === false) {
    await signOut(auth);
    throw new Error("Your employee account has been deactivated. Contact HRD Admin.");
  }
  return { user: cred.user, profile };
}

/**
 * Sends a password reset email.
 * @param {string} email
 */
export async function requestPasswordReset(email) {
  if (!isFirebaseConfigured()) {
    throw new Error("Firebase is not configured yet.");
  }
  await sendPasswordResetEmail(auth, email.trim());
}

/**
 * Signs out the current user and redirects to login page.
 */
export async function logoutUser() {
  await signOut(auth);
  window.location.href = "index.html";
}

/**
 * Fetches the Firestore user profile document at `users/{uid}`.
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
export async function fetchUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  return { uid: snap.id, ...snap.data() };
}

/**
 * Role-based access guard for protected pages (`admin.html`, `app.html`) and login (`index.html`).
 *
 * @param {object} options
 * @param {'guest'|'admin'|'employee'} options.requiredRole
 * @param {function(object): void} [options.onAuthenticated]
 * @param {function(): void} [options.onUnauthenticated]
 * @param {function(Error): void} [options.onError]
 */
export function guardRoute({ requiredRole, onAuthenticated, onUnauthenticated, onError }) {
  if (!isFirebaseConfigured()) {
    if (requiredRole !== "guest") {
      window.location.href = "index.html";
      return;
    }
    if (onUnauthenticated) onUnauthenticated();
    return;
  }

  onAuthStateChanged(auth, async (firebaseUser) => {
    try {
      if (!firebaseUser) {
        if (requiredRole !== "guest") {
          window.location.href = "index.html";
          return;
        }
        if (onUnauthenticated) onUnauthenticated();
        return;
      }

      const profile = await fetchUserProfile(firebaseUser.uid);
      if (!profile) {
        await signOut(auth);
        const err = new Error("User profile missing in Firestore. Please contact HRD.");
        if (onError) onError(err);
        if (requiredRole !== "guest") window.location.href = "index.html";
        return;
      }

      if (profile.isActive === false) {
        await signOut(auth);
        const err = new Error("Account is inactive. Please contact HRD.");
        if (onError) onError(err);
        if (requiredRole !== "guest") window.location.href = "index.html";
        return;
      }

      const role = normalizeRole(profile.role);

      if (requiredRole === "guest") {
        window.location.href = role === "admin" ? "admin.html" : "app.html";
        return;
      }

      if (requiredRole === "admin" && role !== "admin") {
        window.location.href = "app.html";
        return;
      }

      if (requiredRole === "employee" && role === "admin") {
        // Admins visiting app.html are routed to admin.html unless explicitly allowed
        window.location.href = "admin.html";
        return;
      }

      if (onAuthenticated) {
        onAuthenticated({ user: firebaseUser, profile: { ...profile, normalizedRole: role } });
      }
    } catch (err) {
      console.error("[Auth Guard Error]", err);
      if (onError) onError(err);
    }
  });
}

/**
 * Formats Firebase Auth error codes into human-friendly messages.
 * @param {Error} err
 * @returns {string}
 */
export function formatAuthError(err) {
  const code = err?.code || "";
  switch (code) {
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/user-disabled":
      return "This account has been disabled in Firebase Authentication.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Invalid email or password. Please check your credentials.";
    case "auth/too-many-requests":
      return "Too many failed login attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network error. Please check your internet connection.";
    case "auth/email-already-in-use":
      return "This email address is already registered.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    default:
      return err?.message || "Authentication failed. Please try again.";
  }
}

/**
 * Displays a non-blocking enterprise toast notification.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 * @param {number} [durationMs]
 */
export function showToast(message, type = "info", durationMs = 3800) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm w-[calc(100%-2rem)] sm:w-96 pointer-events-none";
    document.body.appendChild(container);
  }

  const palette = {
    success: "bg-emerald-600 text-white border-emerald-500",
    error: "bg-rose-600 text-white border-rose-500",
    warning: "bg-amber-500 text-slate-950 border-amber-400",
    info: "bg-slate-900 text-white border-slate-700"
  };

  const icons = {
    success: `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
    error: `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86l-7.5 13A1 1 0 003.65 18h16.7a1 1 0 00.86-1.5l-7.5-13a1 1 0 00-1.72 0z"/></svg>`,
    warning: `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    info: `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
  };

  const toast = document.createElement("div");
  toast.className = `pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-xl text-sm font-medium transition-all duration-200 translate-y-2 opacity-0 ${palette[type] || palette.info}`;
  toast.innerHTML = `
    ${icons[type] || icons.info}
    <span class="flex-1 leading-snug">${escapeHtml(message)}</span>
    <button type="button" aria-label="Close notification" class="opacity-75 hover:opacity-100 ml-1 shrink-0">&times;</button>
  `;

  const removeToast = () => {
    toast.classList.add("opacity-0", "translate-y-2");
    setTimeout(() => toast.remove(), 200);
  };

  toast.querySelector("button").addEventListener("click", removeToast);
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove("opacity-0", "translate-y-2");
  });

  if (durationMs > 0) {
    setTimeout(removeToast, durationMs);
  }
}

/**
 * Attaches an automatic network connectivity banner for offline resilience.
 */
export function initNetworkMonitor() {
  const bannerId = "network-offline-banner";
  const updateState = () => {
    let banner = document.getElementById(bannerId);
    if (!navigator.onLine) {
      if (!banner) {
        banner = document.createElement("div");
        banner.id = bannerId;
        banner.className = "fixed bottom-4 left-1/2 -translate-x-1/2 z-[9998] bg-amber-500 text-slate-950 px-4 py-2 rounded-full shadow-lg text-xs font-semibold flex items-center gap-2";
        banner.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-950 animate-pulse"></span><span>Offline mode — cached data shown. Live QR validation requires internet.</span>`;
        document.body.appendChild(banner);
      }
    } else if (banner) {
      banner.remove();
      showToast("Internet connection restored.", "success", 2500);
    }
  };

  window.addEventListener("online", updateState);
  window.addEventListener("offline", updateState);
  if (!navigator.onLine) updateState();
}

/**
 * Escapes HTML special characters to prevent XSS in template rendering.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Formats an integer amount in Indonesian Rupiah (IDR).
 * @param {number} amount
 * @returns {string}
 */
export function formatIDR(amount) {
  const num = Number(amount || 0);
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(num);
}

/**
 * Returns local date string in `YYYY-MM-DD` format.
 * @param {Date} [date]
 * @returns {string}
 */
export function toLocalDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Formats a timestamp (ISO string, epoch ms, or Firestore Timestamp) into `HH:mm`.
 * @param {string|number|object|null} value
 * @returns {string}
 */
export function formatTimeShort(value) {
  if (!value) return "--:--";
  const date = toDateObject(value);
  if (!date || Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Converts ISO string, epoch ms, or Firestore Timestamp to JS Date.
 * @param {string|number|object|null} value
 * @returns {Date|null}
 */
export function toDateObject(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && typeof value.toDate === "function") return value.toDate();
  if (typeof value === "object" && typeof value.seconds === "number") return new Date(value.seconds * 1000);
  return new Date(value);
}
