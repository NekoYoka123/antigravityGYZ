/**
 * Redis 工具函数
 * 封装常用的 Redis 操作模式，提高 Redis 使用效率
 */

import { redis } from './redis';

/**
 * 带过期时间的 Redis 设置
 * @param key Redis 键名
 * @param value 值（会自动转换为字符串）
 * @param expiry 过期时间（秒）
 */
export async function setWithExpiry(
    key: string, 
    value: any, 
    expiry: number
): Promise<void> {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    await redis.set(key, stringValue, 'EX', expiry);
}

/**
 * 批量获取 Redis 键值
 * @param keys 键名数组
 * @returns 值数组，与输入键名顺序对应，不存在的键返回 null
 */
export async function batchGet(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) {
        return [];
    }
    return redis.mget(keys);
}

/**
 * 批量设置 Redis 键值
 * @param keyValuePairs 键值对数组，格式为 [key, value, expiry?]
 */
export async function batchSet(
    keyValuePairs: Array<[string, any, number?]>
): Promise<void> {
    if (keyValuePairs.length === 0) {
        return;
    }
    
    const pipeline = redis.pipeline();
    
    for (const [key, value, expiry] of keyValuePairs) {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        if (expiry) {
            pipeline.set(key, stringValue, 'EX', expiry);
        } else {
            pipeline.set(key, stringValue);
        }
    }
    
    await pipeline.exec();
}

/**
 * 使用流水线执行多个 Redis 命令
 * @param operations 操作函数，接收 pipeline 对象，返回 void
 * @returns 命令执行结果数组
 */
export async function withPipeline<T = any>(
    operations: (pipeline: any) => void
): Promise<T[]> {
    const pipeline = redis.pipeline();
    operations(pipeline);
    const results = await pipeline.exec();
    
    // 处理结果，只返回实际值，忽略错误（如果有错误会在调用处抛出）
    if (!results) {
        return [];
    }
    
    return results.map(result => {
        if (result[0]) {
            throw result[0];
        }
        return result[1] as T;
    });
}

/**
 * 批量添加元素到 Redis 列表
 * @param key 列表键名
 * @param values 要添加的值数组
 */
export async function batchRpush(key: string, values: any[]): Promise<void> {
    if (values.length === 0) {
        return;
    }
    
    const stringValues = values.map(v => typeof v === 'string' ? v : JSON.stringify(v));
    await redis.rpush(key, ...stringValues);
}

/**
 * 批量删除 Redis 键
 * @param keys 要删除的键名数组
 */
export async function batchDel(keys: string[]): Promise<void> {
    if (keys.length === 0) {
        return;
    }
    await redis.del(...keys);
}

/**
 * 获取并递增计数器
 * @param key 计数器键名
 * @param increment 递增步长，默认 1
 * @param expiry 可选的过期时间（秒），如果键不存在则设置
 * @returns 递增后的值
 */
export async function incrWithExpiry(
    key: string, 
    increment: number = 1, 
    expiry?: number
): Promise<number> {
    const result = await redis.incrby(key, increment);
    
    if (result === increment && expiry) {
        // 如果是新创建的键，设置过期时间
        await redis.expire(key, expiry);
    }
    
    return result;
}
