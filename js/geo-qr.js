/**
 * Dual-Factor Attendance Validation: Dynamic QR + Geofencing
 * ----------------------------------------------------------
 * 1. Haversine Formula for exact Earth-surface distance in meters
 * 2. HTML5 Geolocation API validator with anti-spoof / accuracy checks
 * 3. Dynamic QR Kiosk generator (`qrcodejs`) rotating every 20 seconds in Firestore
 * 4. Employee QR Scanner (`html5-qrcode`) verifying both token match & expiration
 */

import { db } from "./firebase-config.js";
import {
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const QR_ROTATION_SECONDS = 20;

/**
 * Calculates the exact distance in meters between two GPS coordinates using the Haversine formula.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in meters
 */
export function calculateHaversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Requests live high-accuracy GPS position via HTML5 Geolocation API.
 * @param {number} [timeoutMs]
 * @returns {Promise<{ lat: number, lng: number, accuracy: number, timestamp: number }>}
 */
export function getCurrentGpsPosition(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation is not supported by this device or browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          reject(new Error("Invalid GPS coordinates received from device."));
          return;
        }
        if (latitude === 0 && longitude === 0) {
          reject(new Error("GPS returned null island (0, 0). Possible GPS spoofing or sensor failure."));
          return;
        }
        resolve({
          lat: latitude,
          lng: longitude,
          accuracy: Number.isFinite(accuracy) ? accuracy : 9999,
          timestamp: pos.timestamp || Date.now()
        });
      },
      (err) => {
        switch (err.code) {
          case err.PERMISSION_DENIED:
            reject(new Error("Location permission denied. Enable GPS access in browser settings to clock in/out."));
            break;
          case err.POSITION_UNAVAILABLE:
            reject(new Error("GPS signal unavailable. Please step near a window or enable High Accuracy Location."));
            break;
          case err.TIMEOUT:
            reject(new Error("GPS request timed out. Please retry with location services enabled."));
            break;
          default:
            reject(new Error(err.message || "Unable to retrieve GPS location."));
        }
      },
      {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0
      }
    );
  });
}

/**
 * Validates employee GPS coordinates against HRD office geofence & accuracy rules.
 *
 * @param {{ lat: number, lng: number, accuracy: number }} coords
 * @param {object} rules
 * @returns {{
 *   allowed: boolean,
 *   distanceMeters: number,
 *   maxRadiusMeters: number,
 *   accuracy: number,
 *   reason: string
 * }}
 */
export function validateGeofence(coords, rules) {
  const officeLat = Number(rules?.officeLat);
  const officeLng = Number(rules?.officeLng);
  const maxRadius = Number(rules?.maxRadiusMeters ?? 50);
  const maxAccuracy = Number(rules?.maxGpsAccuracyMeters ?? 150);

  if (!Number.isFinite(officeLat) || !Number.isFinite(officeLng)) {
    return {
      allowed: false,
      distanceMeters: 0,
      maxRadiusMeters: maxRadius,
      accuracy: coords.accuracy,
      reason: "Office coordinates have not been configured by HRD Admin."
    };
  }

  if (coords.accuracy > maxAccuracy) {
    return {
      allowed: false,
      distanceMeters: Math.round(calculateHaversineDistance(coords.lat, coords.lng, officeLat, officeLng)),
      maxRadiusMeters: maxRadius,
      accuracy: Math.round(coords.accuracy),
      reason: `GPS accuracy too low (±${Math.round(coords.accuracy)}m). Max allowed inaccuracy is ${maxAccuracy}m. Disable mock/VPN location apps and try outdoors.`
    };
  }

  const distance = calculateHaversineDistance(coords.lat, coords.lng, officeLat, officeLng);
  const roundedDistance = Math.round(distance * 10) / 10;

  if (distance > maxRadius) {
    return {
      allowed: false,
      distanceMeters: roundedDistance,
      maxRadiusMeters: maxRadius,
      accuracy: Math.round(coords.accuracy),
      reason: `Outside office geofence: You are ${roundedDistance}m away from the office (max allowed: ${maxRadius}m).`
    };
  }

  return {
    allowed: true,
    distanceMeters: roundedDistance,
    maxRadiusMeters: maxRadius,
    accuracy: Math.round(coords.accuracy),
    reason: `Verified within geofence (${roundedDistance}m from office).`
  };
}

