<template>
  <el-card class="board-card" shadow="hover" @click="$emit('open', board)">
    <template #header>
      <div class="board-card-header">
        <h3>{{ board.name }}</h3>
        <el-button
          type="danger"
          :icon="Delete"
          circle
          size="small"
          @click.stop="$emit('delete', board)"
        />
      </div>
    </template>
    <p class="board-desc">{{ board.description || 'No description' }}</p>
    <div class="board-meta">
      <el-tag size="small" type="info">
        <el-icon><Grid /></el-icon>
        {{ board.column_count || 0 }} columns
      </el-tag>
      <el-tag size="small" type="info">
        <el-icon><Document /></el-icon>
        {{ board.card_count || 0 }} cards
      </el-tag>
    </div>
    <div class="board-date">
      <el-text type="info" size="small">
        Created {{ formatDate(board.created_at) }}
      </el-text>
      <el-text v-if="board.last_updated_at" type="info" size="small">
        · Updated {{ formatDate(board.last_updated_at) }}
      </el-text>
    </div>
  </el-card>
</template>

<script setup>
import { Delete, Grid, Document } from '@element-plus/icons-vue'

defineProps({
  board: { type: Object, required: true }
})

defineEmits(['open', 'delete'])

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<style scoped>
.board-card {
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}

.board-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
}

.board-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.board-card-header h3 {
  font-size: 18px;
  color: #303133;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-desc {
  color: #606266;
  font-size: 14px;
  margin-bottom: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-meta {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.board-meta .el-tag {
  display: flex;
  align-items: center;
  gap: 4px;
}

.board-date {
  margin-top: 4px;
}
</style>
