<script lang="ts">
    import type { Toast } from '../stores/app.svelte'
    let { toasts }: { toasts: { items: Toast[]; dismiss(id: number): void } } = $props()
</script>

<div class="pointer-events-none fixed inset-x-0 top-4 z-[100] flex flex-col items-center gap-2 px-4" aria-live="polite">
    {#each toasts.items as toast (toast.id)}
        <button class="pointer-events-auto max-w-md rounded-xl border border-kai-border bg-kai-surface px-4 py-3 text-left text-sm shadow-xl {toast.kind === 'error' ? 'text-kai-danger' : toast.kind === 'success' ? 'text-kai-ok' : 'text-kai-text'}" onclick={() => toasts.dismiss(toast.id)}>
            {toast.message}
        </button>
    {/each}
</div>
