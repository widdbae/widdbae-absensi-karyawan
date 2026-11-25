/**
 * Firebase Modular SDK v10+ Initialization & Configuration
 * --------------------------------------------------------
 * Replace the placeholder values below with your Firebase project config
 * from Firebase Console -> Project Settings -> Your Apps -> Web App.
 */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDa8D0B2F8ufAfdh_5jMYfeJK3c68Kfauk",
  authDomain: "absensi-karyawan-6f218.firebaseapp.com",
  projectId: "absensi-karyawan-6f218",
  storageBucket: "absensi-karyawan-6f218.firebasestorage.app",
  messagingSenderId: "342303388436",
  appId: "1:342303388436:web:8bb89e6a34b2ff622fc801"
};

/**
 * Checks whether the Firebase configuration has been replaced with real project keys.
 * @returns {boolean}
 */
export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey &&
    !firebaseConfig.apiKey.startsWith("YOUR_") &&
    firebaseConfig.projectId &&
    !firebaseConfig.projectId.startsWith("YOUR_")
  );
}

// Primary Firebase App
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// Firebase Auth with local browser persistence
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {
  // Fallback gracefully if third-party storage is restricted
});

// Cloud Firestore with offline IndexedDB persistence where supported
let dbInstance;
try {
  dbInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
} catch {
  dbInstance = getFirestore(app);
}
export const db = dbInstance;

/**
 * Returns a secondary Firebase Auth instance used solely by HRD Admins to
 * create new employee accounts without signing out their current admin session.
 */
export function getSecondaryAuth() {
  const secondaryName = "AdminEmployeeProvisioner";
  const existing = getApps().find((a) => a.name === secondaryName);
  const secondaryApp = existing || initializeApp(firebaseConfig, secondaryName);
  return getAuth(secondaryApp);
}
