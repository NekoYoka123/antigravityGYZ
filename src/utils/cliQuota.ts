import { redis } from './redis';

export type CliQuotaGroup = 'flash' | 'pro' | 'v3' | 'other';

export type CliQuotaLimits = {
  flash: number;
  pro: number;
  v3: number;
  total: number;
};

type QuotaValue = {
  base: { flash: number; pro: number; v3: number };
  increment: { flash: number; pro: number; v3: number };
};

function getQuotaValue(levelConfig: any, defaultValue: number): QuotaValue {
  if (typeof levelConfig === 'number') {
    return {
      base: {
        flash: levelConfig,
        pro: Math.floor(levelConfig / 4),
        v3: Math.floor(levelConfig / 4)
      },
      increment: { flash: 0, pro: 0, v3: 0 }
    };
  }
  if (levelConfig && typeof levelConfig === 'object' && levelConfig.base) {
    return {
      base: {
        flash: levelConfig.base?.flash ?? defaultValue,
        pro: levelConfig.base?.pro ?? Math.floor(defaultValue / 4),
        v3: levelConfig.base?.v3 ?? Math.floor(defaultValue / 4)
      },
      increment: {
        flash: levelConfig.increment?.flash ?? 0,
        pro: levelConfig.increment?.pro ?? 0,
        v3: levelConfig.increment?.v3 ?? 0
      }
    };
  }
  return {
    base: {
      flash: defaultValue,
      pro: Math.floor(defaultValue / 4),
      v3: Math.floor(defaultValue / 4)
    },
    increment: { flash: 0, pro: 0, v3: 0 }
  };
}

export function calculateCliQuotaLimits(conf: any, activeCredCount: number, activeV3CredCount: number): CliQuotaLimits {
  const quotaConf = conf?.quota || {};
  let levelQuota: QuotaValue;

  if (activeV3CredCount > 0) levelQuota = getQuotaValue(quotaConf.v3_contributor, 3000);
  else if (activeCredCount > 0) levelQuota = getQuotaValue(quotaConf.contributor, 1500);
  else levelQuota = getQuotaValue(quotaConf.newbie, 300);

  const additionalCreds = Math.max(0, activeCredCount - 1);
  const flash = levelQuota.base.flash + additionalCreds * levelQuota.increment.flash;
  const pro = levelQuota.base.pro + additionalCreds * levelQuota.increment.pro;
  const v3 = levelQuota.base.v3 + additionalCreds * levelQuota.increment.v3;
  const legacyInc = quotaConf.increment_per_credential ?? 0;
  const legacyExtra = additionalCreds * legacyInc;

  return { flash, pro, v3, total: flash + pro + v3 + legacyExtra };
}

export function normalizeCliModelName(modelName: string): string {
  const name = String(modelName || '').toLowerCase();
  if (name === 'gemini-3-pro-high' || name === 'gemini-3-pro-low') return 'gemini-3-pro-preview';
  if (name.startsWith('gemini-3-flash-') && !name.includes('preview')) return 'gemini-3-flash-preview';
  if (name === 'gemini-3-pro-image-preview') return 'gemini-3-pro-image';
  return name;
}

export function resolveCliUsageGroup(modelName: string): { group: CliQuotaGroup; statsKey: string } {
  const name = normalizeCliModelName(modelName);
  if (name.includes('gemini-2.5-flash')) return { group: 'flash', statsKey: 'gemini-2.5-flash' };
  if (name.includes('gemini-2.5-pro')) return { group: 'pro', statsKey: 'gemini-2.5-pro' };
  if (name.includes('gemini-3-flash')) return { group: 'v3', statsKey: 'gemini-3-flash-preview' };
  if (name.includes('gemini-3-pro')) return { group: 'v3', statsKey: 'gemini-3-pro-preview' };
  if (name.includes('gemini-3') || name.includes('gemini-exp')) return { group: 'v3', statsKey: 'gemini-3-pro-preview' };
  return { group: 'other', statsKey: 'other' };
}

export function getCliUsageKeysForGroup(group: CliQuotaGroup): string[] {
  if (group === 'flash') return ['gemini-2.5-flash'];
  if (group === 'pro') return ['gemini-2.5-pro'];
  if (group === 'v3') return ['gemini-3-pro-preview', 'gemini-3-flash-preview'];
  return [];
}

export function getTodayStrUTC8(): string {
  const now = new Date();
  const utc8Offset = 8 * 60 * 60 * 1000;
  return new Date(now.getTime() + utc8Offset).toISOString().split('T')[0];
}

export async function getCliUsageCount(userId: number, group: CliQuotaGroup): Promise<number> {
  const keys = getCliUsageKeysForGroup(group);
  if (keys.length === 0) return 0;
  const todayStr = getTodayStrUTC8();
  const statsKey = `USER_STATS:${userId}:${todayStr}`;
  const values = await redis.hmget(statsKey, ...keys);
  return values.reduce((sum, value) => sum + parseInt(value || '0', 10), 0);
}
