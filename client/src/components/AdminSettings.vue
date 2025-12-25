<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import { api } from '../utils/api';
const isSharedMode = ref(true);
const antigravityStrictMode = ref(false);
const forceDiscordBind = ref(false);
const gemini3OpenAccess = ref(false);
const isLoading = ref(false);
const message = ref('');

// Health Check
const healthCheckLoading = ref<'cli' | 'antigravity' | null>(null);
const healthCheckResult = ref<any>(null);
const healthCheckLogs = ref<string[]>([]);
const logContainerRef = ref<HTMLElement | null>(null);

onMounted(async () => {
  await fetchSettings();
});

const fetchSettings = async () => {
  try {
    const res = await api.get('/admin/settings');
    isSharedMode.value = res.data.enable_cli_shared_mode ?? res.data.enable_shared_mode;
    antigravityStrictMode.value = !!res.data.antigravity_strict_mode;
    forceDiscordBind.value = !!res.data.force_discord_bind;
    gemini3OpenAccess.value = !!res.data.enable_gemini3_open_access;
  } catch (e) {
    console.error('Failed to fetch settings', e);
  }
};

const toggleMode = async () => {
  isLoading.value = true;
  message.value = '';
  try {
    // Toggle the value
    const newValue = !isSharedMode.value;
    await api.post('/admin/settings', { enable_cli_shared_mode: newValue });
    isSharedMode.value = newValue;
    message.value = newValue ? '已开启 CLI 共享模式：所有用户可用 Cloud Code 渠道' : '已关闭 CLI 共享模式：仅上传 CLI 凭证用户可用 Cloud Code';
  } catch (e) {
    message.value = '设置更新失败';
  } finally {
    isLoading.value = false;
  }
};

const toggleAntigravityMode = async () => {
  isLoading.value = true;
  message.value = '';
  try {
    const newValue = !antigravityStrictMode.value;
    await api.post('/admin/settings', { antigravity_strict_mode: newValue });
    antigravityStrictMode.value = newValue;
    message.value = newValue ? '反重力渠道已开启严格模式：仅上传 Token 用户可使用' : '反重力渠道已开启共享模式：所有用户均可使用';
  } catch (e) {
    message.value = '设置更新失败';
  } finally {
    isLoading.value = false;
  }
};

const toggleForceDiscordBind = async () => {
  isLoading.value = true;
  message.value = '';
  try {
    const newValue = !forceDiscordBind.value;
    await api.post('/admin/settings', { force_discord_bind: newValue });
    forceDiscordBind.value = newValue;
    message.value = newValue ? '已开启强制 Discord 授权' : '已关闭强制 Discord 授权';
  } catch (e) {
    message.value = '设置更新失败';
  } finally {
    isLoading.value = false;
  }
};
const toggleGemini3OpenAccess = async () => {
  isLoading.value = true;
  message.value = '';
  try {
    const newValue = !gemini3OpenAccess.value;
    await api.post('/admin/settings', { enable_gemini3_open_access: newValue });
    gemini3OpenAccess.value = newValue;
    message.value = newValue ? '已开放 3.0 系列（CLI）给无凭证/无3.0权限用户' : '已关闭 3.0 系列开放访问（CLI）';
  } catch (e) {
    message.value = '设置更新失败';
  } finally {
    isLoading.value = false;
  }
};


