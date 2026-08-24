<script lang="ts">
    /**
     * Renders a RisuAI multi-language string the way RisuAI itself does.
     *
     * Card authors write creator notes as
     *
     *     # `ko`
     *     한국어 소개 **마크다운**
     *     # `en`
     *     English intro
     *
     * and RisuAI (`MultiLangDisplay`) shows one tab per language and renders the
     * selected section through `ParseMarkdown`. KAI printed the raw string, so
     * the heading markers were visible, every language showed at once, and
     * markdown stayed as literal asterisks.
     *
     * Two deliberate differences from upstream:
     *  - a single-language note renders without tabs (upstream shows a lone
     *    "Unknown Language" button for notes that carry no headings at all);
     *  - the default tab follows the instance locale, because KAI has no
     *    per-user language setting to read.
     */
    import { ParseMarkdown } from '../../ts/parser/parser.svelte'
    import { toLangName } from '../../ts/util'
    import { multiLangSections, preferredSection } from '../lib/multilang'
    import { appConfig } from '../stores/app.svelte'

    interface Props {
        value: string
        /** Extra classes for the rendered body (sizing, spacing). */
        class?: string
    }

    let { value, class: className = '' }: Props = $props()

    const sections = $derived(multiLangSections(value))
    const preferred = $derived(preferredSection(sections, appConfig.site?.defaultLocale ?? 'en'))

    /** null until the reader picks a tab, so the locale default keeps winning. */
    let picked = $state<string | null>(null)
    const active = $derived(sections.find((s) => s.code === picked) ?? preferred)
</script>

{#if active}
    <div class="flex min-w-0 flex-col gap-3">
        {#if sections.length > 1}
            <div class="flex flex-wrap gap-1.5">
                {#each sections as section}
                    <button
                        type="button"
                        class="kai-chip"
                        class:kai-chip-active={section.code === active.code}
                        aria-pressed={section.code === active.code}
                        onclick={() => (picked = section.code)}>{toLangName(section.code)}</button
                    >
                {/each}
            </div>
        {/if}
        <!-- ParseMarkdown output is DOMPurify-sanitised by the engine itself. -->
        {#await ParseMarkdown(active.text)}
            <div class="whitespace-pre-line text-kai-dim {className}">{active.text}</div>
        {:then html}
            <div
                class="kai-risu-message chattext kai-prose {className}"
                lang={active.code === 'xx' ? null : active.code}
            >
                {@html html}
            </div>
        {:catch}
            <div class="whitespace-pre-line text-kai-dim {className}">{active.text}</div>
        {/await}
    </div>
{/if}
