<script lang="ts">
    import type { CharacterSummary } from '@kai/shared/contract'
    import { api } from '../api/client'
    import CharacterTile from '../components/CharacterTile.svelte'
    import CharacterCardSkeleton from '../components/CharacterCardSkeleton.svelte'

    let items = $state<CharacterSummary[]>([])
    let sort = $state<'popular' | 'trending' | 'newest'>('popular')
    let loading = $state(true)
    let seq = 0
    async function load() {
        const mine = ++seq
        loading = true
        try { const result = await api.characters.list({ sort, pageSize: 40, nsfw: false }); if (mine === seq) items = result.items }
        finally { if (mine === seq) loading = false }
    }
    $effect(() => { sort; void load() })
</script>

<div class="kai-page-container kai-list-page">
    <div class="kai-ranking-head">
        <div><h1 class="kai-page-title">작품 랭킹</h1></div>
        <div class="kai-period-tabs" role="tablist" aria-label="랭킹 기준">
            <button class:active={sort === 'trending'} onclick={() => sort = 'trending'}>실시간</button><span>·</span>
            <button class:active={sort === 'popular'} onclick={() => sort = 'popular'}>전체</button><span>·</span>
            <button class:active={sort === 'newest'} onclick={() => sort = 'newest'}>신작</button>
        </div>
    </div>
    {#if loading}<CharacterCardSkeleton count={8} />{:else}
        <div class="kai-work-grid kai-ranking-page-grid">{#each items as character, index}<CharacterTile {character} rank={index + 1} variant="ranking" />{/each}</div>
    {/if}
</div>
