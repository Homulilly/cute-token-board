import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type DeviceKey = string;
type SeriesKey = DeviceKey | "merged";

type TokenTotals = {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  totalTokens: number;
};

type RawModelBreakdown = Partial<TokenTotals> & {
  modelName?: string;
  cost?: number;
};

type RawWeek = Partial<TokenTotals> & {
  period?: string;
  cost?: number;
  modelBreakdowns?: RawModelBreakdown[];
  modelsUsed?: string[];
  metadata?: {
    agents?: string[];
  };
};

type RawUsage = {
  totals?: Partial<TokenTotals>;
  daily?: RawWeek[];
};

type DataSource = "local" | "remote";

export type ModelSummary = TokenTotals & {
  modelName: string;
  totalCost: number;
};

export type UsageWeek = TokenTotals & {
  period: string;
  label: string;
  monthKey: string;
  device: SeriesKey;
  modelsUsed: string[];
  agentsUsed: string[];
  modelBreakdowns: ModelSummary[];
};

export type MonthlySummary = TokenTotals & {
  monthKey: string;
  label: string;
  activeWeeks: number;
};

export type DeviceSummary = {
  key: DeviceKey;
  label: string;
  color: string;
  totals: TokenTotals;
  weeks: UsageWeek[];
  monthly: MonthlySummary[];
  activeWeeks: number;
  share: number;
  peakWeek: UsageWeek;
  latestWeek: UsageWeek;
  averageWeekTokens: number;
};

export type ChartLine = {
  width: number;
  height: number;
  mergedPath: string;
  devicePaths: { deviceKey: string; color: string; path: string }[];
  mergedArea: string;
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
};

export type ChartRange = ChartLine & {
  key: "1m" | "3m" | "1y" | "all";
  label: string;
  caption: string;
  weekCount: number;
};

export type HeatWeek = {
  period: string;
  label: string;
  monthKey: string;
  totalTokens: number;
  totalCost: number;
  deviceTokens: Record<string, number>;
  level: number;
};

export type HeatDay = {
  date: string;
  label: string;
  weekLabel: string;
  monthKey: string;
  totalTokens: number;
  totalCost: number;
  deviceTokens: Record<string, number>;
  intensity: number;
  color: string;
};

export type AgentSummary = {
  name: string;
  activeWeeks: number;
  tokenTouch: number;
};

export type BoardViewData = {
  chartRanges: ChartRange[];
  topWeeks: UsageWeek[];
  topCostWeeks: UsageWeek[];
  topAgents: AgentSummary[];
  records: {
    peakWeek: UsageWeek;
    latestWeek: UsageWeek;
    previousWeek: UsageWeek;
    biggestJump: UsageWeek & { deltaTokens: number };
    longestStreak: number;
    currentStreak: number;
    averageActiveWeekTokens: number;
  };
};

export type TokenBoardData = {
  generatedAt: string;
  sourceMode: "local" | "remote" | "mixed";
  totals: TokenTotals;
  mergedWeeks: UsageWeek[];
  monthly: MonthlySummary[];
  devices: DeviceSummary[];
  heatmap: HeatWeek[];
  dailyHeatmap: HeatDay[];
  topMonths: MonthlySummary[];
  topModels: ModelSummary[];
  weekly: BoardViewData;
  daily: BoardViewData;
  monthlyView: BoardViewData;
  records: {
    peakMonth: MonthlySummary;
    cacheShare: number;
    outputShare: number;
  };
};

const zeroTotals = (): TokenTotals => ({
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0,
  totalTokens: 0
});

const totalKeys: (keyof TokenTotals)[] = [
  "cacheCreationTokens",
  "cacheReadTokens",
  "inputTokens",
  "outputTokens",
  "totalCost",
  "totalTokens"
];

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addTotals(target: TokenTotals, source: Partial<TokenTotals>): TokenTotals {
  for (const key of totalKeys) {
    target[key] += asNumber(source[key]);
  }

  return target;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parsePeriod(period: string): Date {
  const [year, month, day] = period.split("-").map(Number);
  return startOfUtcDay(new Date(Date.UTC(year, month - 1, day)));
}

function toPeriod(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getMonthKey(period: string): string {
  return period.slice(0, 7);
}

function formatPeriodLabel(period: string): string {
  const date = parsePeriod(period);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const week = Math.floor((date.getUTCDate() - 1) / 7) + 1;

  return `${year}-${month} W${week}`;
}

function monthLabel(monthKey: string): string {
  return monthKey;
}

export interface DeviceConfig {
  key: string;
  label: string;
  pathOrUrl: string;
  color: string;
}

const devicePalette = [
  "var(--blue)",
  "var(--pink)",
  "var(--yellow)",
  "var(--green-strong)",
  "#705ec7",
  "#2f8f83",
  "#b45f7d",
  "#8a6102"
];

const reservedDeviceKeys = new Set(["merged", "total"]);

export function getDevicesConfig(): DeviceConfig[] {
  const envVal = import.meta.env.TOKEN_DEVICES || "";
  const deviceLabels = envVal.trim()
    ? envVal.split(",").map((item) => item.trim()).filter(Boolean)
    : [];

  const usedKeys = new Set<string>();

  return deviceLabels.map((label, index) => {
    const key = label.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (!key) {
      throw new Error(`Invalid device name "${label}" in TOKEN_DEVICES.`);
    }

    if (reservedDeviceKeys.has(key)) {
      throw new Error(`"${label}" is reserved and cannot be used as a device name.`);
    }

    if (usedKeys.has(key)) {
      throw new Error(`Duplicate device key "${key}" generated from TOKEN_DEVICES.`);
    }
    usedKeys.add(key);

    const envUrlName = `TOKEN_URL_${key.toUpperCase()}`;
    let pathOrUrl = (import.meta.env as any)[envUrlName]?.trim();

    if (!pathOrUrl) {
      pathOrUrl = `data/token-${key}.json`;
    }

    return { key, label, pathOrUrl, color: devicePalette[index % devicePalette.length] };
  });
}

function decodeJsonBytes(bytes: Uint8Array): string {
  let encoding: string = "utf-8";

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
  } else if (bytes[0] === 0x7b && bytes[1] === 0x00) {
    encoding = "utf-16le";
  } else if (bytes[0] === 0x00 && bytes[1] === 0x7b) {
    encoding = "utf-16be";
  }

  return new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/u, "");
}

