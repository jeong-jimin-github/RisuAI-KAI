<script lang="ts">
    import { router } from './lib/router.svelte'
    import { appConfig, session, toasts } from './stores/app.svelte'
    import AppShell from './components/AppShell.svelte'
    import ToastHost from './components/ToastHost.svelte'
    import HomePage from './routes/HomePage.svelte'
    import ExplorePage from './routes/ExplorePage.svelte'
    import RankingPage from './routes/RankingPage.svelte'
    import BookmarksPage from './routes/BookmarksPage.svelte'
    import CharacterPage from './routes/CharacterPage.svelte'
    import ChatListPage from './routes/ChatListPage.svelte'
    import ChatPage from './routes/ChatPage.svelte'
    import CreatePage from './routes/CreatePage.svelte'
    import SettingsPage from './routes/SettingsPage.svelte'
    import LoginPage from './routes/LoginPage.svelte'
    import RegisterPage from './routes/RegisterPage.svelte'
    import NotFoundPage from './routes/NotFoundPage.svelte'
    import AdminApp from './admin/AdminApp.svelte'

    const route = $derived(router.current)

    /** Routes that render without the shell chrome (their own full-bleed layout). */
    const BARE = new Set(['login', 'register', 'chat', 'admin', 'adminHome'])
    const bare = $derived(BARE.has(route.name))

    /** Routes that require a signed-in user. */
    const PRIVATE = new Set(['chats', 'chat', 'settings', 'create', 'bookmarks'])

    const blocked = $derived(!session.loading && !session.signedIn && PRIVATE.has(route.name))
    const adminBlocked = $derived(
        !session.loading && route.name.startsWith('admin') && !session.isAdmin,
    )

    $effect(() => {
        if (blocked) {
            const next = encodeURIComponent(location.pathname + location.search)
            router.go(`/login?next=${next}`, { replace: true })
        }
    })

    $effect(() => {
        route.name
        route.path
        router.resetRouteScroll()
    })
</script>

{#if appConfig.loading || session.loading}
    <div class="flex h-full items-center justify-center text-kai-faint">
        <span class="text-sm">불러오는 중…</span>
    </div>
{:else if appConfig.error}
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p class="text-lg font-semibold">서버에 연결할 수 없습니다</p>
        <p class="max-w-sm text-sm text-kai-dim">{appConfig.error}</p>
        <button class="kai-btn kai-btn-primary" onclick={() => location.reload()}>다시 시도</button>
    </div>
{:else if adminBlocked}
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p class="text-lg font-semibold">접근 권한이 없습니다</p>
        <a class="kai-btn kai-btn-ghost" href="/">홈으로</a>
    </div>
{:else if bare}
    {#if route.name === 'login'}
        <LoginPage />
    {:else if route.name === 'register'}
        <RegisterPage />
    {:else if route.name === 'chat'}
        <ChatPage chatId={route.params.chatId} />
    {:else}
        <AdminApp section={route.params.rest ?? ''} />
    {/if}
{:else}
    <AppShell>
        {#if route.name === 'home'}
            <HomePage />
        {:else if route.name === 'explore'}
            <ExplorePage />
        {:else if route.name === 'ranking'}
            <RankingPage />
        {:else if route.name === 'bookmarks'}
            <BookmarksPage />
        {:else if route.name === 'character'}
            <CharacterPage idOrSlug={route.params.idOrSlug} />
        {:else if route.name === 'chats'}
            <ChatListPage />
        {:else if route.name === 'create'}
            <CreatePage />
        {:else if route.name === 'settings'}
            <SettingsPage />
        {:else}
            <NotFoundPage />
        {/if}
    </AppShell>
{/if}

<ToastHost {toasts} />
