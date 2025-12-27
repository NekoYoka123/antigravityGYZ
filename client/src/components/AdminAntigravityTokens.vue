<template>
  <div class="admin-antigravity-tokens">
    <div class="p-4 md:p-6 border-b border-purple-500/20 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <h3 class="text-lg md:text-xl font-black text-white flex items-center gap-2">
        <span class="text-xl md:text-2xl">&#128203;</span> Token List
      </h3>
      <div class="flex items-center gap-2 flex-wrap">
          <!-- Search Input -->
          <div class="relative w-full md:w-64">
              <input
                  v-model="tokenSearch"
                  @keyup.enter="handleSearch"
                  placeholder="🔍 搜索ID / 邮箱 / Discord / 用户ID"
                  class="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-2 pl-10 text-sm text-white focus:outline-none focus:border-[#8B5CF6] transition-all placeholder-[#A5B4FC]/50"
              >
              <span class="absolute left-3 top-2.5 text-xs text-[#A5B4FC]">🔎</span>
          </div>
          <!-- Filter Dropdown -->
          <select v-model="tokenStatus" @change="tokenPage=1; fetchTokens()"
              class="appearance-none bg-black/20 border border-white/10 pl-3 pr-8 py-1.5 text-purple-300 font-bold text-xs focus:outline-none focus:border-purple-500 cursor-pointer hover:bg-white/5 rounded-lg transition-all">
              <option value="">📋 全部</option>
              <option value="DUPLICATE">🔁 重复邮箱</option>
          </select>
          <select v-model="poolFilter" @change="tokenPage=1; fetchTokens()"
              class="appearance-none bg-black/20 border border-white/10 pl-3 pr-8 py-1.5 text-purple-300 font-bold text-xs focus:outline-none focus:border-purple-500 cursor-pointer hover:bg-white/5 rounded-lg transition-all">
              <option value="">池: 全部</option>
              <option value="Normal">池: Normal</option>
              <option value="Pro">池: Pro</option>
          </select>
          <div class="text-xs text-purple-300/70">第 {{ tokenPage }} / {{ tokenPageCount }} 页</div>
          <button @click="prevTokenPage" :disabled="tokenPage<=1" class="px-2 py-1 bg-purple-600/30 hover:bg-purple-600/50 disabled:opacity-50 rounded-lg text-white text-xs font-bold"><</button>
          <button @click="nextTokenPage" :disabled="tokenPage>=tokenPageCount" class="px-2 py-1 bg-purple-600/30 hover:bg-purple-600/50 disabled:opacity-50 rounded-lg text-white text-xs font-bold">></button>
          <button @click="fetchTokens" class="px-4 py-2 bg-purple-600/50 hover:bg-purple-600/70 rounded-xl text-white text-xs md:text-sm font-bold transition-all flex items-center justify-center gap-2">
          <span :class="{ 'animate-spin': loadingTokens }">&#8635;</span> 刷新
          </button>
          <button @click="refreshQuotas" :disabled="refreshRunning" class="px-4 py-2 bg-indigo-600/50 hover:bg-indigo-600/70 disabled:opacity-50 rounded-xl text-white text-xs md:text-sm font-bold transition-all">
            {{ refreshRunning ? '刷新中...' : '刷新额度缓存' }}
          </button>
      </div>
    </div>

    <div v-if="refreshStatus" class="px-4 md:px-6 text-xs text-indigo-200 space-y-1">
      <div class="flex items-center gap-2">
        <span v-if="refreshRunning" class="animate-spin">⏳</span>
        <span>{{ refreshStatus }}</span>
        <span v-if="refreshProgress">({{ refreshProgress.current }}/{{ refreshProgress.total }})</span>
      </div>
      <div v-if="refreshProgress" class="w-full h-1.5 bg-white/10 rounded overflow-hidden">
        <div class="h-full bg-indigo-400 transition-all" :style="{ width: progressPercent }"></div>
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full">
        <thead>
          <tr class="text-left border-b border-purple-500/20 bg-purple-900/20">
            <th @click="handleSort('id')" class="px-4 md:px-6 py-3 md:py-4 text-[10px] md:text-xs font-black text-purple-300/70 uppercase tracking-wider cursor-pointer hover:text-purple-200 select-none">
              ID <span v-if="tokenSortBy === 'id'">{{ tokenOrder === 'asc' ? '↑' : '↓' }}</span>
            </th>
            <th class="px-4 md:px-6 py-3 md:py-4 text-[10px] md:text-xs font-black text-purple-300/70 uppercase tracking-wider">邮箱</th>
            <th class="px-4 md:px-6 py-3 md:py-4 text-[10px] md:text-xs font-black text-purple-300/70 uppercase tracking-wider hidden md:table-cell">上传者</th>
            <th @click="handleSort('total_used')" class="px-4 md:px-6 py-3 md:py-4 text-[10px] md:text-xs font-black text-purple-300/70 uppercase tracking-wider cursor-pointer hover:text-purple-200 select-none">
              次数 <span v-if="tokenSortBy === 'total_used'">{{ tokenOrder === 'asc' ? '↑' : '↓' }}</span>
            </th>
            <th class="px-4 md:px-6 py-3 md:py-4 text-[10px] md:text-xs font-black text-purple-300/70 uppercase tracking-wider hidden md:table-cell">状态</th>
            <th class="px-4 md:px-6 py-3 md:py-4 text-[10px] md:text-xs font-black text-purple-300/70 uppercase tracking-wider text-right">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-purple-500/10">
          <tr v-if="tokens.length === 0">
            <td colspan="6" class="px-6 py-12 text-center text-purple-300/50">
              <div class="text-3xl md:text-4xl mb-2">&#127756;</div>
              <div class="text-sm md:text-base">暂无 Token</div>
            </td>
          </tr>
          <tr v-for="token in tokens" :key="token.id" class="hover:bg-purple-500/10 transition-colors group">
            <td class="px-4 md:px-6 py-3 md:py-4">
              <span class="px-2 py-1 bg-purple-500/20 rounded text-purple-300 font-mono text-xs md:text-sm">#{{ token.id }}</span>
            </td>
            <td class="px-4 md:px-6 py-3 md:py-4 text-white text-xs md:text-sm truncate max-w-[120px] md:max-w-[200px]">
              {{ token.email || '未知邮箱' }}
            </td>
            <!-- Owner column with Discord info -->
            <td class="px-4 md:px-6 py-3 md:py-4 hidden md:table-cell">
              <div class="flex items-center gap-2">
                <img v-if="token.owner_discord_avatar" 
                     :src="`https://cdn.discordapp.com/avatars/${token.owner_discord_id}/${token.owner_discord_avatar}.png?size=32`"
                     class="w-6 h-6 rounded-full border border-white/10 shadow-sm" />
                <div v-else class="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-[10px] text-white font-bold">
                  {{ token.owner_email?.[0]?.toUpperCase() || '?' }}
                </div>
                <div class="flex flex-col">
                  <span v-if="token.owner_discord_username" class="text-xs font-medium text-purple-200">{{ token.owner_discord_username }}</span>
                  <span class="text-[10px] text-purple-300/60 font-mono">{{ token.owner_email || '未知' }}</span>
                  <span v-if="token.owner_discord_id" class="text-[9px] text-purple-300/40 font-mono">ID: {{ token.owner_discord_id }}</span>
                </div>
              </div>
            </td>
            <td class="px-4 md:px-6 py-3 md:py-4 text-purple-300 text-xs md:text-sm">
              {{ token.total_used || 0 }}
            </td>
            <td class="px-4 md:px-6 py-3 md:py-4 hidden md:table-cell">
              <div class="flex items-center gap-2">
                <span v-if="token.is_enabled" class="px-3 py-1 bg-green-500/20 text-green-400 rounded-full text-xs font-bold inline-flex items-center gap-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span> 已启用
                </span>
                <span v-else class="px-3 py-1 bg-gray-500/20 text-gray-400 rounded-full text-xs font-bold">已禁用</span>
                <span v-if="token.status==='ACTIVE'" class="px-3 py-1 bg-emerald-500/20 text-emerald-300 rounded-full text-xs font-bold">活跃</span>
                <span v-else-if="token.status==='COOLING'" class="px-3 py-1 bg-amber-500/20 text-amber-300 rounded-full text-xs font-bold">冷却中</span>
                <span v-else class="px-3 py-1 bg-gray-500/20 text-gray-300 rounded-full text-xs font-bold">失效</span>
                <span v-if="token.classification" class="px-3 py-1 bg-indigo-500/20 text-indigo-300 rounded-full text-xs font-bold">{{ token.classification }}</span>
                <span v-if="typeof token.remaining==='number'" class="px-3 py-1 bg-cyan-500/20 text-cyan-300 rounded-full text-xs font-bold">{{ (token.remaining*100).toFixed(0) }}%</span>
              </div>
            </td>
            <td class="px-4 md:px-6 py-3 md:py-4 text-right">
              <div class="flex items-center justify-end gap-2 opacity-70 md:opacity-0 group-hover:opacity-100 transition-opacity">
                <button @click="toggleToken(token)"
                  class="w-8 h-8 rounded-lg flex items-center justify-center transition-all text-sm md:text-base"
                  :class="token.is_enabled ? 'bg-amber-500/20 hover:bg-amber-500/40 text-amber-400' : 'bg-green-500/20 hover:bg-green-500/40 text-green-400'"
                  :title="token.is_enabled ? 'Disable' : 'Enable'">
                  {{ token.is_enabled ? '&#9208;' : '&#9654;' }}
                </button>
                <button @click="deleteToken(token)"
                  class="w-8 h-8 rounded-lg bg-red-500/20 hover:bg-red-500/40 text-red-400 flex items-center justify-center transition-all text-sm md:text-base"
                  title="Delete">
                  &#128465;
                </button>
                <button @click="openQuotaModal(token)"
                  class="px-3 h-8 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/40 text-indigo-300 flex items-center justify-center transition-all text-xs font-bold"
                  title="查看额度">
                  额度
                </button>
                <button @click="forceRefreshQuota(token)"
                  class="px-3 h-8 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-300 flex items-center justify-center transition-all text-xs font-bold"
                  title="强制刷新额度">
                  刷新额度
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Teleport to="body">
      <div v-if="quotaModalVisible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div class="w-[95%] max-w-5xl max-h-[80vh] overflow-y-auto bg-white/5 backdrop-blur-xl border border-indigo-500/30 rounded-2xl p-4 md:p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span v-if="quotaData?.classification==='Pro'" class="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold">Pro</span>
            <span v-else class="px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold">Normal</span>
            <span class="text-xs text-indigo-200/80">{{ quotaData?.window_label || '' }}</span>
          </div>
          <div class="text-[10px] md:text-xs text-indigo-200/70" v-if="quotaData?.meta">
            {{ quotaData?.meta?.from_cache ? '缓存' : '实时' }} · {{ new Date(quotaData?.meta?.fetched_at).toLocaleString() }}
          </div>
          <button @click="closeQuotaModal" class="px-3 py-1 rounded-lg bg-white/10 text-white text-xs">关闭</button>
        </div>
        <div v-if="quotaLoading" class="text-center text-indigo-200 py-6">
          <span class="animate-spin">&#9881;</span>
        </div>
        <div v-else-if="quotaError" class="text-center text-red-300 py-4">{{ quotaError }}</div>
        <div v-else class="overflow-x-auto max-h-[60vh]">
          <table class="w-full">
            <thead>
              <tr class="text-left border-b border-indigo-500/20">
                <th class="px-3 py-2 text-[10px] md:text-xs text-indigo-200/80">模型ID</th>
                <th class="px-3 py-2 text-[10px] md:text-xs text-indigo-200/80">剩余(%)</th>
                <th class="px-3 py-2 text-[10px] md:text-xs text-indigo-200/80">重置时间</th>
                <th class="px-3 py-2 text-[10px] md:text-xs text-indigo-200/80">距重置(小时)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in quotaData?.models || []" :key="m.model_id" class="border-b border-white/5">
                <td class="px-3 py-2 text-white text-xs md:text-sm truncate">{{ m.model_id }}</td>
                <td class="px-3 py-2 text-indigo-100 text-xs md:text-sm">{{ ((m.remaining || 0) * 100).toFixed(1) }}</td>
                <td class="px-3 py-2 text-indigo-100 text-xs md:text-sm">{{ m.reset_time ? new Date(m.reset_time).toLocaleString() : '未知' }}</td>
                <td class="px-3 py-2 text-indigo-100 text-xs md:text-sm">{{ m.hours_to_reset ? m.hours_to_reset.toFixed(1) : '未知' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '@/utils/api';

const emit = defineEmits(['quota-refreshed']);

const tokens = ref<any[]>([]);
const tokenPage = ref(1);
const tokenLimit = ref(10);
const tokenTotal = ref(0);
const tokenPageCount = computed(() => Math.max(1, Math.ceil(tokenTotal.value / tokenLimit.value)));
const tokenSortBy = ref('id');
const tokenOrder = ref<'asc' | 'desc'>('asc');
const tokenStatus = ref('');
const poolFilter = ref('');
const tokenSearch = ref('');
const loadingTokens = ref(false);

const quotaModalVisible = ref(false);
const quotaLoading = ref(false);
const quotaError = ref('');
const quotaData = ref<any | null>(null);
const refreshRunning = ref(false);
const refreshStatus = ref('');
const refreshProgress = ref<{ current: number; total: number } | null>(null);
const progressPercent = computed(() => {
  if (!refreshProgress.value || !refreshProgress.value.total) return '0%';
  const pct = Math.min(100, Math.max(0, (refreshProgress.value.current / refreshProgress.value.total) * 100));
  return `${pct.toFixed(0)}%`;
});
let refreshEs: EventSource | null = null;

const fetchTokens = async () => {
  loadingTokens.value = true;
  try {
    const res = await api.get('/antigravity/tokens', {
        params: {
            page: tokenPage.value,
            limit: tokenLimit.value,
            sort_by: tokenSortBy.value,
            order: tokenOrder.value,
            status: tokenStatus.value || undefined,
            pool: poolFilter.value || undefined,
            search: tokenSearch.value || undefined
        }
    });
    tokens.value = res.data.tokens || [];
    tokenTotal.value = res.data.meta?.total || 0;
  } catch (e) {
    console.error('Failed to fetch tokens', e);
  } finally {
    loadingTokens.value = false;
  }
};

const prevTokenPage = () => { if (tokenPage.value > 1) { tokenPage.value -= 1; fetchTokens(); } };
const nextTokenPage = () => { if (tokenPage.value < tokenPageCount.value) { tokenPage.value += 1; fetchTokens(); } };

const handleSearch = () => {
  tokenPage.value = 1;
  fetchTokens();
};

const handleSort = (field: string) => {
    if (tokenSortBy.value === field) {
        tokenOrder.value = tokenOrder.value === 'asc' ? 'desc' : 'asc';
    } else {
        tokenSortBy.value = field;
        tokenOrder.value = 'desc'; // Default to desc for new field (usually usage)
    }
    fetchTokens();
};

const toggleToken = async (token: any) => {
  try {
    await api.put(`/antigravity/tokens/${token.id}`, { is_enabled: !token.is_enabled });
    token.is_enabled = !token.is_enabled;
    fetchTokens();
  } catch (e: any) {
    alert('Failed: ' + (e.response?.data?.error || e.message));
  }
};

const deleteToken = async (token: any) => {
  const created = token.created_at ? new Date(token.created_at).toLocaleString() : '';
  const email = token.email || '未知邮箱';
  const msg = `确认删除凭证 #${token.id}
邮箱：${email}
创建时间：${created}
此操作不可恢复，继续吗？`;
  if (!confirm(msg)) return;
  try {
    await api.delete(`/antigravity/tokens/${token.id}`);
    fetchTokens();
  } catch (e: any) {
    alert('删除失败: ' + (e.response?.data?.error || e.message));
  }
};

const openQuotaModal = async (token: any) => {
  quotaError.value = '';
  quotaData.value = null;
  quotaLoading.value = true;
  try {
    const res = await api.get(`/antigravity/tokens/${token.id}/quotas`);
    quotaData.value = res.data;
    token._quota_class = res.data.classification;
    quotaModalVisible.value = true;
  } catch (e: any) {
    quotaError.value = e.response?.data?.error || e.message;
    quotaModalVisible.value = true;
  } finally {
    quotaLoading.value = false;
  }
};

const closeQuotaModal = () => { quotaModalVisible.value = false; };

const forceRefreshQuota = async (token: any) => {
  quotaError.value = '';
  quotaData.value = null;
  quotaLoading.value = true;
  try {
    const res = await api.get(`/antigravity/tokens/${token.id}/quotas`, { params: { force: true } });
    quotaData.value = res.data;
    token._quota_class = res.data.classification;
    quotaModalVisible.value = true;
  } catch (e: any) {
    quotaError.value = e.response?.data?.error || e.message;
    quotaModalVisible.value = true;
  } finally {
    quotaLoading.value = false;
  }
};

const refreshQuotas = async () => {
  if (refreshRunning.value) return;
  const token = sessionStorage.getItem('token') || localStorage.getItem('token');
  if (!token) {
    refreshStatus.value = '缺少登录凭证，无法刷新';
    return;
  }
  refreshRunning.value = true;
  refreshStatus.value = '启动刷新...';
  refreshProgress.value = null;

  const base = api.defaults.baseURL || '';
  const url = `${base}/antigravity/quotas/refresh-stream?token=${encodeURIComponent(token)}`;
  refreshEs = new EventSource(url);

  refreshEs.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'start') {
        refreshStatus.value = `开始刷新，共 ${data.total} 个`;
        refreshProgress.value = { current: 0, total: data.total || 0 };
      } else if (data.type === 'progress') {
        refreshProgress.value = { current: data.current || 0, total: data.total || 0 };
        refreshStatus.value = `已刷新 ${data.current}/${data.total}`;
      } else if (data.type === 'done') {
        refreshStatus.value = '刷新完成';
        refreshProgress.value = null;
        cleanupRefreshEs();
        await fetchTokens();
        emit('quota-refreshed');
      }
    } catch (e) {
      refreshStatus.value = '解析进度失败';
    }
  };

  refreshEs.onerror = () => {
    // 若已完成则静默结束；否则提示
    if (refreshStatus.value !== '刷新完成') {
      refreshStatus.value = '刷新出错或连接中断';
    }
    refreshProgress.value = null;
    cleanupRefreshEs();
    fetchTokens(); // 确保列表状态刷新
  };
};

const cleanupRefreshEs = () => {
  if (refreshEs) {
    refreshEs.close();
    refreshEs = null;
  }
  refreshRunning.value = false;
  refreshProgress.value = null;
};

onMounted(() => {
  fetchTokens();
});
</script>

<style scoped>
/* Reusing styles from AntigravityView but scoped to this component */
</style>
