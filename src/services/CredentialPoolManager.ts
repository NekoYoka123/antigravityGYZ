/**
 * 凭证池管理器
 * 负责管理 Google 凭证池，包括同步到 Redis、获取凭证、刷新令牌等功能
 */
import { PrismaClient, CredentialStatus } from '@prisma/client';
import { request } from 'undici';
import { redis } from '../utils/redis';

const prisma = new PrismaClient();

// Redis 键名常量
const POOL_KEY = 'GLOBAL_CREDENTIAL_POOL'; // 全局凭证池
const POOL_KEY_V3 = 'GLOBAL_CREDENTIAL_POOL_V3'; // V3 模型专用凭证池
const COOLING_SET_PREFIX = 'COOLING:'; // 冷却中凭证前缀

/**
 * 凭证池管理器类
 * 负责管理 Google 凭证的生命周期和使用
 */
export class CredentialPoolManager {
  /**
   * 构造函数
   * 初始化时将数据库中的活跃凭证同步到 Redis
   */
  constructor() {
    this.syncToRedis().catch(console.error);
  }

  /**
   * 将数据库中的活跃凭证同步到 Redis 列表
   * 清理现有列表并重新填充
   */
  async syncToRedis() {
    console.log('[PoolManager] 正在将凭证同步到 Redis...');
    
    // 清空现有凭证池
    await redis.del(POOL_KEY);
    await redis.del(POOL_KEY_V3);

    // 从数据库获取所有活跃凭证
    const activeCreds = await prisma.googleCredential.findMany({
      where: { status: CredentialStatus.ACTIVE },
      select: { id: true, supports_v3: true }
    });

    if (activeCreds.length === 0) {
      console.warn('[PoolManager] 未找到活跃凭证。');
      return;
    }

    // 分组凭证：所有活跃凭证和支持 V3 的凭证
    const allIds = activeCreds.map(c => c.id);
    const v3Ids = activeCreds.filter(c => c.supports_v3).map(c => c.id);

    // 将凭证 ID 推送到 Redis 列表
    await redis.rpush(POOL_KEY, ...allIds.map(String));
    if (v3Ids.length > 0) {
        await redis.rpush(POOL_KEY_V3, ...v3Ids.map(String));
    }
    
    console.log(`[PoolManager] 已同步 ${allIds.length} 个凭证到 GLOBAL 池，${v3Ids.length} 个到 V3 池`);
  }

  /**
   * 立即将新凭证添加到池中
   * @param credentialId 凭证 ID
   * @param supportsV3 是否支持 V3 模型
   */
  async addCredential(credentialId: number, supportsV3: boolean = false) {
    await redis.lpush(POOL_KEY, String(credentialId));
    if (supportsV3) {
        await redis.lpush(POOL_KEY_V3, String(credentialId));
    }
    console.log(`[PoolManager] 已将凭证 ${credentialId} 添加到池 (V3: ${supportsV3})。`);
  }

  /**
   * 通过轮询方式获取有效的凭证
   * 遍历列表查找可用的凭证
   * @param type 凭证池类型 (GLOBAL 或 V3)
   * @param userId 用户 ID (可选，用于加锁)
   * @param ttlMs 锁的过期时间 (毫秒)
   * @returns 凭证信息对象，包含凭证 ID、访问令牌和项目 ID
   */
  async getRoundRobinCredential(type: 'GLOBAL' | 'V3' = 'GLOBAL', userId?: number, ttlMs: number = 30000): Promise<{ credentialId: number; accessToken: string; projectId: string } | null> {
    const targetPool = type === 'V3' ? POOL_KEY_V3 : POOL_KEY;

    // 1. 获取池大小以确定最大尝试次数（防止无限循环）
    const poolSize = await redis.llen(targetPool);
    
    if (poolSize === 0) {
        // 池为空时尝试同步（如果 Redis 被清空可能需要重新同步）
        await this.syncToRedis();
        if (await redis.llen(targetPool) === 0) {
            console.warn(`[PoolManager] ${type} 池在同步后仍为空。`);
            return null;
        }
    }

    // 最大尝试次数：当前池大小 + 2 个缓冲
    const maxAttempts = (await redis.llen(targetPool)) + 2; 

    for (let i = 0; i < maxAttempts; i++) {
        // 轮询：将最后一个元素移到最前面
        const credentialIdStr = await redis.rpoplpush(targetPool, targetPool);
        
        if (!credentialIdStr) {
             await this.syncToRedis();
             continue;
        }

        const credentialId = parseInt(credentialIdStr, 10);

        // 跳过被其他用户持有锁的凭证
        if (userId) {
            const lockKey = `CRED_LOCK:CLI:${credentialId}`;
            const holder = await redis.get(lockKey);
            if (holder && parseInt(holder, 10) !== userId) continue;
        }

        // 加载并验证凭证
        try {
            const cred = await this.loadAndRefreshToken(credentialId);
            if (cred) {
                // 加锁
                if (userId) {
                    const ok = await this.acquireLock(credentialId, userId, ttlMs);
                    if (!ok) continue;
                }
                return cred;
            }
        } catch (error: any) {
             console.warn(`[PoolManager] 加载凭证 ${credentialId} 时发生意外错误: ${error.message}`);
        }
    }

    console.error(`[PoolManager] ${type} 池中的所有凭证都已尝试但未成功。`);
    return null;
  }

