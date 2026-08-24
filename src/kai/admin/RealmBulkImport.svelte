<script lang="ts">
    import type { RealmBrowseSort, RealmCharacterSummary } from '@kai/shared/contract'
    import { ChevronLeft, ChevronRight, Download, ExternalLink, RefreshCw, Search, X } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { api, apiGet, apiPost } from '../api/client'
    import { toasts } from '../stores/app.svelte'

    let { onimported }: { onimported: () => void | Promise<void> } = $props()
    const sorts: { value: RealmBrowseSort; label: string }[] = [
        { value: 'downloads', label: '인기' },
        { value: 'trending', label: '실시간' },
        { value: 'recent', label: '최신' },
        { value: 'recommended', label: '추천' },
        { value: 'random', label: '랜덤' },
    ]
    /** Realm returns a fixed shuffled/curated set for these, so paging them is meaningless. */
    const unpaged: RealmBrowseSort[] = ['recommended', 'random']

    let items = $state<RealmCharacterSummary[]>([])
    let selected = $state<Set<string>>(new Set())
    let sort = $state<RealmBrowseSort>('downloads')
    let search = $state('')
    let appliedSearch = $state('')
    let nsfw = $state(false)
    let skipLowQuality = $state(true)
    let cleaningUp = $state(false)
    let page = $state(1)
    let loading = $state(true)
    let importing = $state(false)
    let request = 0
    let progressDone = $state(0)
    let progressTotal = $state(0)
    let progressImported = $state(0)
    let progressFailed = $state(0)
    let progressName = $state('')
    const progressPercent = $derived(progressTotal ? Math.round((progressDone / progressTotal) * 100) : 0)
    const paged = $derived(!unpaged.includes(sort))
    const realmUrl = $derived(`https://realm.risuai.net/?sort=${sort === 'recent' ? '' : sort}&mode=character`)

    async function load(nextPage = page) {
        const mine = ++request
        loading = true
        try {
            const result = await apiGet<RealmCharacterSummary[]>('/characters/import/realm/browse', {
                sort,
                search: appliedSearch,
                nsfw,
                page: nextPage,
            })
            if (mine !== request) return
            items = result
            page = nextPage
            selected = new Set()
        } catch (error) {
            if (mine === request) toasts.error(error)
        } finally {
            if (mine === request) loading = false
        }
    }

    function setSort(value: RealmBrowseSort) {
        if (sort === value || importing) return
        sort = value
        void load(1)
    }

    function submitSearch(event: SubmitEvent) {
        event.preventDefault()
        appliedSearch = search.trim()
        // Realm ignores the query for its curated and shuffled feeds.
        if (appliedSearch && unpaged.includes(sort)) sort = 'recent'
        void load(1)
    }

    function clearSearch() {
        search = ''
        if (!appliedSearch) return
        appliedSearch = ''
        void load(1)
    }

    function toggle(id: string) {
        const next = new Set(selected)
        next.has(id) ? next.delete(id) : next.add(id)
        selected = next
    }

    function selectAvailable() {
        const available = items.filter((item) => !item.imported).map((item) => item.id)
        selected = selected.size === available.length ? new Set() : new Set(available)
    }

    async function importSelected() {
        if (!selected.size || importing) return
        importing = true
        const queue = [...selected]
        progressDone = 0
        progressTotal = queue.length
        progressImported = 0
        progressFailed = 0
        try {
            for (const id of queue) {
                progressName = items.find((item) => item.id === id)?.name ?? id
                try {
                    await api.characters.importRealm(id, skipLowQuality)
                    progressImported++
                } catch {
                    progressFailed++
                } finally {
                    progressDone++
                }
            }
            const details = `${progressImported}개 가져옴${progressFailed ? ` · ${progressFailed}개 실패/제외` : ''}`
            progressFailed ? toasts.error(details) : toasts.success(details)
            await load(page)
            await onimported()
        } finally {
            importing = false
            progressName = ''
        }
    }

    async function cleanupLowQuality() {
        if (cleaningUp || importing || !confirm('DB에서 썸네일 이외의 이미지가 없는 저품질 챗을 일괄 삭제할까요?')) return
        cleaningUp = true
        try {
            const res = await apiPost<{ deletedCount: number }>('/admin/characters/cleanup-low-quality')
            toasts.success(`저품질 챗 ${res.deletedCount}개를 DB에서 삭제했습니다.`)
            await load(page)
            await onimported()
        } catch (e) {
            toasts.error(e)
        } finally {
            cleaningUp = false
        }
    }

    onMount(() => load())
