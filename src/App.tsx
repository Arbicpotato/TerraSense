import { useEffect, useMemo, useState } from "react"
import { Capacitor } from "@capacitor/core"
import { FirebaseAuthentication } from "@capacitor-firebase/authentication"
import {
  GoogleAuthProvider, signInWithCredential, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  updateProfile, onAuthStateChanged, signOut, type User,
} from "firebase/auth"
import { auth, db, firestore } from "./firebase"
import { doc, setDoc, getDoc, serverTimestamp } from "firebase/firestore"
import { ref, onValue, set, remove, update, query, limitToLast } from "firebase/database"
import { BleClient, dataViewToText } from "@capacitor-community/bluetooth-le"



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
    await set(ref(db, `greenhouses/${id}/ownerUid`), uid)
    await set(ref(db, `userGreenhouses/${uid}/${id}`), true)
    await set(ref(db, `greenhouses/${id}/meta`), {
      name: input.name.trim() || `Greenhouse ${id.slice(-4)}`,
      location: input.location.trim() || "Location not set",
      crop: "No crop selected",
      stage: "Setup",
    })
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
    await remove(ref(db, `${base}/controls`))
    await remove(ref(db, `${base}/live`))
    await remove(ref(db, `${base}/history`))
    await remove(ref(db, `${base}/wifi`))
    await remove(ref(db, `${base}/meta`))
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

async function provisionHubOverBle(
  ghId: string, code: string, ssid: string, pass: string, onStep: (message: string) => void
) {
  const id = ghId.trim().toUpperCase()
  if (!GH_ID_PATTERN.test(id)) throw new Error("Enter a valid ID in the format TS-GH-XXXX.")

  await BleClient.initialize({ androidNeverForLocation: true })
  onStep("Looking for your hub…")
  let deviceId: string
  try {
    const device = await BleClient.requestDevice({ services: [BLE_SERVICE], name: `TerraSense-${id.slice(6)}` })
    deviceId = device.deviceId
  } catch {
    throw new Error("No hub found. Check that it is powered on, nearby, and that Bluetooth is on.")
  }

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
  waterTank?: number
  fertilizer?: number
  updatedAt?: number
}

