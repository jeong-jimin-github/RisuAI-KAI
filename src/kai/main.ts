import '../ts/polyfill'
import 'core-js/actual'
import './kai.css'
import './redesign.css'
import { mount } from 'svelte'
import KaiApp from './KaiApp.svelte'
import { bootstrapApp } from './stores/app.svelte'

function disableImageDragging(node: Node) {
    if (node instanceof HTMLImageElement) node.draggable = false
    if (node instanceof Element || node instanceof Document || node instanceof DocumentFragment) {
        for (const image of node.querySelectorAll('img')) image.draggable = false
    }
}

disableImageDragging(document)
const imageDragObserver = new MutationObserver((records) => {
    for (const record of records) {
        for (const node of record.addedNodes) disableImageDragging(node)
    }
})
imageDragObserver.observe(document.documentElement, { childList: true, subtree: true })
document.addEventListener(
    'dragstart',
    (event) => {
        if (event.target instanceof HTMLImageElement) event.preventDefault()
    },
    true,
)

const isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

if (isIos) {
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (viewportMeta && !/maximum-scale\s*=/.test(viewportMeta.content)) {
        viewportMeta.content = `${viewportMeta.content}, maximum-scale=1`
    }
}

/**
 * RisuAI-KAI entry point.
 *
 * Unlike stock RisuAI this does NOT call `loadData()` — the engine is not
 * booted here. It is initialised lazily by the chat screen (see
 * `engine/bridge.svelte.ts`) so that browsing the gallery never pays for the
 * tokenizer, plugin sandbox and WASM bundles.
 */

addEventListener('vite:preloadError', (event) => {
    console.error('Chunk load error detected:', event)
    location.reload()
})

const target = document.getElementById('app')
if (!target) throw new Error('#app mount point is missing from index.html')

const app = mount(KaiApp, { target })

bootstrapApp().finally(() => {
    document.getElementById('preloading')?.remove()
})

export default app
