/**
 * Global client state: session, server-pushed runtime config, and toasts.
 *
 * Everything the admin controls arrives in `RuntimeConfig` and is read-only
 * here — the client deliberately offers no way to edit generation settings,
 * model choice, or prompts.
 */

import type { PublicUser, RuntimeConfig, SessionInfo } from '@kai/shared/contract'
import { api, KaiApiError, onUnauthorized } from '../api/client'

/* ------------------------------- session ------------------------------- */

class SessionStore {
    user = $state<PublicUser | null>(null)
    gatewayToken = $state<string | null>(null)
    loading = $state(true)

    get signedIn() {
        return this.user !== null
    }
    get isAdmin() {
        return this.user?.role === 'admin'
    }

    apply(info: SessionInfo) {
        this.user = info.user
        this.gatewayToken = info.gatewayToken
    }

    clear() {
        this.user = null
        this.gatewayToken = null
    }

    async refresh(): Promise<boolean> {
        try {
            this.apply(await api.auth.session())
            return true
        } catch (e) {
            if (e instanceof KaiApiError && e.isAuth) this.clear()
            return false
        } finally {
            this.loading = false
        }
    }

    async login(email: string, password: string) {
        this.apply(await api.auth.login({ email, password }))
    }

    async register(body: { email: string; password: string; displayName: string; inviteCode?: string }) {
        this.apply(await api.auth.register(body))
    }

    async logout() {
        try {
            await api.auth.logout()
        } finally {
            this.clear()
        }
    }
}

export const session = new SessionStore()

/* ---------------------------- runtime config ---------------------------- */

class ConfigStore {
    config = $state<RuntimeConfig | null>(null)
    loading = $state(true)
    error = $state<string | null>(null)

    private pollTimer: ReturnType<typeof setInterval> | null = null

    get site() {
        return this.config?.site ?? null
    }
    get features() {
        return this.config?.features ?? null
    }
    /** Feature gate helper: unknown flags default to off, never on. */
    can(flag: keyof NonNullable<RuntimeConfig['features']>): boolean {
        const f = this.config?.features
        if (!f) return false
        const v = f[flag]
        return typeof v === 'boolean' ? v : false
    }

    async load() {
        try {
            this.config = await api.config.get()
            this.error = null
            applySiteChrome(this.config)
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e)
        } finally {
            this.loading = false
        }
    }

    /**
     * The admin can change models, prompts or feature flags at any time. Polling
     * a single integer is cheap; only a changed revision triggers a real refetch.
     */
    startPolling(intervalMs = 60_000) {
        this.stopPolling()
        this.pollTimer = setInterval(async () => {
            if (document.hidden) return
            try {
                const { revision } = await api.config.revision()
                if (this.config && revision !== this.config.revision) await this.load()
            } catch {
                /* transient network failures are not worth surfacing */
            }
        }, intervalMs)
    }

    stopPolling() {
        if (this.pollTimer) clearInterval(this.pollTimer)
        this.pollTimer = null
    }
}

export const appConfig = new ConfigStore()

function applySiteChrome(config: RuntimeConfig) {
    document.title = config.site.name
    if (config.site.accentColor) {
        document.documentElement.style.setProperty('--kai-accent', config.site.accentColor)
    }
    if (config.site.faviconUrl) {
        let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-kai]')
        if (!link) {
            link = document.createElement('link')
            link.rel = 'icon'
            link.dataset.kai = ''
            document.head.appendChild(link)
        }
        link.href = config.site.faviconUrl
    }
    document.documentElement.lang = config.site.defaultLocale
}

/* -------------------------------- theme -------------------------------- */

export type ThemeMode = 'dark' | 'light' | 'system'

class ThemeStore {
    mode = $state<ThemeMode>((localStorage.getItem('kai:theme') as ThemeMode) ?? 'dark')

    constructor() {
        this.apply()
        matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
            if (this.mode === 'system') this.apply()
        })
    }

    set(mode: ThemeMode) {
        this.mode = mode
        localStorage.setItem('kai:theme', mode)
        this.apply()
    }

    private apply() {
        const light =
            this.mode === 'light' || (this.mode === 'system' && matchMedia('(prefers-color-scheme: light)').matches)
        document.documentElement.dataset.kaiTheme = light ? 'light' : 'dark'
    }
}

export const theme = new ThemeStore()

/* ---------------------------- selected model ---------------------------- */
/*
 * rev 21: 클라이언트 모델 선택 UI 를 완전히 제거하면서 이 store 자체도 함께
 * 사라진다. 예전 사용자 브라우저에는 `kai:selected_model` 이 `gemini-3.7-flash`
 * 같이 이제는 존재하지 않는 별칭으로 남아 있을 수 있어, 부팅 시 한 번 정리한다.
 */
try {
    localStorage.removeItem('kai:selected_model')
} catch {
    // 프라이빗 모드 등 localStorage 접근이 막혀도 무시.
}

/* -------------------------------- toasts -------------------------------- */

export interface Toast {
    id: number
    kind: 'info' | 'success' | 'error'
    message: string
}

class ToastStore {
    items = $state<Toast[]>([])
    private seq = 0

    push(message: string, kind: Toast['kind'] = 'info', ttl = 4000) {
        const id = ++this.seq
        this.items = [...this.items, { id, kind, message }]
        setTimeout(() => this.dismiss(id), ttl)
        return id
    }

    error(e: unknown) {
        const message =
            e instanceof KaiApiError ? e.message : e instanceof Error ? e.message : '알 수 없는 오류가 발생했습니다.'
        return this.push(message, 'error', 6000)
    }

    success(message: string) {
        return this.push(message, 'success')
    }

    dismiss(id: number) {
        this.items = this.items.filter((t) => t.id !== id)
    }
}

export const toasts = new ToastStore()

/* ------------------------------ bootstrap ------------------------------ */

let booted = false

/** Loads config + session in parallel. Safe to call more than once. */
export async function bootstrapApp() {
    if (booted) return
    booted = true

    if (typeof window !== 'undefined') {
        window.addEventListener('unhandledrejection', (event) => {
            if (event.reason) {
                const msg = event.reason instanceof KaiApiError ? event.reason.message : (event.reason?.message ?? String(event.reason))
                if (msg && msg !== 'canceled' && !msg.includes('AbortError')) {
                    toasts.error(event.reason)
                }
            }
        })
    }

    onUnauthorized.add(() => session.clear())

    await Promise.all([appConfig.load(), session.refresh()])
    appConfig.startPolling()
}
