# PulseHR — Employee Attendance & HR Management Suite

A 100% free-tier, zero-build, pure client-side **Employee Attendance & HR Management Web Application** built with **HTML5, Tailwind CSS, Vanilla JavaScript (ES6+ Modules), Firebase Authentication, and Cloud Firestore**.

Designed for seamless deployment to **Vercel**, **Netlify**, or **Firebase Hosting** with zero paid backend dependencies.

---

## Key Features

- **Dual-Interface Role-Based Routing (`index.html`, `app.html`, `admin.html`):**
  - **Employee Portal (`app.html`):** Mobile-first UX (`max-w-md` centered on desktop, full viewport on mobile) with bottom navigation (`Home/Scan`, `History`, `Leave/OT`, `Profile`).
  - **HRD Admin Dashboard (`admin.html`):** Desktop-first sidebar command center (`Dashboard Overview`, `Live QR Kiosk`, `Attendance Logs`, `Leave & OT Approvals`, `Employee Management`, `Dynamic Rules & Geofence`).
- **Dual-Factor Attendance Validation:**
  - **Dynamic 20-Second QR Kiosk:** Uses `qrcodejs` to rotate a cryptographic token stored in `settings/active_qr` with a live countdown ring, validating both `token` match and `expiresAt` timestamp to block screenshot sharing.
  - **Geofencing (Haversine Formula):** Uses the HTML5 Geolocation API to compute exact meter distance from office coordinates and blocks clock-in/out when outside radius or when GPS accuracy indicates spoofing/low precision.
- **Dynamic HRD Rules Engine (`settings/attendance_rules`):**
  - Day-by-day shift schedule (default: Mon–Thu & Sat `07:00–15:00`, Fri `07:00–15:30`, Sun Off-Day).
  - Editable grace period & lateness deduction toggle with 3 selectable modes: **Per-Minute Rate**, **Tiered Brackets**, or **Percentage of Daily Rate**.
  - Configurable overtime mode (**Auto-Calculated** vs **Approval-Required**), minimum threshold minutes, and hourly rate/multiplier.
- **Zero-Cost Sick/Leave Attachments:**
  - Built-in HTML5 Canvas image resizing & JPEG compression keeping uploaded doctor's notes strictly **< 150 KB** Base64 inside Firestore—no paid Firebase Storage needed.
- **Monthly Recap & One-Click Exports:**
  - Filterable by month, department, employee, and status.
  - Exports formatted multi-sheet **Excel (`.xlsx`)** via SheetJS and landscape **PDF (`.pdf`)** via `jsPDF` + `jspdf-autotable`.
- **Smooth Motion & Scroll Architecture:**
  - **Lenis** smooth scrolling on the desktop HRD dashboard, **GSAP + ScrollTrigger** scroll reveals, and **Motion One (ESM)** micro-interactions and modals.

---

## Step-by-Step Firebase Setup (100% Free Spark Plan)

### 1. Create Your Firebase Project
1. Go to the [Firebase Console](https://console.firebase.google.com/) and click **Add project**.
2. Keep the default **Spark (Free)** plan.
3. In the left menu, open **Build → Authentication → Get started**, then enable the **Email/Password** sign-in provider.
4. Open **Build → Firestore Database → Create database**, choose **Start in production mode**, and select a region close to your office (e.g., `asia-southeast2` for Jakarta).

### 2. Paste Your Firebase Config Keys
1. In Firebase Console, go to **Project Settings (gear icon) → Your apps → Web (`</>`)** and register a web app (no Hosting setup required yet).
2. Copy the `firebaseConfig` object and paste your keys into [`js/firebase-config.js`](js/firebase-config.js):

```js
export const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef..."
};
```

### 3. Deploy Firestore Security Rules
1. In Firebase Console, go to **Firestore Database → Rules**.
2. Copy the entire contents of [`firestore.rules`](firestore.rules) into the editor and click **Publish**.

### 4. Create the First HRD Admin Account
Because employee provisioning happens inside the HRD Admin Dashboard, create your first HRD Admin account manually in the Firebase Console:

1. Open **Authentication → Users → Add user** and enter your admin email and password (e.g., `hrd@company.com`).
2. Copy the newly generated **User UID** from the Authentication table.
3. Open **Firestore Database → Data → Start collection**:
   - Collection ID: `users`
   - Document ID: `<paste the User UID here>`
   - Add these fields:
     - `name` (string): `"HRD Administrator"`
     - `employeeId` (string): `"HRD-001"`
     - `email` (string): `"hrd@company.com"`
     - `role` (string): `"admin"`
     - `department` (string): `"Human Resources"`
     - `position` (string): `"HRD Manager"`
     - `dailyRate` (number): `400000`
     - `hourlyOvertimeRate` (number): `60000`
     - `isActive` (boolean): `true`
4. Sign in at `index.html` with that email/password. You will be routed directly to `admin.html`.
5. Inside **Dynamic Rules & Geofence**, click **Use My Current GPS** (or enter your office coordinates) and click **Save All HRD Rules**.
6. Inside **Employee Management**, use **+ Add Employee** to create employee accounts without signing out of your admin session.

---

## Local Development & Testing

> **Important:** Because this app uses ES6 Modules (`<script type="module">`), camera scanning, and GPS geolocation, always serve over a local HTTP server (not `file://`). Camera & GPS work on `http://localhost` and require **HTTPS** in production.

```bash
# Option 1: Node.js
npx serve .

# Option 2: Python 3
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html` (or whatever port is printed).

---

## Free Deployment Guide

### Option A: Deploy to Vercel (Recommended)
1. Push this folder to a GitHub/GitLab/Bitbucket repository (or install the Vercel CLI).
2. Go to [vercel.com](https://vercel.com), click **Add New → Project**, and import your repository.
3. Leave Framework Preset as **Other** and Build Command empty (static files).
4. Click **Deploy**. [`vercel.json`](vercel.json) automatically applies `camera` and `geolocation` permission headers over HTTPS.

### Option B: Deploy to Netlify
1. Log in to [app.netlify.com](https://app.netlify.com).
2. Drag and drop the project folder onto the **Sites** dropzone, or connect your Git repository with an empty build command and publish directory `.`.
3. Netlify automatically serves the site over HTTPS.

### Option C: Deploy to Firebase Hosting
```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # Choose existing project, public directory: ".", single-page rewrite: No
firebase deploy --only hosting,firestore:rules
```
