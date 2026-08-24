import { execFile } from 'node:child_process'
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'
import { readFile, readdir, statfs } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SystemStatus, TemperatureSensor } from '../../../shared/contract.js'
import { env } from '../env.js'

interface CpuTimes {
    idle: number
    total: number
}

interface BatteryFields {
    levelPct: number | null
    status: string | null
    health: string | null
    plugged: string | null
    temperatureC: number | null
    voltageV: number | null
    currentMa: number | null
}

const STATUS_CACHE_MS = 2_000
const BATTERY_CACHE_MS = 30_000
const BATTERY_FAILURE_CACHE_MS = 5 * 60_000
const TERMUX_BATTERY_COMMAND = 'termux-battery-status'

let previousCpu = captureCpuTimes()
let cachedStatus: { expiresAt: number; value: SystemStatus } | null = null
let pendingStatus: Promise<SystemStatus> | null = null
let cachedBattery: { expiresAt: number; value: SystemStatus['battery'] } | null = null
let termuxApiApp: { expiresAt: number; available: boolean } | null = null

function finite(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
    return Number.isFinite(parsed) ? parsed : null
}

function rounded(value: number, digits = 1): number {
    const factor = 10 ** digits
    return Math.round(value * factor) / factor
}

function percent(used: number, total: number): number {
    return total > 0 ? rounded((used / total) * 100) : 0
}

function captureCpuTimes(): CpuTimes {
    let idle = 0
    let total = 0
    for (const cpu of cpus()) {
        idle += cpu.times.idle
        total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    }
    return { idle, total }
}

export function cpuUsageBetween(previous: CpuTimes, current: CpuTimes): number | null {
    const elapsed = current.total - previous.total
    const idle = current.idle - previous.idle
    if (elapsed <= 0) return null
    return rounded(Math.min(100, Math.max(0, ((elapsed - idle) / elapsed) * 100)))
}

export function parseTopCpuUsage(output: string, cores: number): number | null {
    const cpuLine = output.split(/\r?\n/).find((line) => /%cpu/i.test(line))
    const idle = cpuLine?.match(/([\d.]+)%idle/i)
    if (!idle || cores <= 0) return null
    const aggregateIdle = Number.parseFloat(idle[1])
    if (!Number.isFinite(aggregateIdle)) return null
    return rounded(Math.min(100, Math.max(0, 100 - aggregateIdle / cores)))
}

export function normalizeSysfsTemperature(value: unknown): number | null {
    const parsed = finite(value)
    if (parsed === null) return null
    const celsius = Math.abs(parsed) >= 1_000 ? parsed / 1_000 : Math.abs(parsed) >= 200 ? parsed / 10 : parsed
    if (celsius <= 0 || celsius > 150) return null
    return rounded(celsius)
}

function normalizeVoltage(value: unknown): number | null {
    const parsed = finite(value)
    if (parsed === null) return null
    return rounded(Math.abs(parsed) > 1_000 ? parsed / 1_000_000 : parsed, 3)
}

function normalizeCurrent(value: unknown): number | null {
    const parsed = finite(value)
    if (parsed === null) return null
    return rounded(Math.abs(parsed) > 10_000 ? parsed / 1_000 : parsed)
}

function nullableText(value: unknown): string | null {
    const text = typeof value === 'string' ? value.trim() : ''
    return text || null
}

export function parseTermuxBatteryPayload(payload: unknown): BatteryFields | null {
    if (!payload || typeof payload !== 'object') return null
    const value = payload as Record<string, unknown>
    const fields: BatteryFields = {
        levelPct: finite(value.percentage),
        status: nullableText(value.status),
        health: nullableText(value.health),
        plugged: nullableText(value.plugged),
        temperatureC: normalizeSysfsTemperature(value.temperature),
        voltageV: normalizeVoltage(value.voltage),
        currentMa: normalizeCurrent(value.current),
    }
    return Object.values(fields).some((field) => field !== null) ? fields : null
}

async function readText(path: string): Promise<string | null> {
    try {
        return (await readFile(path, 'utf8')).trim() || null
    } catch {
        return null
    }
}

async function readNumber(path: string): Promise<number | null> {
    return finite(await readText(path))
}

async function collectTemperatureSensors(): Promise<TemperatureSensor[]> {
    const root = '/sys/class/thermal'
    try {
        const entries = await readdir(root, { withFileTypes: true })
        const sensors = await Promise.all(entries
            .filter((entry) => entry.name.startsWith('thermal_zone'))
            .map(async (entry): Promise<TemperatureSensor | null> => {
                const path = resolve(root, entry.name)
                const [name, raw] = await Promise.all([readText(resolve(path, 'type')), readText(resolve(path, 'temp'))])
                const temperatureC = normalizeSysfsTemperature(raw)
                if (!name || temperatureC === null) return null
                return { name: name.slice(0, 64), temperatureC }
            }))
        return sensors
            .filter((sensor): sensor is TemperatureSensor => sensor !== null)
            .sort((a, b) => b.temperatureC - a.temperatureC || a.name.localeCompare(b.name))
    } catch {
        return []
    }
}

function runTermuxBatteryStatus(): Promise<string> {
    return runCommand(TERMUX_BATTERY_COMMAND, [], 1_500)
}

function runCommand(command: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 }, (error, stdout) => {
            if (error) reject(error)
            else resolvePromise(stdout)
        })
    })
}

async function hasTermuxApiApp(): Promise<boolean> {
    if (termuxApiApp && termuxApiApp.expiresAt > Date.now()) return termuxApiApp.available
    let available = false
    try {
        available = (await runCommand('/system/bin/pm', ['path', 'com.termux.api'], 1_500)).includes('package:')
    } catch {
        available = false
    }
    termuxApiApp = { expiresAt: Date.now() + BATTERY_FAILURE_CACHE_MS, available }
    return available
}

