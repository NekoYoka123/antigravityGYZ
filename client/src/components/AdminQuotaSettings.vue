<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../utils/api';

const config = ref({
  enable_registration: true,
  quota: {
    newbie: 300,
    contributor: 1500,
    v3_contributor: 3000,
    personal_max_usage: 0,
    increment_per_credential: 0
  },
  rate_limit: {
    newbie: 10,
    contributor: 60,
    v3_contributor: 120
  },
  antigravity: {
    claude_limit: 100,
    gemini3_limit: 200
  }
});

const isLoading = ref(false);
const message = ref('');

const antigravityStats = ref<any>(null);

const fetchSettings = async () => {
  try {
    const [res, agRes, agStatsRes] = await Promise.all([
      api.get('/admin/settings'),
      api.get('/antigravity/config'),
      api.get('/antigravity/stats')
    ]);
    
    // System Settings
    config.value.enable_registration = res.data.enable_registration ?? true;
    if (res.data.quota) config.value.quota = { ...config.value.quota, ...res.data.quota };
    if (res.data.rate_limit) config.value.rate_limit = { ...config.value.rate_limit, ...res.data.rate_limit };

    // Antigravity Settings
    if (agRes.data) {
        config.value.antigravity = { ...config.value.antigravity, ...agRes.data };
    }
    
    // Antigravity Stats
    if (agStatsRes.data) {
        antigravityStats.value = agStatsRes.data;
    }
  } catch (e) {
    console.error('Failed to fetch settings', e);
  }
};

const saveSettings = async () => {
  isLoading.value = true;
  message.value = '';
  try {
    await Promise.all([
        api.post('/admin/settings', {
            enable_registration: config.value.enable_registration,
            quota: config.value.quota,
            rate_limit: config.value.rate_limit
        }),
        api.post('/antigravity/config', config.value.antigravity)
    ]);
    message.value = '配置已保存 ✅';
    setTimeout(() => message.value = '', 3000);
  } catch (e) {
    message.value = '保存失败 ❌';
  } finally {
    isLoading.value = false;
  }
};

onMounted(fetchSettings);
</script>