/**
 * Generates a cryptographically strong random token string.
 * @returns {string}
 */
function generateSecureToken() {
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Dynamic QR Kiosk Controller for HRD Admin Screen.
 * Rotates `settings/active_qr` every 20 seconds and drives the visual countdown ring.
 */
export class DynamicQrKiosk {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.qrContainer - Element where QRCode renders
   * @param {HTMLElement} [opts.countdownTextEl]
   * @param {SVGCircleElement} [opts.ringProgressEl]
   * @param {HTMLElement} [opts.tokenPreviewEl]
   * @param {HTMLElement} [opts.expiresAtEl]
   * @param {function(object): void} [opts.onRotate]
   * @param {function(Error): void} [opts.onError]
   */
  constructor(opts) {
    this.qrContainer = opts.qrContainer;
    this.countdownTextEl = opts.countdownTextEl;
    this.ringProgressEl = opts.ringProgressEl;
    this.tokenPreviewEl = opts.tokenPreviewEl;
    this.expiresAtEl = opts.expiresAtEl;
    this.onRotate = opts.onRotate;
    this.onError = opts.onError;

    this.running = false;
    this.tickTimer = null;
    this.currentExpiresAt = 0;
    this.isRotating = false;
    this.ringCircumference = 2 * Math.PI * 52; // r=52 in SVG
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (this.ringProgressEl) {
      this.ringProgressEl.style.strokeDasharray = `${this.ringCircumference}`;
      this.ringProgressEl.style.strokeDashoffset = "0";
    }
    await this.rotateNow();
    this.tickTimer = setInterval(() => this.tick(), 250);
  }

  stop() {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async rotateNow() {
    if (this.isRotating) return;
    this.isRotating = true;
    try {
      const now = Date.now();
      const expiresAt = now + QR_ROTATION_SECONDS * 1000;
      const token = generateSecureToken();

      const payload = {
        token,
        generatedAt: now,
        expiresAt,
        generatedAtIso: new Date(now).toISOString(),
        expiresAtIso: new Date(expiresAt).toISOString()
      };

      await setDoc(doc(db, "settings", "active_qr"), payload);

      this.currentExpiresAt = expiresAt;
      this.renderQrCode(JSON.stringify({ app: "absensi-hr", token, exp: expiresAt }));

      if (this.tokenPreviewEl) {
        this.tokenPreviewEl.textContent = `${token.slice(0, 8)}••••${token.slice(-6)}`;
      }
      if (this.expiresAtEl) {
        this.expiresAtEl.textContent = new Date(expiresAt).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
      }
      if (this.onRotate) this.onRotate(payload);
    } catch (err) {
      console.error("[QR Kiosk] Failed to rotate token:", err);
      if (this.onError) this.onError(err);
    } finally {
      this.isRotating = false;
    }
  }

  renderQrCode(textPayload) {
    if (!this.qrContainer) return;
    this.qrContainer.innerHTML = "";
    if (typeof window.QRCode !== "function") {
      this.qrContainer.innerHTML = `<div class="p-6 text-rose-600 text-sm font-medium">QRCode library failed to load. Check internet connection.</div>`;
      return;
    }
    new window.QRCode(this.qrContainer, {
      text: textPayload,
      width: 248,
      height: 248,
      colorDark: "#0f172a",
      colorLight: "#ffffff",
      correctLevel: window.QRCode.CorrectLevel.M
    });
  }

  tick() {
    if (!this.running || !this.currentExpiresAt) return;
    const remainingMs = Math.max(0, this.currentExpiresAt - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    const ratio = remainingMs / (QR_ROTATION_SECONDS * 1000);

    if (this.countdownTextEl) {
      this.countdownTextEl.textContent = `${remainingSec}s`;
    }
    if (this.ringProgressEl) {
      const offset = this.ringCircumference * (1 - ratio);
      this.ringProgressEl.style.strokeDashoffset = String(offset);
      if (remainingSec <= 5) {
        this.ringProgressEl.setAttribute("stroke", "#f59e0b");
      } else {
        this.ringProgressEl.setAttribute("stroke", "#2563eb");
      }
    }

    if (remainingMs <= 0 && !this.isRotating) {
      this.rotateNow();
    }
  }
}

/**
 * Parses a scanned QR text string and validates it against Firestore `settings/active_qr`.
 * Enforces both exact token match and server-persisted `expiresAt` timestamp.
 *
 * @param {string} rawQrText
 * @returns {Promise<{ valid: boolean, token: string, reason?: string }>}
 */
export async function validateScannedQrToken(rawQrText) {
  if (!navigator.onLine) {
    throw new Error("Internet connection is required to verify the live QR code.");
  }

  let scannedToken = "";
  try {
    const parsed = JSON.parse(rawQrText);
    if (parsed && typeof parsed.token === "string") {
      scannedToken = parsed.token.trim();
    }
  } catch {
    // Allow plain token string fallback if needed
    scannedToken = String(rawQrText || "").trim();
  }

  if (!scannedToken) {
    return { valid: false, token: "", reason: "Unrecognized QR code format. Scan the official HRD Kiosk QR." };
  }

  const snap = await getDoc(doc(db, "settings", "active_qr"));
  if (!snap.exists()) {
    return { valid: false, token: scannedToken, reason: "No active QR session found. Ask HRD to open the Live QR Kiosk." };
  }

  const activeQr = snap.data();
  const now = Date.now();

  if (scannedToken !== activeQr.token) {
    return {
      valid: false,
      token: scannedToken,
      reason: "QR code mismatch or outdated screenshot. Please scan the live rotating QR on the Kiosk screen."
    };
  }

  if (!activeQr.expiresAt || now > Number(activeQr.expiresAt)) {
    return {
      valid: false,
      token: scannedToken,
      reason: "This QR code has expired (20-second limit). Wait for the next code and scan again."
    };
  }

  return { valid: true, token: scannedToken };
}

/**
 * Wrapper around `html5-qrcode` for clean mobile camera scanning lifecycle & permission error handling.
 */
export class EmployeeQrScanner {
  /**
   * @param {string} elementId
   */
  constructor(elementId) {
    this.elementId = elementId;
    this.scanner = null;
    this.isScanning = false;
  }

  /**
   * Starts rear camera QR scanning.
   * @param {function(string): void} onDecoded
   * @param {function(string): void} [onStatusError]
   */
  async start(onDecoded, onStatusError) {
    if (this.isScanning) return;

    if (typeof window.Html5Qrcode !== "function") {
      throw new Error("QR Scanner library failed to load. Check your network connection.");
    }

    if (!window.isSecureContext && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
      throw new Error("Camera access requires HTTPS. Please deploy or serve over HTTPS.");
    }

    this.scanner = new window.Html5Qrcode(this.elementId);
    let handledOnce = false;

    const config = {
      fps: 10,
      qrbox: { width: 220, height: 220 },
      aspectRatio: 1.0
    };

    const successCb = async (decodedText) => {
      if (handledOnce) return;
      handledOnce = true;
      await this.stop();
      onDecoded(decodedText);
    };

    const errorCb = () => {
      // Frame-by-frame decode misses are normal; ignore silently
    };

    try {
      this.isScanning = true;
      await this.scanner.start({ facingMode: "environment" }, config, successCb, errorCb);
    } catch (err) {
      this.isScanning = false;
      const msg = String(err?.message || err || "");
      if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("notallowed")) {
        const friendly = "Camera permission denied. Please allow camera access in your browser settings to scan the QR code.";
        if (onStatusError) onStatusError(friendly);
        throw new Error(friendly);
      }
      if (msg.toLowerCase().includes("notfound") || msg.toLowerCase().includes("no device")) {
        const friendly = "No camera detected on this device.";
        if (onStatusError) onStatusError(friendly);
        throw new Error(friendly);
      }
      if (onStatusError) onStatusError(msg || "Unable to start camera.");
      throw new Error(msg || "Unable to start camera.");
    }
  }

  async stop() {
    if (!this.scanner) return;
    try {
      if (this.isScanning) {
        await this.scanner.stop();
      }
      this.scanner.clear();
    } catch {
      // Ignore cleanup errors if stream already stopped
    } finally {
      this.isScanning = false;
      this.scanner = null;
    }
  }
}
