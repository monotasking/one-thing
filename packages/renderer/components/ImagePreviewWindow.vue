<template>
  <div
    class="image-preview-window"
    :class="{ 'is-dragging': isDragging, 'gallery-mode': isGalleryMode }"
  >
    <!-- Drag region for window -->
    <div class="drag-region" />

    <!-- Gallery sidebar (left thumbnails) -->
    <div
      v-if="isGalleryMode"
      class="gallery-sidebar"
    >
      <div class="sidebar-header">
        <span class="image-count">{{ images.length }} images</span>
      </div>
      <div
        ref="thumbnailListRef"
        class="thumbnail-list"
      >
        <div
          v-for="(img, index) in images"
          :key="img.id"
          class="thumbnail-item"
          :class="{ active: currentIndex === index }"
          @click="selectImage(index)"
        >
          <img
            :src="img.thumbnail || img.src"
            :alt="img.alt || 'Image'"
          >
        </div>
      </div>
    </div>

    <!-- Main preview area -->
    <div class="preview-area">
      <!-- Image container -->
      <div
        ref="containerRef"
        class="image-container"
        @wheel="handleWheel"
        @mousedown="startDrag"
        @mousemove="onDrag"
        @mouseup="endDrag"
        @mouseleave="endDrag"
      >
        <img
          v-if="imageSrc"
          :src="imageSrc"
          :alt="imageAlt"
          class="preview-image"
          :style="imageStyle"
          @load="onImageLoad"
          @error="onImageError"
        >
        <div
          v-else-if="!loadError"
          class="loading-state"
        >
          <div class="loading-spinner" />
          <span>Loading image...</span>
        </div>
        <div
          v-if="loadError"
          class="error-state"
        >
          <ErrorNote message="Failed to load image" />
        </div>
      </div>

      <!-- Controls bar -->
      <div class="controls-bar">
        <div class="controls-left">
          <span class="image-name">{{ imageAlt || 'Image' }}</span>
        </div>
        <div class="controls-center">
          <!-- Navigation for gallery mode -->
          <template v-if="isGalleryMode">
            <Tooltip text="Previous (←)">
              <Button
                unstyled
                class="control-btn"
                :disabled="currentIndex === 0"
                aria-label="Previous image"
                @click="prevImage"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </Button>
            </Tooltip>
            <span class="nav-info">{{ currentIndex + 1 }} / {{ images.length }}</span>
            <Tooltip text="Next (→)">
              <Button
                unstyled
                class="control-btn"
                :disabled="currentIndex >= images.length - 1"
                aria-label="Next image"
                @click="nextImage"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </Button>
            </Tooltip>
            <div class="divider" />
          </template>
          <Tooltip text="Zoom out (-)">
            <Button
              unstyled
              class="control-btn"
              aria-label="Zoom out"
              @click="zoomOut"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <circle
                  cx="11"
                  cy="11"
                  r="8"
                />
                <line
                  x1="21"
                  y1="21"
                  x2="16.65"
                  y2="16.65"
                />
                <line
                  x1="8"
                  y1="11"
                  x2="14"
                  y2="11"
                />
              </svg>
            </Button>
          </Tooltip>
          <span class="zoom-level">{{ Math.round(scale * 100) }}%</span>
          <Tooltip text="Zoom in (+)">
            <Button
              unstyled
              class="control-btn"
              aria-label="Zoom in"
              @click="zoomIn"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <circle
                  cx="11"
                  cy="11"
                  r="8"
                />
                <line
                  x1="21"
                  y1="21"
                  x2="16.65"
                  y2="16.65"
                />
                <line
                  x1="11"
                  y1="8"
                  x2="11"
                  y2="14"
                />
                <line
                  x1="8"
                  y1="11"
                  x2="14"
                  y2="11"
                />
              </svg>
            </Button>
          </Tooltip>
          <Tooltip text="Reset (0)">
            <Button
              unstyled
              class="control-btn"
              aria-label="Reset view"
              @click="resetView"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </Button>
          </Tooltip>
          <div class="divider" />
          <Tooltip text="Fit to window">
            <Button
              unstyled
              class="control-btn"
              aria-label="Fit to window"
              @click="fitToWindow"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect
                  x="3"
                  y="3"
                  width="18"
                  height="18"
                  rx="2"
                />
                <path d="M9 3v18" />
                <path d="M15 3v18" />
                <path d="M3 9h18" />
                <path d="M3 15h18" />
              </svg>
            </Button>
          </Tooltip>
          <Tooltip text="Actual size (1)">
            <Button
              unstyled
              class="control-btn"
              aria-label="Actual size"
              @click="actualSize"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect
                  x="3"
                  y="3"
                  width="18"
                  height="18"
                  rx="2"
                />
                <text
                  x="12"
                  y="16"
                  text-anchor="middle"
                  font-size="10"
                  fill="currentColor"
                  stroke="none"
                >1:1</text>
              </svg>
            </Button>
          </Tooltip>
        </div>
        <div class="controls-right">
          <Tooltip text="Download">
            <Button
              unstyled
              class="control-btn"
              aria-label="Download"
              @click="downloadImage"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line
                  x1="12"
                  y1="15"
                  x2="12"
                  y2="3"
                />
              </svg>
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { matchShortcut } from '@/composables/useShortcuts'
import type { MediaAsset } from '@/types'
import { platformApi } from '@/platform'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.image-preview')

