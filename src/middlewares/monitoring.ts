/**
 * 监控中间件
 * 增强系统监控，记录请求成功率、响应时间等指标
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../utils/redis';

// 扩展 IncomingMessage 类型，添加 startTime 属性
declare module 'http' {
  interface IncomingMessage {
    startTime?: number;
  }
}

// 监控指标类型
interface MonitoringMetrics {
    responseTime: number;
    statusCode: number;
    path: string;
    method: string;
    isAntiGravity: boolean;
}

/**
 * 记录监控指标
 * @param metrics 监控指标数据
 */
async function recordMetrics(metrics: MonitoringMetrics): Promise<void> {
    const { responseTime, statusCode, path, method, isAntiGravity } = metrics;
    const timestamp = Math.floor(Date.now() / 1000);
    const minuteKey = Math.floor(timestamp / 60);
    const serviceType = isAntiGravity ? 'antigravity' : 'cli';
    
    try {
        // 使用 Redis 流水线记录多个指标，减少网络请求
        await redis.pipeline()
            // 1. 总请求计数 (按分钟)
            .incr(`monitor:request:count:${method}:${minuteKey}`)
            
            // 2. 按服务类型请求计数 (CLI vs 反重力)
            .incr(`monitor:request:count:${serviceType}:${method}:${minuteKey}`)
            
            // 3. 总状态码计数 (按分钟)
            .incr(`monitor:status:${statusCode}:${method}:${minuteKey}`)
            
            // 4. 按服务类型状态码计数
            .incr(`monitor:status:${serviceType}:${statusCode}:${method}:${minuteKey}`)
            
            // 5. 总响应时间直方图 (按分钟)
            .hincrby(`monitor:response_time:${method}:${minuteKey}`, String(Math.ceil(responseTime / 100)), 1)
            
            // 6. 按服务类型响应时间直方图
            .hincrby(`monitor:response_time:${serviceType}:${method}:${minuteKey}`, String(Math.ceil(responseTime / 100)), 1)
            
            // 7. 路径请求计数
            .incr(`monitor:path:count:${method}:${path}`)
            
            // 8. 设置过期时间 (24小时)
            .expire(`monitor:request:count:${method}:${minuteKey}`, 24 * 3600)
            .expire(`monitor:request:count:${serviceType}:${method}:${minuteKey}`, 24 * 3600)
            .expire(`monitor:status:${statusCode}:${method}:${minuteKey}`, 24 * 3600)
            .expire(`monitor:status:${serviceType}:${statusCode}:${method}:${minuteKey}`, 24 * 3600)
            .expire(`monitor:response_time:${method}:${minuteKey}`, 24 * 3600)
            .expire(`monitor:response_time:${serviceType}:${method}:${minuteKey}`, 24 * 3600)
            .expire(`monitor:path:count:${method}:${path}`, 24 * 3600)
            
            // 执行流水线
            .exec();
            
    } catch (error) {
        console.error('[Monitoring] Failed to record metrics:', error);
        // 监控失败不应影响主流程
    }
}

/**
 * 监控中间件
 * @param fastify Fastify 实例
 */