type HistoryRow = { temperature?: number; humidity?: number; soilMoisture?: number }

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
        full.push({ temperature: t, humidity: num(v.humidity), soilMoisture: num(v.soilMoisture) })
      })
      setHistory(rows)
      setHistoryRows(full)
    })
    return () => { offLive(); offControls(); offHistory() }
  }, [currentId])

  // 3) Saved Wi-Fi settings for the selected greenhouse
  useEffect(() => {
    setWifiSettings({ ssid: "", password: "", deviceName: "TerraSense Hub" })
    if (!user || !currentId) return
    let cancelled = false
    getDoc(doc(firestore, "users", user.uid, "devices", currentId))
      .then((snap) => {
        if (cancelled || !snap.exists()) return
        const d = snap.data()
        setWifiSettings({ ssid: d.ssid ?? "", password: d.wifiPassword ?? "", deviceName: d.name ?? "TerraSense Hub" })
      })
      .catch((e) => console.error("Wi-Fi settings load error:", e))
    return () => { cancelled = true }
  }, [user?.uid, currentId])

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
      <main className="mx-auto min-h-dvh w-full max-w-md bg-canvas pb-24 shadow-2xl">
        <header style={{ paddingLeft: "1.5rem", paddingRight: "1.5rem" }} className="safe-header-top sticky top-0 z-30 border-b border-border/70 bg-canvas pb-4">
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

          {activeNav === "Overview" && (loading ? <LoadingState /> : hasDevice ? <>
          <section className="grid gap-5">
            <div className="relative min-h-72 overflow-hidden rounded-3xl bg-forest text-white shadow-card">
              <img className="absolute inset-0 h-full w-full object-cover opacity-45 mix-blend-luminosity" src="https://images.unsplash.com/photo-1656740840036-7744c5bce4fc?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1400" alt="Rows of thriving plants inside a greenhouse" />
              <div className="absolute inset-0 bg-gradient-to-r from-forest via-forest/90 to-forest/25" />
              <div className="relative flex h-full min-h-72 flex-col justify-between p-6">
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
            <div className="grid gap-4">
              {sensorDefs.map((def) => {
                const v = live?.[def.key]
                return <SensorCard key={def.key} target={targetFor(def.key)} label={def.label} unit={def.unit} icon={def.icon} tone={def.tone} value={typeof v === "number" ? String(Math.round(v * 10) / 10) : "—"} progress={typeof v === "number" ? Math.max(0, Math.min(100, (v / def.max) * 100)) : 0} />
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
          </> : <NoDeviceState section="Overview" onConnect={() => setProfileOpen(true)} />)}

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
                }).catch((e) => console.error(e))
              }}
              onStop={() => {
                if (!greenhouse) return
                remove(ref(db, `greenhouses/${greenhouse.id}/meta/plan`)).catch((e) => console.error(e))
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
        <nav className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 z-40 flex w-[calc(100%-3rem)] max-w-sm -translate-x-1/2 items-center rounded-3xl border border-white/70 bg-white p-1.5 shadow-[0_12px_40px_rgb(23_59_44_/_0.18)]">
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
          wifiSettings={wifiSettings}
          onUpdateWifi={async (settings) => {
            if (!user || !greenhouse) return
            await setDoc(
              doc(firestore, "users", user.uid, "devices", greenhouse.id),
              { name: settings.deviceName, greenhouseId: greenhouse.id, ssid: settings.ssid, wifiPassword: settings.password, status: "configured", updatedAt: serverTimestamp() },
              { merge: true }
            )
            await set(ref(db, `greenhouses/${greenhouse.id}/wifi`), { ssid: settings.ssid, password: settings.password, ts: Date.now() })
            setWifiSettings(settings)
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
          onRemove={async (id) => {
            if (!user) throw new Error("You must be signed in to remove a greenhouse.")
            await unlinkGreenhouse(user.uid, id)
          }}
          onAdd={async (input) => {
            if (!user) throw new Error("You must be signed in to add a greenhouse.")
            const id = await claimGreenhouse(user.uid, input)
            setPendingSelect(id)
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
      <main className="safe-auth-top mx-auto flex min-h-dvh w-full max-w-md flex-col bg-canvas px-5 pb-8 shadow-2xl">

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
      <main className="safe-page-top mx-auto min-h-dvh w-full max-w-md bg-canvas px-5 pb-8 shadow-2xl">
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
  const [ssid, setSsid] = useState("")
  const [password, setPassword] = useState("")
  const [deviceName, setDeviceName] = useState("TerraSense Hub")
  const [sharing, setSharing] = useState(false)
  const [step, setStep] = useState("")
  const [error, setError] = useState("")

  const connectDevice = async (event: React.FormEvent) => {
    event.preventDefault()
    if (sharing) return

    if (!greenhouseId.trim() || !claimCode.trim()) {
      setError("Enter the greenhouse ID and claim code from your TerraSense hub.")
      return
    }

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
      setSharing(true)
      setError("")

      // 0) Hand the Wi-Fi details to the hub over Bluetooth (it has no network yet)
      await provisionHubOverBle(greenhouseId, claimCode, ssid.trim(), password, setStep)
      setStep("Linking to your account…")

      // 1) Claim the ESP32 hub so Firebase links it to THIS user
      const id = await claimGreenhouse(user.uid, {
        id: greenhouseId,
        code: claimCode,
        name: greenhouseName,
        location: "",
      })

      // 2) Save the Wi-Fi details for that hub
      const name = deviceName.trim() || "TerraSense Hub"
      await setDoc(
        doc(firestore, "users", user.uid, "devices", id),
        {
          name,
          greenhouseId: id,
          ssid: ssid.trim(),
          wifiPassword: password,
          status: "configured",
          createdAt: serverTimestamp(),
        },
        { merge: true }
      )

      onComplete({ ssid: ssid.trim(), password, deviceName: name }, id)
    } catch (e: any) {
      console.error("Device setup error:", e)
      setError(e?.message || "Unable to connect the device. Please try again.")
    } finally {
      setSharing(false)
      setStep("")
    }
  }

  return (
    <div className="min-h-dvh bg-forest">
      <main className="safe-setup-top mx-auto flex min-h-dvh w-full max-w-md flex-col bg-canvas px-5 pb-8 shadow-2xl">

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
            STEP 2 OF 2
          </span>
        </div>

        <div className="mt-10">
          <div className="grid size-14 place-items-center rounded-2xl bg-blue-soft text-blue-ink">
            <Icon name="wifi" size={25} />
          </div>

          <p role="heading" aria-level={1} className="mt-6 text-3xl font-extrabold tracking-tight">
            Connect your device.
          </p>

          <p className="mt-3 text-sm leading-6 text-muted">
            Enter the ID and claim code on your TerraSense hub to link it to your account, then the Wi-Fi network it should use.
          </p>
        </div>

        <form onSubmit={connectDevice} className="mt-8 space-y-5">

          <AuthField id="setup-gh-id" label="Greenhouse ID" type="text" value={greenhouseId} onChange={setGreenhouseId} placeholder="TS-GH-XXXX" />
          <AuthField id="setup-claim-code" label="Claim code" type="text" value={claimCode} onChange={setClaimCode} placeholder="Code shown on your hub" />
          <AuthField id="setup-gh-name" label="Greenhouse name" type="text" value={greenhouseName} onChange={setGreenhouseName} placeholder="e.g. North greenhouse" />
          <AuthField id="setup-device" label="Device name" type="text" value={deviceName} onChange={setDeviceName} placeholder="TerraSense Hub" />
          <AuthField id="setup-ssid" label="Wi-Fi network name" type="text" value={ssid} onChange={setSsid} placeholder="Enter network SSID" />
          <AuthField id="setup-wifi-password" label="Wi-Fi password" type="password" value={password} onChange={setPassword} placeholder="Enter network password" />

          {error && (
            <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
              {error}
            </p>
          )}

          <div className="flex gap-3 rounded-2xl bg-mint/50 p-4 text-forest">
            <Icon name="bolt" size={18} />

            <p className="text-[10px] leading-4">
              Keep your TerraSense hub powered on and within a few meters of your phone, with Bluetooth turned on.
            </p>
          </div>

          <button
            disabled={sharing}
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-forest py-4 text-sm font-bold text-white shadow-lg transition disabled:opacity-70"
          >
            {sharing ? (
              <>
                <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                {step || "Linking device…"}
              </>
            ) : (
              "Connect TerraSense device"
            )}
          </button>

          <button type="button" onClick={onSkip} className="w-full py-2 text-xs font-bold text-muted">
            Skip for now
          </button>

        </form>
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

const analyticsMetrics = [
  { key: "temperature", label: "Temperature", unit: "°C" },
  { key: "humidity", label: "Humidity", unit: "%" },
  { key: "soilMoisture", label: "Soil moisture", unit: "%" },
] as const

function AnalyticsPage({ rows }: { rows: HistoryRow[] }) {
  const [metric, setMetric] = useState<(typeof analyticsMetrics)[number]["key"]>("temperature")
  const def = analyticsMetrics.find((m) => m.key === metric)!
  const values = rows.map((r) => r[metric]).filter((v): v is number => typeof v === "number")
  const has = values.length > 0
  const avg = has ? values.reduce((a, b) => a + b, 0) / values.length : 0
  const fmt = (n: number) => `${Math.round(n * 10) / 10}${def.unit}`
  const detail = has ? `Last ${values.length} readings` : "No readings yet"
  const lower = def.label.toLowerCase()
  return (
    <section className="space-y-5">
      <div><p role="heading" aria-level={2} className="text-2xl font-bold tracking-tight">Greenhouse analytics</p><p className="mt-1 text-sm text-muted">Based on readings recorded by your TerraSense hub.</p></div>
      <div className="flex gap-2">
        {analyticsMetrics.map((m) => (
          <button key={m.key} onClick={() => setMetric(m.key)} className={`rounded-full px-4 py-2 text-xs font-bold transition ${metric === m.key ? "bg-forest text-white" : "border border-border bg-white text-muted"}`}>{m.label}</button>
        ))}
      </div>
      <div className="grid gap-4">
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

function ProfilePanel({
  shown,
  onClose,
  onSignOut,
  greenhouses,
  currentGreenhouse,
  onSwitch,
  onAdd,
  onEdit,
  onRemove,
  wifiSettings,
  onUpdateWifi,
  now,
}: {
  shown: boolean
  onClose: () => void
  onSignOut: () => void
  greenhouses: Greenhouse[]
  currentGreenhouse: number
  onSwitch: (index: number) => void
  onAdd: (input: { id: string; code: string; name: string; location: string }) => Promise<void>
  onEdit: (id: string, data: { name: string; location: string }) => Promise<void>
  onRemove: (id: string) => Promise<void>
  wifiSettings: WifiSettings
  onUpdateWifi: (settings: WifiSettings) => Promise<void>
  now: number
}) {
  const [notifications, setNotifications] = useState(true)
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
  const [newGreenhouseId, setNewGreenhouseId] = useState("")
  const [newGreenhouseCode, setNewGreenhouseCode] = useState("")
  const [newGreenhouseName, setNewGreenhouseName] = useState("")
  const [newGreenhouseLocation, setNewGreenhouseLocation] = useState("")
  const [claiming, setClaiming] = useState(false)
  const [greenhouseError, setGreenhouseError] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editLocation, setEditLocation] = useState("")
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
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
      await onRemove(id)
      setRemovingId(null)
    } catch (e: any) {
      setGreenhouseError(e?.message || "Couldn't remove the greenhouse. Please try again.")
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

    try {
      await onUpdateWifi({
        deviceName: deviceName || "TerraSense Hub",
        ssid,
        password,
      })
      setEditingWifi(false)
    } catch (e) {
      console.error("Wi-Fi save error:", e)
    } finally {
      setWifiSynced(true)
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
                onClick={() => {
                  setAddingGreenhouse((value) => !value)
                  setGreenhouseError("")
                }}
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

                        <Icon name="chevron" size={16} />
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
                            <p className="text-xs font-bold text-red-600">Remove {greenhouse.name}?</p>
                            <p className="mt-1 text-[11px] leading-4 text-red-600/80">It will be unlinked from your account and its settings and readings cleared. The hub can be added again with its claim code.</p>
                            {greenhouseError && <p className="mt-2 text-xs font-medium text-red-600">{greenhouseError}</p>}
                            <div className="mt-3 flex gap-2">
                              <button onClick={() => confirmRemove(greenhouse.id)} disabled={busyId === greenhouse.id} className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-60">{busyId === greenhouse.id ? "Removing…" : "Remove"}</button>
                              <button onClick={() => { setRemovingId(null); setGreenhouseError("") }} className="rounded-xl bg-white px-4 py-2.5 text-xs font-bold text-ink">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button onClick={() => startEdit(greenhouse)} className="rounded-xl bg-black/5 px-3 py-2 text-xs font-bold text-ink">Edit</button>
                            <button onClick={() => { setRemovingId(greenhouse.id); setEditingId(null); setGreenhouseError("") }} className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600">Remove</button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </section>

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
                      {wifiSynced ? "Save Wi-Fi" : "Syncing..."}
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

          {/* Notifications */}
          <section className="mt-6">
            <div className="flex items-center justify-between rounded-2xl border border-black/10 p-4">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-xl bg-black/5">
                  <Icon name="bell" size={18} />
                </div>

                <div>
                  <p className="text-sm font-bold text-ink">
                    Notifications
                  </p>

                  <p className="mt-1 text-xs text-black/40">
                    Greenhouse alerts and updates
                  </p>
                </div>
              </div>

              <button
                onClick={() =>
                  setNotifications((value) => !value)
                }
                aria-label="Toggle notifications"
                className={`relative h-6 w-11 rounded-full transition ${
                  notifications
                    ? "bg-forest"
                    : "bg-black/15"
                }`}
              >
                <span
                  className={`absolute top-1 size-4 rounded-full bg-white shadow-sm transition ${
                    notifications
                      ? "left-6"
                      : "left-1"
                  }`}
                />
              </button>
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