</script>

<section class="kai-card mb-5 overflow-hidden">
    <div class="flex flex-col gap-4 border-b border-kai-border-soft p-5 sm:flex-row sm:items-center">
        <div class="min-w-0 flex-1">
            <h2 class="font-bold">RisuRealm 둘러보기</h2>
            <p class="mt-1 text-sm text-kai-dim">정렬과 검색으로 Realm 목록을 찾아 공개 작품으로 가져옵니다.</p>
        </div>
        <div class="flex flex-wrap gap-2">
            <button class="kai-btn kai-btn-ghost text-xs" disabled={loading || importing || cleaningUp} onclick={cleanupLowQuality}>
                {cleaningUp ? '정리 중…' : 'DB 저품질 챗 정리'}
            </button>
            <button class="kai-btn kai-btn-ghost" disabled={loading || importing} onclick={() => load(page)} aria-label="목록 새로고침"><RefreshCw size={16} class={loading ? 'animate-spin' : ''} /> 새로고침</button>
            <a class="kai-btn kai-btn-ghost" href={realmUrl} target="_blank" rel="noreferrer">Realm 열기 <ExternalLink size={15} /></a>
        </div>
    </div>

    <div class="flex flex-col gap-3 border-b border-kai-border-soft p-5">
        <form class="flex items-stretch gap-2" onsubmit={submitSearch}>
            <div class="relative min-w-0 flex-1">
                <input class="kai-input w-full pl-10 pr-9" bind:value={search} placeholder="Realm 작품명 · 제작자 검색" aria-label="Realm 검색어" disabled={importing} />
                <Search size={17} class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-kai-faint" />
                {#if search}
                    <button type="button" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-kai-faint hover:text-kai-text" onclick={clearSearch} aria-label="검색어 지우기"><X size={16} /></button>
                {/if}
            </div>
            <button class="kai-btn kai-btn-ghost shrink-0" type="submit" disabled={loading || importing}>검색</button>
        </form>
        <div class="flex flex-wrap items-center gap-2">
            {#each sorts as option}
                <button
                    class="kai-chip rounded-full"
                    class:border-kai-accent={sort === option.value}
                    class:text-kai-accent={sort === option.value}
                    disabled={importing}
                    aria-pressed={sort === option.value}
                    onclick={() => setSort(option.value)}
                >{option.label}</button>
            {/each}
            <span class="mx-1 h-5 w-px bg-kai-border-soft"></span>
            <button
                class="kai-chip rounded-full"
                class:border-kai-accent={nsfw}
                class:text-kai-accent={nsfw}
                disabled={importing}
                aria-pressed={nsfw}
                onclick={() => { nsfw = !nsfw; void load(1) }}
            >NSFW 포함</button>
            <button
                class="kai-chip rounded-full"
                class:border-kai-accent={skipLowQuality}
                class:text-kai-accent={skipLowQuality}
                disabled={importing}
                aria-pressed={skipLowQuality}
                onclick={() => skipLowQuality = !skipLowQuality}
            >저품질 챗 (이미지 없음) 제외</button>
            {#if appliedSearch}
                <span class="text-xs text-kai-faint">‘{appliedSearch}’ 검색 결과</span>
            {/if}
        </div>
    </div>

    {#if importing}
        <div class="border-b border-kai-border-soft bg-kai-surface-2 px-5 py-4" aria-live="polite">
            <div class="flex items-center justify-between gap-4 text-xs">
                <span class="min-w-0 truncate text-kai-dim">{progressName} 가져오는 중</span>
                <strong class="shrink-0 text-kai-text">{progressDone} / {progressTotal} · {progressPercent}%</strong>
            </div>
            <div class="mt-2 h-2 overflow-hidden rounded-full bg-kai-bg" role="progressbar" aria-valuenow={progressDone} aria-valuemin="0" aria-valuemax={progressTotal}>
                <span class="block h-full rounded-full bg-kai-accent transition-[width] duration-300" style:width={`${progressPercent}%`}></span>
            </div>
            <p class="mt-2 text-[11px] text-kai-faint">완료 {progressImported} · 실패 {progressFailed}</p>
        </div>
    {/if}

    <div class="flex flex-wrap items-center gap-2 border-b border-kai-border-soft px-5 py-3">
        <button class="kai-btn kai-btn-ghost" disabled={loading || importing || !items.length} onclick={selectAvailable}>현재 페이지 전체 선택</button>
        <span class="text-xs text-kai-faint">{selected.size}개 선택</span>
        <button class="kai-btn kai-btn-primary ml-auto" disabled={!selected.size || importing} onclick={importSelected}>
            <Download size={16} /> {importing ? '가져오는 중…' : '선택 작품 가져오기'}
        </button>
    </div>

    {#if loading && !items.length}
        <p class="p-10 text-center text-sm text-kai-faint">Realm 목록을 불러오는 중…</p>
    {:else if !items.length}
        <p class="p-10 text-center text-sm text-kai-faint">{appliedSearch ? '검색 결과가 없습니다.' : '표시할 작품이 없습니다.'}</p>
    {:else}
        <div class="grid gap-px bg-kai-border-soft sm:grid-cols-2 lg:grid-cols-3">
            {#each items as item}
                <button
                    class="group flex min-h-32 gap-3 bg-kai-surface p-3 text-left disabled:cursor-default disabled:opacity-55"
                    class:ring-2={selected.has(item.id)}
                    class:ring-inset={selected.has(item.id)}
                    class:ring-kai-accent={selected.has(item.id)}
                    disabled={item.imported || importing}
                    onclick={() => toggle(item.id)}
                >
                    <div class="relative h-28 w-20 shrink-0 overflow-hidden rounded-lg bg-kai-surface-2">
                        {#if item.imageUrl}<img class="h-full w-full object-cover" src={item.imageUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />{:else}<span class="grid h-full place-items-center text-xl font-bold text-kai-faint">{item.name.slice(0, 1)}</span>{/if}
                        {#if paged && !appliedSearch}<span class="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">#{item.rank}</span>{/if}
                    </div>
                    <span class="min-w-0 flex-1">
                        <strong class="line-clamp-2 text-sm">{item.name}</strong>
                        <span class="mt-1 flex items-center gap-1.5 truncate text-xs text-kai-faint">
                            <span class="truncate">{item.creatorName || 'Unknown'}</span>
                            {#if item.downloads}<span>· ⬇ {item.downloads}</span>{/if}
                        </span>
                        <span class="mt-2 line-clamp-3 text-xs leading-5 text-kai-dim">{item.description || '설명 없음'}</span>
                        {#if item.imported}<span class="mt-2 inline-block text-[11px] font-bold text-kai-ok">가져옴</span>{/if}
                    </span>
                </button>
            {/each}
        </div>
    {/if}

    {#if paged}
        <div class="flex items-center justify-center gap-3 border-t border-kai-border-soft p-3">
            <button class="kai-icon-action" disabled={page <= 1 || loading || importing} onclick={() => load(page - 1)} aria-label="이전 페이지"><ChevronLeft size={18} /></button>
            <span class="min-w-12 text-center text-xs text-kai-dim">{page}쪽</span>
            <button class="kai-icon-action" disabled={loading || importing || !items.length} onclick={() => load(page + 1)} aria-label="다음 페이지"><ChevronRight size={18} /></button>
        </div>
    {/if}
</section>
