<script lang="ts">
    let { count = 4 }: { count?: number } = $props()
</script>

<div class="kai-work-grid" aria-label="캐릭터를 불러오는 중" aria-busy="true">
    {#each Array(count) as _}
        <div class="kai-card-skeleton" aria-hidden="true">
            <div class="kai-skeleton-media"></div>
            <div class="kai-skeleton-line wide"></div>
            <div class="kai-skeleton-line"></div>
            <div class="kai-skeleton-line short"></div>
        </div>
    {/each}
</div>
