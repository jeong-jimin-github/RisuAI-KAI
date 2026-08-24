<script lang="ts">
    import { Clock3, Flame, Heart, MessageCircle, Sparkles, Trophy } from '@lucide/svelte'
    import { router } from '../lib/router.svelte'

    let { compact = false }: { compact?: boolean } = $props()
    const genres = ['시뮬레이션', '로맨스', '판타지/SF', '드라마', '무협/사극', '공포/추리', '액션', '코믹/일상', '스포츠/학원', 'BL', 'GL', '기타']
    const path = $derived(router.current.path)
</script>

<nav class="kai-discovery-nav" class:compact aria-label="콘텐츠 탐색">
    <div class="kai-nav-rail kai-nav-primary">
        <a class:active={path === '/'} href="/"><Sparkles size={15} /> 메인 화면</a>
        <a class:active={path === '/explore'} href="/explore">작품 전체</a>
        <a href="/explore?sort=newest"><Clock3 size={15} /> 신작</a>
        <a class:active={path === '/ranking'} href="/ranking"><Trophy size={15} /> 랭킹</a>
        <a class:active={path === '/chats'} href="/chats"><MessageCircle size={15} /> 내 채팅</a>
        <a class:active={path === '/bookmarks'} href="/bookmarks"><Heart size={15} /> 북마크</a>
        <a class="event" href="/explore?sort=trending"><Flame size={15} /> 지금 인기</a>
    </div>
    {#if !compact}
        <div class="kai-nav-rail kai-genre-rail" aria-label="장르 탐색">
            {#each genres as genre}
                <a href={`/explore?tag=${encodeURIComponent(genre)}`}>{genre}</a>
            {/each}
        </div>
    {/if}
</nav>
