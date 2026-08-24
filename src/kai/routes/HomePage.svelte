<script lang="ts">
    import type { CharacterSummary } from '@kai/shared/contract'
    import { Clock3, Shapes, Sparkles, Trophy } from '@lucide/svelte'
    import type { Component } from 'svelte'
    import { onMount } from 'svelte'
    import { api } from '../api/client'
    import CharacterTile from '../components/CharacterTile.svelte'
    import CharacterCardSkeleton from '../components/CharacterCardSkeleton.svelte'
    import FeaturedStory from '../components/FeaturedStory.svelte'
    import SectionHeader from '../components/SectionHeader.svelte'
    import SiteFooter from '../components/SiteFooter.svelte'

    let trending = $state<CharacterSummary[]>([])
    let newest = $state<CharacterSummary[]>([])
    let popular = $state<CharacterSummary[]>([])
    let loading = $state(true)
    let discoveryMode = $state<'recommend' | 'ranking' | 'newest' | 'genre'>('recommend')
    const discoveryTabs: {
        value: typeof discoveryMode
        label: string
        icon: Component
    }[] = [
        { value: 'recommend', label: '추천', icon: Sparkles },
        { value: 'ranking', label: '랭킹', icon: Trophy },
        { value: 'newest', label: '신작', icon: Clock3 },
        { value: 'genre', label: '장르', icon: Shapes },
    ]
    let selectedGenre = $state('로맨스')
    let genreItems = $state<CharacterSummary[]>([])
    let genreLoading = $state(false)

    const genres = ['로맨스', '판타지/SF', '시뮬레이션', '드라마', '공포/추리', '액션', '코믹/일상', '무협/사극', '스포츠/학원', 'BL', 'GL']
    const discoveryItems = $derived(
        discoveryMode === 'ranking'
            ? popular
            : discoveryMode === 'newest'
              ? newest
              : trending,
    )
    const discoveryTitle = $derived(
        discoveryMode === 'ranking'
            ? '랭킹'
            : discoveryMode === 'newest'
                ? '신작'
                : discoveryMode === 'genre'
                  ? `${selectedGenre} 작품`
                  : '추천 작품',
    )
    const featuredStories = $derived.by(() => {
        const candidates = [
            ...trending.filter((item) => item.featured),
            ...popular.filter((item) => item.featured),
            ...newest.filter((item) => item.featured),
            ...trending,
            ...newest,
        ]
        return [...new Map(candidates.map((item) => [item.id, item])).values()].slice(0, 5)
    })
    const moreHref = $derived(
        discoveryMode === 'ranking'
            ? '/ranking'
            : discoveryMode === 'newest'
              ? '/explore?sort=newest'
              : discoveryMode === 'genre'
                ? `/explore?tag=${encodeURIComponent(selectedGenre)}`
                : '/explore',
    )

    function preventMobileDrag(event: DragEvent) {
        if (window.innerWidth >= 768) return
        const target = event.target
        if (target instanceof Element && target.closest('a, img')) event.preventDefault()
    }

    async function selectGenre(genre: string) {
        selectedGenre = genre
        genreLoading = true
        try {
            const res = await api.characters.list({ tag: genre, pageSize: 24, nsfw: false })
            genreItems = res.items
        } catch {
            genreItems = trending.filter((c) => (c.tags ?? []).includes(genre))
        } finally {
            genreLoading = false
        }
    }

    onMount(async () => {
        try {
            const [a, b, c] = await Promise.all([
                api.characters.list({ sort: 'trending', pageSize: 30, nsfw: false }),
                api.characters.list({ sort: 'newest', pageSize: 30, nsfw: false }),
                api.characters.list({ sort: 'popular', pageSize: 30, nsfw: false }),
            ])
            trending = a.items
            newest = b.items
            popular = c.items
            await selectGenre(selectedGenre)
        } finally {
            loading = false
        }
    })
</script>

<svelte:window ondragstart={preventMobileDrag} />

<div class="kai-page-container kai-home-page pb-4">
    {#if loading}
        <div class="kai-featured-skeleton" aria-label="추천 이야기를 불러오는 중" aria-busy="true"></div>
    {:else if featuredStories.length}
        <FeaturedStory characters={featuredStories} />
    {/if}

    <nav class="kai-home-discovery-tabs" aria-label="홈 콘텐츠 둘러보기">
        {#each discoveryTabs as tab}
            {@const Icon = tab.icon}
            <button
                class:active={discoveryMode === tab.value}
                aria-pressed={discoveryMode === tab.value}
                onclick={() => {
                    discoveryMode = tab.value
                    if (tab.value === 'genre' && !genreItems.length) void selectGenre(selectedGenre)
                }}
            >
                <Icon size={16} />
                <span>{tab.label}</span>
            </button>
        {/each}
    </nav>

    <section class="kai-section kai-first-section">
        <SectionHeader title={discoveryTitle} href={moreHref} />
        {#if discoveryMode === 'genre'}
            <div class="kai-home-genre-grid">
                {#each genres as genre}
                    <button
                        type="button"
                        class="kai-genre-tab-btn"
                        class:active={selectedGenre === genre}
                        onclick={() => selectGenre(genre)}
                    >#{genre}</button>
                {/each}
            </div>
            {#if genreLoading}
                <CharacterCardSkeleton count={4} />
            {:else if genreItems.length}
                <div class="kai-home-card-rail kai-home-genre-preview">
                    {#each genreItems as character}<CharacterTile {character} />{/each}
                </div>
            {:else}
                <div class="kai-empty-state">해당 장르의 작품이 아직 없습니다.</div>
            {/if}
        {:else if loading}
            <CharacterCardSkeleton count={4} />
        {:else if discoveryItems.length}
            <div class="kai-home-card-rail">
                {#each discoveryItems.slice(0, 24) as character, index}
                    <CharacterTile {character} rank={discoveryMode === 'ranking' ? index + 1 : undefined} />
                {/each}
            </div>
        {:else}
            <div class="kai-empty-state">아직 공개된 캐릭터가 없습니다.</div>
        {/if}
    </section>

</div>

<SiteFooter />