const settingsStore = useSettingsStore()

/**
 * Parse URL query params from window.location.hash
 * Format: #/image-preview?mode=gallery&mediaId=xxx
 */
function getQueryParams(): Record<string, string> {
  const hash = window.location.hash
  const queryIndex = hash.indexOf('?')
  if (queryIndex === -1) return {}

  const queryString = hash.slice(queryIndex + 1)
  const params: Record<string, string> = {}
  queryString.split('&').forEach(pair => {
    const [key, value] = pair.split('=')
    if (key && value) {
      params[decodeURIComponent(key)] = decodeURIComponent(value)
    }
  })
  return params
}

interface GalleryImage {
  id: string
  src: string
  alt?: string
  thumbnail?: string
}

interface SingleImagePreviewPayload {
  mode?: 'single'
  previewId?: string
  src?: string
  alt?: string
}

// Mode and images state
const isGalleryMode = ref(false)
const images = ref<GalleryImage[]>([])
const currentIndex = ref(0)

// Single image state (for non-gallery mode)
const singleImageSrc = ref('')
const singleImageAlt = ref('')

// Computed current image
const imageSrc = computed(() => {
  if (isGalleryMode.value && images.value.length > 0) {
    return images.value[currentIndex.value]?.src || ''
  }
  return singleImageSrc.value
})

const imageAlt = computed(() => {
  if (isGalleryMode.value && images.value.length > 0) {
    return images.value[currentIndex.value]?.alt || 'Image'
  }
  return singleImageAlt.value
})

// Image state
const loadError = ref(false)
const imageNaturalWidth = ref(0)
const imageNaturalHeight = ref(0)
const containerRef = ref<HTMLElement | null>(null)
const thumbnailListRef = ref<HTMLElement | null>(null)

// Transform state
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const minScale = 0.1
const maxScale = 10

// Drag state
const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
const lastTranslateX = ref(0)
const lastTranslateY = ref(0)

const imageStyle = computed(() => ({
  transform: `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value})`,
}))

function selectImage(index: number) {
  if (index >= 0 && index < images.value.length) {
    currentIndex.value = index
    resetView()
    scrollThumbnailIntoView(index)
  }
}

function prevImage() {
  if (currentIndex.value > 0) {
    selectImage(currentIndex.value - 1)
  }
}

function nextImage() {
  if (currentIndex.value < images.value.length - 1) {
    selectImage(currentIndex.value + 1)
  }
}

function scrollThumbnailIntoView(index: number) {
  nextTick(() => {
    const list = thumbnailListRef.value
    if (!list) return
    const items = list.querySelectorAll('.thumbnail-item')
    const item = items[index] as HTMLElement
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })
}

function onImageLoad(event: Event) {
  const img = event.target as HTMLImageElement
  imageNaturalWidth.value = img.naturalWidth
  imageNaturalHeight.value = img.naturalHeight
  loadError.value = false
  // Auto fit to window on first load
  fitToWindow()
}

function onImageError() {
  loadError.value = true
}

function zoomIn() {
  scale.value = Math.min(scale.value * 1.25, maxScale)
}

function zoomOut() {
  scale.value = Math.max(scale.value / 1.25, minScale)
}

function resetView() {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
}

function fitToWindow() {
  if (!containerRef.value || !imageNaturalWidth.value || !imageNaturalHeight.value) return

  const containerRect = containerRef.value.getBoundingClientRect()
  const padding = 40 // Some padding around the image

  const scaleX = (containerRect.width - padding) / imageNaturalWidth.value
  const scaleY = (containerRect.height - padding) / imageNaturalHeight.value

  scale.value = Math.min(scaleX, scaleY, 1) // Don't scale up beyond 100%
  translateX.value = 0
  translateY.value = 0
}