function parseRawUsage(text: string, label: string): RawUsage {
  try {
    return JSON.parse(text) as RawUsage;
  } catch (error) {
    const jsonStart = text.search(/[\[{]/u);
    if (jsonStart > 0) {
      try {
        return JSON.parse(text.slice(jsonStart)) as RawUsage;
      } catch {
        // Keep the original parser error below; it points at the actual payload issue.
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON for ${label}: ${message}`);
  }
}

async function loadJson(config: DeviceConfig): Promise<{ raw: RawUsage; source: DataSource }> {
  const url = config.pathOrUrl;

  if (url.startsWith("http://") || url.startsWith("https://")) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: responded with ${response.status}`);
    }

    return {
      raw: parseRawUsage(decodeJsonBytes(new Uint8Array(await response.arrayBuffer())), `${config.label} (${url})`),
      source: "remote"
    };
  }

  const buffer = await readFile(resolve(process.cwd(), url));

  return {
    raw: parseRawUsage(decodeJsonBytes(buffer), `${config.label} (${url})`),
    source: "local"
  };
}

async function loadJsonSafe(config: DeviceConfig): Promise<{ raw: RawUsage; source: DataSource }> {
  try {
    return await loadJson(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[token-board] Skipping ${config.label}: ${message}`);
    return {
      raw: { daily: [] },
      source: config.pathOrUrl.startsWith("http://") || config.pathOrUrl.startsWith("https://") ? "remote" : "local"
    };
  }
}

function normalizeModelBreakdown(raw: RawModelBreakdown): ModelSummary {
  return {
    modelName: raw.modelName || "unknown",
    cacheCreationTokens: asNumber(raw.cacheCreationTokens),
    cacheReadTokens: asNumber(raw.cacheReadTokens),
    inputTokens: asNumber(raw.inputTokens),
    outputTokens: asNumber(raw.outputTokens),
    totalCost: asNumber(raw.cost ?? raw.totalCost),
    totalTokens:
      asNumber(raw.totalTokens) ||
      asNumber(raw.cacheCreationTokens) +
        asNumber(raw.cacheReadTokens) +
        asNumber(raw.inputTokens) +
        asNumber(raw.outputTokens)
  };
}

function normalizeTotals(raw: RawWeek): TokenTotals {
  const cacheCreationTokens = asNumber(raw.cacheCreationTokens);
  const cacheReadTokens = asNumber(raw.cacheReadTokens);
  const inputTokens = asNumber(raw.inputTokens);
  const outputTokens = asNumber(raw.outputTokens);
  const modelBreakdowns = (raw.modelBreakdowns || []).map(normalizeModelBreakdown);

  return {
    cacheCreationTokens,
    cacheReadTokens,
    inputTokens,
    outputTokens,
    totalCost:
      asNumber(raw.totalCost ?? raw.cost) ||
      modelBreakdowns.reduce((sum, model) => sum + model.totalCost, 0),
    totalTokens:
      asNumber(raw.totalTokens) ||
      cacheCreationTokens + cacheReadTokens + inputTokens + outputTokens ||
      modelBreakdowns.reduce((sum, model) => sum + model.totalTokens, 0)
  };
}

function normalizeDay(raw: RawWeek, device: SeriesKey): UsageWeek {
  const period = raw.period || "1970-01-01";
  const totals = normalizeTotals(raw);

  return {
    ...totals,
    period,
    label: period,
    monthKey: getMonthKey(period),
    device,
    modelsUsed: [...new Set(raw.modelsUsed || [])].sort(),
    agentsUsed: [...new Set(raw.metadata?.agents || [])].sort(),
    modelBreakdowns: (raw.modelBreakdowns || []).map(normalizeModelBreakdown)
  };
}

function getStartOfWeek(dateStr: string): string {
  const date = parsePeriod(dateStr);
  const day = date.getUTCDay();
  const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date);
  monday.setUTCDate(diff);
  return toPeriod(monday);
}

function aggregateDaysToWeeks(days: UsageWeek[], device: SeriesKey): UsageWeek[] {
  const weeksMap = new Map<string, UsageWeek[]>();

  for (const day of days) {
    const weekPeriod = getStartOfWeek(day.period);
    const list = weeksMap.get(weekPeriod) || [];
    list.push(day);
    weeksMap.set(weekPeriod, list);
  }

  const weeks: UsageWeek[] = [];
  for (const [weekPeriod, dayList] of weeksMap.entries()) {
    weeks.push(mergeWeeks(weekPeriod, dayList, device));
  }

  return weeks.sort((a, b) => a.period.localeCompare(b.period));
}

function mergeDays(period: string, days: UsageWeek[], device: SeriesKey): UsageWeek {
  const totals = days.reduce((acc, day) => addTotals(acc, day), zeroTotals());

  return {
    ...totals,
    period,
    label: period,
    monthKey: getMonthKey(period),
    device,
    modelsUsed: [...new Set(days.flatMap((day) => day.modelsUsed))].sort(),
    agentsUsed: [...new Set(days.flatMap((day) => day.agentsUsed))].sort(),
    modelBreakdowns: mergeModelBreakdowns(days)
  };
}

function normalizeWeek(raw: RawWeek, device: SeriesKey): UsageWeek {
  const period = raw.period || "1970-01-01";
  const totals = normalizeTotals(raw);

  return {
    ...totals,
    period,
    label: formatPeriodLabel(period),
    monthKey: getMonthKey(period),
    device,
    modelsUsed: [...new Set(raw.modelsUsed || [])].sort(),
    agentsUsed: [...new Set(raw.metadata?.agents || [])].sort(),
    modelBreakdowns: (raw.modelBreakdowns || []).map(normalizeModelBreakdown)
  };
}

function emptyWeek(period: string, device: SeriesKey): UsageWeek {
  return {
    ...zeroTotals(),
    period,
    label: formatPeriodLabel(period),
    monthKey: getMonthKey(period),
    device,
    modelsUsed: [],
    agentsUsed: [],
    modelBreakdowns: []
  };
}

function mergeModelBreakdowns(weeks: UsageWeek[]): ModelSummary[] {
  const map = new Map<string, ModelSummary>();

  for (const week of weeks) {
    for (const model of week.modelBreakdowns) {
      const current = map.get(model.modelName) || {
        ...zeroTotals(),
        modelName: model.modelName,
        totalCost: 0
      };
      addTotals(current, model);
      map.set(model.modelName, current);
    }
  }

  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function mergeWeeks(period: string, weeks: UsageWeek[], device: SeriesKey): UsageWeek {
  const totals = weeks.reduce((acc, week) => addTotals(acc, week), zeroTotals());

  return {
    ...totals,
    period,
    label: formatPeriodLabel(period),
    monthKey: getMonthKey(period),
    device,
    modelsUsed: [...new Set(weeks.flatMap((week) => week.modelsUsed))].sort(),
    agentsUsed: [...new Set(weeks.flatMap((week) => week.agentsUsed))].sort(),
    modelBreakdowns: mergeModelBreakdowns(weeks)
  };
}

function buildWeekRange(weeks: UsageWeek[]): string[] {
  const activePeriods = weeks.map((week) => week.period).sort();

  if (!activePeriods.length) {
    return [];
  }

  const start = parsePeriod(activePeriods[0]);
  const end = parsePeriod(activePeriods[activePeriods.length - 1]);
  const range: string[] = [];

  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) {
    range.push(toPeriod(cursor));
  }

  return range;
}

function buildMonthly(weeks: UsageWeek[]): MonthlySummary[] {
  const map = new Map<string, MonthlySummary>();

  for (const week of weeks) {
    const current = map.get(week.monthKey) || {
      ...zeroTotals(),
      monthKey: week.monthKey,
      label: monthLabel(week.monthKey),
      activeWeeks: 0
    };
    addTotals(current, week);
    if (week.totalTokens > 0) {
      current.activeWeeks += 1;
    }
    map.set(week.monthKey, current);
  }

  return [...map.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
}

function topBy<T>(items: T[], getter: (item: T) => number, limit: number): T[] {
  return [...items].sort((a, b) => getter(b) - getter(a)).slice(0, limit);
}

function buildDeviceSummary(config: DeviceConfig, weeks: UsageWeek[], mergedTotalTokens: number): DeviceSummary {
  const { key, label, color } = config;
  const activeWeeks = weeks.filter((week) => week.totalTokens > 0);
  const totals = weeks.reduce((acc, week) => addTotals(acc, week), zeroTotals());
  const peakWeek = topBy(activeWeeks.length ? activeWeeks : weeks, (week) => week.totalTokens, 1)[0] || emptyWeek("1970-01-01", key);
  const latestWeek = [...activeWeeks].sort((a, b) => a.period.localeCompare(b.period)).at(-1) || peakWeek;

  return {
    key,
    label,
    color,
    totals,
    weeks,
    monthly: buildMonthly(weeks),
    activeWeeks: activeWeeks.length,
    share: mergedTotalTokens > 0 ? totals.totalTokens / mergedTotalTokens : 0,
    peakWeek,
    latestWeek,
    averageWeekTokens: activeWeeks.length ? totals.totalTokens / activeWeeks.length : 0
  };
}

function buildHeatmap(weeks: UsageWeek[], deviceWeeks: Record<string, Map<string, UsageWeek>>): HeatWeek[] {
  const nonZeroValues = weeks.map((week) => week.totalTokens).filter(Boolean).sort((a, b) => a - b);
  const quantile = (ratio: number) => nonZeroValues[Math.max(0, Math.ceil(nonZeroValues.length * ratio) - 1)] || 0;
  const q1 = quantile(0.25);
  const q2 = quantile(0.5);
  const q3 = quantile(0.75);

  const deviceKeys = Object.keys(deviceWeeks);

  return weeks.map((week) => {
    let level = 0;
    if (week.totalTokens > 0) {
      level = week.totalTokens <= q1 ? 1 : week.totalTokens <= q2 ? 2 : week.totalTokens <= q3 ? 3 : 4;
    }

    const deviceTokens: Record<string, number> = {};
    deviceKeys.forEach((key) => {
      deviceTokens[key] = deviceWeeks[key].get(week.period)?.totalTokens || 0;
    });

    return {
      period: week.period,
      label: week.label,
      monthKey: week.monthKey,
      totalTokens: week.totalTokens,
      totalCost: week.totalCost,
      deviceTokens,
      level
    };
  });
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

function interpolateColor(value: number): string {
  const stops = [
    { at: 0, color: "#ece7db" },
    { at: 0.22, color: "#faeaed" },
    { at: 0.55, color: "#f5c2cb" },
    { at: 1, color: "#c45468" }
  ];
  const clamped = Math.min(Math.max(value, 0), 1);
  const endIndex = stops.findIndex((stop) => stop.at >= clamped);
  const end = stops[Math.max(endIndex, 1)];
  const start = stops[Math.max(stops.indexOf(end) - 1, 0)];
  const local = start.at === end.at ? 0 : smoothStep((clamped - start.at) / (end.at - start.at));
  const startRgb = hexToRgb(start.color);
  const endRgb = hexToRgb(end.color);

  return rgbToHex([
    startRgb[0] + (endRgb[0] - startRgb[0]) * local,
    startRgb[1] + (endRgb[1] - startRgb[1]) * local,
    startRgb[2] + (endRgb[2] - startRgb[2]) * local
  ]);
}

function buildDailyHeatmap(
  weeks: UsageWeek[],
  deviceDailyMaps: Record<string, Map<string, UsageWeek>>
): HeatDay[] {
  let paddedWeeks = [...weeks];
  let needCount = 0;
  if (paddedWeeks.length > 0 && paddedWeeks.length < 53) {
    needCount = 53 - paddedWeeks.length;
    const firstWeekDate = parsePeriod(paddedWeeks[0].period);
    const prepended: UsageWeek[] = [];
    for (let i = 1; i <= needCount; i++) {
      const prevDate = addDays(firstWeekDate, -7 * i);
      const prevPeriod = toPeriod(prevDate);
      prepended.unshift(emptyWeek(prevPeriod, "merged"));
    }
    paddedWeeks = [...prepended, ...paddedWeeks];
  }

  const deviceKeys = Object.keys(deviceDailyMaps);

  let maxDailyTokens = 1;
  paddedWeeks.forEach((week) => {
    const startDate = parsePeriod(week.period);
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = toPeriod(addDays(startDate, dayIndex));
      let totalTokens = 0;
      deviceKeys.forEach((key) => {
        totalTokens += deviceDailyMaps[key].get(date)?.totalTokens ?? 0;
      });
      if (totalTokens > maxDailyTokens) {
        maxDailyTokens = totalTokens;
      }
    }
  });

  const days: HeatDay[] = [];

  paddedWeeks.forEach((week) => {
    const startDate = parsePeriod(week.period);
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = toPeriod(addDays(startDate, dayIndex));
      
      const deviceTokens: Record<string, number> = {};
      let totalTokens = 0;
      let totalCost = 0;

      deviceKeys.forEach((key) => {
        const deviceDay = deviceDailyMaps[key].get(date);
        const t = deviceDay?.totalTokens ?? 0;
        deviceTokens[key] = t;
        totalTokens += t;
        totalCost += deviceDay?.totalCost ?? 0;
      });

      const intensity = Math.sqrt(totalTokens / maxDailyTokens);

      days.push({
        date,
        label: date,
        weekLabel: week.label,
        monthKey: getMonthKey(date),
        totalTokens,
        totalCost,
        deviceTokens,
        intensity,
        color: interpolateColor(intensity)
      });
    }
  });

  return days;
}

type SvgPoint = {
  x: number;
  y: number;
};

function formatSvgNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function smoothPath(points: SvgPoint[]): string {
  if (points.length === 0) {
    return "";
  }

  if (points.length === 1) {
    return `M ${formatSvgNumber(points[0].x)},${formatSvgNumber(points[0].y)}`;
  }

  const segments = [`M ${formatSvgNumber(points[0].x)},${formatSvgNumber(points[0].y)}`];

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(index - 1, 0)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(index + 2, points.length - 1)];
    const cp1 = {
      x: p1.x + (p2.x - p0.x) / 6,
      y: p1.y + (p2.y - p0.y) / 6
    };
    const cp2 = {
      x: p2.x - (p3.x - p1.x) / 6,
      y: p2.y - (p3.y - p1.y) / 6
    };
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    cp1.y = clamp(cp1.y, minY, maxY);
    cp2.y = clamp(cp2.y, minY, maxY);

    segments.push(
      `C ${formatSvgNumber(cp1.x)},${formatSvgNumber(cp1.y)} ${formatSvgNumber(cp2.x)},${formatSvgNumber(cp2.y)} ${formatSvgNumber(p2.x)},${formatSvgNumber(p2.y)}`
    );
  }

  return segments.join(" ");
}

function smoothAreaPath(points: SvgPoint[], bottom: number): string {
  if (!points.length) {
    return "";
  }

  const linePath = smoothPath(points).replace(/^M [^C]+/, "");
  const first = points[0];
  const last = points[points.length - 1];

  return [
    `M ${formatSvgNumber(first.x)},${formatSvgNumber(bottom)}`,
    `L ${formatSvgNumber(first.x)},${formatSvgNumber(first.y)}`,
    linePath.trim(),
    `L ${formatSvgNumber(last.x)},${formatSvgNumber(bottom)}`,
    "Z"
  ]
    .filter(Boolean)
    .join(" ");
}

function buildChart(weeks: UsageWeek[], deviceWeeks: Record<string, Map<string, UsageWeek>>, devicesConfig: DeviceConfig[], granularity: "weekly" | "daily" | "monthly" = "weekly"): ChartLine {
  const width = 920;
  const height = 300;
  const padX = 44;
  const padTop = 24;
  const padBottom = 44;
  const chartWidth = width - padX * 2;
  const chartHeight = height - padTop - padBottom;
  const maxValue = Math.max(1, ...weeks.map((week) => week.totalTokens));

  const point = (index: number, value: number) => {
    const x = weeks.length <= 1 ? padX : padX + (index / (weeks.length - 1)) * chartWidth;
    const y = padTop + chartHeight - (value / maxValue) * chartHeight;
    return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
  };

  const pointsFor = (series: string) =>
    weeks.map((week, index) => {
      const value = series === "merged" ? week.totalTokens : deviceWeeks[series]?.get(week.period)?.totalTokens || 0;
      return point(index, value);
    });

  const mergedPointList = pointsFor("merged");
  const mergedArea = smoothAreaPath(mergedPointList, padTop + chartHeight);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: Number((padTop + chartHeight - ratio * chartHeight).toFixed(2)),
    label: formatCompact(maxValue * ratio)
  }));

  let xTicks: { x: number; label: string }[];

  if (granularity === "daily" && weeks.length > 1) {
    // Daily view: evenly spaced day ticks (target ~7 labels) using MM-DD,
    // so the X axis isn't left nearly empty by sparse month boundaries.
    const targetTicks = 7;
    const step = Math.max(1, Math.round((weeks.length - 1) / (targetTicks - 1)));
    const indexes: number[] = [];
    for (let i = 0; i < weeks.length; i += step) {
      indexes.push(i);
    }
    // Always include the last day so the axis spans the full range.
    if (indexes[indexes.length - 1] !== weeks.length - 1) {
      indexes.push(weeks.length - 1);
    }
    xTicks = indexes.map((index) => {
      const p = point(index, 0);
      return {
        x: p.x,
        label: weeks[index].period.slice(5) // "YYYY-MM-DD" -> "MM-DD"
      };
    });
  } else {
    const monthIndexes = weeks.reduce<{ monthKey: string; index: number }[]>((acc, week, index) => {
      if (!acc.some((item) => item.monthKey === week.monthKey)) {
        acc.push({ monthKey: week.monthKey, index });
      }
      return acc;
    }, []);

    xTicks = monthIndexes.map((item) => {
      const p = point(item.index, 0);
      return {
        x: p.x,
        label: monthLabel(item.monthKey)
      };
    });
  }

  const devicePaths = devicesConfig.map(({ key, color }) => {
    const pointList = pointsFor(key);
    return {
      deviceKey: key,
      color,
      path: smoothPath(pointList)
    };
  });

  return {
    width,
    height,
    mergedPath: smoothPath(mergedPointList),
    devicePaths,
    mergedArea,
    yTicks,
    xTicks
  };
}

function buildChartRanges(weeks: UsageWeek[], deviceWeeks: Record<string, Map<string, UsageWeek>>, devicesConfig: DeviceConfig[]): ChartRange[] {
  const ranges = [
    { key: "1m" as const, label: "1 Month", weeks: 5 },
    { key: "3m" as const, label: "3 Months", weeks: 13 },
    { key: "1y" as const, label: "1 Year", weeks: 52 }
  ];

  return ranges.map((range) => {
    const rangeWeeks = weeks.slice(Math.max(0, weeks.length - range.weeks));
    const activeWeeks = rangeWeeks.filter((week) => week.totalTokens > 0).length;

    return {
      ...buildChart(rangeWeeks, deviceWeeks, devicesConfig),
      key: range.key,
      label: range.label,
      caption: `Last ${range.label} · ${rangeWeeks.length} weekly entries · ${activeWeeks} active weeks`,
      weekCount: rangeWeeks.length
    };
  });
}

function buildAgents(weeks: UsageWeek[]): AgentSummary[] {
  const map = new Map<string, AgentSummary>();

  for (const week of weeks) {
    for (const agent of week.agentsUsed) {
      const current = map.get(agent) || {
        name: agent,
        activeWeeks: 0,
        tokenTouch: 0
      };
      current.activeWeeks += 1;
      current.tokenTouch += week.totalTokens;
      map.set(agent, current);
    }
  }

  return [...map.values()].sort((a, b) => b.activeWeeks - a.activeWeeks || b.tokenTouch - a.tokenTouch);
}

function buildStreaks(weeks: UsageWeek[]): { longestStreak: number; currentStreak: number } {
  let longestStreak = 0;
  let currentRun = 0;

  for (const week of weeks) {
    if (week.totalTokens > 0) {
      currentRun += 1;
      longestStreak = Math.max(longestStreak, currentRun);
    } else {
      currentRun = 0;
    }
  }

  let currentStreak = 0;
  for (const week of [...weeks].reverse()) {
    if (week.totalTokens <= 0) {
      break;
    }
    currentStreak += 1;
  }

  return { longestStreak, currentStreak };
}

function buildBiggestJump(weeks: UsageWeek[]): UsageWeek & { deltaTokens: number } {
  let best = { ...(weeks[0] || emptyWeek("1970-01-01", "merged")), deltaTokens: 0 };

  for (let index = 1; index < weeks.length; index += 1) {
    const deltaTokens = weeks[index].totalTokens - weeks[index - 1].totalTokens;
    if (deltaTokens > best.deltaTokens) {
      best = { ...weeks[index], deltaTokens };
    }
  }

  return best;
}

function buildDailyChartRanges(days: UsageWeek[], deviceDays: Record<string, Map<string, UsageWeek>>, devicesConfig: DeviceConfig[]): ChartRange[] {
  const ranges = [
    { key: "1m" as const, label: "1 Month", days: 30 },
    { key: "3m" as const, label: "3 Months", days: 90 },
    { key: "1y" as const, label: "1 Year", days: 365 }
  ];

  return ranges.map((range) => {
    const rangeDays = days.slice(Math.max(0, days.length - range.days));
    const activeDays = rangeDays.filter((day) => day.totalTokens > 0).length;

    return {
      ...buildChart(rangeDays, deviceDays, devicesConfig, "daily"),
      key: range.key,
      label: range.label,
      caption: `Last ${range.label} · ${rangeDays.length} daily entries · ${activeDays} active days`,
      weekCount: rangeDays.length
    };
  });
}

function buildMonthlyDataset(
  mergedWeeks: UsageWeek[],
  deviceWeeks: Record<string, Map<string, UsageWeek>>
): {
  mergedMonths: UsageWeek[];
  deviceMonths: Record<string, Map<string, UsageWeek>>;
} {
  const mergedMap = new Map<string, UsageWeek>();
  const deviceKeys = Object.keys(deviceWeeks);
  
  const deviceMaps: Record<string, Map<string, UsageWeek>> = {};
  deviceKeys.forEach((key) => {
    deviceMaps[key] = new Map<string, UsageWeek>();
  });

  for (const week of mergedWeeks) {
    const monthKey = week.monthKey;
    const currentMerged = mergedMap.get(monthKey) || {
      period: monthKey,
      monthKey,
      device: "merged",
      totalTokens: 0,
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelsUsed: [],
      agentsUsed: [],
      modelBreakdowns: []
    };

    currentMerged.totalTokens += week.totalTokens;
    currentMerged.totalCost += week.totalCost;
    currentMerged.inputTokens += week.inputTokens;
    currentMerged.outputTokens += week.outputTokens;
    currentMerged.cacheReadTokens += week.cacheReadTokens;
    currentMerged.cacheCreationTokens += week.cacheCreationTokens;
    
    currentMerged.modelsUsed = [...new Set([...currentMerged.modelsUsed, ...week.modelsUsed])];
    currentMerged.agentsUsed = [...new Set([...currentMerged.agentsUsed, ...week.agentsUsed])];
    
    for (const mb of week.modelBreakdowns) {
      const match = currentMerged.modelBreakdowns.find((item) => item.modelName === mb.modelName);
      if (match) {
        match.totalTokens = (match.totalTokens || 0) + (mb.totalTokens || 0);
        match.inputTokens += mb.inputTokens;
        match.outputTokens += mb.outputTokens;
        match.cost += mb.cost;
        match.cacheReadTokens += mb.cacheReadTokens;
        match.cacheCreationTokens += mb.cacheCreationTokens;
      } else {
        currentMerged.modelBreakdowns.push({ ...mb });
      }
    }

    mergedMap.set(monthKey, currentMerged);

    deviceKeys.forEach((key) => {
      const devWeek = deviceWeeks[key].get(week.period);
      if (devWeek) {
        const currentDev = deviceMaps[key].get(monthKey) || {
          period: monthKey,
          monthKey,
          device: key,
          totalTokens: 0,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          modelsUsed: [],
          agentsUsed: [],
          modelBreakdowns: []
        };
        currentDev.totalTokens += devWeek.totalTokens;
        currentDev.totalCost += devWeek.totalCost;
        currentDev.inputTokens += devWeek.inputTokens;
        currentDev.outputTokens += devWeek.outputTokens;
        currentDev.cacheReadTokens += devWeek.cacheReadTokens;
        currentDev.cacheCreationTokens += devWeek.cacheCreationTokens;
        deviceMaps[key].set(monthKey, currentDev);
      }
    });
  }

  const mergedMonths = [...mergedMap.values()].sort((a, b) => a.period.localeCompare(b.period));

  return {
    mergedMonths,
    deviceMonths: deviceMaps
  };
}

function buildMonthlyChartRanges(
  months: UsageWeek[],
  deviceMonths: Record<string, Map<string, UsageWeek>>,
  devicesConfig: DeviceConfig[]
): ChartRange[] {
  const ranges = [
    { key: "1y" as const, label: "1 Year", months: 12 },
    { key: "all" as const, label: "All Time", months: months.length }
  ];

  return ranges.map((range) => {
    const rangeMonths = months.slice(Math.max(0, months.length - range.months));
    const activeMonths = rangeMonths.filter((m) => m.totalTokens > 0).length;

    return {
      ...buildChart(rangeMonths, deviceMonths, devicesConfig),
      key: range.key,
      label: range.label,
      caption: `Last ${range.label} · ${rangeMonths.length} monthly entries · ${activeMonths} active months`,
      weekCount: rangeMonths.length
    };
  });
}

export async function buildTokenBoard(): Promise<TokenBoardData> {
  const devicesConfig = getDevicesConfig();
  const results = await Promise.all(devicesConfig.map((c) => loadJsonSafe(c)));

  const deviceRawDays: Record<string, UsageWeek[]> = {};
  const deviceDailyMaps: Record<string, Map<string, UsageWeek>> = {};
  const sources: string[] = [];

  devicesConfig.forEach((config, idx) => {
    const result = results[idx];
    sources.push(result.source);
    const normalizedDays = (result.raw.daily || []).map((day) => normalizeDay(day, config.key));
    deviceRawDays[config.key] = normalizedDays;
    deviceDailyMaps[config.key] = new Map(normalizedDays.map((day) => [day.period, day]));
  });

  const sourceMode = sources.every((source) => source === "remote") ? "remote" : sources.every((source) => source === "local") ? "local" : "mixed";

  const allDayPeriods = devicesConfig.flatMap((c) => deviceRawDays[c.key].map((d) => d.period));
  const dayPeriods = [...new Set(allDayPeriods)].sort();
  const mergedDays = dayPeriods.map((period) => {
    const list = devicesConfig.map((c) => deviceDailyMaps[c.key].get(period) || emptyWeek(period, c.key));
    return mergeDays(period, list, "merged");
  });

  const deviceWeeks: Record<string, UsageWeek[]> = {};
  devicesConfig.forEach((c) => {
    deviceWeeks[c.key] = aggregateDaysToWeeks(deviceRawDays[c.key], c.key);
  });

  const allRawWeeks = devicesConfig.flatMap((c) => deviceWeeks[c.key]);
  const periods = buildWeekRange(allRawWeeks);

  const deviceWeeksAligned: Record<string, UsageWeek[]> = {};
  const deviceWeeksMap: Record<string, Map<string, UsageWeek>> = {};
  devicesConfig.forEach((c) => {
    const rawMap = new Map(deviceWeeks[c.key].map((w) => [w.period, w]));
    const aligned = periods.map((p) => rawMap.get(p) || emptyWeek(p, c.key));
    deviceWeeksAligned[c.key] = aligned;
    deviceWeeksMap[c.key] = new Map(aligned.map((w) => [w.period, w]));
  });

  const mergedWeeks = periods.map((period) => {
    const list = devicesConfig.map((c) => deviceWeeksMap[c.key].get(period)!);
    return mergeWeeks(period, list, "merged");
  });

  const activeMergedWeeks = mergedWeeks.filter((week) => week.totalTokens > 0);
  const totals = mergedWeeks.reduce((acc, week) => addTotals(acc, week), zeroTotals());
  const monthly = buildMonthly(mergedWeeks);
  const topMonths = topBy(monthly, (month) => month.totalTokens, 6);
  const peakWeek = topBy(activeMergedWeeks, (week) => week.totalTokens, 1)[0] || emptyWeek("1970-01-01", "merged");
  const peakMonth = topMonths[0] || {
    ...zeroTotals(),
    monthKey: "1970-01",
    label: "1970-01",
    activeWeeks: 0
  };
  const latestWeek = [...activeMergedWeeks].sort((a, b) => a.period.localeCompare(b.period)).at(-1) || peakWeek;
  const latestIndex = mergedWeeks.findIndex((week) => week.period === latestWeek.period);
  const previousWeek = latestIndex > 0 ? mergedWeeks[latestIndex - 1] : emptyWeek(latestWeek.period, "merged");
  const streaks = buildStreaks(mergedWeeks);

  // Calculate Daily board view data
  const activeMergedDays = mergedDays.filter((day) => day.totalTokens > 0);
  const peakDay = topBy(activeMergedDays, (day) => day.totalTokens, 1)[0] || emptyWeek("1970-01-01", "merged");
  const latestDay = [...activeMergedDays].sort((a, b) => a.period.localeCompare(b.period)).at(-1) || peakDay;
  const latestDayIndex = mergedDays.findIndex((day) => day.period === latestDay.period);
  const previousDay = latestDayIndex > 0 ? mergedDays[latestDayIndex - 1] : emptyWeek(latestDay.period, "merged");
  const dailyStreaks = buildStreaks(mergedDays);

  // Calculate Monthly board view data
  const { mergedMonths, deviceMonths } = buildMonthlyDataset(mergedWeeks, deviceWeeksMap);
  const activeMergedMonths = mergedMonths.filter((m) => m.totalTokens > 0);
  const peakMonthWeek = topBy(activeMergedMonths, (m) => m.totalTokens, 1)[0] || emptyWeek("1970-01", "merged");
  const latestMonthWeek = [...activeMergedMonths].sort((a, b) => a.period.localeCompare(b.period)).at(-1) || peakMonthWeek;
  const latestMonthIndex = mergedMonths.findIndex((m) => m.period === latestMonthWeek.period);
  const previousMonthWeek = latestMonthIndex > 0 ? mergedMonths[latestMonthIndex - 1] : emptyWeek(latestMonthWeek.period, "merged");
  const monthlyStreaks = buildStreaks(mergedMonths);

  return {
    generatedAt: new Date().toISOString(),
    sourceMode,
    totals,
    mergedWeeks,
    monthly,
    devices: devicesConfig.map((config) =>
      buildDeviceSummary(config, deviceWeeksAligned[config.key], totals.totalTokens)
    ),
    heatmap: buildHeatmap(mergedWeeks, deviceWeeksMap),
    dailyHeatmap: buildDailyHeatmap(mergedWeeks, deviceDailyMaps),
    topMonths,
    topModels: topBy(mergeModelBreakdowns(mergedWeeks), (model) => model.totalTokens, 10),
    weekly: {
      chartRanges: buildChartRanges(mergedWeeks, deviceWeeksMap, devicesConfig),
      topWeeks: topBy(activeMergedWeeks, (week) => week.totalTokens, 8),
      topCostWeeks: topBy(activeMergedWeeks, (week) => week.totalCost, 6),
      topAgents: buildAgents(activeMergedWeeks),
      records: {
        peakWeek,
        latestWeek,
        previousWeek,
        biggestJump: buildBiggestJump(mergedWeeks),
        longestStreak: streaks.longestStreak,
        currentStreak: streaks.currentStreak,
        averageActiveWeekTokens: activeMergedWeeks.length ? totals.totalTokens / activeMergedWeeks.length : 0
      }
    },
    daily: {
      chartRanges: buildDailyChartRanges(mergedDays, deviceDailyMaps, devicesConfig),
      topWeeks: topBy(activeMergedDays, (day) => day.totalTokens, 8),
      topCostWeeks: topBy(activeMergedDays, (day) => day.totalCost, 6),
      topAgents: buildAgents(activeMergedDays),
      records: {
        peakWeek: peakDay,
        latestWeek: latestDay,
        previousWeek: previousDay,
        biggestJump: buildBiggestJump(mergedDays),
        longestStreak: dailyStreaks.longestStreak,
        currentStreak: dailyStreaks.currentStreak,
        averageActiveWeekTokens: activeMergedDays.length ? totals.totalTokens / activeMergedDays.length : 0
      }
    },
    monthlyView: {
      chartRanges: buildMonthlyChartRanges(mergedMonths, deviceMonths, devicesConfig),
      topWeeks: topBy(activeMergedMonths, (m) => m.totalTokens, 8),
      topCostWeeks: topBy(activeMergedMonths, (m) => m.totalCost, 6),
      topAgents: buildAgents(activeMergedMonths),
      records: {
        peakWeek: peakMonthWeek,
        latestWeek: latestMonthWeek,
        previousWeek: previousMonthWeek,
        biggestJump: buildBiggestJump(mergedMonths),
        longestStreak: streaks.longestStreak,
        currentStreak: streaks.currentStreak,
        averageActiveWeekTokens: activeMergedMonths.length ? totals.totalTokens / activeMergedMonths.length : 0
      }
    },
    records: {
      peakMonth,
      cacheShare: totals.totalTokens > 0 ? (totals.cacheReadTokens + totals.cacheCreationTokens) / totals.totalTokens : 0,
      outputShare: totals.totalTokens > 0 ? totals.outputTokens / totals.totalTokens : 0
    }
  };
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1000000000 ? 2 : 1
  }).format(value);
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2
  }).format(value);
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1
  }).format(value);
}

export function formatSignedCompact(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatCompact(value)}`;
}
