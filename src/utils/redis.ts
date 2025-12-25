/**
 * 共享 Redis 连接池
 * 所有服务应使用此模块导出的 redis 实例，避免创建多个连接
 */

import Redis from 'ioredis';

// 单例 Redis 连接
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(redisUrl, {
    // 连接池配置
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    // 启用 lazyConnect 以避免启动时立即连接
    lazyConnect: false,
    // 连接超时
    connectTimeout: 10000,
    // 命令超时
    commandTimeout: 5000,
});

// 连接事件日志
redis.on('connect', () => {
    console.log('[Redis] Connected to', redisUrl.replace(/\/\/.*@/, '//<credentials>@'));
});

redis.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
});

redis.on('reconnecting', () => {
    console.log('[Redis] Reconnecting...');
});

// 导出类型以便其他模块使用
export type RedisClient = typeof redis;