  /**
   * 加载凭证，检查过期时间，必要时刷新（5 分钟缓冲）
   * 镜像 CredentialManager._load_current_credential 和 _should_refresh_token 逻辑
   * @param credentialId 凭证 ID
   * @returns 刷新后的凭证信息，或 null（如果凭证无效）
   */
  private async loadAndRefreshToken(credentialId: number): Promise<{ credentialId: number; accessToken: string; projectId: string } | null> {
    const cred = await prisma.googleCredential.findUnique({
      where: { id: credentialId },
      select: { 
        id: true,
        client_id: true,
        client_secret: true,
        refresh_token: true,
        project_id: true,
        access_token: true,
        expires_at: true,
        status: true
      }
    });

    if (!cred) return null;
    if (cred.status !== CredentialStatus.ACTIVE) return null; // 应该已经被过滤，但再次检查

    // 检查过期时间（5 分钟缓冲）
    const now = Date.now();
    const expiry = cred.expires_at ? cred.expires_at.getTime() : 0;
    const isExpired = !cred.access_token || (expiry - now < 300 * 1000); // < 300s (5 分钟)

    if (isExpired) {
        console.log(`[PoolManager] 凭证 ${credentialId} 的令牌已过期或丢失，正在刷新...`);
        try {
            const { accessToken, expiresIn } = await this.refreshGoogleToken(
                cred.refresh_token.trim(),
                cred.client_id.trim(),
                cred.client_secret.trim()
            );

            // 更新数据库
            const newExpiry = new Date(Date.now() + (expiresIn * 1000));
            await prisma.googleCredential.update({
                where: { id: credentialId },
                data: {
                    access_token: accessToken,
                    expires_at: newExpiry,
                    last_validated_at: new Date()
                }
            });

            return { 
                credentialId: cred.id, 
                accessToken, 
                projectId: cred.project_id.trim() 
            };
        } catch (e: any) {
            console.error(`[PoolManager] 刷新凭证 ${credentialId} 失败: ${e.message}`);
            
            // 检查是否为永久错误
            const isPermanent = this.isPermanentError(e.message, (e as any).statusCode);
            if (isPermanent) {
                await this.markAsDead(credentialId);
            }
            return null;
        }
    }

    // 凭证有效，直接返回
    return { 
        credentialId: cred.id, 
        accessToken: cred.access_token!, 
        projectId: cred.project_id.trim() 
    };
  }

  /**
   * 刷新 Google 访问令牌
   * @param refreshToken 刷新令牌
   * @param clientId 客户端 ID
   * @param clientSecret 客户端密钥
   * @returns 新的访问令牌和过期时间
   */
  private async refreshGoogleToken(refreshToken: string, clientId: string, clientSecret: string): Promise<{ accessToken: string, expiresIn: number }> {
    const oauthUrl = process.env.GOOGLE_OAUTH_URL || 'https://oauth2.googleapis.com/token';
    
    const { statusCode, body } = await request(oauthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });

