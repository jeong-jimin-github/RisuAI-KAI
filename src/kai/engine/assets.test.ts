import { describe, expect, it } from 'vitest'
import { hydrateHostedCharacterAssets } from './assets'

describe('hydrateHostedCharacterAssets', () => {
    it('resolves legacy and CHARX references and reconstructs missing lists', () => {
        const card = hydrateHostedCharacterAssets<Record<string, any>>(
            {
                additionalAssets: [['legacy', '__asset:0', 'png']],
                emotionImages: [],
            },
            {
                '0': '/api/assets/as_legacy',
                'assets/emotion/image/happy.webp': '/api/assets/as_happy',
                'assets/other/image/scene.webp': '/api/assets/as_scene',
                'assets/icon/image/main.png': '/api/assets/as_main',
            },
        )

        expect(card.additionalAssets).toContainEqual(['legacy', '/api/assets/as_legacy', 'png'])
        expect(card.additionalAssets).toContainEqual(['scene', '/api/assets/as_scene', 'webp'])
        expect(card.emotionImages).toContainEqual(['happy', '/api/assets/as_happy'])
        expect(card.image).toBe('/api/assets/as_main')
    })
})

