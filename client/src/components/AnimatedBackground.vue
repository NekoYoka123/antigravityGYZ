<template>
  <div class="fixed inset-0 z-[-1] overflow-hidden bg-[#1a1a2e]">
    <!-- 1. 基础背景 (深蓝紫色) -->
    
    <!-- 2. 流动的光斑 (直接用 Style 绑定动画，确保生效) -->
    <div class="blob blob-1"></div>
    <div class="blob blob-2"></div>
    <div class="blob blob-3"></div>
    <div class="blob blob-4"></div>

    <!-- 3. 噪点纹理 -->
    <div class="absolute inset-0 opacity-20 pointer-events-none mix-blend-overlay" :style="{ backgroundImage: `url(${noiseSvg})` }"></div>
  </div>
</template>

<script setup lang="ts">
const noiseSvg = "data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='1'/%3E%3C/svg%3E";
</script>