    if (statusCode !== 200) {
      const errorText = await body.text();
      const error = new Error(`令牌刷新失败: ${errorText}`);
      (error as any).statusCode = statusCode;
      throw error;
    }

    const data = await body.json() as any;
    return { 
        accessToken: data.access_token, 
        expiresIn: data.expires_in // 秒
    };
  }

  /**
   * 检查是否为永久错误（匹配 gcli2api 逻辑）
   * @param errMsg 错误信息
   * @param statusCode HTTP 状态码
   * @returns 是否为永久错误
   */
  private isPermanentError(errMsg: string, statusCode?: number): boolean {
    return statusCode === 403;
  }

  /**
   * 将凭证标记为冷却状态
   * 当凭证遇到 429 错误时调用
   * @param credentialId 凭证 ID
   * @param resetTimestamp 重置时间戳（可选）
   */
  async markAsCooling(credentialId: number, resetTimestamp?: number) {
    console.warn(`[PoolManager] 凭证 ${credentialId} 遇到 429 错误，正在移至冷却状态。`);
    
    let resetTime: Date;

    if (resetTimestamp) {
        resetTime = new Date(resetTimestamp);
        console.log(`[PoolManager] 使用上游配额重置时间: ${resetTime.toISOString()}`);
    } else {
        // 回退：UTC+7 次日逻辑
        const now = new Date();
        const utc7Now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
        const utc7NextMidnight = new Date(utc7Now);
        utc7NextMidnight.setUTCHours(0, 0, 0, 0);
        utc7NextMidnight.setDate(utc7NextMidnight.getDate() + 1);
        resetTime = new Date(utc7NextMidnight.getTime() - 7 * 60 * 60 * 1000);
    }

    // 更新数据库中的凭证状态
    await prisma.googleCredential.update({
      where: { id: credentialId },
      data: {
        status: CredentialStatus.COOLING,
        cooling_expires_at: resetTime
      }
    });

    // 从 Redis 池中移除凭证
    await redis.lrem(POOL_KEY, 0, String(credentialId));
    await redis.lrem(POOL_KEY_V3, 0, String(credentialId));
  }

  /**
   * 获取凭证锁
   * @param credentialId 凭证 ID
   * @param userId 用户 ID
   * @param ttlMs 锁的过期时间（毫秒）
   * @returns 是否成功获取锁
   */
  async acquireLock(credentialId: number, userId: number, ttlMs: number = 30000): Promise<boolean> {
    const key = `CRED_LOCK:CLI:${credentialId}`;
    const holder = await redis.get(key);
    // 如果锁已被其他用户持有，返回失败
    if (holder && parseInt(holder, 10) !== userId) return false;
    
    // 尝试获取锁，设置过期时间
    const ok = await redis.set(key, String(userId), 'PX', ttlMs, 'NX');
    
    // 如果锁已存在且持有者是当前用户，刷新过期时间
    if (ok === null && holder === String(userId)) {
      await redis.pexpire(key, ttlMs);
      return true;
    }
    
    return ok !== null;
  }

  /**
   * 释放凭证锁
   * @param credentialId 凭证 ID
   * @param userId 用户 ID
   */
  async releaseLock(credentialId: number, userId: number): Promise<void> {
    const key = `CRED_LOCK:CLI:${credentialId}`;
    const holder = await redis.get(key);
    // 只有锁的持有者才能释放锁
    if (holder && parseInt(holder, 10) === userId) {
      await redis.del(key);
    }
  }

  /**
   * 将凭证标记为死亡状态（自动禁用）
   * 当凭证遇到永久错误时调用
   * @param credentialId 凭证 ID
   */
  async markAsDead(credentialId: number) {
    console.warn(`[PoolManager] 将凭证 ${credentialId} 标记为死亡状态 (自动禁用)。`);
    await prisma.googleCredential.update({
      where: { id: credentialId },
      data: { 
        status: CredentialStatus.DEAD,
        is_active: false
      }
    });
    // 从 Redis 池中移除凭证
    await redis.lrem(POOL_KEY, 0, String(credentialId));
    await redis.lrem(POOL_KEY_V3, 0, String(credentialId));
  }
}