<template>
  <div class="space-y-6 text-gray-800">
    
    <!-- Registration Switch -->
    <div class="bg-white border border-gray-200 rounded-3xl p-6 flex items-center justify-between shadow-sm">
        <div>
            <h3 class="font-bold text-lg">允许新用户注册</h3>
            <p class="text-gray-500 text-sm">关闭后，新用户将无法通过邮箱或 Discord 创建账号。</p>
        </div>
        <button 
            @click="config.enable_registration = !config.enable_registration" 
            class="relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none"
            :class="config.enable_registration ? 'bg-green-500' : 'bg-gray-200'"
        >
            <span class="sr-only">Toggle</span>
            <span
                class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform shadow"
                :class="config.enable_registration ? 'translate-x-7' : 'translate-x-1'"
            />
        </button>
    </div>

    <!-- Quota & Rate Limit Settings -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <!-- Newbie -->
        <div class="bg-white border border-gray-200 rounded-3xl p-6 space-y-4 relative overflow-hidden shadow-sm">
            <div class="absolute top-0 right-0 p-4 opacity-10 text-6xl text-green-500">🌱</div>
            <h3 class="font-bold text-lg text-green-600">萌新 (Newbie)</h3>
            
            <div>
                <label class="block text-xs text-gray-500 mb-1">每日额度 (Daily Quota)</label>
                <input type="number" v-model.number="config.quota.newbie" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-green-500 outline-none transition text-gray-900">
            </div>
            <div>
                <label class="block text-xs text-gray-500 mb-1">速率限制 (RPM)</label>
                <input type="number" v-model.number="config.rate_limit.newbie" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-green-500 outline-none transition text-gray-900">
            </div>
        </div>

        <!-- Contributor -->
        <div class="bg-white border border-gray-200 rounded-3xl p-6 space-y-4 relative overflow-hidden shadow-sm">
            <div class="absolute top-0 right-0 p-4 opacity-10 text-6xl text-yellow-500">👑</div>
            <h3 class="font-bold text-lg text-yellow-600">大佬 (Contributor)</h3>
            
            <div>
                <label class="block text-xs text-gray-500 mb-1">每日额度 (Daily Quota)</label>
                <input type="number" v-model.number="config.quota.contributor" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-yellow-500 outline-none transition text-gray-900">
            </div>
            <div>
                <label class="block text-xs text-gray-500 mb-1">速率限制 (RPM)</label>
                <input type="number" v-model.number="config.rate_limit.contributor" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-yellow-500 outline-none transition text-gray-900">
            </div>
            <div>
                <label class="block text-xs text-gray-500 mb-1">每张凭证增量 (+X/天)</label>
                <input type="number" v-model.number="config.quota.increment_per_credential" min="0" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-yellow-500 outline-none transition text-gray-900">
                <p class="text-[11px] text-gray-500 mt-1">第1张凭证按基础额度，后续每张增加此值。</p>
            </div>
        </div>

        <!-- V3 Contributor -->
        <div class="bg-white border border-gray-200 rounded-3xl p-6 space-y-4 relative overflow-hidden shadow-sm">
            <div class="absolute top-0 right-0 p-4 opacity-10 text-6xl text-purple-500">💎</div>
            <h3 class="font-bold text-lg text-purple-600">至臻大佬 (V3)</h3>
            
            <div>
                <label class="block text-xs text-gray-500 mb-1">每日额度 (Daily Quota)</label>
                <input type="number" v-model.number="config.quota.v3_contributor" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-purple-500 outline-none transition text-gray-900">
            </div>
            <div>
                <label class="block text-xs text-gray-500 mb-1">速率限制 (RPM)</label>
                <input type="number" v-model.number="config.rate_limit.v3_contributor" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-purple-500 outline-none transition text-gray-900">
            </div>
        </div>

        <!-- Antigravity Settings -->
        <div class="bg-white border border-gray-200 rounded-3xl p-6 space-y-4 relative overflow-hidden shadow-sm">
            <div class="absolute top-0 right-0 p-4 opacity-10 text-6xl text-blue-500">🌌</div>
            <h3 class="font-bold text-lg text-blue-600">反重力 (Antigravity)</h3>
            
            <div v-if="antigravityStats" class="bg-blue-50/50 rounded-xl p-3 text-xs mb-4 border border-blue-100">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-gray-500">有效凭证数</span>
                    <span class="font-bold text-blue-600">{{ antigravityStats.meta.active_tokens }}</span>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="space-y-1">
                        <div class="text-blue-600/70 font-bold">Claude</div>
                        <div class="flex justify-between">
                            <span class="text-gray-400">已用</span>
                            <span class="font-mono">{{ antigravityStats.usage.claude }}</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-gray-400">容量</span>
                            <span class="font-mono">{{ antigravityStats.capacity.claude }}</span>
                        </div>
                    </div>
                    <div class="space-y-1">
                        <div class="text-purple-600/70 font-bold">Gemini 3</div>
                        <div class="flex justify-between">
                            <span class="text-gray-400">已用</span>
                            <span class="font-mono">{{ antigravityStats.usage.gemini3 }}</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-gray-400">容量</span>
                            <span class="font-mono">{{ antigravityStats.capacity.gemini3 }}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div>
                <label class="block text-xs text-gray-500 mb-1">Claude 限额 (次/天)</label>
                <input type="number" v-model.number="config.antigravity.claude_limit" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-blue-500 outline-none transition text-gray-900">
            </div>
            <div>
                <label class="block text-xs text-gray-500 mb-1">Gemini 3.0 限额 (次/天)</label>
                <input type="number" v-model.number="config.antigravity.gemini3_limit" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-blue-500 outline-none transition text-gray-900">
            </div>
        </div>
    </div>

    <!-- Personal Max Usage -->
    <div class="bg-white border border-gray-200 rounded-3xl p-6 space-y-4 shadow-sm">
        <h3 class="font-bold text-lg text-indigo-600">个人最大次数</h3>
        <p class="text-gray-500 text-sm">用于计算总使用上限：总使用次数 = 个人最大次数 × 后台有效凭证数量（反重力）</p>
        <div>
            <label class="block text-xs text-gray-500 mb-1">个人最大次数</label>
            <input type="number" v-model.number="config.quota.personal_max_usage" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:border-indigo-500 outline-none transition text-gray-900">
        </div>
    </div>

    <div class="flex justify-end items-center gap-4">
        <span v-if="message" class="text-sm font-bold animate-pulse" :class="message.includes('失败') ? 'text-red-500' : 'text-green-600'">
            {{ message }}
        </span>
        <button 
            @click="saveSettings" 
            :disabled="isLoading"
            class="px-8 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-full shadow-lg shadow-indigo-500/30 transition-all disabled:opacity-50"
        >
            {{ isLoading ? '保存中...' : '保存配置' }}
        </button>
    </div>

  </div>
</template>
