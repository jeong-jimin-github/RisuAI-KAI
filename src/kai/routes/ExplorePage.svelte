<script lang="ts">
    import type { CharacterSummary } from '@kai/shared/contract'
    import { Search, X } from '@lucide/svelte'
    import { onMount, untrack } from 'svelte'
    import { api } from '../api/client'
    import CharacterTile from '../components/CharacterTile.svelte'
    import CharacterCardSkeleton from '../components/CharacterCardSkeleton.svelte'
    import { router } from '../lib/router.svelte'

    let items = $state<CharacterSummary[]>([])
    let total = $state(0)
    let loading = $state(false)
    let search = $state(router.current.query.get('q') ?? '')
    let selectedTags = $state((router.current.query.get('tag') ?? '').split(',').filter(Boolean))
    let sort = $state<'trending' | 'newest' | 'popular' | 'name'>((router.current.query.get('sort') as any) ?? 'trending')
    let request = 0
    const genres = ['시뮬레이션', '로맨스', '판타지/SF', '드라마', '무협/사극', '공포/추리', '액션', '코믹/일상', '스포츠/학원', 'BL', 'GL', '기타']

    function preventMobileDrag(event: DragEvent) {
        if (window.innerWidth >= 768) return
        const target = event.target
        if (target instanceof Element && target.closest('a, img')) event.preventDefault()
    }

    $effect(() => {
        const queryTag = router.current.query.get('tag')
        const queryQ = router.current.query.get('q')
        const querySort = router.current.query.get('sort')
        untrack(() => {
            const newTags = (queryTag ?? '').split(',').filter(Boolean)
            const newSearch = queryQ ?? ''
            const newSort = (querySort as any) ?? 'trending'

            if (newTags.join(',') !== selectedTags.join(',')) selectedTags = newTags
            if (newSearch !== search) search = newSearch
            if (newSort !== sort) sort = newSort
        })
    })

    async function load() {
        const mine = ++request
        loading = true
        try {
            const result = await api.characters.list({ q: search, tag: selectedTags.join(',') || undefined, sort, pageSize: 60, nsfw: false })
            if (mine === request) {
                items = result.items
                total = result.total
            }
        } finally {
            if (mine === request) loading = false
        }
    }
    $effect(() => { sort; selectedTags; void load() })

    function submit(event: SubmitEvent) {
        event.preventDefault()
        router.setQuery({ q: search, tag: selectedTags.join(','), sort })
        void load()
    }
    function setSort(value: typeof sort) {
        sort = value
        router.setQuery({ q: search, tag: selectedTags.join(','), sort: value })
    }
    function clearTags() {
        selectedTags = []
        router.setQuery({ q: search, tag: null, sort })
    }
    function toggleTag(value: string) {
        selectedTags = selectedTags.includes(value)
            ? selectedTags.filter((tag) => tag !== value)
            : [...selectedTags, value]
        router.setQuery({ q: search, tag: selectedTags.join(',') || null, sort })
    }

    onMount(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('.kai-page-scroll')?.scrollTo(0, 0)))
</script>

<svelte:window ondragstart={preventMobileDrag} />

<div class="kai-page-container kai-list-page kai-mobile-drag-guard">
    <header class="kai-page-heading">
        <h1 class="kai-page-title">작품 전체</h1>
    </header>

    <form class="kai-search-form" onsubmit={submit}>
        <Search size={21} />
        <input bind:value={search} placeholder="캐릭터, 세계관, 제작자로 검색" aria-label="캐릭터 검색" />
        {#if search}<button type="button" aria-label="검색어 지우기" onclick={() => search = ''}><X size={18} /></button>{/if}
        <button class="kai-search-submit" type="submit">검색</button>
    </form>

    <div class="kai-category-filter" aria-label="장르 필터">
        <button class:active={!selectedTags.length} aria-pressed={!selectedTags.length} onclick={clearTags}>전체</button>
        {#each genres as genre}
            <button class:active={selectedTags.includes(genre)} aria-pressed={selectedTags.includes(genre)} onclick={() => toggleTag(genre)}>{genre}</button>
        {/each}
    </div>

    <div class="kai-filter-row">
        <div class="kai-filter-tabs" role="tablist" aria-label="정렬">
            {#each [['trending', '추천'], ['popular', '인기'], ['newest', '최신'], ['name', '이름순']] as option}
                <button role="tab" aria-selected={sort === option[0]} class:active={sort === option[0]} onclick={() => setSort(option[0] as typeof sort)}>{option[1]}</button>
            {/each}
        </div>
        {#each selectedTags as tag}<button class="kai-active-filter" onclick={() => toggleTag(tag)}>#{tag}<X size={13} /></button>{/each}
        <span class="kai-result-count">{total.toLocaleString()}개 작품</span>
    </div>

    {#if loading}
        <CharacterCardSkeleton count={8} />
    {:else if items.length}
        <div class="kai-work-grid">
            {#each items as character}<CharacterTile {character} />{/each}
        </div>
    {:else}
        <div class="kai-empty-state">
            <div><p class="text-lg font-semibold text-kai-text">검색 결과가 없습니다</p><p class="mt-2 text-sm">다른 이름이나 태그로 찾아보세요.</p></div>
        </div>
    {/if}
</div>

<svelte:head>
    <title>{search ? `"${search}" 검색 - RisuAI-KAI` : '작품 탐색 - RisuAI-KAI'}</title>
</svelte:head>
