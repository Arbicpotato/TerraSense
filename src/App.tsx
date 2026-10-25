import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Capacitor, registerPlugin } from "@capacitor/core"
import { FirebaseAuthentication } from "@capacitor-firebase/authentication"
import {
  GoogleAuthProvider, signInWithCredential, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  updateProfile, onAuthStateChanged, signOut, type User,
} from "firebase/auth"
import { auth, db, firestore } from "./firebase"
  import { doc, setDoc, getDoc, getDocs, deleteDoc, deleteField, collection, serverTimestamp } from "firebase/firestore"
import { ref, onValue, set, remove, update, query, limitToLast,get } from "firebase/database"
import { BleClient, dataViewToText } from "@capacitor-community/bluetooth-le"
import { LocalNotifications } from "@capacitor/local-notifications"
import { Haptics } from "@capacitor/haptics"



async function googleSignIn() {
  if (Capacitor.isNativePlatform()) {
    const result = await FirebaseAuthentication.signInWithGoogle()

    if (!result.credential?.idToken) {
      throw new Error("Google sign-in did not return an ID token")
    }

    const credential = GoogleAuthProvider.credential(
      result.credential.idToken
    )

    await signInWithCredential(auth, credential)
  } else {
    await signInWithPopup(auth, new GoogleAuthProvider())
  }
}

const GH_ID_PATTERN = /^TS-GH-[A-Z0-9]{4,}$/

function isPermissionError(e: any) {
  return /permission[_ ]denied/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`)
}

/**
 * Claims a TerraSense hub (ESP32) for the signed-in user.
 * The ESP32 registers itself and a secret claim code in the database; the security
 * rules only accept ownerUid = <this user> if the code matches the device's code.
 */
async function claimGreenhouse(
  uid: string,
  input: { id: string; code: string; name: string; location: string }
) {
  const id = input.id.trim().toUpperCase()
  const code = input.code.trim().toUpperCase()

  if (!GH_ID_PATTERN.test(id)) throw new Error("Enter a valid ID in the format TS-GH-XXXX.")
  if (!code) throw new Error("Enter the claim code printed on your TerraSense hub.")
    
  try {
    await set(ref(db, `claims/${id}/${uid}`), code)

    let alreadyMine = false
    try {
      alreadyMine = (await get(ref(db, `greenhouses/${id}/ownerUid`))).val() === uid
    } catch {}
    if (!alreadyMine) await set(ref(db, `greenhouses/${id}/ownerUid`), uid)

    await set(ref(db, `userGreenhouses/${uid}/${id}`), true)

    // The same owner setting the hub up again (new Wi-Fi, reinstalled app) must not break a running plant cycle,
    // so their greenhouse record is kept. A new owner starts clean: the plan only ends when the owner is removed.
    let hasMeta = false
    if (alreadyMine) {
      try { hasMeta = (await get(ref(db, `greenhouses/${id}/meta/name`))).exists() } catch {}
    }
    if (!hasMeta) {
      await set(ref(db, `greenhouses/${id}/meta`), {
        name: input.name.trim() || `Greenhouse ${id.slice(-4)}`,
        location: input.location.trim() || "Location not set",
        crop: "No crop selected",
        stage: "Setup",
      })
    } else if (input.name.trim()) {
      await update(ref(db, `greenhouses/${id}/meta`), { name: input.name.trim() })
    }

    // Removing a hub clears its record in the database, but this user's plant cycle is kept on their
    // account (see the plan backup effect in App). Put it back, so the cycle carries on where it was.
    try {
      const backup = await getDoc(doc(firestore, "users", uid, "devices", id))
      const plan: any = backup.exists() ? backup.data().plan : undefined
      if (plan && plan.stages) {
        const planAlready = (await get(ref(db, `greenhouses/${id}/meta/plan`))).exists()
        if (!planAlready) await set(ref(db, `greenhouses/${id}/meta/plan`), plan)
      }
    } catch (e) {
      console.error("Plant cycle restore failed:", e)
    }
  } catch (e) {
    if (isPermissionError(e)) {
      throw new Error(
        "Couldn't claim this greenhouse. Check the ID and claim code, or it may already belong to another account."
      )
    }
    throw e
  } finally {
    remove(ref(db, `claims/${id}/${uid}`)).catch(() => {})
  }

  return id
}

/**
 * Unlinks a greenhouse from the signed-in user.
 * Order matters: the database rules check ownerUid, so it is removed last.
 */
async function unlinkGreenhouse(uid: string, id: string) {
  const base = `greenhouses/${id}`
  try {
    await remove(ref(db, `userGreenhouses/${uid}/${id}`))
    // Clean-up is best effort: a failure here must never block releasing ownership
    for (const child of ["controls", "live", "history", "meta"]) {
      await remove(ref(db, `${base}/${child}`)).catch(() => {})
    }
    // Last: the other rules check ownerUid, so it has to go after everything else
    await remove(ref(db, `${base}/ownerUid`))
  } catch (e) {
    if (isPermissionError(e)) throw new Error("You don't have permission to remove this greenhouse.")
    throw e
  }
}

// ---- Bluetooth setup: the hub has no Wi-Fi yet, so the phone hands it the credentials ----
const BLE_SERVICE = "7e1a0001-5c0b-4b8e-9d3a-2f4b6c7d8e90"
const BLE_PROV    = "7e1a0002-5c0b-4b8e-9d3a-2f4b6c7d8e90"
const BLE_STATUS  = "7e1a0003-5c0b-4b8e-9d3a-2f4b6c7d8e90"

const bleErrors: Record<string, string> = {
  "error:bad_code": "That claim code doesn't match this hub.",
  "error:wifi_failed": "The hub couldn't join that Wi-Fi. Check the name and password (it must be 2.4 GHz).",
  "error:bad_json": "Setup data got garbled. Please try again.",
  "error:bad_ssid": "Enter a valid Wi-Fi network name.",
}

async function findHub(id: string, onStep: (message: string) => void): Promise<string> {
  const wanted = `TerraSense-${id.slice(6)}`

  await BleClient.initialize({ androidNeverForLocation: true })

  try {
    if (Capacitor.getPlatform() === "android" && !(await BleClient.isEnabled())) {
      await BleClient.enable()
    }
  } catch {
    throw new Error("Bluetooth is off. Turn it on and try again.")
  }

  onStep("Looking for your hub…")
  const seen = new Set<string>()
  const result = { deviceId: "" }

  await BleClient.requestLEScan({ services: [BLE_SERVICE] }, (r) => {
    const name = r.localName ?? r.device.name ?? ""
    if (name) seen.add(name)
    if (name === wanted) result.deviceId = r.device.deviceId
  })

  for (let i = 0; i < 10 && !result.deviceId; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  await BleClient.stopLEScan().catch(() => {})

  if (result.deviceId) return result.deviceId

  if (seen.size > 0) {
    throw new Error(`Found a TerraSense hub named "${[...seen].join(", ")}", but not "${wanted}". Check the greenhouse ID.`)
  }
  throw new Error("No hub found. Check that it is powered on and nearby, that Bluetooth is on, and that the app has Nearby devices permission.")
}

async function provisionHubOverBle(
  ghId: string, code: string, ssid: string, pass: string, onStep: (message: string) => void
) {
  const id = ghId.trim().toUpperCase()
  if (!GH_ID_PATTERN.test(id)) throw new Error("Enter a valid ID in the format TS-GH-XXXX.")

  const deviceId = await findHub(id, onStep)

  onStep("Connecting…")
  await BleClient.connect(deviceId)
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ ssid, pass, code: code.trim().toUpperCase() }) + "\n")
    for (let i = 0; i < bytes.length; i += 18) {   // 18-byte chunks work with any BLE MTU
      const chunk = bytes.slice(i, i + 18)
      await BleClient.write(deviceId, BLE_SERVICE, BLE_PROV, new DataView(chunk.buffer))
    }
    onStep("Hub is joining your Wi-Fi…")
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const status = dataViewToText(await BleClient.read(deviceId, BLE_SERVICE, BLE_STATUS))
      if (status === "wifi_ok") return
      if (status.startsWith("error:")) throw new Error(bleErrors[status] ?? "Setup failed. Please try again.")
    }
    throw new Error("The hub didn't report back. Check the Wi-Fi password and try again.")
  } finally {
    await BleClient.disconnect(deviceId).catch(() => {})
  }
}
// Page 1 of setup: find the hub and stay connected
async function connectToHub(
  ghId: string, onStep: (message: string) => void, onLost?: () => void
): Promise<string> {
  const id = ghId.trim().toUpperCase()
  if (!GH_ID_PATTERN.test(id)) throw new Error("Enter a valid ID in the format TS-GH-XXXX.")
  const deviceId = await findHub(id, onStep)
  onStep("Connecting…")
  await BleClient.connect(deviceId, () => onLost?.())
  return deviceId
}

// Page 2 of setup: send Wi-Fi over the open connection and wait for the result
async function sendWifiToHub(
  deviceId: string, code: string, ssid: string, pass: string, onStep: (message: string) => void
) {
  const bytes = new TextEncoder().encode(JSON.stringify({ ssid, pass, code: code.trim().toUpperCase() }) + "\n")
  for (let i = 0; i < bytes.length; i += 18) {
    const chunk = bytes.slice(i, i + 18)
    await BleClient.write(deviceId, BLE_SERVICE, BLE_PROV, new DataView(chunk.buffer))
  }
  onStep("Hub is joining your Wi-Fi…")
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const status = dataViewToText(await BleClient.read(deviceId, BLE_SERVICE, BLE_STATUS))
    if (status === "wifi_ok") return
    if (status.startsWith("error:")) throw new Error(bleErrors[status] ?? "Setup failed. Please try again.")
  }
  throw new Error("The hub didn't report back. Check the Wi-Fi password and try again.")
}

async function disconnectHub(deviceId: string) {
  await BleClient.disconnect(deviceId).catch(() => {})
}
// ---- Saved Wi-Fi networks (per account, so each hub can be given a different one) ----
type SavedNetwork = { id: string; ssid: string; password: string; ts?: number }

// Firestore document ids can't contain "/", so the id is the network name in hex
function networkId(ssid: string) {
  return Array.from(new TextEncoder().encode(ssid)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function loadNetworks(uid: string): Promise<SavedNetwork[]> {
  const read = async () => {
    const snap = await getDocs(collection(firestore, "users", uid, "wifiNetworks"))
    return snap.docs
      .map((d) => ({
        id: d.id,
        ssid: (d.data().ssid as string) ?? "",
        password: (d.data().password as string) ?? "",
        ts: (d.data().updatedAt as any)?.toMillis?.() ?? 0,
      }))
      .filter((n) => n.ssid)
      .sort((a, b) => a.ssid.localeCompare(b.ssid))
  }

  const list = await read()

  // One-time import of the Wi-Fi that was saved with each hub before this list existed. It runs once per
  // account and is then marked done, so a network the user deletes never comes back.
  try {
    const doneRef = doc(firestore, "users", uid, "wifiNetworks", "_imported")
    if (!(await getDoc(doneRef)).exists()) {
      let result = list
      if (list.length === 0) {
        const devices = await getDocs(collection(firestore, "users", uid, "devices"))
        const old = devices.docs.map((d) => d.data()).filter((d) => d.ssid)
        if (old.length > 0) {
          await Promise.all(old.map((d) => saveNetwork(uid, d.ssid as string, (d.wifiPassword as string) ?? "")))
          result = await read()
        }
      }
      await setDoc(doneRef, { done: true })
      return result
    }
  } catch {}
  return list
}

async function saveNetwork(uid: string, ssid: string, password: string) {
  await setDoc(
    doc(firestore, "users", uid, "wifiNetworks", networkId(ssid)),
    { ssid, password, updatedAt: serverTimestamp() },
    { merge: true }
  )
}

async function deleteNetwork(uid: string, id: string) {
  await deleteDoc(doc(firestore, "users", uid, "wifiNetworks", id))
}
// ---- Home-screen widget (Android): the app hands it the latest numbers, current action and plant cycle ----
const WidgetBridge = registerPlugin<{ update(options: { json: string }): Promise<void> }>("WidgetBridge")

// ---- Notifications: hub-offline alert + always-on plant cycle card ----
const CYCLE_CHANNEL = "plant-cycle"
const ALERT_CHANNEL = "hub-alerts"
const NOTIF_KEY = "terrasense.notifPrefs"

type NotifPrefs = { offline: boolean; cycle: boolean }

function loadNotifPrefs(): NotifPrefs {
  try {
    const raw = localStorage.getItem(NOTIF_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      return { offline: p.offline !== false, cycle: p.cycle !== false }
    }
  } catch {}
  return { offline: true, cycle: true }
}

// Notification ids must be integers; derive a stable one per greenhouse so a repeat replaces the old card
function notifId(text: string) {
  let h = 7
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0
  return (Math.abs(h) % 2000000000) + 1
}

async function ensureNotifications(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  try {
    let perm = await LocalNotifications.checkPermissions()
    if (perm.display === "prompt" || perm.display === "prompt-with-rationale") {
      perm = await LocalNotifications.requestPermissions()
    }
    if (perm.display !== "granted") return false
    if (Capacitor.getPlatform() === "android") {
      await LocalNotifications.createChannel({
        id: CYCLE_CHANNEL, name: "Plant cycle", description: "Always-on status of the current growth stage",
        importance: 2, vibration: false,
      })
      await LocalNotifications.createChannel({
        id: ALERT_CHANNEL, name: "Hub alerts", description: "Alerts when a hub goes offline",
        importance: 4, vibration: true,
      })
    }
    return true
  } catch (e) {
    console.error("Notification setup failed:", e)
    return false
  }
}

async function notifyHubOffline(gh: { id: string; name: string }) {
  if (!(await ensureNotifications())) return
  await LocalNotifications.schedule({
    notifications: [{
      id: notifId(`offline:${gh.id}`),
      title: `${gh.name} is offline`,
      body: "Your hub stopped reporting. Check its power and Wi-Fi. If the Wi-Fi changed, reconnect it over Bluetooth from Settings.",
      channelId: ALERT_CHANNEL,
    }],
  })
}

async function clearHubOffline(id: string) {
  if (!Capacitor.isNativePlatform()) return
  await LocalNotifications.cancel({ notifications: [{ id: notifId(`offline:${id}`) }] }).catch(() => {})
}

type CycleNote = { key: string; title: string; body: string; large: string }

function cycleNotification(gh: Greenhouse, now: number): CycleNote | null {
  const plan = gh.plan
  const cur = currentStage(plan, now)
  if (!plan || !cur) return null
  const total = plan.stages.reduce((sum, st) => sum + st.days, 0)
  if (cur.finished) {
    const body = `${gh.name} · cycle complete after ${total} days`
    return { key: `${plan.name}|done|${total}`, title: `${plan.name} · cycle complete`, body, large: body }
  }
  let end = 0
  for (const st of plan.stages) {
    end += st.days
    if (st === cur.stage) break
  }
  const left = Math.max(1, end - cur.day + 1)
  const next = plan.stages[plan.stages.indexOf(cur.stage) + 1]
  const title = `${plan.name} · ${cur.stage.name} stage`
  const body = `${gh.name} · Day ${cur.day} of ${total} · ${left} ${left === 1 ? "day" : "days"} left in this stage`
  const large = [
    body,
    `Targets: ${cur.stage.tempMin}–${cur.stage.tempMax}°C, soil ${cur.stage.moistureMin}–${cur.stage.moistureMax}%`,
    next ? `Next: ${next.name}` : "Final stage",
  ].join("\n")
  return { key: `${title}|${body}`, title, body, large }
}

// Short vibration for taps. Native uses the phone's haptic motor; the browser falls back to the Vibration API.
// Vibration feedback. Durations are long enough to feel through a phone case.
type BuzzKind = "tap" | "switch" | "heavy"
const BUZZ_MS: Record<BuzzKind, number> = { tap: 70, switch: 110, heavy: 220 }

function buzz(kind: BuzzKind = "tap") {
  const ms = BUZZ_MS[kind]
  const web = () => { try { navigator.vibrate?.(ms) } catch {} }
  if (Capacitor.isNativePlatform()) {
    Haptics.vibrate({ duration: ms }).catch(web)
    return
  }
  web()
}

// Outcome feedback, Built from fixed pulses so it is as strong as the tap buzz:
// success = two pulses, warning = two long pulses, error = three long pulses.
const RESULT_PATTERN: Record<"success" | "warning" | "error", number[]> = {
  success: [90, 80, 90],
  warning: [170, 100, 170],
  error: [260, 100, 260, 100, 260],
}
function buzzResult(type: "success" | "warning" | "error") {
  const pattern = RESULT_PATTERN[type]
  if (!Capacitor.isNativePlatform()) {
    try { navigator.vibrate?.(pattern) } catch {}
    return
  }
  // Odd entries are pulses, even entries are gaps
  let t = 0
  pattern.forEach((ms, i) => {
    if (i % 2 === 0) window.setTimeout(() => { Haptics.vibrate({ duration: ms }).catch(() => {}) }, t)
    t += ms
  })
}

function authMessage(e: any) {
  const code = String(e?.code ?? "")
  if (/invalid-credential|wrong-password|user-not-found/.test(code)) return "Incorrect email or password."
  if (code.includes("email-already-in-use")) return "An account with this email already exists."
  if (code.includes("weak-password")) return "Password is too weak."
  return e?.message ?? "Something went wrong."
}

type IconName =
  | "grid"
  | "chart"
  | "leaf"
  | "book"
  | "bell"
  | "sun"
  | "droplet"
  | "thermometer"
  | "wind"
  | "wifi"
  | "flask"
  | "tank"
  | "chevron"
  | "bolt"
  | "pause"
  | "menu"
  | "close"
  | "plus"
  | "logout"

const iconPaths: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  chart: <><path d="M4 19V9" /><path d="M10 19V5" /><path d="M16 19v-7" /><path d="M22 19H2" /></>,
  leaf: <><path d="M20 4c-7 0-13 3-13 10 0 3 2 5 5 5 7 0 8-8 8-15Z" /><path d="M4 21c2-6 6-9 12-12" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5Z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5Z" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  droplet: <path d="M12 2S5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13Z" />,
  thermometer: <><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z" /><path d="M12 10v7" /></>,
  wind: <><path d="M3 8h10c3 0 3-4 0-4" /><path d="M3 12h15c3 0 3 4 0 4" /><path d="M3 16h7" /></>,
  wifi: <><path d="M5 12.5a10 10 0 0 1 14 0" /><path d="M8.5 16a5 5 0 0 1 7 0" /><path d="M12 20h.01" /></>,
  flask: <><path d="M9 3h6M10 3v6l-5 9c-.7 1.3.2 3 1.7 3h10.6c1.5 0 2.4-1.7 1.7-3l-5-9V3" /><path d="M8 15h8" /></>,
  tank: <><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M5 13c3-2 5 2 8 0s4 1 6 0" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  bolt: <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />,
  pause: <><path d="M9 8v8M15 8v8" /><circle cx="12" cy="12" r="9" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>
}

const navItems: { label: string; icon: IconName }[] = [
  { label: "Overview", icon: "grid" },
  { label: "Analytics", icon: "chart" },
  { label: "Plants", icon: "leaf" },
  { label: "Plant Library", icon: "book" },
]

const sensorDefs = [
  { key: "temperature", label: "Temperature", unit: "°C", icon: "thermometer" as IconName, tone: "amber", max: 50 },
  { key: "humidity", label: "Humidity", unit: "%", icon: "droplet" as IconName, tone: "blue", max: 100 },
  { key: "soilMoisture", label: "Soil moisture", unit: "%", icon: "leaf" as IconName, tone: "green", max: 100 },
  { key: "lightLux", label: "Light", unit: "lx", icon: "sun" as IconName, tone: "purple", max: 100000 },
] as const

const controlDefs: { key: string; name: string; icon: IconName }[] = [
  { key: "pump", name: "Irrigation pump", icon: "droplet" },
  { key: "lights", name: "Grow lights", icon: "sun" },
  { key: "heater", name: "Heating system", icon: "thermometer" },
  { key: "cooler", name: "Cooling system", icon: "wind" },
  { key: "humidifier", name: "Humidifier", icon: "droplet" },
  { key: "fertilizer", name: "Fertilizer pump", icon: "flask" },
]

const ONLINE_WINDOW_MS = 2 * 60 * 1000
const isOnline = (lastSeen: number | undefined, now: number) => !!lastSeen && now - lastSeen < ONLINE_WINDOW_MS

type LiveData = {
  temperature?: number
  humidity?: number
  soilMoisture?: number
  lightLux?: number
  waterTank?: number
  fertilizer?: number
  updatedAt?: number
}

type HistoryRow = { temperature?: number; humidity?: number; soilMoisture?: number; lightLux?: number }

type StageDef = {
  key: string
  name: string
  days: number
  tempMin: number
  tempMax: number
  moistureMin: number
  moistureMax: number
  lightHours: number
  feedEveryDays: number
}

type PlanView = { plantId: string; name: string; startedAt: number; stages: StageDef[] }

type Greenhouse = {
  id: string
  name: string
  location: string
  crop: string
  stage: string
  lastSeen?: number
  plan?: PlanView
}

type PlantProfile = {
  id: string
  name: string
  category: string
  image?: string
  stages: StageDef[]
}

function toStageList(raw: any): StageDef[] {
  return Object.entries(raw ?? {})
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, st]: [string, any]) => ({
      key,
      name: String(st?.name ?? key),
      days: Number(st?.days) || 0,
      tempMin: Number(st?.tempMin) || 0,
      tempMax: Number(st?.tempMax) || 0,
      moistureMin: Number(st?.moistureMin) || 0,
      moistureMax: Number(st?.moistureMax) || 0,
      lightHours: Number(st?.lightHours) || 0,
      feedEveryDays: Number(st?.feedEveryDays) || 0,
    }))
}

function stagesToObject(stages: StageDef[]) {
  return Object.fromEntries(stages.map(({ key, ...rest }) => [key, rest]))
}

function toPlant(id: string, p: any): PlantProfile {
  return {
    id,
    name: String(p?.name ?? id),
    category: String(p?.category ?? "Other"),
    ...(p?.image ? { image: String(p.image) } : {}),
    stages: toStageList(p?.stages),
  }
}

function currentStage(plan: { startedAt: number; stages: StageDef[] } | undefined, now: number) {
  if (!plan || plan.stages.length === 0) return null
  const day = Math.max(1, Math.floor((now - plan.startedAt) / 86400000) + 1)
  let end = 0
  for (const stage of plan.stages) {
    end += stage.days
    if (day <= end) return { stage, day, finished: false }
  }
  return { stage: plan.stages[plan.stages.length - 1], day, finished: true }
}

type WifiSettings = {
  ssid: string
  password: string
  deviceName: string
}

const toneClasses: Record<string, { soft: string; ink: string; fill: string }> = {
  amber: { soft: "bg-amber-soft", ink: "text-amber-ink", fill: "bg-amber" },
  blue: { soft: "bg-blue-soft", ink: "text-blue-ink", fill: "bg-blue" },
  green: { soft: "bg-green-soft", ink: "text-green-ink", fill: "bg-green" },
  purple: { soft: "bg-purple-soft", ink: "text-purple-ink", fill: "bg-purple" },
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="grid h-36 place-items-center text-xs text-muted">Not enough readings yet</div>
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const y = (value: number) => 80 - ((value - min) / span) * 68
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${y(value)}`).join(" ")
  const area = `0,88 ${points} 100,88`
  return (
    <svg className="h-36 w-full overflow-visible" viewBox="0 0 100 90" preserveAspectRatio="none" aria-label="Temperature trend chart">
      <defs>
        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-leaf)" stopOpacity=".24" />
          <stop offset="100%" stopColor="var(--color-leaf)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[18, 41, 64, 87].map((line) => <line key={line} x1="0" x2="100" y1={line} y2={line} stroke="var(--color-border)" strokeWidth=".5" strokeDasharray="2 2" />)}
      <polygon points={area} fill="url(#chartFill)" />
      <polyline points={points} fill="none" stroke="var(--color-leaf)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="100" cy={y(values[values.length - 1])} r="1.8" fill="var(--color-leaf)" stroke="white" strokeWidth=".9" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/**
 * Keeps a panel mounted long enough to play its closing animation.
 * mounted = render it at all, shown = it is in its open position.
 */