function actualSize() {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
}

function handleWheel(e: WheelEvent) {
  e.preventDefault()

  const delta = e.deltaY > 0 ? 0.9 : 1.1
  const newScale = Math.min(Math.max(scale.value * delta, minScale), maxScale)

  // Zoom towards mouse position
  if (containerRef.value) {
    const rect = containerRef.value.getBoundingClientRect()
    const mouseX = e.clientX - rect.left - rect.width / 2
    const mouseY = e.clientY - rect.top - rect.height / 2

    const scaleFactor = newScale / scale.value
    translateX.value = mouseX - (mouseX - translateX.value) * scaleFactor
    translateY.value = mouseY - (mouseY - translateY.value) * scaleFactor
  }

  scale.value = newScale
}

function startDrag(e: MouseEvent) {
  if (e.button !== 0) return // Only left mouse button
  isDragging.value = true
  dragStartX.value = e.clientX
  dragStartY.value = e.clientY
  lastTranslateX.value = translateX.value
  lastTranslateY.value = translateY.value
}

function onDrag(e: MouseEvent) {
  if (!isDragging.value) return
  translateX.value = lastTranslateX.value + (e.clientX - dragStartX.value)
  translateY.value = lastTranslateY.value + (e.clientY - dragStartY.value)
}

function endDrag() {
  isDragging.value = false
}

function downloadImage() {
  if (!imageSrc.value) return

  const link = document.createElement('a')
  link.href = imageSrc.value
  link.download = imageAlt.value || 'image.png'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

function handleKeydown(e: KeyboardEvent) {
  // Close window with Escape or configured close shortcut
  const closeShortcut = settingsStore.settings?.general?.shortcuts?.closeChat
  if (e.key === 'Escape' || matchShortcut(e, closeShortcut)) {
    e.preventDefault()
    window.close()
    return
  }

  if (e.key === '+' || e.key === '=') {
    zoomIn()
  } else if (e.key === '-') {
    zoomOut()
  } else if (e.key === '0') {
    resetView()
  } else if (e.key === '1') {
    actualSize()
  } else if (e.key === 'ArrowLeft' && isGalleryMode.value) {
    prevImage()
  } else if (e.key === 'ArrowRight' && isGalleryMode.value) {
    nextImage()
  }
}

// Listen for single image updates from main process
async function applySingleImagePreview(data: SingleImagePreviewPayload) {
  log.debug('single image preview applying', {
    previewId: data.previewId,
    hasInlineSrc: Boolean(data.src),
    inlineSrcLength: data.src?.length,
    alt: data.alt,
  })

  isGalleryMode.value = false
  singleImageSrc.value = ''
  singleImageAlt.value = data.alt || ''
  loadError.value = false
  resetView()

  if (data.src) {
    singleImageSrc.value = data.src
    return
  }

  if (!data.previewId) {
    log.warn('single image preview missing previewId and src')
    loadError.value = true
    return
  }

  try {
    const response = await platformApi?.getImagePreview?.(data.previewId)
    if (!response?.success || !response.src) {
      throw new Error(response?.error || 'Image preview was not found')
    }
    singleImageSrc.value = response.src
    singleImageAlt.value = response.alt || data.alt || ''
  } catch (error) {
    log.error('single image preview load failed', { previewId: data.previewId }, error)
    loadError.value = true
  }
}

function setupSingleImageListener() {
  log.debug('single image listener installed')
  const cleanup = platformApi?.onImagePreviewUpdate?.((data) => {
    void applySingleImagePreview(data)
  })
  return cleanup
}

/**
 * Load gallery from media storage (Pull mode - more reliable than IPC push)
 * Reads mediaId from URL params, loads all media, and finds the target image
 */
async function loadGalleryFromMedia(mediaId: string) {
  log.debug('gallery load requested', { mediaId })
  try {
    const gallery = await platformApi.getMediaGallery(mediaId, { kind: 'image' })
    log.debug('media gallery loaded', { count: gallery.images.length })

    if (gallery.images.length === 0) {
      log.warn('media gallery empty', { mediaId })
      loadError.value = true
      return
    }

    const galleryImages: GalleryImage[] = gallery.images.map((item: MediaAsset) => {
      const filePath = item.filePath || ''
      const filename = filePath.split('/').pop() || item.fileName
      const src = /^(https?:)?\/\//.test(filePath) || filePath.startsWith('/api/')
        ? filePath
        : `media://${filename}`
      return {
        id: item.id,
        src,
        alt: item.metadata?.prompt || item.fileName,
        thumbnail: src,
      }
    })
    const targetIndex = gallery.currentIndex

    log.debug('gallery ready', {
      count: galleryImages.length,
      targetIndex,
      firstImage: galleryImages[0]?.src,
    })

    isGalleryMode.value = true
    images.value = galleryImages
    currentIndex.value = targetIndex
    loadError.value = false
    resetView()
    scrollThumbnailIntoView(targetIndex)
  } catch (error) {
    log.error('media gallery load failed', { mediaId }, error)
    loadError.value = true
  }
}

let cleanupSingleListener: (() => void) | undefined

onMounted(() => {
  // Set up single image IPC listener (for non-media images like attachments)
  cleanupSingleListener = setupSingleImageListener()

  // Read mode and mediaId from URL params (parsed from window.location.hash)
  const params = getQueryParams()
  const mode = params.mode
  const mediaId = params.mediaId
  const previewId = params.previewId

  log.debug('image preview window mounted', { mode, mediaId, previewId })

  if (mode === 'gallery' && mediaId) {
    // Gallery mode: load media data ourselves (Pull mode - reliable)
    loadGalleryFromMedia(mediaId)
  } else if (mode === 'single' && previewId) {
    void applySingleImagePreview({ mode: 'single', previewId })
  }
  // Single mode without previewId still waits for IPC message for backward compatibility.

  // Load settings for keyboard shortcuts (non-blocking)
  settingsStore.loadSettings().then(() => {
    document.addEventListener('keydown', handleKeydown)
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  cleanupSingleListener?.()
})
</script>

<style scoped>
.image-preview-window {
  width: 100vw;
  height: 100vh;
  display: flex;
  background: var(--ui-surface-app-bg, var(--bg-primary));
  overflow: hidden;
}

.drag-region {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 38px;
  -webkit-app-region: drag;
  z-index: var(--z-sticky);
}

/* Gallery sidebar */
.gallery-sidebar {
  width: 180px;
  min-width: 180px;
  background: var(--ui-surface-panel-bg, var(--bg-secondary));
  border-right: 1px solid var(--ui-border-default-border, var(--border-primary));
  display: flex;
  flex-direction: column;
  padding-top: 38px; /* Account for drag region */
}

.sidebar-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--ui-border-default-border, var(--border-primary));
}

.image-count {
  font-size: 12px;
  color: var(--ui-text-secondary-fg);
  font-weight: 500;
}

.thumbnail-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.thumbnail-item {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all var(--duration-normal) var(--ease-default);
  background: var(--ui-surface-elevated-bg, var(--bg-tertiary));
}

.thumbnail-item:hover {
  border-color: var(--ui-border-subtle-border, var(--border-secondary));
}

.thumbnail-item.active {
  border-color: var(--ui-accent-primary-fg);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-accent-primary-fg) 20%, transparent);
}

