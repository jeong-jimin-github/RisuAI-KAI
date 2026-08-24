<script lang="ts">
    import type { CharacterSummary } from '@kai/shared/contract'
    import { ArrowUpRight, ChevronLeft, ChevronRight, Heart, MessageCircle } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { fade } from 'svelte/transition'
    import { descriptionPreview } from '../lib/multilang'
    import { appConfig } from '../stores/app.svelte'

    import { router } from '../lib/router.svelte'

    let { characters }: { characters: CharacterSummary[] } = $props()
    let index = $state(0)
    let paused = $state(false)
    const character = $derived(characters[index] ?? characters[0])
    const description = $derived(
        character ? descriptionPreview(character.description, appConfig.site?.defaultLocale ?? 'en') : '',
    )

    function move(delta: number) {
        if (characters.length < 2) return
        index = (index + delta + characters.length) % characters.length
    }

    function handleCardClick(event: MouseEvent) {
        const target = event.target as HTMLElement | null
        if (target?.closest('button, .kai-featured-arrow, .kai-featured-pagination')) return
        if (character) router.go(`/c/${character.slug}`)
    }

    onMount(() => {
        const timer = window.setInterval(() => {
            if (!paused) move(1)
        }, 6500)
        return () => window.clearInterval(timer)
    })
</script>

{#if character}
    <section
        class="kai-featured-carousel"
        aria-label="추천 이야기"
        onmouseenter={() => paused = true}
        onmouseleave={() => paused = false}
        onfocusin={() => paused = true}
        onfocusout={() => paused = false}
    >
        {#key character.id}
            <article
                class="kai-featured-story kai-featured-slide cursor-pointer"
                in:fade={{ duration: 260 }}
                out:fade={{ duration: 160 }}
                onclick={handleCardClick}
            >
                <a class="kai-featured-art" href={`/c/${character.slug}`} aria-label={`${character.name} 자세히 보기`}>
                    {#if character.avatarUrl}
                        <img src={character.avatarUrl} alt={character.name} width="900" height="1200" draggable="false" />
                    {:else}
                        <span>{character.name.slice(0, 1)}</span>
                    {/if}
                </a>
                <div class="kai-featured-copy">
                    <p class="kai-eyebrow">추천 스토리</p>
                    <h1>{character.name}</h1>
                    <p class="kai-featured-description">{description || character.tagline}</p>
                    {#if character.tags.length}
                        <div class="kai-featured-tags">{#each character.tags.slice(0, 4) as tag}<span>#{tag}</span>{/each}</div>
                    {/if}
                    <div class="kai-featured-meta">
                        <span>{character.creatorName || 'RisuAI-KAI'}</span>
                        <span title="북마크"><Heart size={14} />{character.likeCount.toLocaleString()}</span>
                        <span><MessageCircle size={14} />{character.chatCount.toLocaleString()}</span>
                    </div>
                    <a class="kai-featured-cta" href={`/c/${character.slug}`}>
                        상세 보기 <ArrowUpRight size={18} />
                    </a>
                </div>
            </article>
        {/key}
        {#if characters.length > 1}
            <button class="kai-featured-arrow previous" aria-label="이전 추천 이야기" onclick={() => move(-1)}><ChevronLeft size={22} /></button>
            <button class="kai-featured-arrow next" aria-label="다음 추천 이야기" onclick={() => move(1)}><ChevronRight size={22} /></button>
            <div class="kai-featured-pagination" aria-label={`${index + 1} / ${characters.length}`}>
                {#each characters as item, itemIndex}
                    <button class:active={itemIndex === index} aria-label={`${itemIndex + 1}번째 이야기`} onclick={() => index = itemIndex}></button>
                {/each}
            </div>
        {/if}
    </section>
{/if}
