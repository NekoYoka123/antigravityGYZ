<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { api } from '../utils/api';
import GaugeChart from './GaugeChart.vue';

const users = ref<any[]>([]);
const pagination = ref({ page: 1, limit: 10, total: 0, total_pages: 1 });
const search = ref('');
const loading = ref(false);

// Modals
const showQuotaModal = ref(false);
const showPasswordModal = ref(false);
const showAgLimitModal = ref(false);
const selectedUser = ref<any>(null);
const newQuota = ref(0);
const newPassword = ref('');
const newAgClaudeLimit = ref<number>(0);
const newAgGeminiLimit = ref<number>(0);

const fetchUsers = async () => {
  loading.value = true;
  try {
    const res = await api.get('/admin/users', { 
      params: { 
        page: pagination.value.page, 
        limit: pagination.value.limit,
        search: search.value 
      } 
    });
    users.value = res.data.data;
    pagination.value = res.data.meta;
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
};

watch(() => pagination.value.page, fetchUsers);

const handleSearch = () => {
    pagination.value.page = 1;
    fetchUsers();
};

const toggleUserStatus = async (user: any) => {
    if (!confirm(user.is_active ? '⚠️ 确定要禁用该用户吗？这将同时禁用其所有 API 密钥。' : '确定要启用该用户吗？')) return;
    
    try {
        await api.patch(`/admin/users/${user.id}/toggle`, { is_active: !user.is_active });
        user.is_active = !user.is_active;
    } catch (e: any) {
        alert('操作失败: ' + (e.response?.data?.error || e.message));
    }
};

const openQuotaModal = (user: any) => {
    selectedUser.value = user;
    newQuota.value = user.daily_limit;
    showQuotaModal.value = true;
};

const openAgLimitModal = (user: any) => {
    selectedUser.value = user;
    newAgClaudeLimit.value = Number(user.ag_claude_limit || 0);
    newAgGeminiLimit.value = Number(user.ag_gemini3_limit || 0);
    showAgLimitModal.value = true;
};

const confirmAgLimits = async () => {
    try {
        await api.patch(`/admin/users/${selectedUser.value.id}/antigravity-limits`, { 
            claude_limit: Number(newAgClaudeLimit.value), 
            gemini3_limit: Number(newAgGeminiLimit.value) 
        });
        selectedUser.value.ag_claude_limit = Number(newAgClaudeLimit.value);
        selectedUser.value.ag_gemini3_limit = Number(newAgGeminiLimit.value);
        showAgLimitModal.value = false;
    } catch (e: any) {
        alert('更新失败: ' + (e.response?.data?.error || e.message));
    }
};

const confirmQuota = async () => {
    try {
        await api.patch(`/admin/users/${selectedUser.value.id}/quota`, { daily_limit: Number(newQuota.value) });
        selectedUser.value.daily_limit = Number(newQuota.value);
        showQuotaModal.value = false;
    } catch (e) {
        alert('更新失败');
    }
};

const openPasswordModal = (user: any) => {
    selectedUser.value = user;
    newPassword.value = '';
    showPasswordModal.value = true;
};

const confirmPassword = async () => {
    if (newPassword.value.length < 6) return alert('密码至少6位');
    try {
        await api.post(`/admin/users/${selectedUser.value.id}/reset-password`, { password: newPassword.value });
        alert('密码重置成功 ✅');
        showPasswordModal.value = false;
    } catch (e) {
        alert('重置失败');
    }
};

onMounted(fetchUsers);
</script>

<template>
  <div class="space-y-4">
    <!-- Header & Search -->
    <div class="flex flex-col md:flex-row justify-between items-center gap-4 bg-white p-4 rounded-2xl border border-gray-200 shadow-sm">
        <h3 class="text-xl font-bold text-gray-800 flex items-center gap-2">
            <span>👥 用户管理</span>
            <span class="text-xs bg-indigo-50 text-indigo-600 px-2 py-1 rounded-full border border-indigo-100">{{ pagination.total }}</span>
        </h3>
        <div class="relative w-full md:w-64">
            <input 
                v-model="search" 
                @keyup.enter="handleSearch"
                placeholder="🔍 搜索邮箱..." 
                class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 pl-10 text-sm text-gray-800 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all placeholder-gray-400"
            >
            <span class="absolute left-3 top-2.5 text-xs text-gray-400">🔎</span>
        </div>
    </div>

    <!-- Table -->
    <div class="overflow-x-auto bg-white rounded-3xl border border-gray-200 shadow-sm">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="text-gray-500 text-xs uppercase tracking-wider border-b border-gray-100 bg-gray-50/50">
            <th class="p-6 font-bold">用户</th>
            <th class="p-6 font-bold text-center">角色</th>
            <th class="p-6 font-bold text-center">状态</th>
            <th class="p-6 font-bold">今日用量 / 额度</th>
            <th class="p-6 font-bold">反重力用量</th>
            <th class="p-6 font-bold text-center">Discord ID</th>
            <th class="p-6 font-bold text-center">Discord 头像</th>
            <th class="p-6 font-bold text-center">Discord 名称</th>
            <th class="p-6 font-bold text-center">公益站用户名</th>
            <th class="p-6 font-bold text-right">操作</th>
          </tr>
        </thead>
        <tbody class="text-sm divide-y divide-gray-100">
          <tr v-for="user in users" :key="user.id" class="hover:bg-gray-50 transition-colors group">
            
            <!-- User Info -->
            <td class="p-6">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center overflow-hidden shadow-sm border border-gray-200 shrink-0">
                        <div class="w-full h-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold text-sm">
                            {{ user.email.charAt(0).toUpperCase() }}
                        </div>
                    </div>
                    <div>
                        <div class="font-bold text-gray-800 flex items-center gap-2">
                            {{ user.email }}
                        </div>
                        <div class="text-xs text-gray-400 font-mono mt-0.5">ID: {{ user.id }} • {{ new Date(user.created_at).toLocaleDateString() }}</div>
                    </div>
                </div>
            </td>

            <!-- Role -->
            <td class="p-6 text-center">
                <span v-if="user.role === 'ADMIN'" class="bg-yellow-50 text-yellow-700 px-3 py-1 rounded-full text-xs font-bold border border-yellow-200 shadow-sm">
                    👑 ADMIN
                </span>
                <span v-else class="bg-gray-100 text-gray-600 px-3 py-1 rounded-full text-xs font-medium border border-gray-200">
                    USER
                </span>
            </td>

            <!-- Status -->
            <td class="p-6 text-center">
                <div class="flex justify-center">
                    <span v-if="user.is_active" class="bg-emerald-50 text-emerald-700 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 border border-emerald-200">
                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> 正常
                    </span>
                    <span v-else class="bg-rose-50 text-rose-700 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 border border-rose-200">
                        🚫 已禁用
                    </span>
                </div>
            </td>

            <!-- Usage -->
            <td class="p-6 w-64">
                <div class="flex flex-col gap-1">
                    <div class="flex justify-between text-xs font-mono text-gray-500">
                        <span>{{ user.today_used }}</span>
                        <span>{{ user.daily_limit }}</span>
                    </div>
                    <div class="w-full bg-gray-100 h-2 rounded-full overflow-hidden border border-gray-100">
                        <div 
                            class="h-full rounded-full transition-all duration-500 shadow-sm"
                            :class="user.today_used > user.daily_limit ? 'bg-rose-500' : 'bg-indigo-500'"
                            :style="{ width: Math.min((user.today_used / (user.daily_limit || 1)) * 100, 100) + '%' }"
                        ></div>
                    </div>
                </div>
            </td>

            <!-- Antigravity Usage -->
            <td class="p-6 w-48">
                <div class="flex flex-col gap-2">
                    <!-- Claude -->
                    <div class="flex items-center gap-2 text-xs">
                        <span class="w-12 text-gray-500 font-bold">C</span>
                        <div class="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                             <div class="h-full bg-blue-500" :style="{ width: Math.min((user.ag_claude_used / (user.ag_claude_limit || 100)) * 100, 100) + '%' }"></div>
                        </div>
                        <span class="text-gray-600 font-mono text-[10px]">{{ user.ag_claude_used }}/{{ user.ag_claude_limit || 100 }}</span>
                    </div>
                    <!-- Gemini 3 -->
                    <div class="flex items-center gap-2 text-xs">
                        <span class="w-12 text-gray-500 font-bold">G3</span>
                        <div class="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                             <div class="h-full bg-purple-500" :style="{ width: Math.min((user.ag_gemini3_used / (user.ag_gemini3_limit || 200)) * 100, 100) + '%' }"></div>
                        </div>
                        <span class="text-gray-600 font-mono text-[10px]">{{ user.ag_gemini3_used }}/{{ user.ag_gemini3_limit || 200 }}</span>
                    </div>
                </div>
            </td>
            
            <!-- Discord Info -->
            <td class="p-6 text-center font-mono text-gray-600">
              {{ user.discordId || '未绑定' }}
            </td>
            <td class="p-6 text-center">
              <div class="w-8 h-8 rounded-full overflow-hidden border border-gray-200 mx-auto">
                <img v-if="user.discordAvatar" :src="user.discordAvatar" class="w-full h-full object-cover" alt="Discord Avatar">
                <span v-else class="text-xs text-gray-400">无</span>
              </div>
            </td>
            <td class="p-6 text-center font-bold text-gray-800">
              {{ user.discordUsername || '未绑定' }}
            </td>
            <td class="p-6 text-center font-bold text-gray-800">
              {{ user.email }}
            </td>

            <!-- Actions -->
            <td class="p-6 text-right">
                <div class="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button @click="openAgLimitModal(user)" title="反重力模型限额" class="w-8 h-8 rounded-lg bg-purple-50 hover:bg-purple-100 text-purple-600 flex items-center justify-center transition-colors border border-purple-100">
                        🚀
                    </button>
                    <button @click="openQuotaModal(user)" title="修改额度" class="w-8 h-8 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 flex items-center justify-center transition-colors border border-indigo-100">
                        ⚖️
                    </button>
                    <button @click="openPasswordModal(user)" title="重置密码" class="w-8 h-8 rounded-lg bg-yellow-50 hover:bg-yellow-100 text-yellow-600 flex items-center justify-center transition-colors border border-yellow-100">
                        🔑
                    </button>
                    <button @click="toggleUserStatus(user)" :title="user.is_active ? '禁用' : '启用'" class="w-8 h-8 rounded-lg bg-gray-50 hover:bg-gray-100 text-gray-600 flex items-center justify-center transition-colors text-lg border border-gray-200">
                        {{ user.is_active ? '🛑' : '✅' }}
                    </button>
                </div>
            </td>

          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div class="flex justify-center mt-6 gap-2" v-if="pagination.total_pages > 1">
        <button 
            @click="pagination.page--" 
            :disabled="pagination.page === 1"
            class="px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold text-gray-700 shadow-sm"
        >
            ← 上一页
        </button>
        <span class="px-4 py-2 text-sm text-gray-500 font-mono">{{ pagination.page }} / {{ pagination.total_pages }}</span>
        <button 
            @click="pagination.page++" 
            :disabled="pagination.page === pagination.total_pages"
            class="px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold text-gray-700 shadow-sm"
        >
            下一页 →
        </button>
    </div>

    <!-- Quota Modal -->
    <div v-if="showQuotaModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white border border-gray-100 p-8 rounded-3xl w-full max-w-sm shadow-2xl" v-motion-pop>
            <h3 class="text-xl font-bold mb-6 text-gray-900">⚖️ 修改额度</h3>
            <p class="text-sm text-gray-500 mb-4">修改用户 <span class="font-mono text-gray-700">{{ selectedUser.email }}</span> 的每日请求限制。</p>
            <input type="number" v-model="newQuota" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 mb-6 text-gray-900 font-mono text-xl text-center focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all">
            <div class="flex justify-end gap-3">
                <button @click="showQuotaModal = false" class="px-5 py-2 rounded-xl hover:bg-gray-100 text-sm text-gray-600">取消</button>
                <button @click="confirmQuota" class="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold text-sm shadow-lg shadow-indigo-200">保存</button>
            </div>
        </div>
    </div>

    <!-- Antigravity Limits Modal -->
    <div v-if="showAgLimitModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white border border-gray-100 p-8 rounded-3xl w-full max-w-sm shadow-2xl" v-motion-pop>
            <h3 class="text-xl font-bold mb-6 text-gray-900">🚀 反重力模型限额</h3>
            <p class="text-sm text-gray-500 mb-4">为用户 <span class="font-mono text-gray-700">{{ selectedUser.email }}</span> 设置每日模型使用次数。</p>
            <div class="space-y-4">
                <div>
                    <label class="block text-xs text-gray-500 mb-1">Claude (每日次数)</label>
                    <input type="number" v-model.number="newAgClaudeLimit" min="0" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-100 transition-all">
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">Gemini 3 (每日次数)</label>
                    <input type="number" v-model.number="newAgGeminiLimit" min="0" class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-100 transition-all">
                </div>
            </div>
            <div class="flex justify-end gap-3 mt-6">
                <button @click="showAgLimitModal = false" class="px-5 py-2 rounded-xl hover:bg-gray-100 text-sm text-gray-600">取消</button>
                <button @click="confirmAgLimits" class="px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-bold text-sm shadow-lg shadow-purple-200">保存</button>
            </div>
        </div>
    </div>

    <!-- Password Modal -->
    <div v-if="showPasswordModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white border border-gray-100 p-8 rounded-3xl w-full max-w-sm shadow-2xl" v-motion-pop>
            <h3 class="text-xl font-bold mb-6 text-gray-900">🔑 重置密码</h3>
            <p class="text-sm text-gray-500 mb-4">为用户 <span class="font-mono text-gray-700">{{ selectedUser.email }}</span> 设置新密码。</p>
            <input type="text" v-model="newPassword" placeholder="输入新密码..." class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 mb-6 text-gray-900 focus:outline-none focus:border-yellow-500 focus:ring-2 focus:ring-yellow-100 transition-all">
            <div class="flex justify-end gap-3">
                <button @click="showPasswordModal = false" class="px-5 py-2 rounded-xl hover:bg-gray-100 text-sm text-gray-600">取消</button>
                <button @click="confirmPassword" class="px-5 py-2 bg-yellow-500 hover:bg-yellow-400 text-white rounded-xl font-bold text-sm shadow-lg shadow-yellow-200">重置</button>
            </div>
        </div>
    </div>

  </div>
</template>
