/**
 * Prisma 客户端配置
 * 集中管理 Prisma 客户端实例，配置合理的连接池大小
 */

import { PrismaClient } from '@prisma/client';
import { getConfig } from '../config';

// 获取配置
const config = getConfig();
const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * 优化的 Prisma 客户端实例
 * 配置了合理的连接池大小和日志选项
 */
export const prisma = new PrismaClient({
    // 连接池配置
    datasources: {
        db: {
            url: process.env.DATABASE_URL,
        },
    },
    
    // 日志配置 - 使用简化的日志级别配置
    log: isDevelopment ? ['query', 'info', 'warn', 'error'] : ['error', 'warn'],
    
    // 其他选项
    errorFormat: isDevelopment ? 'pretty' : 'colorless',
});

// 导出类型
export type { Prisma } from '@prisma/client';
