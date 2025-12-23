import { AntigravityService } from './AntigravityService';
import { AntigravityTokenData } from '../utils/antigravityUtils';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';

type PerModelQuota = {
  model_id: string;
  remaining: number | null;
  reset_time: string | null;
  window_seconds?: number | null;
};

type TokenQuotaSummary = {
  token_id: number;
  remaining: number | null;
  window_hours: number | null;
  classification: 'Normal' | 'Pro' | null;
  per_model: PerModelQuota[];
  fetched_at: number;
};

class AntigravityQuotaCache {
  private cache = new Map<number, TokenQuotaSummary>();
  private ttlMs = 15 * 60 * 1000;
  private redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  private prisma = new PrismaClient();
  private rateKey = 'AG_QCACHE_RATE';
  private fetchLockPrefix = 'AG_QCACHE_FETCH:';
  private cacheKeyPrefix = 'AG_QCACHE:';

  private async getRateLimitPerMinute(): Promise<number> {
    try {
      const setting = await this.prisma.systemSetting.findUnique({ where: { key: 'QUOTA_FETCH_RATE_PER_MINUTE' } });
      const v = setting ? parseInt(setting.value || '0', 10) : 0;
      return v > 0 ? v : 120;
    } catch {
      return 120;
    }
  }
  private async withinRate(): Promise<boolean> {
    try {
      const limit = await this.getRateLimitPerMinute();
      const n = await this.redis.incr(this.rateKey);
      if (n === 1) {
        await this.redis.expire(this.rateKey, 60);
      }
      return n <= limit;
    } catch {
      return true;
    }
  }
  private async acquireFetchLock(tokenId: number, ttlMs: number): Promise<boolean> {
    try {
      const ok = await this.redis.set(this.fetchLockPrefix + String(tokenId), '1', 'PX', ttlMs, 'NX');
      return ok !== null;
    } catch {
      return false;
    }
  }
  private async releaseFetchLock(tokenId: number): Promise<void> {
    try { await this.redis.del(this.fetchLockPrefix + String(tokenId)); } catch { }
  }
  private async readRedisCache(tokenId: number): Promise<TokenQuotaSummary | null> {
    try {
      const raw = await this.redis.get(this.cacheKeyPrefix + String(tokenId));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj as TokenQuotaSummary;
    } catch {
      return null;
    }
  }
  private async writeRedisCache(summary: TokenQuotaSummary): Promise<void> {
    try {
      await this.redis.set(this.cacheKeyPrefix + String(summary.token_id), JSON.stringify(summary), 'PX', this.ttlMs);
    } catch { }
  }
  async refreshToken(token: AntigravityTokenData): Promise<TokenQuotaSummary | null> {
    const locked = await this.acquireFetchLock(token.id, 15000); // Reduced lock time for faster concurrent refresh
    if (!locked) {
      const existing = await this.readRedisCache(token.id);
      if (existing) {
        this.cache.set(token.id, existing);
        return existing;
      }
      return null;
    }
    const ok = await this.withinRate();
    if (!ok) {
      await this.releaseFetchLock(token.id);
      const existing = await this.readRedisCache(token.id);
      if (existing) {
        this.cache.set(token.id, existing);
        return existing;
      }
      return null;
    }
    const data = await AntigravityService.getModelsWithQuotas(token);
    const now = Date.now();
    const per: PerModelQuota[] = Object.entries(data || {}).map(([model_id, q]: [string, any]) => ({
      model_id,
      remaining: typeof q?.remaining === 'number' ? q.remaining : (typeof q?.remainingFraction === 'number' ? q.remainingFraction : null),
      reset_time: q?.resetTime || null,
      window_seconds: typeof q?.windowSeconds === 'number' ? q.windowSeconds : null
    }));
    const vals = per.map(p => p.remaining).filter((v): v is number => typeof v === 'number');
    const remaining = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const hoursFromReset = per
      .map(p => p.reset_time ? Math.max(0, (new Date(p.reset_time).getTime() - now) / 3600000) : null)
      .filter((v): v is number => typeof v === 'number');
    // 如果没有 reset_time，则尝试读取窗口秒数（从原始数据）
    let hoursList = hoursFromReset;
    if (hoursList.length === 0) {
      const secondsList = Object.values(data || {}).map((q: any) => typeof q?.windowSeconds === 'number' ? q.windowSeconds : null)
        .filter((v): v is number => typeof v === 'number');
      hoursList = secondsList.map(s => s / 3600);
    }
    let medianHours: number | null = null;
    if (hoursList.length > 0) {
      const sorted = [...hoursList].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianHours = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Classification Logic with Persistence to prevent drift
    let classification: 'Normal' | 'Pro' | null = null;

    // 1. Get persistent classification from Redis FIRST
    const classKey = `AG_CLASS:${token.id}`;
    const persistentClass = await this.redis.get(classKey) as 'Normal' | 'Pro' | null;

    // 2. Try to use explicit windowSeconds (Cycle Duration) - most reliable source
    let cycleHours: number | null = null;
    const windowSecondsList = Object.values(data || {}).map((q: any) => typeof q?.windowSeconds === 'number' ? q.windowSeconds : null)
      .filter((v): v is number => typeof v === 'number');

    if (windowSecondsList.length > 0) {
      const sorted = [...windowSecondsList].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const medianSeconds = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      cycleHours = medianSeconds / 3600;
    }

    // 3. Determine classification based on available data
    if (cycleHours !== null) {
      // Strategy A: Use explicit window duration (most reliable)
      // User Requirement:
      //   - cycleHours <= 5h => Pro
      //   - 5h < cycleHours <= 168h (1 week) => Normal
      //   - cycleHours > 168h => Abnormal, default to Pro for safety
      let newClass: 'Normal' | 'Pro';
      if (cycleHours <= 5) {
        newClass = 'Pro';
      } else if (cycleHours <= 168) {
        newClass = 'Normal';
      } else {
        newClass = 'Pro';
      }

      // CRITICAL: Only update classification if:
      // a) No previous classification exists (new token), OR
      // b) Window duration is in a "confident" range (clearly Pro or clearly Normal)
      const clearlyPro = cycleHours <= 4; // Clearly a 5h cycle (with some buffer)
      const clearlyNormal = cycleHours >= 24; // Clearly a 7-day cycle (at least 1 day)

      if (!persistentClass) {
        // New token - save classification
        classification = newClass;
        await this.redis.set(classKey, classification, 'EX', 7 * 86400);
      } else if (clearlyPro || clearlyNormal) {
        // Only update if we're confident about the classification
        if (newClass !== persistentClass) {
          console.log(`[QuotaCache] Token ${token.id} classification changing from ${persistentClass} to ${newClass} (cycleHours=${cycleHours.toFixed(1)})`);
        }
        classification = newClass;
        await this.redis.set(classKey, classification, 'EX', 7 * 86400);
      } else {
        // Ambiguous zone (4h < cycleHours < 24h) - keep persistent classification
        classification = persistentClass;
      }
    } else {
      // Strategy B: No explicit window data - use persistence or heuristic
      if (persistentClass) {
        // ALWAYS prefer persistent classification when no window data
        classification = persistentClass;
      } else if (medianHours !== null) {
        // First time seeing this token, use remaining time as heuristic
        // Be conservative: only classify as Normal if clearly long cycle
        if (medianHours >= 24) {
          classification = 'Normal';
          await this.redis.set(classKey, 'Normal', 'EX', 7 * 86400);
        } else {
          // Default to Pro for short/ambiguous remaining time
          classification = 'Pro';
          await this.redis.set(classKey, 'Pro', 'EX', 7 * 86400);
        }
      } else {
        // Last resort: local Memory cache
        const previousLocal = this.cache.get(token.id);
        classification = previousLocal?.classification || null;
      }
    }
    const summary: TokenQuotaSummary = {
      token_id: token.id,
      remaining,
      window_hours: medianHours,
      classification,
      per_model: per,
      fetched_at: now
    };
    this.cache.set(token.id, summary);
    await this.writeRedisCache(summary);
    await this.releaseFetchLock(token.id);
    return summary;
  }
  get(tokenId: number): TokenQuotaSummary | null {
    const s = this.cache.get(tokenId) || null;
    if (s) {
      if (Date.now() - s.fetched_at > this.ttlMs) {
        this.cache.delete(tokenId);
      } else {
        return s;
      }
    }
    return null;
  }
  setTTL(minutes: number) {
    this.ttlMs = Math.max(1, minutes) * 60 * 1000;
  }
  clear() {
    this.cache.clear();
  }
  async getFromRedis(tokenId: number): Promise<TokenQuotaSummary | null> {
    const obj = await this.readRedisCache(tokenId);
    if (obj) {
      this.cache.set(tokenId, obj);
      return obj;
    }
    return null;
  }
}

export const antigravityQuotaCache = new AntigravityQuotaCache();