// --- Streaming Health Check Logic ---
const streamHealthCheck = async (type: string) => {
    if (healthCheckLoading.value) return;
    
    // Determine target (CLI vs Antigravity)
    const isAntigravity = type.startsWith('ag_');
    healthCheckLoading.value = isAntigravity ? 'antigravity' : 'cli';
    
    healthCheckResult.value = { total: 0, processed: 0, healthy: 0, dead: 0, cooled: 0, downgraded: 0 };
    healthCheckLogs.value = [];
    
    try {
        const token = localStorage.getItem('token');
        const baseUrl = isAntigravity ? '/api/antigravity/health-check/stream' : '/api/admin/health-check/stream';
        const response = await fetch(`${baseUrl}?type=${type}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) throw new Error(response.statusText);
        if (!response.body) throw new Error('No response body');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        
                        if (data.type === 'log') {
                            healthCheckLogs.value.push(data.message);
                            // Auto scroll
                            nextTick(() => {
                                if (logContainerRef.value) {
                                    logContainerRef.value.scrollTop = logContainerRef.value.scrollHeight;
                                }
                            });
                        } else if (data.type === 'init') {
                            healthCheckResult.value.total = data.total;
                        } else if (data.type === 'progress') {
                            healthCheckResult.value = { ...healthCheckResult.value, ...data };
                        } else if (data.type === 'done') {
                            healthCheckLogs.value.push('✅ 任务完成');
                        } else if (data.type === 'error') {
                            healthCheckLogs.value.push(`❌ 错误: ${data.message}`);
                        }
                    } catch (jsonError) {
                        // Ignore JSON parsing errors for incomplete data chunks
                    }
                }
            }
        }
    } catch (e: any) {
        healthCheckLogs.value.push(`❌ 网络或连接错误: ${e.message}`);
    } finally {
        healthCheckLoading.value = null;
    }
};

</script>

<template>
  <div class="space-y-3">
    <!-- CLI/Cloud Code Mode Settings -->
    <div class="bg-white/5 backdrop-blur-xl border border-purple-500/30 rounded-2xl p-4 shadow-[0_0_15px_rgba(139,92,246,0.1)]">
        <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
                <h2 class="text-lg font-bold text-[#C4B5FD] flex items-center gap-2 whitespace-nowrap">
                    <span>☁️ CLI/Cloud Code</span>
                </h2>
                <div class="h-4 w-[1px] bg-white/10"></div>
                <div class="flex flex-col">
                    <h3 class="font-medium text-sm" :class="isSharedMode ? 'text-green-400' : 'text-orange-400'">
                        {{ isSharedMode ? '共享模式 (所有用户)' : '严格模式 (仅贡献者)' }}
                    </h3>
                    <p class="text-xs text-[#A5B4FC] opacity-60">
                        {{ isSharedMode
                            ? '允许所有注册用户使用 Cloud Code 凭证池'
                            : '仅允许上传凭证用户使用 Cloud Code' }}
                    </p>
                </div>
            </div>

            <button
                @click="toggleMode"
                :disabled="isLoading"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0"
                :class="isSharedMode ? 'bg-gradient-to-r from-green-400 to-emerald-500' : 'bg-white/10'"
            >
                <span class="sr-only">切换模式</span>
                <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow"
                :class="isSharedMode ? 'translate-x-6' : 'translate-x-1'"
                />
            </button>
        </div>
        
        <p v-if="message" class="mt-2 text-xs font-medium text-[#C4B5FD] animate-pulse pl-1">
        {{ message }}
        </p>
    </div>

    <!-- Antigravity Mode Settings -->
    <div class="bg-white/5 backdrop-blur-xl border border-purple-500/30 rounded-2xl p-4 shadow-[0_0_15px_rgba(139,92,246,0.1)]">
        <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
                <h2 class="text-lg font-bold text-[#C4B5FD] flex items-center gap-2 whitespace-nowrap">
                    <span>🚀 反重力渠道</span>
                </h2>
                <div class="h-4 w-[1px] bg-white/10"></div>
                <div class="flex flex-col">
                    <h3 class="font-medium text-sm" :class="antigravityStrictMode ? 'text-orange-400' : 'text-green-400'">
                        {{ antigravityStrictMode ? '严格模式 (仅贡献者)' : '共享模式 (所有用户)' }}
                    </h3>
                    <p class="text-xs text-[#A5B4FC] opacity-60">
                        {{ antigravityStrictMode
                            ? '仅上传过 Antigravity Token 的用户可使用'
                            : '允许所有注册用户使用反重力渠道' }}
                    </p>
                </div>
            </div>

            <button
                @click="toggleAntigravityMode"
                :disabled="isLoading"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0"
                :class="!antigravityStrictMode ? 'bg-gradient-to-r from-green-400 to-emerald-500' : 'bg-white/10'"
            >
                <span class="sr-only">切换反重力模式</span>
                <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow"
                :class="!antigravityStrictMode ? 'translate-x-6' : 'translate-x-1'"
                />
            </button>
        </div>
    </div>

    <!-- Force Discord Bind -->
    <div class="bg-white/5 backdrop-blur-xl border border-purple-500/30 rounded-2xl p-4 shadow-[0_0_15px_rgba(139,92,246,0.1)]">
        <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
                <h2 class="text-lg font-bold text-[#C4B5FD] flex items-center gap-2 whitespace-nowrap">
                    <span>🔒 强制授权</span>
                </h2>
                <div class="h-4 w-[1px] bg-white/10"></div>
                <div class="flex flex-col">
                    <h3 class="font-medium text-sm" :class="forceDiscordBind ? 'text-red-400' : 'text-[#A5B4FC]'">
                        {{ forceDiscordBind ? '已开启：未授权用户将被拦截' : '已关闭：不强制弹窗' }}
                    </h3>
                    <p class="text-xs text-[#A5B4FC] opacity-60">
                        开启后，普通用户首次进入控制台会强制弹出 Discord 授权提示
                    </p>
                </div>
            </div>

            <button
                @click="toggleForceDiscordBind"
                :disabled="isLoading"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0"
                :class="forceDiscordBind ? 'bg-gradient-to-r from-red-500 to-rose-600' : 'bg-white/10'"
            >
                <span class="sr-only">切换强制授权</span>
                <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow"
                :class="forceDiscordBind ? 'translate-x-6' : 'translate-x-1'"
                />
            </button>
        </div>
    </div>

    <!-- Quota & Rate Limit Settings (Integrated) -->
    <!-- Health Check Section -->
    <div class="bg-white/5 backdrop-blur-xl border border-purple-500/30 rounded-2xl p-4 shadow-[0_0_15px_rgba(139,92,246,0.1)]">
        <div class="flex items-center gap-4 mb-4">
            <h2 class="text-lg font-bold text-[#C4B5FD] flex items-center gap-2 whitespace-nowrap">
                <span>🔍 凭证检活 & 访问开关</span>
            </h2>
            <div class="h-4 w-[1px] bg-white/10"></div>
            <p class="text-xs text-[#A5B4FC] opacity-60">并发流式检活 (10线程)，支持实时日志</p>
        </div>
        
        <div class="flex flex-wrap gap-3">
            <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                <span class="text-xs text-[#A5B4FC]">3.0 系列开放（CLI）</span>
                <button
                    @click="toggleGemini3OpenAccess"
                    :disabled="isLoading"
                    class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0"
                    :class="gemini3OpenAccess ? 'bg-gradient-to-r from-green-400 to-emerald-500' : 'bg-white/10'"
                >
                    <span class="sr-only">切换 3.0 系列开放</span>
                    <span
                    class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow"
                    :class="gemini3OpenAccess ? 'translate-x-6' : 'translate-x-1'"
                    />
                </button>
            </div>
            <button
                @click="streamHealthCheck('cli')"
                :disabled="healthCheckLoading !== null"
                class="px-4 py-2 bg-gradient-to-r from-blue-500 to-cyan-500 text-white rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50"
            >
                <span v-if="healthCheckLoading === 'cli'" class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></span>
                {{ healthCheckLoading === 'cli' ? '检测中...' : '☁️ 活跃检活' }}
            </button>
            <button
                @click="streamHealthCheck('cli_dead')"
                :disabled="healthCheckLoading !== null"
                class="px-4 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 text-white rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50"
            >
                ☁️ 失效复检
            </button>
            <button
                @click="streamHealthCheck('enable_dead')"
                :disabled="healthCheckLoading !== null"
                class="px-4 py-2 bg-gradient-to-r from-indigo-500 to-blue-600 text-white rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50"
            >
                ⚡ 一键复活
            </button>
            
             <!-- NEW 3.0 Check Button -->
            <button
                @click="streamHealthCheck('cli_v3')"
                :disabled="healthCheckLoading !== null"
                class="px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 shadow-lg shadow-orange-500/20"
            >
                💎 3.0 专项检活
            </button>
        </div>
        
        <div class="flex flex-wrap gap-3 mt-3 pt-3 border-t border-white/10">
            <button
                @click="streamHealthCheck('ag_active')"
                :disabled="healthCheckLoading !== null"
                class="px-4 py-2 bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50"
            >
                <span v-if="healthCheckLoading === 'antigravity'" class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></span>
                {{ healthCheckLoading === 'antigravity' ? '检测中...' : '🚀 反重力检活' }}
            </button>
            <button
                @click="streamHealthCheck('ag_dead')"
                :disabled="healthCheckLoading !== null"
                class="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50"
            >
                🚀 失效复检
            </button>
            <button
                @click="streamHealthCheck('ag_enable_dead')"
                :disabled="healthCheckLoading !== null"
                class="px-4 py-2 bg-gradient-to-r from-fuchsia-500 to-purple-600 text-white rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50"
            >
                ⚡ 一键复活
            </button>
        </div>
        
        <!-- Stream Logs & Progress -->
        <div v-if="healthCheckLogs.length > 0 || healthCheckLoading" class="mt-4 bg-black/40 rounded-xl overflow-hidden border border-white/10">
            <!-- Progress Bar -->
             <div v-if="healthCheckResult && healthCheckResult.total > 0" class="bg-white/5 p-2 border-b border-white/10">
                <div class="flex justify-between text-xs text-[#A5B4FC] mb-1">
                    <span>进度: {{ healthCheckResult.processed }} / {{ healthCheckResult.total }}</span>
                    <span>{{ Math.round((healthCheckResult.processed / healthCheckResult.total) * 100) }}%</span>
                </div>
                <div class="h-2 bg-white/10 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300 ease-out"
                         :style="{ width: `${(healthCheckResult.processed / healthCheckResult.total) * 100}%` }"></div>
                </div>
                <div class="flex gap-4 mt-2 text-xs font-mono">
                    <span class="text-emerald-400">✓ {{ healthCheckResult.healthy || healthCheckResult.activated || 0 }}</span>
                    <span class="text-rose-400">✗ {{ healthCheckResult.dead || healthCheckResult.failed || 0 }}</span>
                    <span v-if="healthCheckResult.downgraded" class="text-amber-400">⬇️ {{ healthCheckResult.downgraded }}</span>
                    <span v-if="healthCheckResult.cooled" class="text-yellow-400">⏳ {{ healthCheckResult.cooled }}</span>
                </div>
             </div>

             <!-- Logs Terminal -->
             <div ref="logContainerRef" class="h-48 overflow-y-auto p-3 font-mono text-xs space-y-1 scroll-smooth">
                 <div v-for="(log, i) in healthCheckLogs" :key="i" class="break-all" :class="{
                     'text-emerald-300': log.includes('✅') || log.includes('🎉'),
                     'text-rose-300': log.includes('❌') || log.includes('💀'),
                     'text-amber-300': log.includes('⚠️') || log.includes('⏳') || log.includes('⬇️'),
                     'text-blue-300': log.includes('🚀') || log.includes('💎'),
                     'text-gray-400': !log.match(/[✅❌⚠️⏳⬇️🎉🚀💎💀]/)
                 }">
                     {{ log }}
                 </div>
                 <div v-if="healthCheckLoading" class="animate-pulse text-gray-500">_</div>
             </div>
        </div>
    </div>

  </div>
</template>

<style scoped>
/* Custom scrollbar for logs */
.overflow-y-auto::-webkit-scrollbar {
  width: 6px;
}
.overflow-y-auto::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.2);
}
.overflow-y-auto::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}
.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>
