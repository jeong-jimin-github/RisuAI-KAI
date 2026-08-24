<script lang="ts">
    import type { CharacterSummary } from '@kai/shared/contract'
    import { Heart, MessageCircle, MessagesSquare } from '@lucide/svelte'
    import { descriptionPreview } from '../lib/multilang'
    import { appConfig } from '../stores/app.svelte'
    type Variant = 'portrait' | 'ranking' | 'horizontal'
    let { character, rank, variant = rank ? 'ranking' : 'portrait' }: { character: CharacterSummary; rank?: number; variant?: Variant } = $props()
    const description = $derived(
        descriptionPreview(character.description, appConfig.site?.defaultLocale ?? 'en'),
    )
</script>

<article class="kai-work-card kai-work-card-{variant}">
    {#if rank}<span class="kai-story-spine" aria-label={`${rank}위`}>{String(rank).padStart(2, '0')}</span>{/if}
    <a href={`/c/${character.slug}`} class="kai-work-media" aria-label={character.name}>
        {#if character.avatarUrl}
            <img
                src={character.avatarUrl + (character.avatarUrl.includes('?') ? '&' : '?') + 'w=400'}
                srcset={`${character.avatarUrl}?w=400 1x, ${character.avatarUrl}?w=800 2x`}
                alt={character.name}
                loading="lazy"
                decoding="async"
                width="600"
                height="800"
                draggable="false"
            />
        {:else}
            <div class="kai-work-placeholder">{character.name.slice(0, 1)}</div>
        {/if}
        {#if character.featured}<span class="kai-rating-badge">PICK</span>{/if}
    </a>
    <div class="kai-work-meta">
        <h3><a href={`/c/${character.slug}`}>{character.name}</a></h3>
        <p>{description}</p>
        {#if character.tags.length}
            <div class="kai-work-tags" aria-label="태그">
                {#each character.tags.slice(0, variant === 'horizontal' ? 3 : 2) as tag}<span>#{tag}</span>{/each}
            </div>
        {/if}
        <div class="kai-work-stats">
            <span title="북마크"><Heart size={12} />{character.likeCount.toLocaleString()}</span>
            <span title="대화"><MessageCircle size={12} />{character.chatCount.toLocaleString()}</span>
            <span title="메시지"><MessagesSquare size={12} />{character.messageCount.toLocaleString()}</span>
        </div>
        <span class="kai-creator">{character.creatorName || 'RisuAI-KAI'}</span>
    </div>
</article>
