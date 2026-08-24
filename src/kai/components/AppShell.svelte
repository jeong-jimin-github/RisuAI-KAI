<script lang="ts">
    import type { Component, Snippet } from 'svelte'
    import {
        Heart,
        Home,
        MessageCircle,
        Moon,
        Plus,
        Search,
        ShieldCheck,
        Sun,
        UserRound,
        WandSparkles,
    } from '@lucide/svelte'
    import { appConfig, session, theme } from '../stores/app.svelte'
    import { router } from '../lib/router.svelte'

    let { children }: { children: Snippet } = $props()
    let headerSearch = $state('')
    const path = $derived(router.current.path)
    const nav: { href: string; label: string; icon: Component }[] = [
        { href: '/', label: '홈', icon: Home },
        { href: '/chats', label: '채팅', icon: MessageCircle },
        { href: '/create', label: '제작', icon: WandSparkles },
        { href: session.signedIn ? '/settings' : '/login', label: '마이', icon: UserRound },
    ]

    const active = (href: string) =>
        path === href || (href !== '/' && href !== '/login' && path.startsWith(href))

    function search(event: SubmitEvent) {
        event.preventDefault()
        const query = headerSearch.trim()
        router.go(query ? `/explore?q=${encodeURIComponent(query)}` : '/explore')
    }
</script>

<div class="kai-app-shell">
    <a class="kai-skip-link" href="#kai-main">본문으로 건너뛰기</a>
    <header class="kai-site-header">
        <div class="kai-header-inner">
            <a href="/" class="kai-wordmark" aria-label="{appConfig.site?.name ?? 'RisuAI-KAI'} 홈">
                <img
                    class="kai-wordmark-mark"
                    src={appConfig.site?.logoUrl || '/kai-logo.png?v=2'}
                    alt=""
                    aria-hidden="true"
                />
                <span>{appConfig.site?.name ?? 'RisuAI-KAI'}</span>
            </a>

            <form class="kai-header-search" role="search" onsubmit={search}>
                <Search size={17} aria-hidden="true" />
                <label class="sr-only" for="kai-header-search">캐릭터 검색</label>
                <input id="kai-header-search" bind:value={headerSearch} placeholder="캐릭터와 세계관 검색" />
            </form>

            <div class="kai-header-actions">
                <a class="kai-icon-action kai-mobile-search" href="/explore" aria-label="검색"><Search size={21} /></a>
                <a class="kai-icon-action" href="/bookmarks" aria-label="북마크"><Heart size={20} /></a>
                <a class="kai-icon-action" href="/create" aria-label="작품 생성"><Plus size={20} /></a>
                <button
                    class="kai-icon-action"
                    aria-label="색상 모드 전환"
                    onclick={() => theme.set(theme.mode === 'dark' ? 'light' : 'dark')}
                >
                    {#if theme.mode === 'dark'}<Sun size={20} />{:else}<Moon size={20} />{/if}
                </button>
                {#if session.signedIn}
                    <a class="kai-profile-link" href="/settings" aria-label="프로필">
                        {#if session.user?.avatarUrl}
                            <img src={session.user.avatarUrl} alt="" />
                        {:else}
                            {session.user?.displayName.slice(0, 1)}
                        {/if}
                    </a>
                {:else}
                    <a class="kai-login-link" href="/login">로그인</a>
                {/if}
                {#if session.isAdmin}
                    <a class="kai-icon-action" href="/admin" aria-label="관리자"><ShieldCheck size={20} /></a>
                {/if}
            </div>
        </div>
    </header>

    <main id="kai-main" class="kai-page-scroll" data-kai-route-scroll tabindex="-1">{@render children()}</main>

    <nav class="kai-mobile-nav" aria-label="하단 주요 메뉴">
        {#each nav as item}
            {@const Icon = item.icon}
            <a href={item.href} class:active={active(item.href)} aria-current={active(item.href) ? 'page' : undefined}>
                <Icon size={21} strokeWidth={active(item.href) ? 2.5 : 2} />
                <span>{item.label}</span>
            </a>
        {/each}
    </nav>
</div>
