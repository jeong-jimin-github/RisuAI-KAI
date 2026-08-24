<script lang="ts">
    import { ChevronRight } from '@lucide/svelte'
    let {
        title,
        href,
        action = '더보기',
    }: { title: string; href?: string; action?: string } = $props()
</script>

<header class="kai-section-header">
    <div class="min-w-0">
        <h2>{title}</h2>
    </div>
    {#if href}
        <a href={href} class="kai-more-link">{action}<ChevronRight size={17} /></a>
    {/if}
</header>