function usePresence(open: boolean, ms = 300) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      // wait two frames so the closed position is painted before sliding in
      let second = 0
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), ms)
    return () => window.clearTimeout(timer)
  }, [open, ms])

  return { mounted, shown }
}

function App() {
  const [authScreen, setAuthScreen] = useState<"app" | "splash" | "login" | "register" | "setup">("splash")
  const [activeNav, setActiveNav] = useState("Overview")
  const [mobileNav, setMobileNav] = useState(false)
  const [alertOpen, setAlertOpen] = useState(false)
  const [downloadedPlants, setDownloadedPlants] = useState<PlantProfile[]>([])
  const [library, setLibrary] = useState<PlantProfile[]>([])
  const [wifiSettings, setWifiSettings] = useState<WifiSettings>({ ssid: "", password: "", deviceName: "TerraSense Hub" })
  const [currentGreenhouse, setCurrentGreenhouse] = useState(0)
  const [pendingSelect, setPendingSelect] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>(loadNotifPrefs)

  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)

  // Greenhouses the signed-in user owns (loaded from Firebase, never hard-coded)
  const [ghIds, setGhIds] = useState<string[]>([])
  const [ghMeta, setGhMeta] = useState<Record<string, any>>({})
  const [ghSeen, setGhSeen] = useState<Record<string, number>>({})
  const [ghLoaded, setGhLoaded] = useState(false)

  // Live data for the greenhouse currently selected
  const [live, setLive] = useState<LiveData | null>(null)
  const [controlState, setControlState] = useState<Record<string, boolean>>({})
  const [history, setHistory] = useState<number[]>([])
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([])
  const [now, setNow] = useState(() => Date.now())

  const greenhouses: Greenhouse[] = useMemo(
    () =>
      ghIds
        .filter((id) => ghMeta[id] !== undefined)
        .map((id) => {
          const raw = ghMeta[id]
          const plan: PlanView | undefined = raw.plan
            ? {
                plantId: String(raw.plan.plantId ?? ""),
                name: String(raw.plan.name ?? "Plant"),
                startedAt: Number(raw.plan.startedAt) || now,
                stages: toStageList(raw.plan.stages),
              }
            : undefined
          const cur = currentStage(plan, now)
          return {
            id,
            name: raw.name ?? id,
            location: raw.location ?? "Location not set",
            crop: plan?.name ?? "No crop selected",
            stage: cur ? (cur.finished ? "Complete" : cur.stage.name) : "Setup",
            lastSeen: ghSeen[id],
            plan,
          }
        }),
    [ghIds, ghMeta, ghSeen, now]
  )
  const myPlants = useMemo(
    () => downloadedPlants.map((p) => ({ ...p, image: library.find((l) => l.id === p.id)?.image ?? p.image })),
    [downloadedPlants, library]
  )
  const greenhouse: Greenhouse | null = greenhouses[currentGreenhouse] ?? null
  const currentId = greenhouse?.id
  const hasDevice = !!greenhouse
  const loading = !!user && (!ghLoaded || ghIds.some((id) => ghMeta[id] === undefined))

  // Current growth stage and its target ranges
  const cycle = currentStage(greenhouse?.plan, now)
  const targetFor = (key: string): { min: number; max: number } | undefined => {
    if (!cycle || cycle.finished) return undefined
    if (key === "temperature") return { min: cycle.stage.tempMin, max: cycle.stage.tempMax }
    if (key === "soilMoisture") return { min: cycle.stage.moistureMin, max: cycle.stage.moistureMax }
    return undefined
  }
  const online = isOnline(greenhouse?.lastSeen, now)
  const stopped = controlState.emergencyStop === true
  const manualMode = controlState.manual === true
  const lowWater = typeof live?.waterTank === "number" && live.waterTank < 20
  const lastUpdate = live?.updatedAt ? new Date(live.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never"
  const avgTemp = history.length ? (history.reduce((a, b) => a + b, 0) / history.length).toFixed(1) : null
  const controls = controlDefs.map((def) => ({ ...def, enabled: controlState[def.key] === true, detail: controlState[def.key] === true ? "On" : "Off" }))

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setAuthReady(true) }), [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (authScreen !== "splash" || !authReady) return
    const timer = window.setTimeout(() => setAuthScreen(user ? "app" : "login"), 1600)
    return () => window.clearTimeout(timer)
  }, [authScreen, authReady, user])

  useEffect(() => {
    if (!profileOpen && !mobileNav) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [profileOpen, mobileNav])

  const navPresence = usePresence(mobileNav)
  const profilePresence = usePresence(profileOpen)

  // 1) The list of greenhouses: ONLY the ones indexed under this user's uid
  useEffect(() => {
    if (!user) {
      setGhIds([])
      setGhMeta({})
      setGhSeen({})
      setGhLoaded(false)
      return
    }
    setGhLoaded(false)
    const offs = new Map<string, () => void>()
    const offIndex = onValue(
      ref(db, `userGreenhouses/${user.uid}`),
      (snap) => {
        const ids = Object.keys(snap.val() ?? {}).sort()
        setGhIds(ids)
        setGhLoaded(true)
        offs.forEach((off, id) => {
          if (!ids.includes(id)) { off(); offs.delete(id) }
        })
        ids.forEach((id) => {
          if (offs.has(id)) return
          const offMeta = onValue(
            ref(db, `greenhouses/${id}/meta`),
            (s) => setGhMeta((m) => ({ ...m, [id]: s.val() ?? {} })),
            (e) => { console.error("Greenhouse meta error:", e); setGhMeta((m) => ({ ...m, [id]: m[id] ?? {} })) }
          )
          const offSeen = onValue(ref(db, `greenhouses/${id}/live/updatedAt`), (s) => setGhSeen((m) => ({ ...m, [id]: Number(s.val()) || 0 })))
          offs.set(id, () => { offMeta(); offSeen() })
        })
      },
      (err) => { console.error("Greenhouse list error:", err); setGhLoaded(true) }
    )
    return () => {
      offIndex()
      offs.forEach((off) => off())
    }
  }, [user?.uid])

  // 2) Live readings, control state and history for the selected greenhouse
  useEffect(() => {
    setLive(null)
    setControlState({})
    setHistory([])
    setHistoryRows([])
    if (!currentId) return
    const base = `greenhouses/${currentId}`
    const offLive = onValue(ref(db, `${base}/live`), (s) => setLive(s.val() ?? {}))
    const offControls = onValue(ref(db, `${base}/controls`), (s) => setControlState(s.val() ?? {}))
    const offHistory = onValue(query(ref(db, `${base}/history`), limitToLast(48)), (s) => {
      const rows: number[] = []
      const full: HistoryRow[] = []
      const num = (x: any) => (x != null && Number.isFinite(Number(x)) ? Number(x) : undefined)
      s.forEach((child) => {
        const v = child.val() ?? {}
        const t = num(v.temperature)
        if (t !== undefined) rows.push(t)
        full.push({ temperature: t, humidity: num(v.humidity), soilMoisture: num(v.soilMoisture), lightLux: num(v.lightLux) })
      })
      setHistory(rows)
      setHistoryRows(full)
    })
    return () => { offLive(); offControls(); offHistory() }
  }, [currentId])

  // 3) Wi-Fi shown in Settings: the selected greenhouse's own network, otherwise the network saved most
  //    recently on the account. Nothing is cleared when the last greenhouse is removed.
  useEffect(() => {
    setWifiSettings({ ssid: "", password: "", deviceName: "TerraSense Hub" })   // different account: start clean
  }, [user?.uid])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      try {
        if (currentId) {
          const snap = await getDoc(doc(firestore, "users", user.uid, "devices", currentId))
          const d: any = snap.exists() ? snap.data() : null
          if (d?.ssid) {
            if (!cancelled) setWifiSettings({ ssid: d.ssid, password: d.wifiPassword ?? "", deviceName: d.name ?? "TerraSense Hub" })
            return
          }
        }
        const list = await loadNetworks(user.uid)
        if (cancelled || list.length === 0) return
        const latest = [...list].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0]
        setWifiSettings((current) => ({ ssid: latest.ssid, password: latest.password, deviceName: current.deviceName || "TerraSense Hub" }))
      } catch (e) {
        console.error("Wi-Fi settings load error:", e)
      }
    })()
    return () => { cancelled = true }
  }, [user?.uid, currentId])

  // 3b) Back up each greenhouse's plant cycle on the user's account. Removing a hub wipes its record in the
  //     database, so this copy is what lets the same cycle continue when the hub is added again.
  const syncedPlans = useRef<Record<string, string>>({})
  useEffect(() => { syncedPlans.current = {} }, [user?.uid])
  useEffect(() => {
    if (!user) return
    for (const id of ghIds) {
      const plan = ghMeta[id]?.plan
      if (!plan) continue                                   // only copy while a cycle exists
      const json = JSON.stringify(plan)
      if (syncedPlans.current[id] === json) continue
      syncedPlans.current[id] = json
      setDoc(doc(firestore, "users", user.uid, "devices", id), { greenhouseId: id, plan }, { merge: true })
        .catch((e) => { delete syncedPlans.current[id]; console.error("Plant cycle backup failed:", e) })
    }
  }, [user?.uid, ghIds, ghMeta])

  // Select a newly claimed greenhouse once it shows up; keep the index in range
  useEffect(() => {
    if (pendingSelect) {
      const index = greenhouses.findIndex((g) => g.id === pendingSelect)
      if (index >= 0) { setCurrentGreenhouse(index); setPendingSelect(null) }
      return
    }
    if (currentGreenhouse > 0 && currentGreenhouse >= greenhouses.length) setCurrentGreenhouse(0)
  }, [greenhouses, pendingSelect, currentGreenhouse])

  // Plant library (added by you in the cloud) + the user's saved plants
  useEffect(() => {
    if (!user) { setLibrary([]); setDownloadedPlants([]); return }
    const offLib = onValue(ref(db, "plantLibrary"), (snap) => {
      setLibrary(Object.entries(snap.val() ?? {}).map(([id, p]) => toPlant(id, p)))
    }, (e) => console.error("Plant library error:", e))
    const offMine = onValue(ref(db, `userPlants/${user.uid}`), (snap) => {
      setDownloadedPlants(Object.entries(snap.val() ?? {}).map(([id, p]) => toPlant(id, p)))
    }, (e) => console.error("User plants error:", e))
    return () => { offLib(); offMine() }
  }, [user?.uid])

  const updateNotifPrefs = (next: NotifPrefs) => {
    setNotifPrefs(next)
    try { localStorage.setItem(NOTIF_KEY, JSON.stringify(next)) } catch {}
    if (next.offline || next.cycle) ensureNotifications()   // ask now, not in the middle of an outage
  }

  // Alert when a hub drops off; remove the alert when it comes back
  const wasOnline = useRef<Record<string, boolean>>({})
  useEffect(() => {
    greenhouses.forEach((g) => {
      const on = isOnline(g.lastSeen, now)
      const prev = wasOnline.current[g.id]
      wasOnline.current[g.id] = on
      if (prev === undefined) return
      if (prev && !on && notifPrefs.offline) notifyHubOffline(g).catch((e) => console.error(e))
      if (!prev && on) clearHubOffline(g.id)
    })
  }, [greenhouses, now, notifPrefs.offline])

  // Always-on plant cycle card: one per greenhouse that has a plan, refreshed when the day or stage changes
  const postedCycle = useRef<Record<string, string>>({})
  const [cycleTick, setCycleTick] = useState(0)
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    ;(async () => {
      // If the system swiped a card away, forget that it was posted so it comes straight back
      try {
        const { notifications } = await LocalNotifications.getDeliveredNotifications()
        const shown = new Set(notifications.map((n) => n.id))
        Object.keys(postedCycle.current).forEach((id) => {
          if (postedCycle.current[id] && !shown.has(notifId(`cycle:${id}`))) delete postedCycle.current[id]
        })
      } catch {}

      const toPost: { id: string; note: CycleNote }[] = []
      const toCancel: string[] = []
      const known = new Set(greenhouses.map((g) => g.id))

      greenhouses.forEach((g) => {
        const note = notifPrefs.cycle ? cycleNotification(g, now) : null
        const prev = postedCycle.current[g.id]
        if (!note) {
          if (prev !== "") { toCancel.push(g.id); postedCycle.current[g.id] = "" }
        } else if (prev !== note.key) {
          toPost.push({ id: g.id, note })
        }
      })
      Object.keys(postedCycle.current).forEach((id) => {
        if (!known.has(id)) { toCancel.push(id); delete postedCycle.current[id] }
      })

      if (toCancel.length) {
        await LocalNotifications.cancel({ notifications: toCancel.map((id) => ({ id: notifId(`cycle:${id}`) })) }).catch(() => {})
      }
      if (toPost.length && (await ensureNotifications())) {
        await LocalNotifications.schedule({
          notifications: toPost.map(({ id, note }) => ({
            id: notifId(`cycle:${id}`),
            title: note.title,
            body: note.body,
            largeBody: note.large,
            channelId: CYCLE_CHANNEL,
            ongoing: true,
            autoCancel: false,
          })),
        })
        toPost.forEach(({ id, note }) => { postedCycle.current[id] = note.key })
      }
    })().catch((e) => console.error("Cycle notification failed:", e))
  }, [greenhouses, now, notifPrefs.cycle, cycleTick])

  // Android 14+ lets the user swipe the card away even though it is "ongoing". Look every few seconds and
  // post it again straight away.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !notifPrefs.cycle) return
    const timer = window.setInterval(async () => {
      try {
        const { notifications } = await LocalNotifications.getDeliveredNotifications()
        const shown = new Set(notifications.map((n) => n.id))
        const missing = Object.keys(postedCycle.current).some(
          (id) => postedCycle.current[id] && !shown.has(notifId(`cycle:${id}`))
        )
        if (missing) setCycleTick((t) => t + 1)
      } catch {}
    }, 5000)
    return () => window.clearInterval(timer)
  }, [notifPrefs.cycle])

  // Home-screen widget: send the selected greenhouse's numbers, current action and plant cycle
  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return

    let payload: Record<string, unknown> = { hasHub: false }
    if (user && greenhouse) {
      const relays = (live as any)?.relays ?? {}
      const actions: string[] = []
      if (!online) {
        actions.push("Hub offline")
      } else if (stopped) {
        actions.push("Emergency stop")
      } else {
        if (relays.pump) actions.push("Watering")
        if (relays.cooler) actions.push("Cooling")
        if ((controlState as any).heater === true) actions.push("Heating")
        if ((controlState as any).humidifier === true) actions.push("Humidifying")
        if ((controlState as any).lights === true) actions.push("Grow lights on")
        if (relays.fertilizer) actions.push("Fertilizing")
        if (actions.length === 0) actions.push(manualMode ? "Idle (manual mode)" : "Idle (automatic)")
      }
      // What is switched on right now, for the icon row at the bottom of the widget
      const running = online && !stopped
      const acts = {
        pump: running && (!!relays.pump || (manualMode && (controlState as any).pump === true)),
        cooler: running && (!!relays.cooler || (manualMode && (controlState as any).cooler === true)),
        heater: running && (controlState as any).heater === true,
        humidifier: running && (controlState as any).humidifier === true,
        lights: running && (controlState as any).lights === true,
        fertilizer: running && (!!relays.fertilizer || (manualMode && (controlState as any).fertilizer === true)),
      }
      const cs = controlState as any
      const ctl = {
        manual: manualMode, emergencyStop: stopped,
        pump: cs.pump === true, cooler: cs.cooler === true, heater: cs.heater === true,
        humidifier: cs.humidifier === true, lights: cs.lights === true, fertilizer: cs.fertilizer === true,
      }
      // Lets the home-screen widget switch devices itself, without opening the app (kept private on this phone)
      const fb = {
        apiKey: auth.app.options.apiKey ?? "",
        dbUrl: auth.app.options.databaseURL ?? "",
        refreshToken: (user as any).refreshToken ?? "",
      }

      const total = greenhouse.plan ? greenhouse.plan.stages.reduce((sum, st) => sum + st.days, 0) : 0
      const day = cycle ? Math.min(cycle.day, total || cycle.day) : 0
      const num = (v: unknown) => (typeof v === "number" ? v : null)

      // Days left in the current stage and the name of the next one (for the widget's cycle card)
      let stageEnd = 0
      let nextStage = ""
      if (greenhouse.plan && cycle && !cycle.finished) {
        const sts = greenhouse.plan.stages
        for (let i = 0; i < sts.length; i++) {
          stageEnd += sts[i].days
          if (sts[i] === cycle.stage || sts[i].key === cycle.stage.key) { nextStage = sts[i + 1]?.name ?? ""; break }
        }
      }
      const daysLeft = cycle && !cycle.finished ? Math.max(0, stageEnd - cycle.day) : 0

      // Alerts for the widget's status strip (offline / emergency stop are already shown as the action)
      const alerts: string[] = []
      const tankPct = num(live?.waterTank)
      const feedPct = num(live?.fertilizer)
      if (tankPct !== null && tankPct < 20) alerts.push("Water tank low")
      if (feedPct !== null && feedPct < 20) alerts.push("Fertilizer low")
      if (cycle && !cycle.finished) {
        const tNow = num(live?.temperature), soilNow = num(live?.soilMoisture)
        if (tNow !== null && tNow > cycle.stage.tempMax) alerts.push(`Warmer than the ${cycle.stage.tempMax}°C target`)
        if (tNow !== null && tNow < cycle.stage.tempMin) alerts.push(`Cooler than the ${cycle.stage.tempMin}°C target`)
        if (soilNow !== null && soilNow < cycle.stage.moistureMin) alerts.push("Soil is drier than target")
      }

      // Plant buddy widget: which plant it is, how grown it is, and what mood it is in
      const petName = String(greenhouse.plan?.name ?? greenhouse.crop ?? "").toLowerCase()
      const petPlant = /tomato/.test(petName) ? "tomato"
        : /lettuce|spinach|kale/.test(petName) ? "lettuce"
        : /chil+i|pepper|capsicum/.test(petName) ? "pepper"
        : /strawberr/.test(petName) ? "strawberry"
        : /cucumber|zucchini/.test(petName) ? "cucumber"
        : "basil"
      const petStageList = greenhouse.plan?.stages ?? []
      let petStage = 0
      if (cycle) {
        const sn = (cycle.finished ? "harvest" : cycle.stage.name).toLowerCase()
        const si = Math.max(0, petStageList.findIndex((st) => st.key === cycle.stage.key))
        petStage = /seed|germ/.test(sn) ? 0
          : /veget|growth/.test(sn) ? 1
          : /flower|bloom/.test(sn) ? 2
          : /fruit|harvest|ripe|complete/.test(sn) ? 3
          : petStageList.length > 1 ? Math.min(3, Math.round((si * 3) / (petStageList.length - 1))) : 0
      }
      // Celebrate for 3 hours after a new stage starts (the first run only records the stage)
      let petJustChanged = false
      if (cycle && !cycle.finished) {
        try {
          const k = `ts_stage_${greenhouse.id}`
          const stageId = `${greenhouse.plan?.startedAt ?? 0}_${cycle.stage.key}`
          const seen = JSON.parse(localStorage.getItem(k) || "null")
          if (!seen || seen.id !== stageId) {
            localStorage.setItem(k, JSON.stringify({ id: stageId, since: seen ? Date.now() : 0 }))
            petJustChanged = !!seen
          } else {
            petJustChanged = Date.now() - (Number(seen.since) || 0) < 3 * 3600 * 1000
          }
        } catch {}
      }
      const petStageDef = cycle && !cycle.finished ? cycle.stage : null
      const petTempMax = petStageDef?.tempMax || 32
      const petTempMin = petStageDef?.tempMin || 15
      const petSoilMin = petStageDef?.moistureMin || 30
      const petTemp = num(live?.temperature), petSoil = num(live?.soilMoisture)
      const petHour = new Date().getHours()
      // Each plant's pet name (change the names here)
      const PET_NAMES: Record<string, string> = {
        cucumber: "Pickles",
        strawberry: "Berry",
        tomato: "Pomodoro",
        lettuce: "Buttercup",
        basil: "Basilisk",
        pepper: "Pepper",
      }
      const pn = PET_NAMES[petPlant] ?? "Your plant"
      let petMood = "happy", petMsg = `${pn} is feeling happy!`
      if (!online) { petMood = "sleep"; petMsg = `${pn} can't reach the hub...` }
      else if (stopped) { petMood = "sleep"; petMsg = `${pn} is paused and resting` }
      else if (petHour >= 22 || petHour < 5) { petMood = "sleep"; petMsg = `${pn} is sleeping. Zzz...` }
      else if (petJustChanged) { petMood = "celebrate"; petMsg = `${pn} just reached ${petStageDef?.name ?? "a new stage"}!` }
      else if (acts.pump) { petMood = "drink"; petMsg = `${pn} is having a drink!` }
      else if (petTemp !== null && petTemp > petTempMax) { petMood = "hot"; petMsg = `${pn} is feeling hot!` }
      else if (petTemp !== null && petTemp < petTempMin) { petMood = "cold"; petMsg = `${pn} is feeling cold!` }
      else if (petSoil !== null && petSoil < petSoilMin) { petMood = "thirsty"; petMsg = `${pn} is feeling thirsty!` }
      const pet = {
        plant: petPlant,
        mood: petMood,
        msg: petMsg,
        stage: petStage,
        label: greenhouse.plan && cycle ? `${pn} · ${cycle.finished ? "Complete" : cycle.stage.name}` : greenhouse.name,
      }

      payload = {
        hasHub: true,
        id: greenhouse.id,
        list: greenhouses.map((g) => ({ id: g.id, name: g.name })),
        ts: Date.now(),
        name: greenhouse.name,
        online,
        temp: num(live?.temperature),
        hum: num(live?.humidity),
        soil: num(live?.soilMoisture),
        lux: num(live?.lightLux),
        tank: tankPct,
        feed: feedPct,
        notes: online ? alerts : [],
        pet,
        action: actions.join(" · "),
        acts,
        ctl,
        fb,
        cycle: greenhouse.plan && cycle
          ? {
              crop: greenhouse.plan.name,
              day,
              total,
              stage: cycle.finished ? "Complete" : cycle.stage.name,
              pct: total > 0 ? Math.round((day / total) * 100) : 0,
              finished: !!cycle.finished,
              daysLeft,
              next: nextStage,
            }
          : null,
      }
    }

    // Wait a moment so a burst of changes becomes one update
    const timer = window.setTimeout(() => {
      WidgetBridge.update({ json: JSON.stringify(payload) }).catch(() => {})
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [user?.uid, greenhouse?.id, greenhouse?.name, greenhouse?.plan, greenhouses, online, stopped, manualMode, controlState, live, cycle?.day, cycle?.finished])

  // If the system swiped the card away, put it back when the app is opened again
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return
      postedCycle.current = {}
      setNow(Date.now())
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  // Vibrate on every tap of a button or switch (switches get a slightly firmer buzz)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const el = target?.closest?.('button, [role="switch"], [role="button"], a[href], select, summary') as HTMLElement | null
      if (!el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return
      const isSwitch = el.getAttribute("role") === "switch" || /^toggle/i.test(el.getAttribute("aria-label") ?? "")
      // Destructive actions get the strongest buzz
      const label = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`
      const heavy = /\b(remove|delete|disown|stop|sign out|log out|emergency)\b/i.test(label)
      buzz(heavy ? "heavy" : isSwitch ? "switch" : "tap")
    }
    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [])

  const setControlFlag = (key: string, value: boolean) => {
    if (!greenhouse) return
    set(ref(db, `greenhouses/${greenhouse.id}/controls/${key}`), value).catch((e) => console.error("Control write failed:", e))
  }

  const toggleControl = (key: string) => {
    if (stopped || !manualMode) return
    setControlFlag(key, !controlState[key])
  }

  if (authScreen === "splash") return <SplashScreen />
  if (authScreen === "login") return <LoginScreen onLogin={() => setAuthScreen("app")} onCreateAccount={() => setAuthScreen("register")} />
  if (authScreen === "register") return <RegisterScreen onRegister={() => setAuthScreen("setup")} onBackToLogin={() => setAuthScreen("login")} />
  if (authScreen === "setup") return <WifiSetupScreen onComplete={(settings, greenhouseId) => { setWifiSettings(settings); setPendingSelect(greenhouseId); setAuthScreen("app") }} onSkip={() => setAuthScreen("app")} />
  function UserAvatar({
  size = "size-9",
}: {
  size?: string
}) {
  const user = auth.currentUser
  const [imageFailed, setImageFailed] = useState(false)

  const initials = (user?.displayName || user?.email || "U")
    .split(" ")
    .map((name) => name.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase()

  return (
    <div
      className={`grid ${size} shrink-0 place-items-center overflow-hidden rounded-full bg-sand text-xs font-bold text-forest`}
    >
      {user?.photoURL && !imageFailed ? (
        <img
          src={user.photoURL}
          alt={user.displayName || "Profile"}
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : (
        initials
      )}
    </div>
  )
}

  return (
    <div className="min-h-dvh bg-forest text-ink">
      <main className="mx-auto min-h-dvh w-full max-w-md bg-canvas pb-24 shadow-2xl landscape:max-w-none">
        <header style={{ paddingLeft: "1.5rem", paddingRight: "1.5rem" }} className="safe-header-top sticky landscape:static top-0 z-30 border-b border-border/70 bg-canvas pb-4">
          <div className="relative flex items-center justify-between">
            <button onClick={() => setMobileNav(true)} className="grid size-9 place-items-center rounded-full bg-white text-forest shadow-card" aria-label="Open navigation"><Icon name="menu" size={18} /></button>
            <div className="absolute left-1/2 max-w-40 -translate-x-1/2 px-3 text-center">
              <p className="truncate text-sm font-extrabold tracking-tight">{greenhouse?.name ?? "TerraSense"}</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-leaf">{greenhouse ? "Active greenhouse" : "No greenhouse yet"}</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <button onClick={() => setAlertOpen(!alertOpen)} className="relative grid size-9 place-items-center rounded-full bg-white text-muted shadow-card" aria-label="Notifications"><Icon name="bell" size={17} />{lowWater && <span className="absolute right-1.5 top-1.5 size-2 rounded-full border-2 border-white bg-coral" />}</button>
                {alertOpen && <div className="absolute right-0 top-12 z-40 w-72 rounded-2xl border border-border bg-white p-4 shadow-xl">{lowWater ? <><p className="text-xs font-bold">Water tank running low</p><p className="mt-1 text-[10px] text-muted">Refill recommended soon.</p></> : <p className="text-xs font-bold">No new alerts</p>}</div>}
              </div>
             <button
  onClick={() => setProfileOpen(true)}
  aria-label="Open user profile"
>
  <UserAvatar size="size-9" />
</button>
            </div>
          </div>

          <div className="island-scroll mt-3 flex snap-x gap-2 overflow-x-auto rounded-3xl bg-ink p-1.5 shadow-lg">
            {greenhouses.map((item, index) => (
              <button key={`${item.name}-${index}`} onClick={() => setCurrentGreenhouse(index)} className={`flex shrink-0 snap-center items-center gap-2 rounded-full py-2 pl-2.5 pr-3 text-left transition-all ${currentGreenhouse === index ? "min-w-52 bg-white/12" : "bg-transparent"}`}>
                <span className={`size-2 shrink-0 rounded-full ${isOnline(item.lastSeen, now) ? "bg-leaf" : "bg-amber"}`} />
                <span className="min-w-0"><span className="block truncate text-[10px] font-bold text-white">{item.name}</span>{currentGreenhouse === index && <span className="block truncate text-[9px] text-white/40">{item.crop} · {isOnline(item.lastSeen, now) ? "Online" : "Offline"}</span>}</span>
              </button>
            ))}
            <button onClick={() => setProfileOpen(true)} className="grid size-9 shrink-0 place-items-center rounded-full border border-white/15 text-sm font-bold text-white/60" aria-label="Add greenhouse">+</button>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div><p role="heading" aria-level={1} className="text-xl font-bold tracking-tight">{activeNav}</p><p className="mt-0.5 text-[10px] text-muted">{greenhouse ? `${greenhouse.name} · ${greenhouse.location} · Updated ${lastUpdate}` : "Add a greenhouse to get started"}</p></div>
            <button onClick={() => setControlFlag("emergencyStop", !stopped)} disabled={!greenhouse} className={`grid size-9 place-items-center rounded-full ${stopped ? "bg-forest text-white" : "bg-coral-soft text-coral"}`} aria-label={stopped ? "Resume system" : "Emergency stop"}><Icon name={stopped ? "bolt" : "pause"} size={16} /></button>
          </div>
        </header>

        <div key={activeNav} style={{ paddingLeft: "1.5rem", paddingRight: "1.5rem" }} className="page-enter space-y-5 py-4">
          {stopped && (
            <div className="flex items-center gap-3 rounded-2xl border border-coral/20 bg-coral-soft p-4 text-sm font-semibold text-coral">
              <Icon name="pause" /> All automated systems are paused. Resume when the greenhouse is safe.
            </div>
          )}

          {activeNav === "Overview" && (loading ? <LoadingState /> : hasDevice ? <div className="grid gap-5 landscape:grid-cols-2 landscape:items-start">
          <section className="grid gap-5">
            <div className="relative min-h-72 overflow-hidden rounded-3xl bg-forest text-white shadow-card landscape:min-h-40">
              <img className="absolute inset-0 h-full w-full object-cover opacity-45 mix-blend-luminosity" src="https://images.unsplash.com/photo-1656740840036-7744c5bce4fc?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1400" alt="Rows of thriving plants inside a greenhouse" />
              <div className="absolute inset-0 bg-gradient-to-r from-forest via-forest/90 to-forest/25" />
              <div className="relative flex h-full min-h-72 flex-col justify-between p-6 landscape:min-h-40 landscape:p-4">
                <div className="flex items-start justify-between">
                  <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest backdrop-blur">Active crop</span>
                  <span className="flex items-center gap-2 text-xs text-white/65"><span className={`size-2 rounded-full ${online ? "bg-leaf" : "bg-amber"}`} />{online ? "Online" : "Offline"}</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-mint">{greenhouse?.crop === "No crop selected" ? "No crop selected" : `${greenhouse?.crop} · ${greenhouse?.stage} stage`}</p>
                  <p role="heading" aria-level={2} className="mt-2 text-3xl font-bold leading-tight tracking-tight">{greenhouse?.name}</p>
                  <p className="mt-3 max-w-lg text-sm leading-6 text-white/65">{online ? "Your TerraSense hub is connected and reporting live conditions." : "Your TerraSense hub isn't reporting right now. Check that it is powered on and connected to Wi-Fi."}</p>
                  <button onClick={() => setActiveNav("Plants")} className="mt-5 flex items-center gap-2 text-sm font-bold text-white">View plant profile <Icon name="chevron" size={16} /></button>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
              <div>
                <p className="text-sm font-bold">Resource levels</p>
                <p className="mt-1 text-xs text-muted">Reported by your TerraSense hub</p>
              </div>
              <div className="mt-6 space-y-6">
                {typeof live?.waterTank === "number" && <ResourceLevel icon="tank" label="Water tank" value={`${live.waterTank}%`} detail={live.waterTank < 20 ? "Refill soon" : "Level OK"} tone="blue" width={`${live.waterTank}%`} />}
                {typeof live?.fertilizer === "number" && <ResourceLevel icon="flask" label="Fertilizer" value={`${live.fertilizer}%`} detail={live.fertilizer < 20 ? "Refill soon" : "Level OK"} tone="green" width={`${live.fertilizer}%`} />}
                {typeof live?.waterTank !== "number" && typeof live?.fertilizer !== "number" && <p className="text-xs text-muted">No resource levels reported yet.</p>}
              </div>
            </div>
          </section>

          {greenhouse?.plan && cycle && <StageTimeline plan={greenhouse.plan} cycle={cycle} />}

          <section>
            <div className="mb-4 flex items-end justify-between">
              <div><p role="heading" aria-level={2} className="text-lg font-bold tracking-tight">Live conditions</p><p className="mt-1 text-xs text-muted">Live from your TerraSense hub</p></div>
              <button onClick={() => setActiveNav("Analytics")} className="text-xs font-bold text-forest">View analytics</button>
            </div>
            <div className="grid gap-4 landscape:grid-cols-2">
              {sensorDefs.map((def) => {
                const raw: unknown = live?.[def.key]
                // Accept numbers and numeric text (e.g. "1234.5"), so a value stored as a string still shows
                const v = raw === null || raw === "" || raw === undefined || !Number.isFinite(Number(raw)) ? undefined : Number(raw)
                const isLux = def.key === "lightLux"
                const shown = typeof v === "number" ? (isLux ? formatLux(v) : String(Math.round(v * 10) / 10)) : "—"
                // Light spans from a few lux to tens of thousands, so its bar uses a log scale (1 lx to 100,000 lx)
                const pct = typeof v === "number"
                  ? (isLux ? Math.max(0, Math.min(100, (Math.log10(v + 1) / 5) * 100)) : Math.max(0, Math.min(100, (v / def.max) * 100)))
                  : 0
                return <SensorCard key={def.key} target={targetFor(def.key)} label={def.label} unit={def.unit} icon={def.icon} tone={def.tone} value={shown} progress={pct} />
              })}
            </div>
          </section>

          <section className="grid gap-5">
            <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
              <div><p role="heading" aria-level={2} className="text-base font-bold">Temperature trend</p><p className="mt-1 text-xs text-muted">{avgTemp ? `Average ${avgTemp}°C · last ${history.length} readings` : "No readings recorded yet"}</p></div>
              <div className="mt-6"><Sparkline values={history} /></div>
            </div>

            <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
              <div className="flex items-start justify-between">
                <div><p role="heading" aria-level={2} className="text-base font-bold">Device controls</p><p className="mt-1 text-xs text-muted">{manualMode ? "Manual control enabled" : "Controlled by plant profile"}</p></div>
                <button onClick={() => setControlFlag("manual", !manualMode)} disabled={stopped} className={`rounded-full px-3 py-1.5 text-xs font-semibold tracking-normal transition disabled:opacity-40 ${manualMode ? "bg-amber-soft text-amber-ink" : "bg-mint text-forest"}`}>{manualMode ? "Manual mode" : "Auto mode"}</button>
              </div>
              <div className={`mt-4 rounded-xl p-3 text-[10px] leading-4 ${manualMode ? "bg-amber-soft text-amber-ink" : "bg-canvas text-muted"}`}>
                {manualMode ? "Manual mode is active. Device switches are now unlocked." : "Switch to Manual Mode before toggling lights, pumps, heating, cooling, or humidity."}
              </div>
              <div className="mt-5 divide-y divide-border">
                {controls.map((control) => (
                  <div key={control.name} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <div className={`grid size-10 place-items-center rounded-xl ${control.enabled && !stopped ? "bg-mint text-forest" : "bg-canvas text-muted"}`}><Icon name={control.icon} size={18} /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold">{control.name}</p>
                      <p className="mt-1 truncate text-[10px] text-muted">{stopped ? "System paused" : !manualMode ? `Auto · ${control.detail}` : control.detail}</p>
                    </div>
                    <button disabled={stopped || !manualMode} onClick={() => toggleControl(control.key)} className={`relative h-6 w-11 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${control.enabled && !stopped ? "bg-leaf" : "bg-border"}`} aria-label={`Toggle ${control.name}`}>
                      <span className={`absolute top-1 size-4 rounded-full bg-white shadow-sm transition ${control.enabled && !stopped ? "left-6" : "left-1"}`} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
          </div> : <NoDeviceState section="Overview" onConnect={() => setProfileOpen(true)} />)}

          {activeNav === "Plants" && (
            <PlantsPage
              plants={myPlants}
              online={online}
              greenhouse={greenhouse}
              now={now}
              onStart={(plant) => {
                if (!greenhouse) return
                set(ref(db, `greenhouses/${greenhouse.id}/meta/plan`), {
                  plantId: plant.id,
                  name: plant.name,
                  startedAt: Date.now(),
                  stages: stagesToObject(plant.stages),
                }).then(() => buzzResult("success")).catch((e) => { console.error(e); buzzResult("error") })
              }}
              onStop={() => {
                if (!greenhouse) return
                buzzResult("warning")
                remove(ref(db, `greenhouses/${greenhouse.id}/meta/plan`)).catch((e) => console.error(e))
                if (user) {
                  delete syncedPlans.current[greenhouse.id]
                  setDoc(doc(firestore, "users", user.uid, "devices", greenhouse.id), { plan: deleteField() }, { merge: true })
                    .catch((e) => console.error("Plant cycle backup removal failed:", e))
                }
              }}
            />
          )}
          {activeNav === "Plant Library" && (
            <PlantLibraryPage
              library={library}
              savedIds={downloadedPlants.map((p) => p.id)}
              onDownload={(plant) => {
                if (!user) return
                set(ref(db, `userPlants/${user.uid}/${plant.id}`), {
                  name: plant.name,
                  category: plant.category,
                  ...(plant.image ? { image: plant.image } : {}),
                  stages: stagesToObject(plant.stages),
                }).catch((e) => console.error(e))
              }}
            />
          )}
          {activeNav === "Analytics" && (loading ? <LoadingState /> : hasDevice ? <AnalyticsPage rows={historyRows} /> : <NoDeviceState section="Analytics" onConnect={() => setProfileOpen(true)} />)}
        </div>
        <nav className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 z-40 flex w-[calc(100%-3rem)] max-w-sm landscape:max-w-3xl -translate-x-1/2 items-center rounded-3xl border border-white/70 bg-white p-1.5 shadow-[0_12px_40px_rgb(23_59_44_/_0.18)]">
          {navItems.map((item) => (
            <button key={item.label} onClick={() => setActiveNav(item.label)} className={`group flex flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl py-1 text-[8px] font-bold transition-all duration-300 active:scale-90 ${activeNav === item.label ? "nav-active text-forest" : "text-muted hover:text-forest"}`}>
              <span className={`grid size-7 place-items-center rounded-xl transition-all duration-300 ${activeNav === item.label ? "bg-forest text-leaf shadow-md" : "group-hover:bg-canvas"}`}><Icon name={item.icon} size={15} /></span>
              <span className="whitespace-nowrap transition-colors duration-300">
                {item.label === "Plant Library" ? "Library" : item.label}
              </span>
            </button>
          ))}
        </nav>
      </main>
      {navPresence.mounted && (
        <div className={`fixed inset-0 z-50 flex bg-ink/40 transition-opacity duration-300 motion-reduce:transition-none ${navPresence.shown ? "opacity-100" : "opacity-0"}`}>
          <aside className={`safe-overlay-panel relative flex h-full w-72 flex-col bg-forest px-5 pb-5 text-white shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none ${navPresence.shown ? "translate-x-0" : "-translate-x-full"}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3"><div className="grid size-9 place-items-center rounded-xl bg-leaf text-forest"><Icon name="leaf" size={19} /></div><div><p className="text-sm font-bold">TerraSense</p><p className="text-[10px] text-white/40">Smart greenhouse</p></div></div>
              <button onClick={() => setMobileNav(false)} className="rounded-xl bg-white/10 p-2 text-white/60" aria-label="Close navigation"><Icon name="close" size={18} /></button>
            </div>
            <div className="mt-7 rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-[9px] font-bold uppercase tracking-widest text-white/35">Currently viewing</p>
              {greenhouse ? (
                <div className="mt-3 flex items-center gap-3"><span className={`size-2 rounded-full ${online ? "bg-leaf" : "bg-amber"}`} /><div className="min-w-0"><p className="truncate text-sm font-bold">{greenhouse.name}</p><p className="mt-0.5 truncate text-[10px] text-white/40">{greenhouse.crop} · {greenhouse.location}</p></div></div>
              ) : (
                <p className="mt-3 text-xs text-white/50">No greenhouse added yet</p>
              )}
            </div>
            <nav className="mt-6 space-y-1">
              {navItems.map((item) => (
                <button key={item.label} onClick={() => { setActiveNav(item.label); setMobileNav(false) }} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition ${activeNav === item.label ? "bg-white/12 text-white" : "text-white/50"}`}><Icon name={item.icon} size={18} />{item.label}</button>
              ))}
            </nav>
            <button
  onClick={() => {
    setMobileNav(false)
    setProfileOpen(true)
  }}
  className="mt-auto flex items-center gap-3 rounded-2xl border border-white/10 p-3 text-left"
>
  <UserAvatar size="size-9" />

  <div className="min-w-0 flex-1">
    <p className="truncate text-xs font-bold">
      {auth.currentUser?.displayName || "TerraSense User"}
    </p>

    <p className="mt-0.5 text-[10px] text-white/40">
      View profile
    </p>
  </div>

  <Icon name="chevron" size={14} />
</button>
          </aside>
          <button onClick={() => setMobileNav(false)} className="h-full flex-1" aria-label="Close navigation overlay" />
        </div>
      )}
      {profilePresence.mounted && (
        <ProfilePanel
          shown={profilePresence.shown}
          onClose={() => setProfileOpen(false)}
          onSignOut={() => { setProfileOpen(false); signOut(auth); setAuthScreen("login") }}
          greenhouses={greenhouses}
          currentGreenhouse={currentGreenhouse}
          now={now}
          notifPrefs={notifPrefs}
          onNotifPrefs={updateNotifPrefs}
          wifiSettings={wifiSettings}
            onUpdateWifi={async (settings, onStep) => {
            if (!user || !greenhouse) return
            const step = onStep ?? (() => {})

            const deviceRef = doc(firestore, "users", user.uid, "devices", greenhouse.id)
            const saved = await getDoc(deviceRef)
            const claimCode = saved.exists() ? (saved.data().claimCode as string | undefined) : undefined
            if (!claimCode) {
              throw new Error("This hub's setup code isn't saved on your phone. Disown the greenhouse and add it again with Bluetooth once.")
            }

            // Bluetooth wakes up, finds the hub and hands it the new Wi-Fi
            const hubDeviceId = await connectToHub(greenhouse.id, step)
            try {
              await sendWifiToHub(hubDeviceId, claimCode, settings.ssid, settings.password, step)
            } finally {
              await disconnectHub(hubDeviceId)
            }

            // The hub confirmed it joined, so keep the same details on the phone
            await setDoc(
              deviceRef,
              { name: settings.deviceName, greenhouseId: greenhouse.id, ssid: settings.ssid, wifiPassword: settings.password, status: "configured", updatedAt: serverTimestamp() },
              { merge: true }
            )
            await saveNetwork(user.uid, settings.ssid, settings.password).catch(() => {})
            setWifiSettings(settings)
            buzzResult("success")
          }}
          onSwitch={(index) => setCurrentGreenhouse(index)}
          onEdit={async (id, data) => {
            try {
              await update(ref(db, `greenhouses/${id}/meta`), { name: data.name, location: data.location || "Location not set" })
            } catch (e) {
              if (isPermissionError(e)) throw new Error("You don't have permission to change this greenhouse.")
              throw e
            }
          }}
          onRemoveFromApp={async (id) => {
            if (!user) throw new Error("You must be signed in to remove a greenhouse.")
            // Only forget it in this app: ownership, the plant cycle and the hub's data stay untouched
            await remove(ref(db, `userGreenhouses/${user.uid}/${id}`))
          }}
          onRemove={async (id) => {
            if (!user) throw new Error("You must be signed in to remove a greenhouse.")
            // A running plant cycle blocks disowning; stop it first
            if (greenhouses.find((g) => g.id === id)?.plan) {
              throw new Error("A plant cycle is running on this greenhouse. Stop it in Plants first, then disown.")
            }
            await unlinkGreenhouse(user.uid, id)
            // Erase every trace of the plant cycle, including the copy kept on this account
            delete syncedPlans.current[id]
            await setDoc(doc(firestore, "users", user.uid, "devices", id), { plan: deleteField() }, { merge: true }).catch(() => {})
            buzzResult("warning")
          }}
          onSetupHub={() => { setProfileOpen(false); setAuthScreen("setup") }}
          onAdd={async (input) => {
            if (!user) throw new Error("You must be signed in to add a greenhouse.")
            const id = await claimGreenhouse(user.uid, input)
            setPendingSelect(id)
            buzzResult("success")
          }}
        />
      )}
    </div>
  )
}

function SplashScreen() {
  return (
    <div className="grid min-h-dvh place-items-center bg-forest px-8 text-white">
      <div className="text-center">
        <div className="splash-mark mx-auto grid size-20 place-items-center rounded-3xl bg-leaf text-forest shadow-2xl"><Icon name="leaf" size={38} /></div>
        <p role="heading" aria-level={1} className="splash-copy mt-6 text-3xl font-extrabold tracking-tight">TerraSense</p>
        <p className="splash-copy mt-2 text-xs font-medium tracking-wide text-white/45">Intelligent growing, naturally.</p>
        <div className="mx-auto mt-10 h-1 w-24 overflow-hidden rounded-full bg-white/10"><div className="splash-progress h-full rounded-full bg-leaf" /></div>
      </div>
    </div>
  )
}

function LoginScreen({
  onLogin,
  onCreateAccount,
}: {
  onLogin: () => void
  onCreateAccount: () => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  useEffect(() => { if (error) buzzResult("error") }, [error])
  const [loading, setLoading] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (loading) return

    setError("")

    if (!email.trim() || !password) {
      setError("Please enter your email and password.")
      return
    }

    try {
      setLoading(true)

      await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      )

      // Only go to the app AFTER Firebase successfully authenticates.
      onLogin()
    } catch (e: any) {
      console.error("Firebase login error:", e)

      if (
        e?.code === "auth/invalid-credential" ||
        e?.code === "auth/wrong-password" ||
        e?.code === "auth/user-not-found"
      ) {
        setError(
          "Invalid email or password. Please check your details or sign up."
        )
      } else if (e?.code === "auth/invalid-email") {
        setError("Please enter a valid email address.")
      } else if (e?.code === "auth/too-many-requests") {
        setError("Too many attempts. Please try again later.")
      } else {
        setError(e?.message || "Unable to sign in. Please try again.")
      }
    } finally {
      setLoading(false)
    }
  }

  const google = async () => {
    setError("")

    try {
      setLoading(true)
      await googleSignIn()
      onLogin()
    } catch (e: any) {
      console.error("Google login error:", e)
      setError(e?.message || "Unable to sign in with Google.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-dvh bg-forest">
      <main className="safe-auth-top mx-auto flex min-h-dvh w-full max-w-md landscape:max-w-xl flex-col bg-canvas px-5 pb-8 shadow-2xl">

        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl bg-forest text-leaf">
            <Icon name="leaf" size={23} />
          </div>

          <div>
            <p className="text-lg font-extrabold tracking-tight">
              TerraSense
            </p>
            <p className="text-[10px] text-muted">
              Smart greenhouse
            </p>
          </div>
        </div>

        <div className="mt-16">
          <span className="rounded-full bg-mint px-3 py-1.5 text-[10px] font-bold text-forest">
            WELCOME BACK
          </span>

          <p
            role="heading"
            aria-level={1}
            className="mt-5 text-3xl font-extrabold tracking-tight"
          >
            Sign in to your greenhouse.
          </p>

          <p className="mt-3 text-sm leading-6 text-muted">
            Monitor your crops, devices, and growing conditions from anywhere.
          </p>
        </div>

        <button
          type="button"
          onClick={google}
          disabled={loading}
          className="mt-9 flex w-full items-center justify-center gap-3 rounded-2xl border border-border bg-white py-3.5 text-sm font-bold text-ink shadow-card transition active:scale-[0.98] disabled:opacity-60"
        >
          <span className="grid size-6 place-items-center rounded-full border border-border text-sm font-extrabold text-blue-ink">
            G
          </span>

          Continue with Google
        </button>

        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted">
            or use email
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <form className="space-y-5" onSubmit={submit}>

          <div>
            <label
              htmlFor="login-email"
              className="text-[10px] font-bold uppercase tracking-widest text-muted"
            >
              Email address
            </label>

            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="mt-2 w-full rounded-2xl border border-border bg-white px-4 py-3.5 text-sm outline-none transition focus:border-leaf focus:ring-4 focus:ring-mint"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor="login-password"
                className="text-[10px] font-bold uppercase tracking-widest text-muted"
              >
                Password
              </label>

              <button
                type="button"
                className="text-[10px] font-bold text-forest"
              >
                Forgot password?
              </button>
            </div>

            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              placeholder="Enter your password"
              className="mt-2 w-full rounded-2xl border border-border bg-white px-4 py-3.5 text-sm outline-none transition placeholder:text-muted/50 focus:border-leaf focus:ring-4 focus:ring-mint"
            />
          </div>

          {error && (
            <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl bg-forest py-4 text-sm font-bold text-white shadow-lg transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>

        </form>

        <p className="mt-auto pt-10 text-center text-xs text-muted">
          New to TerraSense?{" "}
          <button
            type="button"
            onClick={onCreateAccount}
            className="font-bold text-forest"
          >
            Create an account
          </button>
        </p>

      </main>
    </div>
  )
}


function RegisterScreen({
  onRegister,
  onBackToLogin,
}: {
  onRegister: () => void
  onBackToLogin: () => void
}) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  useEffect(() => { if (error) buzzResult("error") }, [error])

  const submitRegistration = async (event: React.FormEvent) => {
    event.preventDefault()
    setError("")

    if (!name.trim()) {
      setError("Please enter your name.")
      return
    }

    if (!email.trim()) {
      setError("Please enter your email.")
      return
    }

    if (password.length < 8) {
      setError("Password must contain at least 8 characters.")
      return
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }

    try {
      const cred = await createUserWithEmailAndPassword(
        auth,
        email.trim(),
        password
      )

      await updateProfile(cred.user, {
        displayName: name.trim(),
      })

      onRegister()
    } catch (e: any) {
      if (e.code === "auth/email-already-in-use") {
        setError("This email is already registered. Please sign in.")
      } else if (e.code === "auth/invalid-email") {
        setError("Please enter a valid email address.")
      } else if (e.code === "auth/weak-password") {
        setError("Please choose a stronger password.")
      } else {
        setError(authMessage(e))
      }
    }
  }

  const google = async () => {
    setError("")
    try {
      await googleSignIn()
      onRegister()
    } catch (e) {
      setError(authMessage(e))
    }
  }

  return (
    <div className="min-h-dvh bg-forest">
      <main className="safe-page-top mx-auto min-h-dvh w-full max-w-md landscape:max-w-xl bg-canvas px-5 pb-8 shadow-2xl">
        <button
          onClick={onBackToLogin}
          className="flex items-center gap-1 rounded-xl py-2 text-xs font-bold text-muted"
        >
          <span className="rotate-180">
            <Icon name="chevron" size={16} />
          </span>
          Back to sign in
        </button>

        <div className="mt-8 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl bg-forest text-leaf">
            <Icon name="leaf" size={23} />
          </div>
          <div>
            <p className="text-lg font-extrabold tracking-tight">TerraSense</p>
            <p className="text-[10px] text-muted">Smart greenhouse</p>
          </div>
        </div>

        <div className="mt-10">
          <span className="rounded-full bg-mint px-3 py-1.5 text-[10px] font-bold text-forest">
            GET STARTED
          </span>
          <p
            role="heading"
            aria-level={1}
            className="mt-5 text-3xl font-extrabold tracking-tight"
          >
            Create your account.
          </p>
          <p className="mt-3 text-sm leading-6 text-muted">
            Start monitoring and managing your greenhouses from anywhere.
          </p>
        </div>

        <button
          type="button"
          onClick={google}
          className="mt-8 flex w-full items-center justify-center gap-3 rounded-2xl border border-border bg-white py-3.5 text-sm font-bold text-ink shadow-card transition active:scale-[0.98]"
        >
          <span className="grid size-6 place-items-center rounded-full border border-border text-sm font-extrabold text-blue-ink">
            G
          </span>
          Sign up with Google
        </button>

        <div className="my-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted">
            or use email
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <form className="space-y-4" onSubmit={submitRegistration}>
          <AuthField
            id="register-name"
            label="Full name"
            type="text"
            value={name}
            onChange={setName}
            placeholder="Your full name"
          />

          <AuthField
            id="register-email"
            label="Email address"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
          />

          <AuthField
            id="register-password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="At least 8 characters"
          />

          <AuthField
            id="register-confirm"
            label="Confirm password"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder="Re-enter your password"
          />

          {error && (
            <p className="rounded-xl bg-coral-soft p-3 text-xs font-medium text-coral">
              {error}
            </p>
          )}

          <label className="flex items-start gap-3 text-[10px] leading-4 text-muted">
            <input
              type="checkbox"
              required
              className="mt-0.5 accent-forest"
            />
            <span>
              I agree to the TerraSense Terms of Service and Privacy Policy.
            </span>
          </label>

          <button
            type="submit"
            className="w-full rounded-2xl bg-forest py-4 text-sm font-bold text-white shadow-lg transition active:scale-[0.98]"
          >
            Create account
          </button>
        </form>

        <p className="pt-8 text-center text-xs text-muted">
          Already have an account?{" "}
          <button
            type="button"
            onClick={onBackToLogin}
            className="font-bold text-forest"
          >
            Sign in
          </button>
        </p>
      </main>
    </div>
  )
}


function AuthField({ id, label, type = "text", value, onChange, placeholder }: { id?: string; label: string; type?: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <div><label htmlFor={id} className="text-[10px] font-bold uppercase tracking-widest text-muted">{label}</label><input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} required placeholder={placeholder} className="mt-2 w-full rounded-2xl border border-border bg-white px-4 py-3 text-sm outline-none transition placeholder:text-muted/50 focus:border-leaf focus:ring-4 focus:ring-mint" /></div>
}

function WifiSetupScreen({
  onComplete,
  onSkip,
}: {
  onComplete: (settings: WifiSettings, greenhouseId: string) => void
  onSkip: () => void
}) {
  const [greenhouseId, setGreenhouseId] = useState("")
  const [claimCode, setClaimCode] = useState("")
  const [greenhouseName, setGreenhouseName] = useState("")
  const [deviceName, setDeviceName] = useState("TerraSense Hub")
  const [ssid, setSsid] = useState("")
  const [password, setPassword] = useState("")
  const [hubDeviceId, setHubDeviceId] = useState("")   // set while the phone is connected to the hub
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState("")
  const [error, setError] = useState("")
  useEffect(() => { if (error) buzzResult("error") }, [error])
  const [networks, setNetworks] = useState<SavedNetwork[]>([])
  const [networkChoice, setNetworkChoice] = useState("new")   // a saved network's id, or "new"

  const connected = hubDeviceId !== ""
  const hubName = `TerraSense-${greenhouseId.trim().toUpperCase().slice(6)}`

  // Offer the Wi-Fi details already saved in the app, so they don't need retyping
    // Saved Wi-Fi networks: pick one, or add a new one
  useEffect(() => {
    const user = auth.currentUser
    if (!user) return
    loadNetworks(user.uid)
      .then((list) => {
        setNetworks(list)
        if (list.length > 0) {
          setNetworkChoice(list[0].id)
          setSsid(list[0].ssid)
          setPassword(list[0].password)
        }
      })
      .catch(() => {})
  }, [])

  const chooseNetwork = (id: string) => {
    setNetworkChoice(id)
    const net = networks.find((n) => n.id === id)
    setSsid(net?.ssid ?? "")
    setPassword(net?.password ?? "")
  }

  // Page 1: find the hub over Bluetooth and connect
  const searchHub = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return

    if (!greenhouseId.trim() || !claimCode.trim()) {
      setError("Enter the greenhouse ID and claim code from your TerraSense hub.")
      return
    }

    try {
      setBusy(true)
      setError("")
      const deviceId = await connectToHub(greenhouseId, setStep, () => setHubDeviceId(""))
      setHubDeviceId(deviceId)
    } catch (e: any) {
      console.error("Bluetooth connect error:", e)
      setError(e?.message || "Couldn't connect to the hub. Please try again.")
    } finally {
      setBusy(false)
      setStep("")
    }
  }

  // Page 2: send the Wi-Fi over Bluetooth, then link the hub to this account
  const sendWifi = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return

    if (!ssid.trim() || !password) {
      setError("Please enter your Wi-Fi network name and password.")
      return
    }

    const user = auth.currentUser
    if (!user) {
      setError("You must be signed in to connect a device.")
      return
    }

    try {
      setBusy(true)
      setError("")

      await sendWifiToHub(hubDeviceId, claimCode, ssid.trim(), password, setStep)
      setStep("Linking to your account…")

      // The hub needs a few seconds after joining Wi-Fi to register itself, so retry
      let id = ""
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          id = await claimGreenhouse(user.uid, {
            id: greenhouseId,
            code: claimCode,
            name: greenhouseName,
            location: "",
          })
          break
        } catch (err) {
          if (attempt === 4) throw err
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }

      const name = deviceName.trim() || "TerraSense Hub"
      await setDoc(
        doc(firestore, "users", user.uid, "devices", id),
        {
          name,
          greenhouseId: id,
          ssid: ssid.trim(),
          wifiPassword: password,
          claimCode: claimCode.trim().toUpperCase(),
          status: "configured",
          createdAt: serverTimestamp(),
        },
        { merge: true }
      )
      // Keep the Wi-Fi on the account's saved list too, so it survives removing every greenhouse
      await saveNetwork(user.uid, ssid.trim(), password).catch(() => {})

      await disconnectHub(hubDeviceId)
      setHubDeviceId("")
      buzzResult("success")
      onComplete({ ssid: ssid.trim(), password, deviceName: name }, id)
    } catch (e: any) {
      console.error("Device setup error:", e)
      setError(e?.message || "Unable to connect the device. Please try again.")
      buzzResult("error")
    } finally {
      setBusy(false)
      setStep("")
    }
  }

  const goBack = async () => {
    if (busy) return
    await disconnectHub(hubDeviceId)
    setHubDeviceId("")
    setError("")
  }

  const skip = async () => {
    if (hubDeviceId) await disconnectHub(hubDeviceId)
    onSkip()
  }

  return (
    <div className="min-h-dvh bg-forest">
      <main className="safe-setup-top mx-auto flex min-h-dvh w-full max-w-md landscape:max-w-xl flex-col bg-canvas px-5 pb-8 shadow-2xl">

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-forest text-leaf">
              <Icon name="leaf" size={23} />
            </div>

            <div>
              <p className="text-lg font-extrabold tracking-tight">TerraSense</p>
              <p className="text-[10px] text-muted">Device setup</p>
            </div>
          </div>

          <span className="rounded-full bg-mint px-2.5 py-1 text-[10px] font-bold text-forest">
            {connected ? "SETUP 2 OF 2" : "SETUP 1 OF 2"}
          </span>
        </div>

        {!connected ? (
          <>
            <div className="mt-10">
              <div className="grid size-14 place-items-center rounded-2xl bg-blue-soft text-blue-ink">
                <Icon name="bolt" size={25} />
              </div>

              <p role="heading" aria-level={1} className="mt-6 text-3xl font-extrabold tracking-tight">
                Connect with Bluetooth.
              </p>

              <p className="mt-3 text-sm leading-6 text-muted">
                Enter the ID and claim code of your TerraSense hub. Your phone will find it and connect over Bluetooth.
              </p>
            </div>

            <form onSubmit={searchHub} className="mt-8 space-y-5">
              <AuthField id="setup-gh-id" label="Greenhouse ID" type="text" value={greenhouseId} onChange={setGreenhouseId} placeholder="TS-GH-XXXX" />
              <AuthField id="setup-claim-code" label="Claim code" type="text" value={claimCode} onChange={setClaimCode} placeholder="Code shown on your hub" />
              <AuthField id="setup-gh-name" label="Greenhouse name" type="text" value={greenhouseName} onChange={setGreenhouseName} placeholder="e.g. North greenhouse" />
              <AuthField id="setup-device" label="Device name" type="text" value={deviceName} onChange={setDeviceName} placeholder="TerraSense Hub" />

              {error && (
                <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
                  {error}
                </p>
              )}

              <div className="flex gap-3 rounded-2xl bg-mint/50 p-4 text-forest">
                <Icon name="bolt" size={18} />

                <p className="text-[10px] leading-4">
                  Keep your TerraSense hub powered on and within a few meters of your phone, with Bluetooth turned on. Allow the Nearby devices permission when asked.
                </p>
              </div>

              <button
                disabled={busy}
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-forest py-4 text-sm font-bold text-white shadow-lg transition disabled:opacity-70"
              >
                {busy ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    {step || "Searching…"}
                  </>
                ) : (
                  "Search for hub"
                )}
              </button>

              <button type="button" onClick={skip} className="w-full py-2 text-xs font-bold text-muted">
                Skip for now
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="mt-10">
              <div className="grid size-14 place-items-center rounded-2xl bg-blue-soft text-blue-ink">
                <Icon name="wifi" size={25} />
              </div>

              <p role="heading" aria-level={1} className="mt-6 text-3xl font-extrabold tracking-tight">
                Send your Wi-Fi.
              </p>

              <p className="mt-3 text-sm leading-6 text-muted">
                Your hub will join this network. It must be a 2.4 GHz network.
              </p>

              <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-green-soft px-3 py-1.5 text-[11px] font-bold text-green-ink">
                <span className="size-2 rounded-full bg-green" />
                Connected to {hubName}
              </p>
            </div>

            <form onSubmit={sendWifi} className="mt-8 space-y-5">
                  {networks.length > 0 && (
                <div>
                  <label htmlFor="setup-network" className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-muted">
                    Saved networks
                  </label>
                  <select
                    id="setup-network"
                    value={networkChoice}
                    onChange={(e) => chooseNetwork(e.target.value)}
                    className="w-full rounded-2xl border border-border bg-white px-4 py-3.5 text-sm font-medium text-ink"
                  >
                    {networks.map((n) => (
                      <option key={n.id} value={n.id}>{n.ssid}</option>
                    ))}
                    <option value="new">Add a new network…</option>
                  </select>
                </div>
              )}
              <AuthField id="setup-ssid" label="Wi-Fi network name" type="text" value={ssid} onChange={setSsid} placeholder="Enter network SSID" />
              <AuthField id="setup-wifi-password" label="Wi-Fi password" type="password" value={password} onChange={setPassword} placeholder="Enter network password" />

              {error && (
                <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
                  {error}
                </p>
              )}

              <button
                disabled={busy}
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-forest py-4 text-sm font-bold text-white shadow-lg transition disabled:opacity-70"
              >
                {busy ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    {step || "Sending…"}
                  </>
                ) : (
                  "Send Wi-Fi to hub"
                )}
              </button>

              <button type="button" onClick={goBack} className="w-full py-2 text-xs font-bold text-muted">
                Back
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  )
}

const fmtRange = (a: number, b: number, unit: string) => `${a}–${b}${unit}`

function StageRow({ stage, active }: { stage: StageDef; active: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${active ? "border-leaf bg-mint/40" : "border-border bg-canvas"}`}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold">{stage.name}{active && <span className="ml-2 rounded-full bg-forest px-2 py-0.5 text-[9px] font-bold text-white">NOW</span>}</p>
        <span className="text-[10px] font-bold text-muted">{stage.days} days</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <span><span className="text-muted">Temp </span><b>{fmtRange(stage.tempMin, stage.tempMax, "°C")}</b></span>
        <span><span className="text-muted">Soil </span><b>{fmtRange(stage.moistureMin, stage.moistureMax, "%")}</b></span>
        <span><span className="text-muted">Light </span><b>{stage.lightHours} h/day</b></span>
        <span><span className="text-muted">Feed </span><b>every {stage.feedEveryDays} d</b></span>
      </div>
    </div>
  )
}

function PlantsPage({ plants, greenhouse, now, online, onStart, onStop }: {
  plants: PlantProfile[]
  greenhouse: Greenhouse | null
  now: number
  online: boolean
  onStart: (plant: PlantProfile) => void
  onStop: () => void
}) {
  const [selected, setSelected] = useState(0)
  const [cycleAlert, setCycleAlert] = useState(false)
  const [offlineAlert, setOfflineAlert] = useState(false)
  const plant = plants[selected] ?? plants[0]
  const active = greenhouse?.plan
  const cur = currentStage(active, now)

  if (!plant) {
    return (
      <section className="grid min-h-[50vh] place-items-center px-5 text-center">
        <div>
          <p className="text-lg font-bold">No plant profiles yet</p>
          <p className="mt-2 text-xs text-muted">Add a plant from the Plant Library to start a growing cycle.</p>
        </div>
      </section>
    )
  }

  const startPlant = () => {
    if (!greenhouse) return
    if (!online) { setOfflineAlert(true); return }
    if (active) { setCycleAlert(true); return }
    onStart(plant)
  }

  const isActivePlant = active?.plantId === plant.id

  return (
    <section className="space-y-5">
      {offlineAlert && (
        <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-ink/50 px-6" role="alertdialog" aria-modal="true">
          <div className="pop-in w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-amber-soft text-amber-ink"><Icon name="wifi" size={26} /></div>
            <p className="mt-4 text-base font-bold">Device is offline</p>
            <p className="mt-2 text-xs leading-5 text-muted">Your TerraSense hub isn't connected right now, so the plant cycle can't be started. Check that it is powered on and connected to Wi-Fi, then try again.</p>
            <button onClick={() => setOfflineAlert(false)} className="mt-5 w-full rounded-xl bg-forest py-3 text-sm font-bold text-white">OK</button>
          </div>
        </div>
      )}
      {active && cur && (
        <div className="rounded-2xl border border-leaf/30 bg-mint/40 p-4">
          <p className="text-xs font-bold text-forest">Active cycle · {active.name}</p>
          <p className="mt-1 text-[11px] text-muted">{cur.finished ? "All stages complete" : `${cur.stage.name} · Day ${cur.day}`}</p>
          <button onClick={onStop} className="mt-3 rounded-xl bg-white px-3 py-2 text-xs font-bold text-coral">Stop cycle</button>
        </div>
      )}
      {cycleAlert && (
        <div className="rounded-2xl border border-amber/30 bg-amber-soft p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1"><p className="text-xs font-bold text-amber-ink">A plant is already in cycle</p><p className="mt-1 text-[10px] leading-4 text-muted">{active?.name} is running in this greenhouse. Stop that cycle before starting {plant.name}.</p></div>
            <button onClick={() => setCycleAlert(false)} className="text-amber-ink" aria-label="Dismiss cycle alert"><Icon name="close" size={15} /></button>
          </div>
        </div>
      )}
      <div>
        <p role="heading" aria-level={2} className="text-2xl font-bold tracking-tight">Plant profiles</p>
        <p className="mt-1 text-sm text-muted">Each plant carries settings for every growth stage.</p>
      </div>
      <div className="grid gap-4">
        {plants.map((item, index) => (
          <button key={item.id} onClick={() => setSelected(index)} className={`overflow-hidden rounded-2xl border bg-white text-left shadow-card transition ${selected === index ? "border-leaf ring-2 ring-leaf/20" : "border-border"}`}>
            {item.image ? <img src={item.image} alt={item.name} className="h-36 w-full object-cover" /> : <div className="grid h-24 w-full place-items-center bg-mint text-forest"><Icon name="leaf" size={32} /></div>}
            <div className="p-4">
              <div className="flex items-center justify-between"><p className="text-sm font-bold">{item.name}</p>{selected === index && <span className="rounded-full bg-mint px-2 py-1 text-[10px] font-bold text-forest">SELECTED</span>}</div>
              <p className="mt-1 text-xs text-muted">{item.category} · {item.stages.length} stages · {item.stages.reduce((n, st) => n + st.days, 0)} days</p>
            </div>
          </button>
        ))}
      </div>
      <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
        <span className="rounded-full bg-mint px-3 py-1.5 text-[10px] font-bold text-forest">GROWTH STAGES</span>
        <p role="heading" aria-level={3} className="mt-5 text-2xl font-bold">{plant.name}</p>
        <div className="mt-5 space-y-3">
          {plant.stages.map((stage) => <StageRow key={stage.key} stage={stage} active={isActivePlant && !!cur && !cur.finished && cur.stage.key === stage.key} />)}
        </div>
        <button onClick={startPlant} disabled={!greenhouse} className="mt-7 w-full rounded-xl bg-forest py-3 text-sm font-bold text-white disabled:opacity-40">
          {greenhouse ? "Start this plant cycle" : "Add a greenhouse first"}
        </button>
      </div>
    </section>
  )
}

function PlantLibraryPage({ library, savedIds, onDownload }: {
  library: PlantProfile[]
  savedIds: string[]
  onDownload: (plant: PlantProfile) => void
}) {
  const [category, setCategory] = useState("All presets")
  const categories = ["All presets", ...Array.from(new Set(library.map((p) => p.category)))]
  const visible = category === "All presets" ? library : library.filter((p) => p.category === category)

  return (
    <section className="space-y-6">
      <div className="rounded-3xl bg-forest p-6 text-white shadow-card">
        <span className="rounded-full bg-white/10 px-3 py-1.5 text-[10px] font-bold tracking-widest text-mint">PLANT PRESETS</span>
        <p role="heading" aria-level={2} className="mt-5 text-2xl font-bold tracking-tight">Plant Library</p>
        <p className="mt-2 text-sm leading-6 text-white/60">Add a plant to your account to use its settings for every growth stage.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map((item) => (
          <button key={item} onClick={() => setCategory(item)} className={`rounded-full px-4 py-2 text-xs font-bold transition ${category === item ? "bg-forest text-white" : "border border-border bg-white text-muted"}`}>{item}</button>
        ))}
      </div>

      {visible.length === 0 && <p className="text-xs text-muted">No presets available yet.</p>}

      <div className="grid gap-4">
        {visible.map((plant) => {
          const saved = savedIds.includes(plant.id)
          return (
            <div key={plant.id} className="rounded-2xl border border-border bg-white p-5 shadow-card">
              {plant.image && <img src={plant.image} alt={plant.name} className="mb-4 h-36 w-full rounded-xl object-cover" />}
              <div className="flex items-start justify-between">
                <div className="grid size-12 place-items-center rounded-2xl bg-mint text-forest"><Icon name="leaf" /></div>
                <span className="rounded-full bg-canvas px-2.5 py-1 text-[10px] font-bold text-muted">{plant.category}</span>
              </div>
              <p role="heading" aria-level={3} className="mt-5 text-base font-bold">{plant.name}</p>
              <p className="mt-1 text-xs text-muted">{plant.stages.length} stages · {plant.stages.reduce((n, st) => n + st.days, 0)} days</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {plant.stages.map((st) => <span key={st.key} className="rounded-full bg-canvas px-2.5 py-1 text-[10px] font-bold text-muted">{st.name} · {st.days}d</span>)}
              </div>
              <div className="mt-5 border-t border-border pt-4">
                <button onClick={() => onDownload(plant)} disabled={saved} className={`w-full rounded-xl px-4 py-2.5 text-xs font-bold transition ${saved ? "bg-mint text-forest" : "bg-forest text-white"}`}>
                  {saved ? "Added to my plants" : "Add to my plants"}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function LoadingState() {
  return (
    <section className="grid min-h-[50vh] place-items-center text-center">
      <div>
        <div className="mx-auto size-8 animate-spin rounded-full border-2 border-border border-t-forest" />
        <p className="mt-4 text-xs text-muted">Loading your greenhouses…</p>
      </div>
    </section>
  )
}

function StageTimeline({ plan, cycle }: { plan: PlanView; cycle: NonNullable<ReturnType<typeof currentStage>> }) {
  const total = plan.stages.reduce((n, st) => n + st.days, 0)
  const index = plan.stages.findIndex((st) => st.key === cycle.stage.key)
  const startOfStage = plan.stages.slice(0, Math.max(index, 0)).reduce((n, st) => n + st.days, 0)
  const dayInStage = cycle.finished ? cycle.stage.days : Math.max(1, cycle.day - startOfStage)
  const daysLeftInStage = cycle.finished ? 0 : Math.max(0, cycle.stage.days - dayInStage)
  const next = plan.stages[index + 1]
  const daysLeftInCycle = Math.max(0, total - Math.min(cycle.day, total))
  const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`

  return (
    <section className="rounded-3xl border border-border bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted">Growth cycle · {plan.name}</p>
          <p role="heading" aria-level={2} className="mt-2 text-lg font-bold tracking-tight">
            {cycle.finished ? "All stages complete" : `${cycle.stage.name} · Day ${dayInStage} of ${cycle.stage.days}`}
          </p>
          <p className="mt-1 text-xs text-muted">
            {cycle.finished
              ? "Ready to harvest, or start a new cycle."
              : next
                ? `${plural(daysLeftInStage)} until ${next.name}`
                : `${plural(daysLeftInStage)} until harvest`}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-mint px-3 py-1.5 text-[10px] font-bold text-forest">{cycle.finished ? "DONE" : `${plural(daysLeftInCycle)} left`}</span>
      </div>

      <div className="mt-5 flex gap-1">
        {plan.stages.map((st, i) => {
          const fill = cycle.finished || i < index ? 100 : i === index ? Math.min(100, (dayInStage / (st.days || 1)) * 100) : 0
          return (
            <div key={st.key} style={{ flexGrow: st.days || 1, flexBasis: 0 }} className="min-w-0">
              <div className="h-2 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-leaf" style={{ width: `${fill}%` }} /></div>
              <p className={`mt-2 truncate text-[10px] font-bold ${i === index && !cycle.finished ? "text-forest" : "text-muted"}`}>{st.name}</p>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function NoDeviceState({ section, onConnect }: { section: "Overview" | "Analytics"; onConnect: () => void }) {
  return (
    <section className="flex min-h-[58vh] flex-col items-center justify-center px-5 text-center">
      <div className="relative">
        <div className="grid size-20 place-items-center rounded-3xl bg-white text-muted shadow-card"><Icon name={section === "Overview" ? "wifi" : "chart"} size={30} /></div>
        <span className="absolute -right-1 -top-1 grid size-7 place-items-center rounded-full border-4 border-canvas bg-amber text-xs font-bold text-white">!</span>
      </div>
      <p role="heading" aria-level={2} className="mt-6 text-xl font-bold tracking-tight">{section === "Overview" ? "No device connected" : "No analytics yet"}</p>
      <p className="mt-2 max-w-xs text-xs leading-5 text-muted">{section === "Overview" ? "Connect a TerraSense device to start seeing live greenhouse conditions and controls." : "Analytics will appear here after a TerraSense device begins collecting greenhouse data."}</p>
      <button onClick={onConnect} className="mt-6 rounded-2xl bg-forest px-6 py-3 text-xs font-bold text-white shadow-lg transition active:scale-95">{section === "Overview" ? "Connect a device" : "Set up TerraSense"}</button>
      <p className="mt-4 text-[10px] text-muted">You can also configure a device from your profile settings.</p>
    </section>
  )
}

// Indoor light is often under 10 lx (even under 1 lx), so whole-number rounding would show 0
function formatLux(n: number) {
  if (n >= 100) return String(Math.round(n))
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

const analyticsMetrics = [
  { key: "temperature", label: "Temperature", unit: "°C" },
  { key: "humidity", label: "Humidity", unit: "%" },
  { key: "soilMoisture", label: "Soil moisture", unit: "%" },
  { key: "lightLux", label: "Light", unit: " lx" },
] as const

function AnalyticsPage({ rows }: { rows: HistoryRow[] }) {
  const [metric, setMetric] = useState<(typeof analyticsMetrics)[number]["key"]>("temperature")
  const def = analyticsMetrics.find((m) => m.key === metric)!
  const values = rows.map((r) => r[metric]).filter((v): v is number => typeof v === "number")
  const has = values.length > 0
  const avg = has ? values.reduce((a, b) => a + b, 0) / values.length : 0
  const fmt = (n: number) => `${metric === "lightLux" ? formatLux(n) : Math.round(n * 10) / 10}${def.unit}`
  const detail = has ? `Last ${values.length} readings` : "No readings yet"
  const lower = def.label.toLowerCase()
  return (
    <section className="space-y-5">
      <div><p role="heading" aria-level={2} className="text-2xl font-bold tracking-tight">Greenhouse analytics</p><p className="mt-1 text-sm text-muted">Based on readings recorded by your TerraSense hub.</p></div>
      <div className="island-scroll flex gap-2 overflow-x-auto">
        {analyticsMetrics.map((m) => (
          <button key={m.key} onClick={() => setMetric(m.key)} className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold transition ${metric === m.key ? "bg-forest text-white" : "border border-border bg-white text-muted"}`}>{m.label}</button>
        ))}
      </div>
      <div className="grid gap-4 landscape:grid-cols-3">
        <Metric label={`Average ${lower}`} value={has ? fmt(avg) : "—"} detail={detail} />
        <Metric label={`Highest ${lower}`} value={has ? fmt(Math.max(...values)) : "—"} detail={detail} />
        <Metric label={`Lowest ${lower}`} value={has ? fmt(Math.min(...values)) : "—"} detail={detail} />
      </div>
      <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
        <p className="text-base font-bold">{def.label} history</p>
        <div className="mt-8"><Sparkline values={values} /></div>
      </div>
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-2xl border border-border bg-white p-5 shadow-card"><p className="text-xs font-medium text-muted">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p><p className="mt-2 text-xs text-leaf">{detail}</p></div>
}

function NotifRow({ icon, title, detail, on, onToggle }: { icon: IconName; title: string; detail: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-black/5">
          <Icon name={icon} size={18} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{title}</p>
          <p className="mt-1 text-xs text-black/40">{detail}</p>
        </div>
      </div>
      <button
        onClick={onToggle}
        role="switch"
        aria-checked={on}
        aria-label={`Toggle ${title}`}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-forest" : "bg-black/15"}`}
      >
        <span className={`absolute top-1 size-4 rounded-full bg-white shadow-sm transition ${on ? "left-6" : "left-1"}`} />
      </button>
    </div>
  )
}

// Short, one-screen summary of a greenhouse (opens from the arrow on its card in Profile)
function GreenhouseInsights({ greenhouse, now, onClose }: { greenhouse: Greenhouse; now: number; onClose: () => void }) {
  const [live, setLive] = useState<LiveData & { relays?: Record<string, boolean> } | null>(null)
  const [rows, setRows] = useState<HistoryRow[]>([])

  useEffect(() => {
    const base = `greenhouses/${greenhouse.id}`
    const offLive = onValue(ref(db, `${base}/live`), (s) => setLive(s.val() ?? {}))
    const offHist = onValue(query(ref(db, `${base}/history`), limitToLast(48)), (s) => {
      const num = (x: any) => (x != null && Number.isFinite(Number(x)) ? Number(x) : undefined)
      const out: HistoryRow[] = []
      s.forEach((c) => {
        const v = c.val() ?? {}
        out.push({ temperature: num(v.temperature), humidity: num(v.humidity), soilMoisture: num(v.soilMoisture), lightLux: num(v.lightLux) })
      })
      setRows(out)
    })
    return () => { offLive(); offHist() }
  }, [greenhouse.id])

  const online = isOnline(greenhouse.lastSeen, now)
  const seen = (() => {
    if (!greenhouse.lastSeen) return "never"
    const mins = Math.max(0, Math.round((now - greenhouse.lastSeen) / 60000))
    if (mins < 1) return "just now"
    if (mins < 60) return `${mins} min ago`
    if (mins < 1440) return `${Math.round(mins / 60)} h ago`
    return `${Math.round(mins / 1440)} d ago`
  })()
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
  const t = num(live?.temperature), h = num(live?.humidity), so = num(live?.soilMoisture), lx = num(live?.lightLux)
  const cyc = currentStage(greenhouse.plan, now)
  const total = greenhouse.plan ? greenhouse.plan.stages.reduce((sum, st) => sum + st.days, 0) : 0
  const day = cyc ? Math.min(cyc.day, total || cyc.day) : 0
  const stageEnd = (() => {
    if (!greenhouse.plan || !cyc || cyc.finished) return 0
    let end = 0
    for (const st of greenhouse.plan.stages) { end += st.days; if (st === cyc.stage) break }
    return end
  })()
  const daysLeft = cyc && !cyc.finished ? Math.max(0, stageEnd - cyc.day) : 0

  const series = (k: keyof HistoryRow) => rows.map((r) => r[k]).filter((v): v is number => typeof v === "number")
  const notes: string[] = []
  if (!online) notes.push("Hub is offline")
  if (typeof live?.waterTank === "number" && live.waterTank < 20) notes.push("Water tank is low")
  if (typeof live?.fertilizer === "number" && live.fertilizer < 20) notes.push("Fertilizer is low")
  if (cyc && !cyc.finished) {
    if (t !== undefined && t > cyc.stage.tempMax) notes.push(`Warmer than the ${cyc.stage.tempMax}°C target`)
    if (t !== undefined && t < cyc.stage.tempMin) notes.push(`Cooler than the ${cyc.stage.tempMin}°C target`)
    if (so !== undefined && so < cyc.stage.moistureMin) notes.push("Soil is drier than the target")
  }
  if (cyc?.finished) notes.push("Plant cycle is complete")

  const tiles: { key: keyof HistoryRow; label: string; icon: IconName; tone: string; value: string; unit: string }[] = [
    { key: "temperature", label: "Temperature", icon: "thermometer", tone: "amber", value: t !== undefined ? t.toFixed(1) : "—", unit: "°C" },
    { key: "humidity", label: "Humidity", icon: "wind", tone: "blue", value: h !== undefined ? String(Math.round(h)) : "—", unit: "%" },
    { key: "soilMoisture", label: "Soil moisture", icon: "droplet", tone: "green", value: so !== undefined ? String(Math.round(so)) : "—", unit: "%" },
    { key: "lightLux", label: "Light", icon: "sun", tone: "purple", value: lx !== undefined ? formatLux(lx) : "—", unit: "lx" },
  ]

  const Spark = ({ values }: { values: number[] }) => {
    if (values.length < 2) return <div className="h-9" />
    const min = Math.min(...values), max = Math.max(...values), span = max - min || 1
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / span) * 24}`).join(" ")
    return (
      <svg className="h-9 w-full overflow-visible" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity=".75" />
      </svg>
    )
  }

  const pct = total > 0 ? Math.min(100, Math.round((day / total) * 100)) : 0
  const R = 42, C = 2 * Math.PI * R
  const rangeText = (k: keyof HistoryRow, vals: number[]) => {
    if (vals.length === 0) return "No history yet"
    const f = (n: number) => (k === "lightLux" ? formatLux(n) : n.toFixed(k === "temperature" ? 1 : 0))
    return `${f(Math.min(...vals))} – ${f(Math.max(...vals))} recently`
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-canvas" role="dialog" aria-modal="true" aria-label={`${greenhouse.name} insights`}>
      <div className="mx-auto w-full max-w-3xl pb-10">
        {/* Hero */}
        <div className="relative overflow-hidden bg-forest px-5 pb-7 text-white" style={{ paddingTop: "max(1.25rem, calc(env(safe-area-inset-top) + 0.75rem))", borderBottomLeftRadius: "2rem", borderBottomRightRadius: "2rem" }}>
          <div className="pointer-events-none absolute -right-10 -top-10 size-44 rounded-full bg-leaf/25 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-16 left-10 size-40 rounded-full bg-leaf/15 blur-2xl" />
          <div className="relative flex items-center justify-between">
            <button onClick={onClose} className="grid size-9 place-items-center rounded-full bg-white/10 text-white backdrop-blur" aria-label="Back"><span style={{ display: "inline-block", transform: "rotate(180deg)" }}><Icon name="chevron" size={16} /></span></button>
            <span className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide ${online ? "bg-leaf/25 text-white" : "bg-amber/25 text-white"}`}>
              <span className={`size-2 rounded-full ${online ? "bg-leaf" : "bg-amber"}`} />{online ? "Online" : "Offline"} · {seen}
            </span>
          </div>
          <div className="relative mt-6 flex items-center gap-4">
            <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-leaf text-forest shadow-lg"><Icon name="leaf" size={26} /></div>
            <div className="min-w-0">
              <p role="heading" aria-level={2} className="truncate text-2xl font-extrabold tracking-tight">{greenhouse.name}</p>
              <p className="mt-0.5 truncate text-xs text-white/60">{greenhouse.location} · {greenhouse.id}</p>
            </div>
          </div>
          <div className="relative mt-5 flex flex-wrap gap-2">
            {notes.length === 0
              ? <span className="rounded-full bg-leaf/25 px-3 py-1.5 text-[11px] font-bold">✓ All good, everything is in range</span>
              : notes.map((n) => <span key={n} className="rounded-full bg-amber/30 px-3 py-1.5 text-[11px] font-bold">⚠ {n}</span>)}
          </div>
        </div>

        <div className="space-y-4 px-5 pt-5">
          {/* Readings */}
          <div className="grid grid-cols-2 gap-3 landscape:grid-cols-4">
            {tiles.map((tile) => {
              const c = toneClasses[tile.tone]
              const vals = series(tile.key)
              return (
                <div key={tile.key} className="rounded-3xl border border-border bg-white p-4 shadow-card">
                  <div className="flex items-center justify-between">
                    <div className={`grid size-9 place-items-center rounded-xl ${c.soft} ${c.ink}`}><Icon name={tile.icon} size={17} /></div>
                    <span className="text-[10px] font-semibold text-muted">{tile.label}</span>
                  </div>
                  <p className="mt-3 text-2xl font-extrabold tracking-tight">{tile.value}<span className="ml-1 text-xs font-bold text-muted">{tile.value === "—" ? "" : tile.unit}</span></p>
                  <div className={`mt-2 ${c.ink}`}><Spark values={vals} /></div>
                  <p className="mt-1 text-[10px] text-muted">{rangeText(tile.key, vals)}</p>
                </div>
              )
            })}
          </div>

          {/* Plant cycle */}
          <div className="rounded-3xl border border-border bg-white p-5 shadow-card">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Plant cycle</p>
            {greenhouse.plan && cyc ? (
              <div className="mt-3">
                <div className="flex items-center gap-5">
                  <div className="relative size-24 shrink-0">
                    <svg viewBox="0 0 100 100" className="size-24 -rotate-90">
                      <circle cx="50" cy="50" r={R} fill="none" stroke="var(--color-border)" strokeWidth="9" />
                      <circle cx="50" cy="50" r={R} fill="none" stroke="var(--color-leaf)" strokeWidth="9" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} />
                    </svg>
                    <div className="absolute inset-0 grid place-items-center text-center"><div><p className="text-xl font-extrabold leading-none">{pct}%</p><p className="mt-1 text-[9px] text-muted">done</p></div></div>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-lg font-extrabold tracking-tight">{greenhouse.plan.name}</p>
                    <span className="mt-1 inline-block rounded-full bg-mint px-2.5 py-1 text-[10px] font-bold text-forest">{cyc.finished ? "Complete" : `${cyc.stage.name} stage`}</span>
                    <p className="mt-2 text-xs text-muted">Day <b className="text-ink">{day}</b> of {total}{!cyc.finished && <> · {daysLeft} {daysLeft === 1 ? "day" : "days"} left in stage</>}</p>
                  </div>
                </div>
                {total > 0 && (
                  <div className="mt-5 flex gap-1" aria-label="Stages">
                    {(() => {
                      let startDay = 0
                      return greenhouse.plan!.stages.map((st) => {
                        const begin = startDay
                        startDay += st.days
                        // Past stages are full, the current one fills day by day, later ones are empty
                        const doneDays = cyc.finished ? st.days : Math.max(0, Math.min(st.days, day - begin))
                        const pctFill = st.days > 0 ? (doneDays / st.days) * 100 : 0
                        return (
                          <div key={st.key} style={{ flexGrow: Math.max(1, st.days) }} className="min-w-0 basis-0">
                            <div className="h-2 overflow-hidden rounded-full bg-border">
                              <div className={`h-full rounded-full ${st === cyc.stage && !cyc.finished ? "bg-leaf" : "bg-forest/60"}`} style={{ width: `${Math.max(0, Math.min(100, pctFill))}%` }} />
                            </div>
                            <p className="mt-1.5 truncate text-[9px] text-muted">{st.name}</p>
                          </div>
                        )
                      })
                    })()}
                  </div>
                )}
                {!cyc.finished && (
                  <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-semibold">
                    <span className="rounded-full bg-amber-soft px-3 py-1.5 text-amber-ink">Temp {cyc.stage.tempMin}–{cyc.stage.tempMax}°C</span>
                    <span className="rounded-full bg-green-soft px-3 py-1.5 text-green-ink">Soil {cyc.stage.moistureMin}–{cyc.stage.moistureMax}%</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-3 text-sm text-muted"><div className="grid size-10 place-items-center rounded-xl bg-canvas"><Icon name="leaf" size={18} /></div>No active cycle. Start one from Plants.</div>
            )}
          </div>

          {/* Supplies */}
          <div className="rounded-3xl border border-border bg-white p-5 shadow-card">
            <p className="mb-4 text-[10px] font-bold uppercase tracking-wide text-muted">Supplies</p>
            <div className="space-y-5">
              {typeof live?.waterTank === "number"
                ? <ResourceLevel icon="tank" label="Water tank" value={`${live.waterTank}%`} detail={live.waterTank < 20 ? "Refill soon" : "Level OK"} tone="blue" width={`${live.waterTank}%`} />
                : <p className="text-xs text-muted">Water tank level not reported.</p>}
              {typeof live?.fertilizer === "number"
                ? <ResourceLevel icon="flask" label="Fertilizer" value={`${live.fertilizer}%`} detail={live.fertilizer < 20 ? "Refill soon" : "Level OK"} tone="green" width={`${live.fertilizer}%`} />
                : <p className="text-xs text-muted">Fertilizer level not reported.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

function ProfilePanel({
  shown,
  onClose,
  onSignOut,
  greenhouses,
  currentGreenhouse,
  onSwitch,
  onAdd,
  onSetupHub,
  onEdit,
  onRemove,
  onRemoveFromApp,
  wifiSettings,
  onUpdateWifi,
  now,
  notifPrefs,
  onNotifPrefs,
}: {
  shown: boolean
  onClose: () => void
  onSignOut: () => void
  greenhouses: Greenhouse[]
  currentGreenhouse: number
  onSwitch: (index: number) => void
  onAdd: (input: { id: string; code: string; name: string; location: string }) => Promise<void>
  onSetupHub: () => void
  onEdit: (id: string, data: { name: string; location: string }) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onRemoveFromApp: (id: string) => Promise<void>
  wifiSettings: WifiSettings
  onUpdateWifi: (settings: WifiSettings, onStep?: (message: string) => void) => Promise<void>
  now: number
  notifPrefs: NotifPrefs
  onNotifPrefs: (next: NotifPrefs) => void
}) {
  const [addingGreenhouse, setAddingGreenhouse] = useState(false)
  const [editingWifi, setEditingWifi] = useState(false)

  const user = auth.currentUser

  const safeWifiSettings: WifiSettings = {
    deviceName: wifiSettings?.deviceName || "TerraSense Hub",
    ssid: wifiSettings?.ssid || "",
    password: wifiSettings?.password || "",
  }

  const [wifiDraft, setWifiDraft] =
    useState<WifiSettings>(safeWifiSettings)

  const [wifiSynced, setWifiSynced] = useState(true)
  const [wifiStep, setWifiStep] = useState("")
    const [savedNetworks, setSavedNetworks] = useState<SavedNetwork[]>([])
  const [networkChoice, setNetworkChoice] = useState("new")   // a saved network's id, or "new"

  // Load the saved networks whenever the Wi-Fi editor opens
  useEffect(() => {
    const u = auth.currentUser
    if (!u) return
    loadNetworks(u.uid)
      .then((list) => {
        setSavedNetworks(list)
        const match = list.find((n) => n.ssid === wifiDraft.ssid)
        setNetworkChoice(match ? match.id : "new")
      })
      .catch(() => {})
  }, [editingWifi])

  const chooseSavedNetwork = (id: string) => {
    setNetworkChoice(id)
    const net = savedNetworks.find((n) => n.id === id)
    setWifiDraft((current) => ({ ...current, ssid: net?.ssid ?? "", password: net?.password ?? "" }))
  }

  const deleteSavedNetwork = async () => {
    const u = auth.currentUser
    if (!u || networkChoice === "new") return
    await deleteNetwork(u.uid, networkChoice).catch(() => {})
    setSavedNetworks((list) => list.filter((n) => n.id !== networkChoice))
    setNetworkChoice("new")
    setWifiDraft((current) => ({ ...current, ssid: "", password: "" }))
  }
  const [newNetSsid, setNewNetSsid] = useState("")
  const [newNetPass, setNewNetPass] = useState("")
  const [netBusy, setNetBusy] = useState(false)
  const [netError, setNetError] = useState("")

  const addNetwork = async () => {
    const u = auth.currentUser
    if (!u || !newNetSsid.trim() || !newNetPass) return
    try {
      setNetBusy(true)
      setNetError("")
      await saveNetwork(u.uid, newNetSsid.trim(), newNetPass)
      setSavedNetworks(await loadNetworks(u.uid))
      setNewNetSsid("")
      setNewNetPass("")
    } catch (e: any) {
      console.error("Save network error:", e)
      setNetError(e?.message || "Couldn't save the network. Please try again.")
    } finally {
      setNetBusy(false)
    }
  }

  const removeNetwork = async (id: string) => {
    const u = auth.currentUser
    if (!u) return
    await deleteNetwork(u.uid, id).catch(() => {})
    setSavedNetworks((list) => list.filter((n) => n.id !== id))
    if (networkChoice === id) setNetworkChoice("new")
  }

  const [wifiError, setWifiError] = useState("")
  const [newGreenhouseId, setNewGreenhouseId] = useState("")
  const [newGreenhouseCode, setNewGreenhouseCode] = useState("")
  const [newGreenhouseName, setNewGreenhouseName] = useState("")
  const [newGreenhouseLocation, setNewGreenhouseLocation] = useState("")
  const [claiming, setClaiming] = useState(false)
  const [greenhouseError, setGreenhouseError] = useState("")
  useEffect(() => { if (greenhouseError) buzzResult("error") }, [greenhouseError])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editLocation, setEditLocation] = useState("")
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [removeMode, setRemoveMode] = useState<"remove" | "disown">("disown")
  const [insightsId, setInsightsId] = useState<string | null>(null)
  const [profileImageFailed, setProfileImageFailed] = useState(false)

  const initials = (
    user?.displayName ||
    user?.email ||
    "U"
  )
    .split(" ")
    .map((name) => name.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase()

  const addGreenhouse = async () => {
    const id = newGreenhouseId.trim().toUpperCase()

    if (!GH_ID_PATTERN.test(id)) {
      setGreenhouseError("Enter a valid ID in the format TS-GH-XXXX.")
      return
    }

    if (!newGreenhouseCode.trim()) {
      setGreenhouseError("Enter the claim code shown on your TerraSense hub.")
      return
    }

    if (greenhouses.some((greenhouse) => greenhouse.id === id)) {
      setGreenhouseError("This greenhouse has already been added to your account.")
      return
    }

    try {
      setClaiming(true)
      setGreenhouseError("")

      await onAdd({
        id,
        code: newGreenhouseCode,
        name: newGreenhouseName,
        location: newGreenhouseLocation,
      })

      setNewGreenhouseId("")
      setNewGreenhouseCode("")
      setNewGreenhouseName("")
      setNewGreenhouseLocation("")
      setAddingGreenhouse(false)
    } catch (e: any) {
      setGreenhouseError(e?.message || "Unable to add this greenhouse. Please try again.")
    } finally {
      setClaiming(false)
    }
  }

  const startEdit = (item: Greenhouse) => {
    setEditingId(item.id)
    setEditName(item.name)
    setEditLocation(item.location === "Location not set" ? "" : item.location)
    setRemovingId(null)
    setGreenhouseError("")
  }

  const saveEdit = async (id: string) => {
    if (!editName.trim()) { setGreenhouseError("Give the greenhouse a name."); return }
    try {
      setBusyId(id)
      setGreenhouseError("")
      await onEdit(id, { name: editName.trim(), location: editLocation.trim() })
      setEditingId(null)
    } catch (e: any) {
      setGreenhouseError(e?.message || "Couldn't save the changes. Please try again.")
    } finally {
      setBusyId(null)
    }
  }

  const confirmRemove = async (id: string) => {
    try {
      setBusyId(id)
      setGreenhouseError("")
      if (removeMode === "remove") await onRemoveFromApp(id)
      else await onRemove(id)
      setRemovingId(null)
    } catch (e: any) {
      setGreenhouseError(e?.message || "Couldn't complete that. Please try again.")
    } finally {
      setBusyId(null)
    }
  }

   const saveWifi = async () => {
    const deviceName = wifiDraft.deviceName.trim()
    const ssid = wifiDraft.ssid.trim()
    const password = wifiDraft.password

    if (!ssid || !password) {
      return
    }

    setWifiSynced(false)
    setWifiError("")

    try {
      await onUpdateWifi(
        {
          deviceName: deviceName || "TerraSense Hub",
          ssid,
          password,
        },
        setWifiStep
      )
      setEditingWifi(false)
    } catch (e: any) {
      console.error("Wi-Fi save error:", e)
      setWifiError(e?.message || "Couldn't send the Wi-Fi to your hub. Please try again.")
    } finally {
      setWifiSynced(true)
      setWifiStep("")
    }
  }
  const startWifiEdit = () => {
    setWifiDraft({
      deviceName: safeWifiSettings.deviceName,
      ssid: safeWifiSettings.ssid,
      password: safeWifiSettings.password,
    })

    setEditingWifi(true)
  }

  return (
    <div className={`fixed inset-0 z-50 bg-ink/40 transition-opacity duration-300 motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}>
      <div className={`absolute inset-y-0 right-0 flex w-full max-w-xl flex-col overflow-hidden bg-white shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none ${shown ? "translate-x-0" : "translate-x-full"}`}>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-black/10 px-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-forest/50">
              Account
            </p>

            <h2 className="mt-1 text-2xl font-bold text-ink">
              Your Profile
            </h2>
          </div>

          <button
            onClick={onClose}
            aria-label="Close profile"
            className="grid size-10 place-items-center rounded-full bg-black/5 text-ink transition hover:bg-black/10"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-6">

          {/* Profile */}
          <section className="rounded-3xl bg-forest p-5 text-white">
            <div className="flex items-center gap-4">

              <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full bg-sand text-lg font-bold text-forest">
                {user?.photoURL && !profileImageFailed ? (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || "Profile"}
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                    onError={() => setProfileImageFailed(true)}
                  />
                ) : (
                  initials
                )}
              </div>

              <div className="min-w-0">
                <h3 className="truncate text-lg font-bold">
                  {user?.displayName || "TerraSense User"}
                </h3>

                <p className="mt-1 truncate text-sm text-white/60">
                  {user?.email || "No email available"}
                </p>

                <p className="mt-2 text-xs text-white/40">
                  {user?.providerData?.some(
                    (provider) => provider.providerId === "google.com"
                  )
                    ? "Google account"
                    : "TerraSense account"}
                </p>
              </div>
            </div>
          </section>

          {/* Greenhouses */}
          <section className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-ink">
                  Your Greenhouses
                </h3>

                <p className="mt-1 text-xs text-black/40">
                  Manage the greenhouses connected to your account.
                </p>
              </div>

              <button
                onClick={onSetupHub}
                className="grid size-9 place-items-center rounded-xl bg-forest text-white transition hover:opacity-90"
                aria-label="Add greenhouse"
              >
                <Icon name="plus" size={18} />
              </button>
            </div>

            {/* Add greenhouse */}
            {addingGreenhouse && (
              <div className="mb-4 rounded-2xl border border-black/10 bg-black/[0.025] p-4">
                <p className="text-sm font-bold text-ink">
                  Add greenhouse
                </p>

                <p className="mt-1 text-xs text-black/40">
                  Enter the greenhouse ID and claim code shown on your TerraSense Hub.
                </p>

                <div className="mt-3 space-y-3">
                  <AuthField label="Greenhouse ID" value={newGreenhouseId} onChange={(value) => { setNewGreenhouseId(value); setGreenhouseError("") }} placeholder="TS-GH-XXXX" />
                  <AuthField label="Claim code" value={newGreenhouseCode} onChange={(value) => { setNewGreenhouseCode(value); setGreenhouseError("") }} placeholder="Code shown on your hub" />
                  <AuthField label="Greenhouse name" value={newGreenhouseName} onChange={setNewGreenhouseName} placeholder="e.g. North greenhouse" />
                  <AuthField label="Location" value={newGreenhouseLocation} onChange={setNewGreenhouseLocation} placeholder="e.g. Backyard" />
                </div>

                {greenhouseError && (
                  <p className="mt-2 text-xs font-medium text-red-500">
                    {greenhouseError}
                  </p>
                )}

                <div className="mt-3 flex gap-2">
                  <button
                    onClick={addGreenhouse}
                    disabled={claiming}
                    className="flex-1 rounded-xl bg-forest px-4 py-3 text-sm font-bold text-white disabled:opacity-60"
                  >
                    {claiming ? "Linking…" : "Add greenhouse"}
                  </button>

                  <button
                    onClick={() => {
                      setAddingGreenhouse(false)
                      setNewGreenhouseId("")
                      setNewGreenhouseCode("")
                      setNewGreenhouseName("")
                      setNewGreenhouseLocation("")
                      setGreenhouseError("")
                    }}
                    className="rounded-xl bg-black/5 px-4 py-3 text-sm font-bold text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {!addingGreenhouse && greenhouseError && <p className="mb-3 text-xs font-medium text-red-500">{greenhouseError}</p>}
            <div className="space-y-3">
              {greenhouses.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-black/10 p-5 text-center">
                  <p className="text-sm font-bold text-ink">
                    No greenhouses yet
                  </p>

                  <p className="mt-1 text-xs text-black/40">
                    Add your first TerraSense greenhouse.
                  </p>
                </div>
              ) : (
                greenhouses.map((greenhouse, index) => {
                  const isCurrent = index === currentGreenhouse

                  return (
                    <div
                      role="button"
                      tabIndex={0}
                      key={`${greenhouse.id}-${index}`}
                      onClick={() => onSwitch(index)}
                      onKeyDown={(e) => { if (e.key === "Enter") onSwitch(index) }}
                      className={`w-full cursor-pointer rounded-2xl border p-4 text-left transition ${
                        isCurrent
                          ? "border-forest bg-forest/[0.06]"
                          : "border-black/10 bg-white hover:bg-black/[0.025]"
                      }`}
                    >
                      <div className="flex items-center gap-3">

                        <div
                          className={`grid size-11 shrink-0 place-items-center rounded-xl ${
                            isCurrent
                              ? "bg-forest text-white"
                              : "bg-black/5 text-forest"
                          }`}
                        >
                          <Icon name="leaf" size={20} />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-bold text-ink">
                              {greenhouse.name}
                            </p>

                            {isCurrent && (
                              <span className="rounded-full bg-forest px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                                Active
                              </span>
                            )}
                          </div>

                          <p className="mt-1 truncate text-xs text-black/40">
                            {greenhouse.id}
                          </p>

                          <p className="mt-1 truncate text-xs text-black/40">
                            {greenhouse.location}
                          </p>
                        </div>

                        <button
                          onClick={(e) => { e.stopPropagation(); setInsightsId(greenhouse.id) }}
                          onKeyDown={(e) => e.stopPropagation()}
                          className="grid size-9 shrink-0 place-items-center rounded-full bg-black/5 text-forest transition active:scale-90"
                          aria-label={`View insights for ${greenhouse.name}`}
                        >
                          <Icon name="chevron" size={16} />
                        </button>
                      </div>

                      <div className="mt-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide">
                        <span className="rounded-full bg-black/5 px-2 py-1 text-black/50">
                          {greenhouse.stage}
                        </span>

                        <span
                          className={`rounded-full px-2 py-1 ${
                            isOnline(greenhouse.lastSeen, now)
                              ? "bg-green-100 text-green-700"
                              : "bg-orange-100 text-orange-700"
                          }`}
                        >
                          {isOnline(greenhouse.lastSeen, now) ? "Online" : "Offline"}
                        </span>
                      </div>

                      <div className="mt-3" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        {editingId === greenhouse.id ? (
                          <div className="space-y-3 border-t border-black/10 pt-3">
                            <AuthField label="Greenhouse name" value={editName} onChange={setEditName} placeholder="e.g. North greenhouse" />
                            <AuthField label="Location" value={editLocation} onChange={setEditLocation} placeholder="e.g. Backyard" />
                            {greenhouseError && <p className="text-xs font-medium text-red-500">{greenhouseError}</p>}
                            <div className="flex gap-2">
                              <button onClick={() => saveEdit(greenhouse.id)} disabled={busyId === greenhouse.id} className="flex-1 rounded-xl bg-forest px-4 py-2.5 text-xs font-bold text-white disabled:opacity-60">{busyId === greenhouse.id ? "Saving…" : "Save"}</button>
                              <button onClick={() => { setEditingId(null); setGreenhouseError("") }} className="rounded-xl bg-black/5 px-4 py-2.5 text-xs font-bold text-ink">Cancel</button>
                            </div>
                          </div>
                        ) : removingId === greenhouse.id ? (
                          <div className="rounded-xl bg-red-50 p-3">
                            <p className="text-xs font-bold text-red-600">{removeMode === "remove" ? `Remove ${greenhouse.name} from this app?` : greenhouse.plan ? `Can't disown ${greenhouse.name} yet` : `Disown ${greenhouse.name}?`}</p>
                            <p className="mt-1 text-[11px] leading-4 text-red-600/80">{removeMode === "remove"
                              ? "It just disappears from this app. You still own the hub, and its plant cycle and data keep running. Add it again any time with its claim code."
                              : greenhouse.plan
                                ? "A plant cycle is running. Stop it in Plants first, then you can disown this greenhouse."
                                : "This unlinks the hub from your account and permanently erases its plant cycle data, readings and settings. This can't be undone. You can claim the hub again later with its claim code."}</p>
                            {greenhouseError && <p className="mt-2 text-xs font-medium text-red-600">{greenhouseError}</p>}
                            <div className="mt-3 flex gap-2">
                              {(removeMode === "remove" || !greenhouse.plan) && <button onClick={() => confirmRemove(greenhouse.id)} disabled={busyId === greenhouse.id} className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-60">{busyId === greenhouse.id ? (removeMode === "remove" ? "Removing…" : "Disowning…") : removeMode === "remove" ? "Yes, remove" : "Yes, disown"}</button>}
                              <button onClick={() => { setRemovingId(null); setGreenhouseError("") }} className="rounded-xl bg-white px-4 py-2.5 text-xs font-bold text-ink">{removeMode === "disown" && greenhouse.plan ? "OK" : "Cancel"}</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button onClick={() => startEdit(greenhouse)} className="rounded-xl bg-black/5 px-3 py-2 text-xs font-bold text-ink">Edit</button>
                            <button onClick={() => { setRemoveMode("remove"); setRemovingId(greenhouse.id); setEditingId(null); setGreenhouseError("") }} className="rounded-xl bg-amber-soft px-3 py-2 text-xs font-bold text-amber-ink">Remove</button>
                            <button onClick={() => { setRemoveMode("disown"); setRemovingId(greenhouse.id); setEditingId(null); setGreenhouseError("") }} className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600">Disown</button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </section>

          {insightsId && greenhouses.find((g) => g.id === insightsId) && (
            <GreenhouseInsights greenhouse={greenhouses.find((g) => g.id === insightsId)!} now={now} onClose={() => setInsightsId(null)} />
          )}

          {/* Wi-Fi */}
          <section className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-ink">
                  Wi-Fi Connection
                </h3>

                <p className="mt-1 text-xs text-black/40">
                  Network used by your TerraSense Hub.
                </p>
              </div>

              {!editingWifi && greenhouses.length > 0 && (
                <button
                  onClick={startWifiEdit}
                  className="rounded-xl bg-black/5 px-3 py-2 text-xs font-bold text-ink transition hover:bg-black/10"
                >
                  Edit
                </button>
              )}
            </div>

            <div className="rounded-2xl border border-black/10 bg-black/[0.025] p-4">

              {!editingWifi ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="grid size-11 place-items-center rounded-xl bg-forest text-white">
                      <Icon name="wifi" size={20} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">
                        {safeWifiSettings.deviceName}
                      </p>

                      <p className="mt-1 truncate text-xs text-black/40">
                        {safeWifiSettings.ssid || "Not configured"}
                      </p>
                    </div>

                    <div
                      className={`size-2.5 rounded-full ${
                        safeWifiSettings.ssid
                          ? "bg-green-500"
                          : "bg-black/20"
                      }`}
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-black/5 pt-3">
                    <span className="text-xs text-black/40">
                      Status
                    </span>

                    <span
                      className={`text-xs font-bold ${
                        safeWifiSettings.ssid
                          ? "text-green-600"
                          : "text-black/40"
                      }`}
                    >
                      {safeWifiSettings.ssid
                        ? "Configured"
                        : "Not configured"}
                    </span>
                  </div>
                </>
              ) : (
                <div>
                  <div className="space-y-4">

                      {savedNetworks.length > 0 && (
                      <div>
                        <label className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-black/40">
                          Saved networks
                        </label>
                        <div className="flex gap-2">
                          <select
                            value={networkChoice}
                            onChange={(e) => chooseSavedNetwork(e.target.value)}
                            className="min-w-0 flex-1 rounded-xl border border-black/10 bg-white px-3 py-3 text-sm font-medium"
                          >
                            {savedNetworks.map((n) => (
                              <option key={n.id} value={n.id}>{n.ssid}</option>
                            ))}
                            <option value="new">Add a new network…</option>
                          </select>
                          {networkChoice !== "new" && (
                            <button
                              type="button"
                              onClick={deleteSavedNetwork}
                              className="rounded-xl bg-red-50 px-3 text-xs font-bold text-red-600"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    <AuthField
                      label="Device name"
                      value={wifiDraft.deviceName}
                      onChange={(value) =>
                        setWifiDraft((current) => ({
                          ...current,
                          deviceName: value,
                        }))
                      }
                      placeholder="TerraSense Hub"
                    />

                    <AuthField
                      label="Wi-Fi network"
                      value={wifiDraft.ssid}
                      onChange={(value) =>
                        setWifiDraft((current) => ({
                          ...current,
                          ssid: value,
                        }))
                      }
                      placeholder="Your Wi-Fi name"
                    />

                    <AuthField
                      label="Wi-Fi password"
                      type="password"
                      value={wifiDraft.password}
                      onChange={(value) =>
                        setWifiDraft((current) => ({
                          ...current,
                          password: value,
                        }))
                      }
                      placeholder="Wi-Fi password"
                    />
                  </div>

                  {wifiError && (
                    <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-xs font-medium text-red-600">
                      {wifiError}
                    </p>
                  )}
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={saveWifi}
                      disabled={
                        !wifiDraft.ssid.trim() ||
                        !wifiDraft.password ||
                        !wifiSynced
                      }
                      className="flex-1 rounded-xl bg-forest px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {wifiSynced ? "Save Wi-Fi" : (wifiStep || "Syncing...")}
                    </button>

                    <button
                      onClick={() => {
                        setWifiDraft({
                          deviceName: safeWifiSettings.deviceName,
                          ssid: safeWifiSettings.ssid,
                          password: safeWifiSettings.password,
                        })

                        setEditingWifi(false)
                      }}
                      className="rounded-xl bg-black/5 px-4 py-3 text-sm font-bold text-ink"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Saved Wi-Fi networks: kept on the account, even with no greenhouse added */}
          <section className="mt-6">
            <div className="mb-3">
              <h3 className="text-base font-bold text-ink">Saved Wi-Fi networks</h3>
              <p className="mt-1 text-xs text-black/40">
                Kept on your account until you change or delete them. Pick any of them when you set up a hub or change its Wi-Fi.
              </p>
            </div>

            <div className="rounded-2xl border border-black/10 bg-black/[0.025] p-4">
              {savedNetworks.length === 0 ? (
                <p className="text-xs text-black/40">No saved networks yet.</p>
              ) : (
                <ul className="divide-y divide-black/5">
                  {savedNetworks.map((n) => (
                    <li key={n.id} className="flex items-center gap-3 py-2.5 first:pt-0">
                      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-forest text-white">
                        <Icon name="wifi" size={16} />
                      </div>
                      <p className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{n.ssid}</p>
                      <button
                        type="button"
                        onClick={() => removeNetwork(n.id)}
                        className="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-bold text-red-600"
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 space-y-3 border-t border-black/5 pt-4">
                <AuthField label="Network name" value={newNetSsid} onChange={setNewNetSsid} placeholder="Wi-Fi name" />
                <AuthField label="Password" type="password" value={newNetPass} onChange={setNewNetPass} placeholder="Wi-Fi password" />
                {netError && (
                  <p className="rounded-xl bg-red-50 px-4 py-3 text-xs font-medium text-red-600">{netError}</p>
                )}
                <button
                  type="button"
                  onClick={addNetwork}
                  disabled={netBusy || !newNetSsid.trim() || !newNetPass}
                  className="w-full rounded-xl bg-forest px-4 py-3 text-sm font-bold text-white disabled:opacity-50"
                >
                  {netBusy ? "Saving…" : "Save network"}
                </button>
              </div>
            </div>
          </section>

          {/* Notifications */}
          <section className="mt-6">
            <h3 className="mb-3 text-base font-bold text-ink">
              Notifications
            </h3>

            <div className="divide-y divide-black/5 rounded-2xl border border-black/10">
              <NotifRow
                icon="bell"
                title="Hub offline alerts"
                detail="Notify me when a hub stops reporting"
                on={notifPrefs.offline}
                onToggle={() => onNotifPrefs({ ...notifPrefs, offline: !notifPrefs.offline })}
              />
              <NotifRow
                icon="leaf"
                title="Plant cycle status"
                detail="Always-on card showing the current growth stage"
                on={notifPrefs.cycle}
                onToggle={() => onNotifPrefs({ ...notifPrefs, cycle: !notifPrefs.cycle })}
              />
            </div>
          </section>

          {/* Account information */}
          <section className="mt-6">
            <h3 className="mb-3 text-base font-bold text-ink">
              Account
            </h3>

            <div className="rounded-2xl border border-black/10 divide-y divide-black/5">

              <div className="flex items-center justify-between px-4 py-4">
                <span className="text-xs font-medium text-black/40">
                  Name
                </span>

                <span className="max-w-[60%] truncate text-sm font-bold text-ink">
                  {user?.displayName || "TerraSense User"}
                </span>
              </div>

              <div className="flex items-center justify-between px-4 py-4">
                <span className="text-xs font-medium text-black/40">
                  Email
                </span>

                <span className="max-w-[60%] truncate text-sm font-bold text-ink">
                  {user?.email || "Not available"}
                </span>
              </div>

              <div className="flex items-center justify-between px-4 py-4">
                <span className="text-xs font-medium text-black/40">
                  Account ID
                </span>

                <span className="max-w-[60%] truncate font-mono text-[10px] text-black/40">
                  {user?.uid || "Not available"}
                </span>
              </div>
            </div>
          </section>

          {/* Sign out */}
          <button
            onClick={onSignOut}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-sm font-bold text-red-600 transition hover:bg-red-100"
          >
            <Icon name="logout" size={18} />
            Sign out
          </button>

          <p className="pb-6 pt-4 text-center text-[10px] text-black/25">
            TerraSense • Smart Greenhouse Management
          </p>
        </div>
      </div>
    </div>
  )
}



function SensorCard({ label, value, unit, icon, tone, progress, target }: { label: string; value: string; unit: string; icon: IconName; tone: string; progress: number; target?: { min: number; max: number } }) {
  const colors = toneClasses[tone]
  const hasValue = value !== "—"
  const num = Number(value)

  let status: "live" | "in" | "near" | "out" = "live"
  if (hasValue && target) {
    const width = target.max - target.min || 1
    const delta = num < target.min ? target.min - num : num > target.max ? num - target.max : 0
    status = delta === 0 ? "in" : delta <= width * 0.25 ? "near" : "out"
  }

  const badgeText = !hasValue ? "NO DATA" : status === "in" ? "IN RANGE" : status === "near" ? "NEAR RANGE" : status === "out" ? "OUT OF RANGE" : "LIVE"
  const badgeColor = !hasValue ? "text-muted" : status === "near" ? "text-amber-ink" : status === "out" ? "text-coral" : "text-leaf"
  const dotColor = !hasValue ? "bg-border" : status === "near" ? "bg-amber" : status === "out" ? "bg-coral" : "bg-leaf"
  const fillColor = !hasValue || !target ? colors.fill : status === "near" ? "bg-amber" : status === "out" ? "bg-coral" : "bg-leaf"

  return (
    <div className="rounded-2xl border border-border bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:shadow-lg">
      <div className="flex items-start justify-between">
        <div className={`grid size-10 place-items-center rounded-xl ${colors.soft} ${colors.ink}`}><Icon name={icon} size={19} /></div>
        <span className={`flex items-center gap-1.5 text-[10px] font-bold ${badgeColor}`}><span className={`size-1.5 rounded-full ${dotColor}`} />{badgeText}</span>
      </div>
      <p className="mt-5 text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight">{value}{hasValue && <span className="ml-1 text-sm font-semibold text-muted">{unit}</span>}</p>
      {target && <p className="mt-1 text-[10px] font-medium text-muted">Target {target.min}–{target.max}{unit}</p>}
      <div className="mt-4 h-1.5 rounded-full bg-canvas"><div className={`h-full rounded-full ${fillColor}`} style={{ width: `${progress}%` }} /></div>
    </div>
  )
}

function ResourceLevel({ icon, label, value, detail, tone, width }: { icon: IconName; label: string; value: string; detail: string; tone: string; width: string }) {
  const colors = toneClasses[tone]
  return (
    <div className="flex items-center gap-4">
      <div className={`grid size-10 place-items-center rounded-xl ${colors.soft} ${colors.ink}`}><Icon name={icon} size={18} /></div>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">{label}</span><span className="text-xs font-bold">{value}</span></div>
        <div className="h-1.5 rounded-full bg-canvas"><div className={`h-full rounded-full ${colors.fill}`} style={{ width }} /></div>
        <p className="mt-1.5 text-[10px] text-muted">{detail}</p>
      </div>
    </div>
  )
}

export default App
