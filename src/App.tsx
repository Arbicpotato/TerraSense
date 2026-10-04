import { useEffect, useMemo, useState } from "react"
import { Capacitor } from "@capacitor/core"
import { FirebaseAuthentication } from "@capacitor-firebase/authentication"
import {
  GoogleAuthProvider, signInWithCredential, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  updateProfile, onAuthStateChanged, signOut, type User,
} from "firebase/auth"
import { auth, firestore } from "./firebase"
import {
  doc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore"



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

const sensors = [
  { label: "Temperature", value: "24.8", unit: "°C", target: "Target 22–26°C", icon: "thermometer" as IconName, tone: "amber", progress: 66 },
  { label: "Humidity", value: "68", unit: "%", target: "Target 60–75%", icon: "droplet" as IconName, tone: "blue", progress: 68 },
  { label: "Soil moisture", value: "74", unit: "%", target: "Target 65–80%", icon: "leaf" as IconName, tone: "green", progress: 74 },
]

const initialControls = [
  { name: "Irrigation pump", detail: "Last run 32 min ago", icon: "droplet" as IconName, enabled: false },
  { name: "Grow lights", detail: "On until 6:30 PM", icon: "sun" as IconName, enabled: true },
  { name: "Heating system", detail: "Ready · Target 24°C", icon: "thermometer" as IconName, enabled: false },
  { name: "Cooling system", detail: "Running · Low speed", icon: "wind" as IconName, enabled: true },
  { name: "Humidifier", detail: "Ready · Target 68%", icon: "droplet" as IconName, enabled: false },
  { name: "Fertilizer pump", detail: "Next dose in 2 days", icon: "flask" as IconName, enabled: false },
]

const chartValues: Record<string, number[]> = {
  "24h": [42, 38, 36, 43, 55, 67, 72, 66, 61, 58, 64, 70],
  "7d": [48, 54, 43, 67, 62, 74, 68, 71, 58, 65, 73, 69],
  "30d": [39, 48, 55, 51, 60, 70, 64, 75, 68, 72, 66, 74],
}

type Greenhouse = {
  id: string
  name: string
  location: string
  crop: string
  stage: string
  devices: number
  status: string
}

type PlantProfile = {
  name: string
  stage: string
  days: string
  temperature: string
  moisture: string
  image?: string
  downloaded?: boolean
}

type WifiSettings = {
  ssid: string
  password: string
  deviceName: string
}

const initialGreenhouses: Greenhouse[] = [
  { id: "TS-GH-A1048", name: "Greenhouse A", location: "North garden", crop: "Cherry Tomato", stage: "Fruiting", devices: 8, status: "Healthy" },
  { id: "TS-GH-B2093", name: "Greenhouse B", location: "East garden", crop: "Sweet Basil", stage: "Vegetative", devices: 6, status: "Healthy" },
  { id: "TS-GH-P3186", name: "Propagation House", location: "West garden", crop: "Butterhead Lettuce", stage: "Seedling", devices: 5, status: "Attention" },
]

const toneClasses: Record<string, { soft: string; ink: string; fill: string }> = {
  amber: { soft: "bg-amber-soft", ink: "text-amber-ink", fill: "bg-amber" },
  blue: { soft: "bg-blue-soft", ink: "text-blue-ink", fill: "bg-blue" },
  green: { soft: "bg-green-soft", ink: "text-green-ink", fill: "bg-green" },
  purple: { soft: "bg-purple-soft", ink: "text-purple-ink", fill: "bg-purple" },
}

function Sparkline({ values }: { values: number[] }) {
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${88 - value}`).join(" ")
  const area = `0,88 ${points} 100,88`
  return (
    <svg className="h-36 w-full overflow-visible" viewBox="0 0 100 90" preserveAspectRatio="none" aria-label="Temperature trend chart">
      <defs>
        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-leaf)" stopOpacity=".24" />
          <stop offset="100%" stopColor="var(--color-leaf)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[18, 41, 64, 87].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="var(--color-border)" strokeWidth=".5" strokeDasharray="2 2" />)}
      <polygon points={area} fill="url(#chartFill)" />
      <polyline points={points} fill="none" stroke="var(--color-leaf)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="100" cy={88 - values.at(-1)!} r="1.8" fill="var(--color-leaf)" stroke="white" strokeWidth=".9" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function App() {
  const [authScreen, setAuthScreen] = useState<"app" | "splash" | "login" | "register" | "setup">("splash")
  const [activeNav, setActiveNav] = useState("Overview")
  const [period, setPeriod] = useState("24h")
  const [controls, setControls] = useState(initialControls)
  const [mobileNav, setMobileNav] = useState(false)
  const [alertOpen, setAlertOpen] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [manualMode, setManualMode] = useState(false)
  const [greenhouses, setGreenhouses] = useState(initialGreenhouses)
  const [downloadedPlants, setDownloadedPlants] = useState<PlantProfile[]>([])
  const [wifiSettings, setWifiSettings] = useState<WifiSettings>({ ssid: "Greenhouse WiFi", password: "terrademo", deviceName: "TerraSense Hub" })
  const [hasDevice, setHasDevice] = useState(true)
  const [currentGreenhouse, setCurrentGreenhouse] = useState(0)
  const [profileOpen, setProfileOpen] = useState(false)
  const updatedTime = useMemo(() => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), [])
  const greenhouse = greenhouses[currentGreenhouse]

   const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setAuthReady(true) }), [])

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

  const toggleControl = (name: string) => {
    if (stopped || !manualMode) return
    setControls((items) => items.map((item) => item.name === name ? { ...item, enabled: !item.enabled } : item))
  }

  if (authScreen === "splash") return <SplashScreen />
  if (authScreen === "login") return <LoginScreen onLogin={() => setAuthScreen("app")} onCreateAccount={() => setAuthScreen("register")} />
  if (authScreen === "register") return <RegisterScreen onRegister={() => { setHasDevice(false); setAuthScreen("setup") }} onBackToLogin={() => setAuthScreen("login")} />
  if (authScreen === "setup") return <WifiSetupScreen onComplete={(settings) => { setWifiSettings(settings); setHasDevice(settings.ssid !== "Not configured"); setAuthScreen("app") }} />
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
        <header className="safe-header-top sticky top-0 z-30 border-b border-border/70 bg-canvas/95 px-4 pb-4 backdrop-blur-xl">
          <div className="relative flex items-center justify-between">
            <button onClick={() => setMobileNav(true)} className="grid size-9 place-items-center rounded-full bg-white text-forest shadow-card" aria-label="Open navigation"><Icon name="menu" size={18} /></button>
            <div className="absolute left-1/2 max-w-40 -translate-x-1/2 px-3 text-center">
              <p className="truncate text-sm font-extrabold tracking-tight">{greenhouse.name}</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-leaf">Active greenhouse</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <button onClick={() => setAlertOpen(!alertOpen)} className="relative grid size-9 place-items-center rounded-full bg-white text-muted shadow-card" aria-label="Notifications"><Icon name="bell" size={17} /><span className="absolute right-1.5 top-1.5 size-2 rounded-full border-2 border-white bg-coral" /></button>
                {alertOpen && <div className="absolute right-0 top-12 z-40 w-72 rounded-2xl border border-border bg-white p-4 shadow-xl"><p className="text-xs font-bold">Water tank running low</p><p className="mt-1 text-[10px] text-muted">Refill recommended within 2 days.</p></div>}
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
              <button key={`${item.name}-${index}`} onClick={() => { setCurrentGreenhouse(index); setStopped(false); setManualMode(false) }} className={`flex shrink-0 snap-center items-center gap-2 rounded-full py-2 pl-2.5 pr-3 text-left transition-all ${currentGreenhouse === index ? "min-w-52 bg-white/12" : "bg-transparent"}`}>
                <span className={`size-2 shrink-0 rounded-full ${item.status === "Healthy" ? "bg-leaf" : "bg-amber"}`} />
                <span className="min-w-0"><span className="block truncate text-[10px] font-bold text-white">{item.name}</span>{currentGreenhouse === index && <span className="block truncate text-[9px] text-white/40">{item.crop} · {item.status}</span>}</span>
              </button>
            ))}
            <button onClick={() => setProfileOpen(true)} className="grid size-9 shrink-0 place-items-center rounded-full border border-white/15 text-sm font-bold text-white/60" aria-label="Add greenhouse">+</button>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div><p role="heading" aria-level={1} className="text-xl font-bold tracking-tight">{activeNav}</p><p className="mt-0.5 text-[10px] text-muted">{greenhouse.name} · {greenhouse.location} · Updated {updatedTime}</p></div>
            <button onClick={() => setStopped(!stopped)} className={`grid size-9 place-items-center rounded-full ${stopped ? "bg-forest text-white" : "bg-coral-soft text-coral"}`} aria-label={stopped ? "Resume system" : "Emergency stop"}><Icon name={stopped ? "bolt" : "pause"} size={16} /></button>
          </div>
        </header>

        <div className="space-y-5 p-4">
          {stopped && (
            <div className="flex items-center gap-3 rounded-2xl border border-coral/20 bg-coral-soft p-4 text-sm font-semibold text-coral">
              <Icon name="pause" /> All automated systems are paused. Resume when the greenhouse is safe.
            </div>
          )}

          {activeNav === "Overview" && (hasDevice ? <>
          <section className="grid gap-5">
            <div className="relative min-h-72 overflow-hidden rounded-3xl bg-forest text-white shadow-card">
              <img className="absolute inset-0 h-full w-full object-cover opacity-45 mix-blend-luminosity" src="https://images.unsplash.com/photo-1656740840036-7744c5bce4fc?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1400" alt="Rows of thriving plants inside a greenhouse" />
              <div className="absolute inset-0 bg-gradient-to-r from-forest via-forest/90 to-forest/25" />
              <div className="relative flex h-full min-h-72 flex-col justify-between p-6">
                <div className="flex items-start justify-between">
                  <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest backdrop-blur">Active crop</span>
                  <span className="flex items-center gap-2 text-xs text-white/65"><span className="size-2 rounded-full bg-leaf" />Automating</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-mint">{greenhouse.crop} · {greenhouse.stage} stage</p>
                  <p role="heading" aria-level={2} className="mt-2 text-3xl font-bold leading-tight tracking-tight">Your crop is thriving.</p>
                  <p className="mt-3 max-w-lg text-sm leading-6 text-white/65">All critical conditions are within the ideal range. Next irrigation is scheduled in 28 minutes.</p>
                  <button onClick={() => setActiveNav("Plants")} className="mt-5 flex items-center gap-2 text-sm font-bold text-white">View plant profile <Icon name="chevron" size={16} /></button>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-bold">Resource levels</p>
                  <p className="mt-1 text-xs text-muted">Estimated supply remaining</p>
                </div>
                <button className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted">Manage</button>
              </div>
              <div className="mt-6 space-y-6">
                <ResourceLevel icon="tank" label="Water tank" value="38%" detail="~2 days left" tone="blue" width="38%" />
                <ResourceLevel icon="flask" label="Fertilizer A" value="72%" detail="~12 days left" tone="green" width="72%" />
                <ResourceLevel icon="bolt" label="Energy today" value="4.2 kWh" detail="-8% vs yesterday" tone="amber" width="56%" />
              </div>
              <div className="mt-6 rounded-2xl bg-canvas p-4">
                <div className="flex items-center gap-3">
                  <div className="grid size-9 place-items-center rounded-xl bg-amber-soft text-amber-ink"><Icon name="bell" size={17} /></div>
                  <div className="flex-1">
                    <p className="text-xs font-bold">Refill water tank soon</p>
                    <p className="mt-0.5 text-[11px] text-muted">Recommended within 2 days</p>
                  </div>
                  <Icon name="chevron" size={16} />
                </div>
              </div>
            </div>
          </section>

          <section>
            <div className="mb-4 flex items-end justify-between">
              <div><p role="heading" aria-level={2} className="text-lg font-bold tracking-tight">Live conditions</p><p className="mt-1 text-xs text-muted">Readings update every 30 seconds</p></div>
              <button onClick={() => setActiveNav("Analytics")} className="text-xs font-bold text-forest">View analytics</button>
            </div>
            <div className="grid gap-4">
              {sensors.map((sensor) => <SensorCard key={sensor.label} {...sensor} />)}
            </div>
          </section>

          <section className="grid gap-5">
            <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><p role="heading" aria-level={2} className="text-base font-bold">Temperature trend</p><p className="mt-1 text-xs text-muted">Average 24.2°C · Optimal range</p></div>
                <div className="flex rounded-xl bg-canvas p-1">
                  {Object.keys(chartValues).map((item) => <button key={item} onClick={() => setPeriod(item)} className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${period === item ? "bg-white text-forest shadow-sm" : "text-muted"}`}>{item}</button>)}
                </div>
              </div>
              <div className="mt-6"><Sparkline values={chartValues[period]} /></div>
              <div className="mt-1 flex justify-between text-[10px] font-medium text-muted"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>Now</span></div>
            </div>

            <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
              <div className="flex items-start justify-between">
                <div><p role="heading" aria-level={2} className="text-base font-bold">Device controls</p><p className="mt-1 text-xs text-muted">{manualMode ? "Manual control enabled" : "Controlled by plant profile"}</p></div>
                <button onClick={() => setManualMode(!manualMode)} disabled={stopped} className={`rounded-full px-3 py-1.5 text-xs font-semibold tracking-normal transition disabled:opacity-40 ${manualMode ? "bg-amber-soft text-amber-ink" : "bg-mint text-forest"}`}>{manualMode ? "Manual mode" : "Auto mode"}</button>
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
                    <button disabled={stopped || !manualMode} onClick={() => toggleControl(control.name)} className={`relative h-6 w-11 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${control.enabled && !stopped ? "bg-leaf" : "bg-border"}`} aria-label={`Toggle ${control.name}`}>
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
              downloadedPlants={downloadedPlants}
              activePlant={greenhouse.crop === "No crop selected" ? null : greenhouse.crop}
              onStart={(plant) => setGreenhouses((items) => items.map((item, index) => index === currentGreenhouse ? { ...item, crop: plant.name, stage: plant.stage, status: "Healthy" } : item))}
            />
          )}
          {activeNav === "Plant Library" && (
            <PlantLibraryPage
              onDownload={(preset) => setDownloadedPlants((items) => items.some((item) => item.name === preset.name) ? items : [...items, preset])}
            />
          )}
          {activeNav === "Analytics" && (hasDevice ? <AnalyticsPage period={period} setPeriod={setPeriod} /> : <NoDeviceState section="Analytics" onConnect={() => setProfileOpen(true)} />)}
        </div>
        <nav className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center rounded-3xl border border-white/70 bg-white/90 p-1.5 shadow-[0_12px_40px_rgb(23_59_44_/_0.18)] backdrop-blur-xl">
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
      {mobileNav && (
        <div className="fixed inset-0 z-50 flex bg-ink/40 backdrop-blur-sm">
          <aside className="safe-overlay-panel relative flex h-full w-72 flex-col bg-forest px-5 pb-5 text-white shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3"><div className="grid size-9 place-items-center rounded-xl bg-leaf text-forest"><Icon name="leaf" size={19} /></div><div><p className="text-sm font-bold">TerraSense</p><p className="text-[10px] text-white/40">Smart greenhouse</p></div></div>
              <button onClick={() => setMobileNav(false)} className="rounded-xl bg-white/10 p-2 text-white/60" aria-label="Close navigation"><Icon name="close" size={18} /></button>
            </div>
            <div className="mt-7 rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-[9px] font-bold uppercase tracking-widest text-white/35">Currently viewing</p>
              <div className="mt-3 flex items-center gap-3"><span className={`size-2 rounded-full ${greenhouse.status === "Healthy" ? "bg-leaf" : "bg-amber"}`} /><div className="min-w-0"><p className="truncate text-sm font-bold">{greenhouse.name}</p><p className="mt-0.5 truncate text-[10px] text-white/40">{greenhouse.crop} · {greenhouse.location}</p></div></div>
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
      {profileOpen && (
        <ProfilePanel
          onClose={() => setProfileOpen(false)}
          onSignOut={() => { setProfileOpen(false); signOut(auth); setAuthScreen("login") }}
          greenhouses={greenhouses}
          currentGreenhouse={currentGreenhouse}
          wifiSettings={wifiSettings}
          onUpdateWifi={(settings) => { setWifiSettings(settings); setHasDevice(true) }}
          onSwitch={(index) => { setCurrentGreenhouse(index); setStopped(false); setManualMode(false) }}
          onAdd={(newGreenhouse) => {
            setGreenhouses((items) => [...items, newGreenhouse])
            setCurrentGreenhouse(greenhouses.length)
            setManualMode(false)
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


function AuthField({ id, label, type, value, onChange, placeholder }: { id: string; label: string; type: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <div><label htmlFor={id} className="text-[10px] font-bold uppercase tracking-widest text-muted">{label}</label><input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} required placeholder={placeholder} className="mt-2 w-full rounded-2xl border border-border bg-white px-4 py-3 text-sm outline-none transition placeholder:text-muted/50 focus:border-leaf focus:ring-4 focus:ring-mint" /></div>
}

function WifiSetupScreen({
  onComplete,
}: {
  onComplete: (settings: WifiSettings) => void
}) {
  const [ssid, setSsid] = useState("")
  const [password, setPassword] = useState("")
  const [deviceName, setDeviceName] = useState("TerraSense Hub")
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState("")

  const connectDevice = async (event: React.FormEvent) => {
    event.preventDefault()

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

      const deviceId = crypto.randomUUID()

      await setDoc(
        doc(firestore, "users", user.uid, "devices", deviceId),
        {
          name: deviceName.trim() || "TerraSense Hub",
          ssid: ssid.trim(),
          wifiPassword: password,
          status: "configured",
          createdAt: serverTimestamp(),
        }
      )

      onComplete({
        ssid,
        password,
        deviceName,
      })
    } catch (e: any) {
      console.error("Wi-Fi configuration error:", e)
      setError(
        e?.message ||
          "Unable to save Wi-Fi configuration. Please try again."
      )
    } finally {
      setSharing(false)
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
              <p className="text-lg font-extrabold tracking-tight">
                TerraSense
              </p>
              <p className="text-[10px] text-muted">
                Device setup
              </p>
            </div>
          </div>

          <span className="rounded-full bg-mint px-2.5 py-1 text-[10px] font-bold text-forest">
            STEP 2 OF 2
          </span>
        </div>

        <div className="mt-12">
          <div className="grid size-14 place-items-center rounded-2xl bg-blue-soft text-blue-ink">
            <Icon name="wifi" size={25} />
          </div>

          <p
            role="heading"
            aria-level={1}
            className="mt-6 text-3xl font-extrabold tracking-tight"
          >
            Connect your device.
          </p>

          <p className="mt-3 text-sm leading-6 text-muted">
            Enter the Wi-Fi network your TerraSense device should use.
            These details will be securely shared with your device.
          </p>
        </div>

        <form onSubmit={connectDevice} className="mt-9 space-y-5">

          <AuthField
            id="setup-device"
            label="Device name"
            type="text"
            value={deviceName}
            onChange={setDeviceName}
            placeholder="TerraSense Hub"
          />

          <AuthField
            id="setup-ssid"
            label="Wi-Fi network name"
            type="text"
            value={ssid}
            onChange={setSsid}
            placeholder="Enter network SSID"
          />

          <AuthField
            id="setup-wifi-password"
            label="Wi-Fi password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Enter network password"
          />

          {error && (
            <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
              {error}
            </p>
          )}

          <div className="flex gap-3 rounded-2xl bg-mint/50 p-4 text-forest">
            <Icon name="bolt" size={18} />

            <p className="text-[10px] leading-4">
              Keep your TerraSense device powered on and nearby while network
              details are being shared.
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
                Saving configuration…
              </>
            ) : (
              "Connect TerraSense device"
            )}
          </button>

        </form>
      </main>
    </div>
  )
}

const plantProfiles: PlantProfile[] = [
  { name: "Cherry Tomato", stage: "Fruiting", days: "Day 68", temperature: "22–26°C", moisture: "65–80%", image: "https://images.unsplash.com/photo-1592841200221-a6898f307baa?auto=format&fit=crop&w=900&q=80" },
  { name: "Sweet Basil", stage: "Vegetative", days: "Day 24", temperature: "20–25°C", moisture: "60–70%", image: "https://images.unsplash.com/photo-1600788886242-5c96aabe3757?auto=format&fit=crop&w=900&q=80" },
  { name: "Butterhead Lettuce", stage: "Maturing", days: "Day 37", temperature: "16–21°C", moisture: "70–80%", image: "https://images.unsplash.com/photo-1622205313162-be1d5712a43f?auto=format&fit=crop&w=900&q=80" },
]

function PlantsPage({ downloadedPlants, activePlant, onStart }: { downloadedPlants: PlantProfile[]; activePlant: string | null; onStart: (plant: PlantProfile) => void }) {
  const [selectedPlant, setSelectedPlant] = useState(0)
  const [cycleAlert, setCycleAlert] = useState(false)
  const availablePlants = [...plantProfiles, ...downloadedPlants]
  const plant = availablePlants[selectedPlant] ?? availablePlants[0]

  const startPlant = () => {
    if (activePlant) {
      setCycleAlert(true)
      return
    }
    onStart(plant)
  }

  return (
    <section className="space-y-5">
      {cycleAlert && (
        <div className="rounded-2xl border border-amber/30 bg-amber-soft p-4">
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/60 text-amber-ink"><Icon name="bell" size={17} /></div>
            <div className="min-w-0 flex-1"><p className="text-xs font-bold text-amber-ink">A plant is already in cycle</p><p className="mt-1 text-[10px] leading-4 text-muted">{activePlant} is currently active in this greenhouse. Finish or stop that cycle before starting {plant.name}.</p></div>
            <button onClick={() => setCycleAlert(false)} className="text-amber-ink" aria-label="Dismiss cycle alert"><Icon name="close" size={15} /></button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><p role="heading" aria-level={2} className="text-2xl font-bold tracking-tight">Plant profiles</p><p className="mt-1 text-sm text-muted">Choose which crop the greenhouse should optimize for.</p></div>
        <button className="rounded-xl bg-forest px-4 py-2.5 text-xs font-bold text-white">+ Add custom plant</button>
      </div>
      <div className="grid gap-5">
        <div className="grid gap-4">
          {availablePlants.map((item, index) => (
            <button key={`${item.name}-${index}`} onClick={() => setSelectedPlant(index)} className={`overflow-hidden rounded-2xl border bg-white text-left shadow-card transition ${selectedPlant === index ? "border-leaf ring-2 ring-leaf/20" : "border-border hover:-translate-y-0.5"}`}>
              {item.image ? <img src={item.image} alt={item.name} className="h-36 w-full object-cover" /> : <div className="grid h-28 w-full place-items-center bg-mint text-forest"><Icon name="leaf" size={32} /></div>}
              <div className="p-4">
                <div className="flex items-center justify-between"><p className="text-sm font-bold">{item.name}</p>{item.downloaded ? <span className="rounded-full bg-blue-soft px-2 py-1 text-[10px] font-bold text-blue-ink">DOWNLOADED</span> : selectedPlant === index && <span className="rounded-full bg-mint px-2 py-1 text-[10px] font-bold text-forest">SELECTED</span>}</div>
                <p className="mt-1 text-xs text-muted">{item.stage} · {item.days}</p>
              </div>
            </button>
          ))}
        </div>
        <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
          <span className="rounded-full bg-mint px-3 py-1.5 text-[10px] font-bold text-forest">CURRENT PROFILE</span>
          <p role="heading" aria-level={3} className="mt-5 text-2xl font-bold">{plant.name}</p>
          <p className="mt-2 text-sm leading-6 text-muted">Automation settings are tuned for the {plant.stage.toLowerCase()} growth stage.</p>
          <div className="mt-7 grid grid-cols-2 gap-3">
            <PlantSetting icon="thermometer" label="Temperature" value={plant.temperature} />
            <PlantSetting icon="droplet" label="Soil moisture" value={plant.moisture} />
            <PlantSetting icon="sun" label="Lighting" value="14 hours/day" />
            <PlantSetting icon="flask" label="Feeding" value="Every 3 days" />
          </div>
          <button onClick={startPlant} className="mt-7 w-full rounded-xl bg-forest py-3 text-sm font-bold text-white">Start this plant cycle</button>
        </div>
      </div>
    </section>
  )
}

function PlantSetting({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return <div className="rounded-2xl bg-canvas p-4"><div className="flex items-center gap-2 text-muted"><Icon name={icon} size={17} /><span className="text-xs font-medium">{label}</span></div><p className="mt-3 text-sm font-bold">{value}</p></div>
}

const libraryPresets = [
  { name: "Roma Tomato", category: "Vegetables", stage: "Full lifecycle", temperature: "22–27°C", moisture: "65–80%", light: "14–16 hours", feeding: "Every 3 days", downloads: 1842, color: "bg-coral-soft text-coral" },
  { name: "English Cucumber", category: "Vegetables", stage: "Full lifecycle", temperature: "21–26°C", moisture: "70–85%", light: "14 hours", feeding: "Every 4 days", downloads: 1268, color: "bg-green-soft text-green-ink" },
  { name: "Sweet Basil", category: "Herbs", stage: "Full lifecycle", temperature: "20–25°C", moisture: "60–70%", light: "12–14 hours", feeding: "Every 14 days", downloads: 2351, color: "bg-mint text-forest" },
  { name: "Butterhead Lettuce", category: "Leafy greens", stage: "Full lifecycle", temperature: "16–21°C", moisture: "70–80%", light: "12–14 hours", feeding: "Every 7 days", downloads: 1644, color: "bg-blue-soft text-blue-ink" },
  { name: "Strawberry", category: "Fruits", stage: "Flowering & fruiting", temperature: "18–24°C", moisture: "65–75%", light: "12–16 hours", feeding: "Every 7 days", downloads: 987, color: "bg-purple-soft text-purple-ink" },
  { name: "Bell Pepper", category: "Vegetables", stage: "Full lifecycle", temperature: "21–28°C", moisture: "65–75%", light: "14–16 hours", feeding: "Every 5 days", downloads: 1106, color: "bg-amber-soft text-amber-ink" },
]

function PlantLibraryPage({ onDownload }: { onDownload: (plant: PlantProfile) => void }) {
  const [category, setCategory] = useState("All presets")
  const [downloaded, setDownloaded] = useState("")
  const categories = ["All presets", "Vegetables", "Herbs", "Leafy greens", "Fruits"]
  const visiblePresets = category === "All presets" ? libraryPresets : libraryPresets.filter((preset) => preset.category === category)

  const downloadPreset = (preset: typeof libraryPresets[number]) => {
    const payload = {
      name: preset.name,
      version: "1.0",
      environmentalConditions: {
        temperature: preset.temperature,
        soilMoisture: preset.moisture,
        dailyLight: preset.light,
        nutrientSchedule: preset.feeding,
      },
      greenhouseMode: "automatic",
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${preset.name.toLowerCase().replaceAll(" ", "-")}-preset.json`
    link.click()
    URL.revokeObjectURL(url)
    onDownload({
      name: preset.name,
      stage: preset.stage,
      days: "Library preset",
      temperature: preset.temperature,
      moisture: preset.moisture,
      downloaded: true,
    })
    setDownloaded(preset.name)
    window.setTimeout(() => setDownloaded(""), 2400)
  }

  return (
    <section className="space-y-6">
      <div className="rounded-3xl bg-forest p-6 text-white shadow-card">
        <div className="flex flex-col gap-6">
          <div className="max-w-2xl">
            <span className="rounded-full bg-white/10 px-3 py-1.5 text-[10px] font-bold tracking-widest text-mint">COMMUNITY PRESETS</span>
            <p role="heading" aria-level={2} className="mt-5 text-2xl font-bold tracking-tight">Plant Library</p>
            <p className="mt-2 text-sm leading-6 text-white/60">Download expert greenhouse settings and import them into your automation system.</p>
          </div>
          <div className="grid size-20 shrink-0 place-items-center rounded-3xl bg-white/10 text-leaf"><Icon name="book" size={34} /></div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          {categories.map((item) => (
            <button key={item} onClick={() => setCategory(item)} className={`rounded-full px-4 py-2 text-xs font-bold transition ${category === item ? "bg-forest text-white" : "border border-border bg-white text-muted hover:text-ink"}`}>{item}</button>
          ))}
        </div>
        <p className="text-xs font-medium text-muted">{visiblePresets.length} presets available</p>
      </div>

      <div className="grid gap-4">
        {visiblePresets.map((preset) => (
          <div key={preset.name} className="rounded-2xl border border-border bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:shadow-lg">
            <div className="flex items-start justify-between">
              <div className={`grid size-12 place-items-center rounded-2xl ${preset.color}`}><Icon name="leaf" /></div>
              <span className="rounded-full bg-canvas px-2.5 py-1 text-[10px] font-bold text-muted">{preset.category}</span>
            </div>
            <p role="heading" aria-level={3} className="mt-5 text-base font-bold">{preset.name}</p>
            <p className="mt-1 text-xs text-muted">{preset.stage}</p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <LibraryDetail label="Temperature" value={preset.temperature} />
              <LibraryDetail label="Moisture" value={preset.moisture} />
              <LibraryDetail label="Daily light" value={preset.light} />
              <LibraryDetail label="Feeding" value={preset.feeding} />
            </div>
            <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
              <span className="text-[10px] font-medium text-muted">{preset.downloads.toLocaleString()} downloads</span>
              <button onClick={() => downloadPreset(preset)} className={`rounded-xl px-4 py-2 text-xs font-bold transition ${downloaded === preset.name ? "bg-mint text-forest" : "bg-forest text-white hover:bg-leaf"}`}>
                {downloaded === preset.name ? "Downloaded" : "Download preset"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function LibraryDetail({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-canvas p-3"><p className="text-[10px] font-medium text-muted">{label}</p><p className="mt-1 text-xs font-bold">{value}</p></div>
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

function AnalyticsPage({ period, setPeriod }: { period: string; setPeriod: (value: string) => void }) {
  return (
    <section className="space-y-5">
      <div><p role="heading" aria-level={2} className="text-2xl font-bold tracking-tight">Greenhouse analytics</p><p className="mt-1 text-sm text-muted">Historical performance and resource insights.</p></div>
      <div className="grid gap-4"><Metric label="Average temperature" value="24.2°C" detail="+0.4° this week" /><Metric label="Water used" value="84 L" detail="-12% this week" /><Metric label="Healthy uptime" value="99.8%" detail="Last 30 days" /></div>
      <div className="rounded-3xl border border-border bg-white p-6 shadow-card">
        <div className="flex items-center justify-between"><p className="text-base font-bold">Temperature history</p><div className="flex rounded-xl bg-canvas p-1">{Object.keys(chartValues).map((item) => <button key={item} onClick={() => setPeriod(item)} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${period === item ? "bg-white text-forest shadow-sm" : "text-muted"}`}>{item}</button>)}</div></div>
        <div className="mt-8"><Sparkline values={chartValues[period]} /></div>
      </div>
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-2xl border border-border bg-white p-5 shadow-card"><p className="text-xs font-medium text-muted">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p><p className="mt-2 text-xs text-leaf">{detail}</p></div>
}

function ProfilePanel({
  onClose,
  onSignOut,
  greenhouses,
  currentGreenhouse,
  onSwitch,
  onAdd,
  wifiSettings,
  onUpdateWifi,
}: {
  onClose: () => void
  onSignOut: () => void
  greenhouses: Greenhouse[]
  currentGreenhouse: number
  onSwitch: (index: number) => void
  onAdd: (greenhouse: Greenhouse) => void
  wifiSettings: WifiSettings
  onUpdateWifi: (settings: WifiSettings) => void
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
  const [greenhouseError, setGreenhouseError] = useState("")
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

  const addGreenhouse = () => {
    const id = newGreenhouseId.trim().toUpperCase()

    if (!/^TS-GH-[A-Z0-9]{4,}$/.test(id)) {
      setGreenhouseError(
        "Enter a valid ID in the format TS-GH-XXXX."
      )
      return
    }

    if (greenhouses.some((greenhouse) => greenhouse.id === id)) {
      setGreenhouseError(
        "This greenhouse has already been added to your account."
      )
      return
    }

    onAdd({
      id,
      name: `Greenhouse ${greenhouses.length + 1}`,
      location: "Location not set",
      crop: "No crop selected",
      stage: "Setup",
      devices: 1,
      status: "Attention",
    })

    setNewGreenhouseId("")
    setGreenhouseError("")
    setAddingGreenhouse(false)
  }

  const saveWifi = () => {
    const deviceName = wifiDraft.deviceName.trim()
    const ssid = wifiDraft.ssid.trim()
    const password = wifiDraft.password

    if (!ssid || !password) {
      return
    }

    const updatedSettings: WifiSettings = {
      deviceName: deviceName || "TerraSense Hub",
      ssid,
      password,
    }

    setWifiSynced(false)

    window.setTimeout(() => {
      onUpdateWifi(updatedSettings)
      setWifiSynced(true)
      setEditingWifi(false)
    }, 900)
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
    <div className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm">
      <div className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col overflow-hidden bg-white shadow-2xl">

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
                  Enter the greenhouse ID shown on your TerraSense Hub.
                </p>

                <div className="mt-3">
                  <input
                    value={newGreenhouseId}
                    onChange={(event) => {
                      setNewGreenhouseId(event.target.value)
                      setGreenhouseError("")
                    }}
                    placeholder="TS-GH-XXXX"
                    className="w-full rounded-xl border border-black/10 bg-white px-4 py-3 text-sm font-medium outline-none transition focus:border-forest"
                  />
                </div>

                {greenhouseError && (
                  <p className="mt-2 text-xs font-medium text-red-500">
                    {greenhouseError}
                  </p>
                )}

                <div className="mt-3 flex gap-2">
                  <button
                    onClick={addGreenhouse}
                    className="flex-1 rounded-xl bg-forest px-4 py-3 text-sm font-bold text-white"
                  >
                    Add greenhouse
                  </button>

                  <button
                    onClick={() => {
                      setAddingGreenhouse(false)
                      setNewGreenhouseId("")
                      setGreenhouseError("")
                    }}
                    className="rounded-xl bg-black/5 px-4 py-3 text-sm font-bold text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

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
                    <button
                      key={`${greenhouse.id}-${index}`}
                      onClick={() => onSwitch(index)}
                      className={`w-full rounded-2xl border p-4 text-left transition ${
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
                            greenhouse.status === "Healthy"
                              ? "bg-green-100 text-green-700"
                              : "bg-orange-100 text-orange-700"
                          }`}
                        >
                          {greenhouse.status}
                        </span>
                      </div>
                    </button>
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

              {!editingWifi && (
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



function SensorCard({ label, value, unit, target, icon, tone, progress }: typeof sensors[number]) {
  const colors = toneClasses[tone]
  return (
    <div className="rounded-2xl border border-border bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:shadow-lg">
      <div className="flex items-start justify-between">
        <div className={`grid size-10 place-items-center rounded-xl ${colors.soft} ${colors.ink}`}><Icon name={icon} size={19} /></div>
        <span className="flex items-center gap-1.5 text-[10px] font-bold text-leaf"><span className="size-1.5 rounded-full bg-leaf" /> OPTIMAL</span>
      </div>
      <p className="mt-5 text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight">{value}<span className="ml-1 text-sm font-semibold text-muted">{unit}</span></p>
      <div className="mt-4 h-1.5 rounded-full bg-canvas"><div className={`h-full rounded-full ${colors.fill}`} style={{ width: `${progress}%` }} /></div>
      <p className="mt-2 text-[10px] text-muted">{target}</p>
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
