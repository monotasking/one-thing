<template>
  <VirtualTable
    row-key="id"
    :data="rows"
    :columns="columns"
    :height="560"
    :row-height="48"
    :overscan="12"
    virtualize-columns
    border
    stripe
    selection-mode="multiple"
    :loading="loading"
    empty-text="No orders found"
    @sort-change="handleSortChange"
    @selection-change="handleSelectionChange"
  />
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue'
import VirtualTable from './VirtualTable.vue'
import type { VirtualTableColumn, VirtualTableRowKey, VirtualTableSortState } from './virtual-table/types'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.virtual-table-example')

interface OrderRow {
  id: number
  customer: string
  status: 'paid' | 'pending' | 'failed'
  amount: number
  region: string
  owner: string
  updatedAt: string
}

const loading = ref(false)
const selectedKeys = ref<VirtualTableRowKey[]>([])

const rows = computed<OrderRow[]>(() => Array.from({ length: 10000 }, (_, index) => {
  const statuses: OrderRow['status'][] = ['paid', 'pending', 'failed']
  return {
    id: index + 1,
    customer: `Customer ${index + 1}`,
    status: statuses[index % statuses.length],
    amount: Math.round((index * 17.31 + 48) * 100) / 100,
    region: ['North America', 'Europe', 'APAC', 'LATAM'][index % 4],
    owner: ['Ada', 'Grace', 'Linus', 'Margaret'][index % 4],
    updatedAt: new Date(2026, 0, (index % 28) + 1).toISOString().slice(0, 10),
  }
}))

const columns: VirtualTableColumn<OrderRow>[] = [
  { key: 'id', field: 'id', title: 'Order ID', width: 110, sortable: true, align: 'right' },
  { key: 'customer', field: 'customer', title: 'Customer', width: 220, sortable: true },
  {
    key: 'status',
    field: 'status',
    title: 'Status',
    width: 140,
    render: ({ value }) => h('span', {
      class: ['order-status', `is-${value}`],
    }, String(value).toUpperCase()),
  },
  {
    key: 'amount',
    field: 'amount',
    title: 'Amount',
    width: 140,
    align: 'right',
    sortable: true,
    render: ({ value }) => `$${Number(value).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`,
  },
  { key: 'region', field: 'region', title: 'Region', width: 180 },
  { key: 'owner', field: 'owner', title: 'Owner', width: 160 },
  { key: 'updatedAt', field: 'updatedAt', title: 'Updated', width: 160, sortable: true },
]

function handleSortChange(state: VirtualTableSortState) {
  log.debug('sort changed', { state })
}

function handleSelectionChange(_rows: OrderRow[], keys: VirtualTableRowKey[]) {
  selectedKeys.value = keys
}
</script>

<style scoped>
.order-status {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
}

.order-status.is-paid {
  color: var(--ui-status-success-fg, var(--color-success));
  background: var(--ui-status-success-bg, var(--color-success-bg));
}

.order-status.is-pending {
  color: var(--ui-status-warning-fg, var(--color-warning));
  background: var(--ui-status-warning-bg, var(--color-warning-bg));
}

.order-status.is-failed {
  color: var(--ui-status-danger-fg, var(--color-danger));
  background: var(--ui-status-danger-bg, var(--color-danger-bg));
}
</style>