.thumbnail-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* Preview area */
.preview-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.image-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: grab;
  padding-top: 38px; /* Account for drag region */
}

.gallery-mode .preview-area .image-container {
  padding-top: 0; /* Sidebar already has padding */
}

.image-container.is-dragging,
.is-dragging .image-container {
  cursor: grabbing;
}

.preview-image {
  max-width: none;
  max-height: none;
  object-fit: contain;
  transition: transform var(--duration-fast) var(--ease-out);
  user-select: none;
  -webkit-user-drag: none;
  border-radius: 4px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--ui-text-secondary-fg);
}

/* Full-panel state: keep the centering, let ErrorNote carry the ink. */
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--ui-border-default-border, var(--border-primary));
  border-top-color: var(--ui-accent-primary-fg);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.controls-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--ui-surface-panel-bg, var(--bg-secondary));
  border-top: 1px solid var(--ui-border-default-border, var(--border-primary));
  gap: 16px;
}

.controls-left,
.controls-center,
.controls-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.controls-left {
  flex: 1;
  min-width: 0;
}

.controls-center {
  flex-shrink: 0;
}

.controls-right {
  flex: 1;
  justify-content: flex-end;
}

.image-name {
  font-size: 13px;
  color: var(--ui-text-secondary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.control-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--ui-text-secondary-fg);
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
}

.control-btn:hover:not(:disabled) {
  background: var(--ui-surface-elevated-bg, var(--bg-tertiary));
  color: var(--ui-text-primary-fg);
}

.control-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.zoom-level,
.nav-info {
  min-width: 48px;
  text-align: center;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-secondary-fg);
  font-variant-numeric: tabular-nums;
}

.nav-info {
  min-width: 60px;
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--ui-border-default-border, var(--border-primary));
  margin: 0 4px;
}
</style>
