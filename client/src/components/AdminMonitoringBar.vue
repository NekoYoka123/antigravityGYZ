<template>
  <div class="admin-monitoring-bar">
    <div class="monitoring-container">
      <!-- 总请求数 -->
      <div class="monitoring-item">
        <div class="monitoring-label">总请求数</div>
        <div class="monitoring-value">
          <span class="success-count">{{ metrics.successRequests }}</span>
          <span class="divider">/</span>
          <span class="error-count">{{ metrics.errorRequests }}</span>
        </div>
      </div>
      
      <!-- CLI 请求 -->
      <div class="monitoring-item">
        <div class="monitoring-label">CLI 请求</div>
        <div class="monitoring-value">
          <span class="success-count">{{ metrics.cliSuccess }}</span>
          <span class="divider">/</span>
          <span class="error-count">{{ metrics.cliError }}</span>
        </div>
      </div>
      
      <!-- 反重力请求 -->
      <div class="monitoring-item">
        <div class="monitoring-label">反重力请求</div>
        <div class="monitoring-value">
          <span class="success-count">{{ metrics.antigravitySuccess }}</span>
          <span class="divider">/</span>
          <span class="error-count">{{ metrics.antigravityError }}</span>
        </div>
      </div>
      
      <!-- 平均响应时间 -->
      <div class="monitoring-item">
        <div class="monitoring-label">平均响应时间</div>
        <div class="monitoring-value">{{ metrics.avgResponseTime }}ms</div>
      </div>
      
      <!-- 系统状态 -->
      <div class="monitoring-item">
        <div class="monitoring-label">系统状态</div>
        <div class="monitoring-value status" :class="metrics.status">
          {{ metrics.status === 'ok' ? '正常' : '异常' }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

// 监控指标数据
const metrics = ref({
  // 成功数/失败数格式
  successRequests: 0,
  errorRequests: 0,
  cliSuccess: 0,
  cliError: 0,
  antigravitySuccess: 0,
  antigravityError: 0,
  avgResponseTime: 0,
  status: 'ok' as 'ok' | 'error'
});

// 从后端获取监控数据
const fetchMetrics = async () => {
  try {
    const response = await fetch('/api/monitoring/metrics');
    if (response.ok) {
      const data = await response.json();
      
      // 计算总成功和失败数
      const totalSuccess = (data.metrics.statusCodes['200']?.GET || 0) + (data.metrics.statusCodes['200']?.POST || 0);
      const totalError = 
        ((data.metrics.statusCodes['400']?.GET || 0) + (data.metrics.statusCodes['400']?.POST || 0)) + 
        ((data.metrics.statusCodes['500']?.GET || 0) + (data.metrics.statusCodes['500']?.POST || 0));
      
      // 简单分类：GET 为 CLI 请求，POST 为反重力请求
      // 实际项目中可能需要更准确的分类逻辑
      const cliSuccess = data.metrics.statusCodes['200']?.GET || 0;
      const cliError = (data.metrics.statusCodes['400']?.GET || 0) + (data.metrics.statusCodes['500']?.GET || 0);
      const antigravitySuccess = data.metrics.statusCodes['200']?.POST || 0;
      const antigravityError = (data.metrics.statusCodes['400']?.POST || 0) + (data.metrics.statusCodes['500']?.POST || 0);
      
      // 更新指标数据
      metrics.value = {
        successRequests: totalSuccess,
        errorRequests: totalError,
        cliSuccess,
        cliError,
        antigravitySuccess,
        antigravityError,
        avgResponseTime: 0, // 暂时硬编码，后续可以从后端获取
        status: 'ok' // 暂时固定为正常状态
      };
    }
  } catch (error) {
    console.error('Failed to fetch monitoring metrics:', error);
    metrics.value.status = 'error';
  }
};

// 定期更新数据
onMounted(() => {
  fetchMetrics();
  // 每 5 秒更新一次数据
  const interval = setInterval(fetchMetrics, 5000);
  
  // 清理定时器
  return () => clearInterval(interval);
});
</script>

<style scoped>
.admin-monitoring-bar {
  background: linear-gradient(135deg, #3a2270, #2d1b5a);
  border: 1px solid rgba(139, 92, 246, 0.2);
  border-radius: 12px;
  padding: 12px 24px;
  backdrop-filter: blur(16px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  margin-bottom: 16px;
  transition: all 0.3s ease;
}

.admin-monitoring-bar:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 40px rgba(139, 92, 246, 0.15);
  border-color: rgba(139, 92, 246, 0.4);
}

.monitoring-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}

.monitoring-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 1;
  padding: 0 16px;
  position: relative;
}

/* 分割线样式 */
.monitoring-item:not(:last-child)::after {
  content: '';
  position: absolute;
  right: 0;
  top: 10%;
  height: 80%;
  width: 1px;
  background: linear-gradient(to bottom, transparent, rgba(139, 92, 246, 0.3), transparent);
}

.monitoring-label {
  font-size: 0.75rem;
  color: #a78bfa;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  text-shadow: 0 0 10px rgba(139, 92, 246, 0.2);
}

.monitoring-value {
  font-size: 1.125rem;
  font-weight: 700;
  color: #e9d5ff;
  text-shadow: 0 0 15px rgba(233, 213, 255, 0.2);
  display: flex;
  align-items: center;
  gap: 4px;
}

.success-count {
  color: #67e8f9;
  text-shadow: 0 0 15px rgba(103, 232, 249, 0.3);
}

.error-count {
  color: #fb7185;
  text-shadow: 0 0 15px rgba(251, 113, 133, 0.3);
}

.divider {
  color: #a78bfa;
  opacity: 0.7;
  font-weight: 600;
}

.monitoring-value.status {
  font-size: 0.875rem;
  padding: 4px 16px;
  border-radius: 16px;
  font-weight: 600;
  border: 1px solid transparent;
  transition: all 0.2s;
}

.monitoring-value.status.ok {
  background: rgba(16, 185, 129, 0.2);
  color: #67e8f9;
  border-color: rgba(103, 232, 249, 0.3);
}

.monitoring-value.status.error {
  background: rgba(239, 68, 68, 0.2);
  color: #fb7185;
  border-color: rgba(251, 113, 133, 0.3);
}

@media (max-width: 768px) {
  .admin-monitoring-bar {
    padding: 10px 16px;
  }
  
  .monitoring-container {
    gap: 16px;
  }
  
  .monitoring-label {
    font-size: 0.625rem;
  }
  
  .monitoring-value {
    font-size: 0.875rem;
  }
  
  .monitoring-item {
    min-width: 50px;
  }
}
</style>