export async function monitoringMiddleware(fastify: FastifyInstance): Promise<void> {
    fastify.addHook('onRequest', async (req: FastifyRequest) => {
        // 记录请求开始时间
        req.raw['startTime'] = Date.now();
    });
    
    fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
        // 计算响应时间
        const startTime = req.raw['startTime'] || Date.now();
        const responseTime = Date.now() - startTime;
        
        // 确定请求是否来自反重力服务
        // 反重力服务的路由通常包含 /api/antigravity 或 /antigravity
        const path = req.routeOptions.url || req.raw.url || '/';
        let isAntiGravity = path.includes('/antigravity') || 
                            req.headers['x-service-type'] === 'antigravity';
        
        // 安全检查 req.body?.serviceType
        if (req.body && typeof req.body === 'object') {
            const body = req.body as Record<string, any>;
            isAntiGravity = isAntiGravity || body.serviceType === 'antigravity';
        }
        
        // 记录监控指标
        await recordMetrics({
            responseTime,
            statusCode: reply.statusCode,
            path,
            method: req.method,
            isAntiGravity
        });
    });
    
    // 添加监控指标获取端点（仅供内部使用）
    fastify.get('/api/monitoring/metrics', async (req, reply) => {
        // 检查是否为内部请求或管理员请求
        const isInternal = req.ip === '127.0.0.1' || req.ip === '::1';
        if (!isInternal) {
            return reply.code(403).send({ error: 'Forbidden' });
        }
        
        try {
            // 获取最近的监控指标
            const now = Math.floor(Date.now() / 1000);
            const currentMinute = Math.floor(now / 60);
            
            // 服务类型：cli 和 antigravity
            const serviceTypes = ['cli', 'antigravity'];
            
            // 使用 Redis 流水线获取多个指标
            const pipeline = redis.pipeline();
            
            // 获取总请求数
            pipeline.get(`monitor:request:count:GET:${currentMinute}`);
            pipeline.get(`monitor:request:count:POST:${currentMinute}`);
            
            // 获取总状态码
            pipeline.get(`monitor:status:200:GET:${currentMinute}`);
            pipeline.get(`monitor:status:200:POST:${currentMinute}`);
            pipeline.get(`monitor:status:400:GET:${currentMinute}`);
            pipeline.get(`monitor:status:400:POST:${currentMinute}`);
            pipeline.get(`monitor:status:500:GET:${currentMinute}`);
            pipeline.get(`monitor:status:500:POST:${currentMinute}`);
            
            // 为每种服务类型获取指标
            for (const serviceType of serviceTypes) {
                // 请求计数
                pipeline.get(`monitor:request:count:${serviceType}:GET:${currentMinute}`);
                pipeline.get(`monitor:request:count:${serviceType}:POST:${currentMinute}`);
                
                // 状态码计数
                pipeline.get(`monitor:status:${serviceType}:200:GET:${currentMinute}`);
                pipeline.get(`monitor:status:${serviceType}:200:POST:${currentMinute}`);
                pipeline.get(`monitor:status:${serviceType}:400:GET:${currentMinute}`);
                pipeline.get(`monitor:status:${serviceType}:400:POST:${currentMinute}`);
                pipeline.get(`monitor:status:${serviceType}:500:GET:${currentMinute}`);
                pipeline.get(`monitor:status:${serviceType}:500:POST:${currentMinute}`);
            }
            
            // 执行流水线
            const results = await pipeline.exec();
            
            // 确保 results 不是 null 且是数组
            const metrics = results || [];
            
            // 辅助函数：安全解析整数值
            const safeParseInt = (value: any): number => {
                if (value === null || value === undefined) return 0;
                return parseInt(String(value), 10) || 0;
            };
            
            // 解析结果
            const totalRequests = {
                GET: safeParseInt(metrics[0]?.[1]),
                POST: safeParseInt(metrics[1]?.[1])
            };
            
            const totalStatusCodes = {
                '200': {
                    GET: safeParseInt(metrics[2]?.[1]),
                    POST: safeParseInt(metrics[3]?.[1])
                },
                '400': {
                    GET: safeParseInt(metrics[4]?.[1]),
                    POST: safeParseInt(metrics[5]?.[1])
                },
                '500': {
                    GET: safeParseInt(metrics[6]?.[1]),
                    POST: safeParseInt(metrics[7]?.[1])
                }
            };
            
            // 解析服务类型指标 (从索引 8 开始)
            let index = 8;
            const serviceMetrics = {} as any;
            
            for (const serviceType of serviceTypes) {
                serviceMetrics[serviceType] = {
                    requests: {
                        GET: safeParseInt(metrics[index++]?.[1]),
                        POST: safeParseInt(metrics[index++]?.[1])
                    },
                    statusCodes: {
                        '200': {
                            GET: safeParseInt(metrics[index++]?.[1]),
                            POST: safeParseInt(metrics[index++]?.[1])
                        },
                        '400': {
                            GET: safeParseInt(metrics[index++]?.[1]),
                            POST: safeParseInt(metrics[index++]?.[1])
                        },
                        '500': {
                            GET: safeParseInt(metrics[index++]?.[1]),
                            POST: safeParseInt(metrics[index++]?.[1])
                        }
                    }
                };
            }
            
            return {
                timestamp: now,
                currentMinute,
                metrics: {
                    total: {
                        requests: totalRequests,
                        statusCodes: totalStatusCodes
                    },
                    byServiceType: serviceMetrics
                }
            };
        } catch (error) {
            console.error('[Monitoring] Failed to get metrics:', error);
            return reply.code(500).send({ error: 'Failed to get metrics' });
        }
    });
}
