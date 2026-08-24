<script lang="ts">
    import type { CharacterSummary } from '@kai/shared/contract'
    import { onMount } from 'svelte'
    import { api } from '../api/client'
    import CharacterTile from '../components/CharacterTile.svelte'
    let items = $state<CharacterSummary[]>([]), loading = $state(true)
    onMount(async () => { try { items = (await api.characters.list({ liked: true, sort: 'popular', pageSize: 60 })).items } finally { loading = false } })
</script>

<div class="kai-page-container kai-list-page">
    <header class="kai-page-heading"><h1 class="kai-page-title">북마크</h1></header>
    {#if loading}<p class="py-28 text-center text-kai-faint">불러오는 중…</p>
    {:else if items.length}<div class="kai-work-grid">{#each items as character}<CharacterTile {character} />{/each}</div>
    {:else}<div class="kai-empty-state"><div>아직 북마크한 캐릭터가 없습니다.<br /><a class="kai-more-link mt-4 justify-center" href="/explore">캐릭터 둘러보기</a></div></div>{/if}
</div>
