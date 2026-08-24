import { describe, expect, it } from 'vitest'
import { cpuUsageBetween, normalizeSysfsTemperature, parseTermuxBatteryPayload, parseTopCpuUsage } from '../services/systemStatus.js'

describe('system status helpers', () => {
    it('normalizes common Android thermal sensor units and rejects sentinels', () => {
        expect(normalizeSysfsTemperature('39600')).toBe(39.6)
        expect(normalizeSysfsTemperature('336')).toBe(33.6)
        expect(normalizeSysfsTemperature('42.5')).toBe(42.5)
        expect(normalizeSysfsTemperature('-273000')).toBeNull()
        expect(normalizeSysfsTemperature('0')).toBeNull()
    })

    it('computes aggregate CPU utilization between samples', () => {
        expect(cpuUsageBetween({ idle: 400, total: 1_000 }, { idle: 450, total: 1_200 })).toBe(75)
        expect(cpuUsageBetween({ idle: 10, total: 20 }, { idle: 10, total: 20 })).toBeNull()
    })

    it('normalizes Android top aggregate idle time across all cores', () => {
        expect(parseTopCpuUsage('800%cpu  80%user  0%sys 720%idle', 8)).toBe(10)
        expect(parseTopCpuUsage('no cpu summary', 8)).toBeNull()
    })

    it('parses Termux battery output without exposing unknown fields', () => {
        expect(parseTermuxBatteryPayload({
            percentage: 82,
            status: 'CHARGING',
            health: 'GOOD',
            plugged: 'PLUGGED_USB',
            temperature: 33.6,
            current: -425000,
        })).toEqual({
            levelPct: 82,
            status: 'CHARGING',
            health: 'GOOD',
            plugged: 'PLUGGED_USB',
            temperatureC: 33.6,
            voltageV: null,
            currentMa: -425,
        })
        expect(parseTermuxBatteryPayload({})).toBeNull()
    })
})
