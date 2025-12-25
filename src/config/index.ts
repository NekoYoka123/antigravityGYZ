/**
 * 统一配置管理入口
 * 整合所有配置项，提供统一的配置获取方式
 */

// 导入现有的配置
import { getConfig as getAppConfig, AppConfig } from './appConfig';
import { 
  ANTIGRAVITY_CONFIG,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_SUFFIX,
  ANTIGRAVITY_SUFFIXES,
  getAntigravityModelNames,
  isAntigravityModel,
  extractRealModelName
} from './antigravityConfig';

/**
 * 数据库连接配置
 */
export const DATABASE_CONFIG = {
  // 连接池大小配置
  connectionPool: {
    max: Math.min(20, Math.max(5, (Number(process.env.CPU_CORES) || require('os').cpus().length) * 2)),
    min: 5,
    acquireTimeoutMillis: 30000,
    idleTimeoutMillis: 60000
  },
  
  // 查询超时配置（毫秒）
  queryTimeout: 30000,
  
  // 日志级别
  logLevel: process.env.NODE_ENV === 'development' ? 'info' : 'error'
};

/**
 * Redis 配置扩展
 */
export const REDIS_CONFIG = {
  // 连接池配置
  pool: {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      return Math.min(times * 50, 2000);
    },
    connectTimeout: 10000,
    commandTimeout: 5000
  },
  
  // 缓存配置
  cache: {
    defaultTTL: 3600, // 默认缓存时间（秒）
    shortTTL: 60, // 短缓存时间（秒）
    longTTL: 86400 // 长缓存时间（秒）
  }
};

/**
 * 监控配置
 */
export const MONITORING_CONFIG = {
  // 指标保留时间（秒）
  metricsRetention: 24 * 3600,
  
  // 采样率（0-1，1 表示全部采样）
  samplingRate: 1.0,
  
  // 是否启用详细日志
  detailedLogging: process.env.NODE_ENV === 'development'
};

/**
 * 统一配置类型
 */
export type Config = AppConfig & {
  database: typeof DATABASE_CONFIG;
  redis: typeof REDIS_CONFIG;
  monitoring: typeof MONITORING_CONFIG;
};

// 统一配置缓存
let cachedConfig: Config | null = null;

/**
 * 获取统一配置
 * @returns 统一配置对象
 */
export function getConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }
  
  const appConfig = getAppConfig();
  
  cachedConfig = {
    ...appConfig,
    database: DATABASE_CONFIG,
    redis: REDIS_CONFIG,
    monitoring: MONITORING_CONFIG
  };
  
  return cachedConfig;
}

// 重新导出所有配置和工具函数
export { 
  ANTIGRAVITY_CONFIG,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_SUFFIX,
  ANTIGRAVITY_SUFFIXES,
  getAntigravityModelNames,
  isAntigravityModel,
  extractRealModelName
};
