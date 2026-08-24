/**
 * Minimal History-API router.
 *
 * RisuAI is a Vite SPA with no framework router, and pulling one in for six
 * screens would be more machinery than the product needs. Routes are matched
 * against a small ordered table; the first match wins.
 */

export interface RouteMatch {
    name: string
    params: Record<string, string>
    query: URLSearchParams
    path: string
}

interface RouteDef {
    name: string
    /** `/characters/:idOrSlug` — a single `*` segment matches the rest. */
    pattern: string
}

const ROUTES: RouteDef[] = [
    { name: 'home', pattern: '/' },
    { name: 'login', pattern: '/login' },
    { name: 'register', pattern: '/register' },
    { name: 'explore', pattern: '/explore' },
    { name: 'ranking', pattern: '/ranking' },
    { name: 'bookmarks', pattern: '/bookmarks' },
    { name: 'character', pattern: '/c/:idOrSlug' },
    { name: 'chats', pattern: '/chats' },
    { name: 'chat', pattern: '/chat/:chatId' },
    { name: 'create', pattern: '/create' },
    { name: 'settings', pattern: '/settings' },
    { name: 'admin', pattern: '/admin/*' },
    { name: 'adminHome', pattern: '/admin' },
]

function matchPath(path: string): RouteMatch | null {
    const url = new URL(path, location.origin)
    const segs = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)

    for (const route of ROUTES) {
        const pSegs = route.pattern.replace(/\/+$/, '').split('/').filter(Boolean)
        const params: Record<string, string> = {}
        let okay = true

        if (pSegs.at(-1) === '*') {
            if (segs.length < pSegs.length - 1) continue
        } else if (pSegs.length !== segs.length) {
            continue
        }

        for (let i = 0; i < pSegs.length; i++) {
            const p = pSegs[i]
            if (p === '*') {
                params.rest = segs.slice(i).join('/')
                break
            }
            if (p.startsWith(':')) {
                if (!segs[i]) {
                    okay = false
                    break
                }
                params[p.slice(1)] = decodeURIComponent(segs[i])
                continue
            }
            if (p !== segs[i]) {
                okay = false
                break
            }
        }
        if (okay) return { name: route.name, params, query: url.searchParams, path: url.pathname }
    }
    return null
}

class Router {
    current = $state<RouteMatch>(
        matchPath(location.pathname + location.search) ?? {
            name: 'notFound',
            params: {},
            query: new URLSearchParams(location.search),
            path: location.pathname,
        },
    )

    constructor() {
        addEventListener('popstate', () => {
            this.sync()
            this.resetRouteScroll()
        })
        addEventListener('click', this.interceptLink)
    }

    /**
     * Reset scroll for window, body, and all Kai route scroll containers
     * so navigating between menus/pages always starts at the top.
     */
    resetRouteScroll() {
        const doReset = () => {
            window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
            if (document.documentElement) document.documentElement.scrollTo({ top: 0, left: 0, behavior: 'auto' })
            if (document.body) document.body.scrollTo({ top: 0, left: 0, behavior: 'auto' })
            document.querySelectorAll<HTMLElement>('[data-kai-route-scroll], .kai-page-scroll, .kai-page-container')
                .forEach((element) => element.scrollTo({ top: 0, left: 0, behavior: 'auto' }))
        }
        doReset()
        requestAnimationFrame(() => {
            doReset()
            requestAnimationFrame(doReset)
        })
    }

    private interceptLink = (e: MouseEvent) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        const anchor = (e.target as HTMLElement | null)?.closest?.('a')
        if (!anchor) return
        const href = anchor.getAttribute('href')
        if (!href || anchor.target === '_blank' || anchor.hasAttribute('download')) return
        if (!href.startsWith('/') || href.startsWith('//')) return
        if (anchor.dataset.kaiExternal !== undefined) return
        e.preventDefault()
        this.go(href)
    }

    private sync() {
        this.current = matchPath(location.pathname + location.search) ?? {
            name: 'notFound',
            params: {},
            query: new URLSearchParams(location.search),
            path: location.pathname,
        }
    }

    go(path: string, opts: { replace?: boolean; keepScroll?: boolean } = {}) {
        if (path === location.pathname + location.search) return
        history[opts.replace ? 'replaceState' : 'pushState']({}, '', path)
        this.sync()
        if (!opts.keepScroll) this.resetRouteScroll()
    }

    back() {
        if (history.length > 1) history.back()
        else this.go('/')
    }

    /** Replaces the query string without touching the route. */
    setQuery(next: Record<string, string | number | undefined | null>) {
        const url = new URL(location.href)
        for (const [k, v] of Object.entries(next)) {
            if (v === undefined || v === null || v === '') url.searchParams.delete(k)
            else url.searchParams.set(k, String(v))
        }
        history.replaceState({}, '', url.pathname + url.search)
        this.sync()
    }
}

export const router = new Router()
export const navigate = (path: string, opts?: { replace?: boolean }) => router.go(path, opts)