async function readTermuxBattery(): Promise<BatteryFields | null> {
    try {
        if (!(await hasTermuxApiApp())) return null
        const output = await runTermuxBatteryStatus()
        return parseTermuxBatteryPayload(JSON.parse(output))
    } catch {
        return null
    }
}

async function readSysfsBattery(): Promise<BatteryFields | null> {
    for (const root of ['/sys/class/power_supply/battery', '/sys/class/power_supply/Battery']) {
        const [levelPct, status, health, temperature, voltage, current, technology] = await Promise.all([
            readNumber(resolve(root, 'capacity')),
            readText(resolve(root, 'status')),
            readText(resolve(root, 'health')),
            readText(resolve(root, 'temp')),
            readText(resolve(root, 'voltage_now')),
            readText(resolve(root, 'current_now')),
            readText(resolve(root, 'technology')),
        ])
        const fields: BatteryFields = {
            levelPct,
            status,
            health,
            plugged: technology,
            temperatureC: normalizeSysfsTemperature(temperature),
            voltageV: normalizeVoltage(voltage),
            currentMa: normalizeCurrent(current),
        }
        if (Object.values(fields).some((field) => field !== null)) return fields
    }
    return null
}

async function collectBattery(thermalBatteryC: number | null): Promise<SystemStatus['battery']> {
    if (cachedBattery && cachedBattery.expiresAt > Date.now()) return cachedBattery.value

    const termux = await readTermuxBattery()
    const sysfs = termux ? null : await readSysfsBattery()
    const fields = termux ?? sysfs
    const source = termux ? 'termux-api' : sysfs ? 'sysfs' : thermalBatteryC !== null ? 'thermal' : 'unavailable'
    const value: SystemStatus['battery'] = {
        available: fields !== null || thermalBatteryC !== null,
        source,
        levelPct: fields?.levelPct ?? null,
        status: fields?.status ?? null,
        health: fields?.health ?? null,
        plugged: fields?.plugged ?? null,
        temperatureC: fields?.temperatureC ?? thermalBatteryC,
        voltageV: fields?.voltageV ?? null,
        currentMa: fields?.currentMa ?? null,
    }
    cachedBattery = {
        expiresAt: Date.now() + (fields ? BATTERY_CACHE_MS : BATTERY_FAILURE_CACHE_MS),
        value,
    }
    return value
}

async function collectDisk(): Promise<SystemStatus['disk']> {
    try {
        const stats = await statfs(env.dataDir)
        const totalBytes = stats.blocks * stats.bsize
        const availableBytes = stats.bavail * stats.bsize
        const usedBytes = Math.max(0, totalBytes - availableBytes)
        return { totalBytes, usedBytes, availableBytes, usedPct: percent(usedBytes, totalBytes) }
    } catch {
        return null
    }
}

function hottest(sensors: TemperatureSensor[], matcher: RegExp): number | null {
    return sensors.find((sensor) => matcher.test(sensor.name))?.temperatureC ?? null
}

async function collectCpu(): Promise<{ usagePct: number | null; cores: number }> {
    const systemCpus = cpus()
    if (systemCpus.length > 0) {
        const currentCpu = captureCpuTimes()
        const usagePct = cpuUsageBetween(previousCpu, currentCpu)
        previousCpu = currentCpu
        return { usagePct, cores: systemCpus.length }
    }

    let cores = 0
    try {
        cores = (await readdir('/sys/devices/system/cpu')).filter((name) => /^cpu\d+$/.test(name)).length
    } catch {
        cores = 0
    }
    cores = Math.max(1, cores)
    try {
        return { usagePct: parseTopCpuUsage(await runCommand('top', ['-b', '-n', '1'], 2_000), cores), cores }
    } catch {
        return { usagePct: null, cores }
    }
}

async function collectSystemStatus(): Promise<SystemStatus> {
    const totalBytes = totalmem()
    const availableBytes = freemem()
    const usedBytes = Math.max(0, totalBytes - availableBytes)
    const processMemory = process.memoryUsage()
    const sensors = await collectTemperatureSensors()
    const batteryC = hottest(sensors, /battery/i)
    const [cpu, disk, battery] = await Promise.all([collectCpu(), collectDisk(), collectBattery(batteryC)])
    const loads = loadavg()

    return {
        sampledAt: new Date().toISOString(),
        cpu: {
            usagePct: cpu.usagePct,
            cores: cpu.cores,
            loadAverage: [rounded(loads[0], 2), rounded(loads[1], 2), rounded(loads[2], 2)],
        },
        memory: {
            totalBytes,
            usedBytes,
            availableBytes,
            usedPct: percent(usedBytes, totalBytes),
            processRssBytes: processMemory.rss,
            processHeapUsedBytes: processMemory.heapUsed,
        },
        disk,
        uptime: { systemSeconds: Math.floor(uptime()), processSeconds: Math.floor(process.uptime()) },
        temperatures: {
            highestC: sensors[0]?.temperatureC ?? null,
            cpuC: hottest(sensors, /^(cpu|cpuss)/i),
            gpuC: hottest(sensors, /^gpu/i),
            batteryC,
            sensors,
        },
        battery,
    }
}

export function getSystemStatus(): Promise<SystemStatus> {
    if (cachedStatus && cachedStatus.expiresAt > Date.now()) return Promise.resolve(cachedStatus.value)
    if (pendingStatus) return pendingStatus
    pendingStatus = collectSystemStatus()
        .then((value) => {
            cachedStatus = { expiresAt: Date.now() + STATUS_CACHE_MS, value }
            return value
        })
        .finally(() => {
            pendingStatus = null
        })
    return pendingStatus
}
